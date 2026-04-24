# pi-fenced

PI coding agent extension and launcher for running PI in a
Fence sandbox and configuring Fence policy out of process.

## Implemented scope (v1)

Current implementation is **global scope only**.

Deferred scope (not implemented yet):

- session/workspace chain selection and reconciliation rules

Included components:

- launcher: `launcher/pi-fenced.ts`
- external applier: `apply/pi-fenced-apply.ts`
- PI extension commands: `/configure-fence`, `/show-fence-config`

The launcher runs PI, detects pending config requests, runs the external
apply flow, and restarts PI when needed.

## Installation

Three supported installation paths are documented below.

### Install from npm (published package)

Recommended one-command global install:

```bash
pi install npm:pi-fenced@<version>
```

This global install does both:

- makes `pi-fenced` available in your PATH (via npm global install)
- registers the package in PI settings so the extension loads

Project-local package registration (for `.pi/settings.json`):

```bash
pi install -l npm:pi-fenced@<version>
```

### Install from GitHub

Install directly from this repository:

```bash
pi install git:github.com/dpolivaev/pi-fenced
```

Project-local package registration from GitHub:

```bash
pi install -l git:github.com/dpolivaev/pi-fenced
```

Optional: pin to a tag or commit by appending `@<ref>`.

Note:

- GitHub install registers the package for PI, but does **not** add
  `pi-fenced` to your shell PATH.
- Pi clones git packages into managed directories:
  - global install: `~/.pi/agent/git/github.com/dpolivaev/pi-fenced`
  - project install (`-l`):
    `<project>/.pi/git/github.com/dpolivaev/pi-fenced`
- To expose `pi-fenced` on PATH after GitHub install, run `npm link`
  from that installed package directory.

### Install from local checkout (development)

From repository root:

```bash
npm install
npm link
pi install .
```

What each command does:

- `npm link` exposes `pi-fenced` in PATH via symlink
- `pi install .` registers the current directory as a PI package

Project-local package registration from local checkout:

```bash
pi install -l .
```

### Verify installation

```bash
pi list
pi-fenced -- --help
```

`pi-fenced-apply` is internal-only and invoked by `pi-fenced`.
Direct invocation is rejected.

## Runtime model

### Managed runtime guard

The extension requires launcher-managed runtime:

- `PI_FENCED_LAUNCHER=1` -> commands are available
- otherwise -> warn + graceful shutdown

### Runtime status label

The footer status label for key `pi-fenced` indicates launcher mode:

- `🔒 fence` when fenced runtime is active
- `yolo` when launcher runs with `--without-fence`

### Global config ownership

Global target path is:

- `<agentDir>/fence/global.json`

`agentDir` resolution:

- `PI_CODING_AGENT_DIR` when set (supports `~` and `~/...`)
- otherwise `~/.pi/agent`

Bootstrap chain on launcher startup:

1. ensure `~/.config/fence/fence.json` exists,
   create `{"extends":"code"}` when missing
2. ensure `<agentDir>/fence/global.json` exists,
   create `{"extends":"@base"}` when missing

### Launcher modes

Default (fenced, self-protected):

```bash
node launcher/pi-fenced.ts -- --model <provider/model>
```

Fenced with monitor:

```bash
node launcher/pi-fenced.ts --fence-monitor -- --model <provider/model>
```

Unfenced diagnostics mode (**requires explicit unlock**):

```bash
node launcher/pi-fenced.ts --without-fence --allow-self-modify -- --model <provider/model>
```

Unlock mode (fenced, maintenance/development):

```bash
node launcher/pi-fenced.ts --allow-self-modify -- --model <provider/model>
```

Notes:

- launcher always forwards remaining args to `pi`
- `--fence-monitor` is ignored in `--without-fence` mode with warning
- `--without-fence` is refused unless `--allow-self-modify` is set
- `--allow-self-modify` emits a loud warning and temporarily disables
  default self-protection writes lock

### Default self-protection lock (when `--allow-self-modify` is not used)

In fenced mode, launcher generates a per-run locked runtime settings
overlay under `/tmp/pi-fenced/runtime/` with a unique filename:

- `/tmp/pi-fenced/runtime/launcher-locked-settings.<run-id>.json`

It adds `filesystem.denyWrite` protections for:

- full `pi-fenced` package root (the launcher installation path)
- `<agentDir>/fence/global.json` and its parent directory
- `~/.config/fence/fence.json` and its parent directory

Lifecycle and cleanup behavior:

- each launcher run creates one unique lock settings file
- launcher removes its own generated file on exit
- startup best-effort stale cleanup prunes old lock files, but keeps
  files that appear to belong to currently running launcher PIDs

This prevents direct in-session tampering of package control-plane code
and active Fence config files. Normal config mutation path remains:
`/configure-fence` -> external apply.

## Request/apply artifacts

All control artifacts live under `/tmp/pi-fenced`:

- requests: `/tmp/pi-fenced/control/request-<id>.json`
- proposals: `/tmp/pi-fenced/proposals/<id>.json`
- backups: `/tmp/pi-fenced/backups/<id>/...`

Request contract uses replace-only apply:

- `scope: "global"`
- `mutationType: "replace"`
- `baseSha256` stale-write protection

## Slash commands

### `/configure-fence`

- usage: `/configure-fence <change request>`
- does not open interactive input when arguments are missing
- shows usage/help text and exits when no change request is provided
- always targets `<agentDir>/fence/global.json`
- rejects vague/non-actionable requests with guidance
- creates proposal + request under `/tmp/pi-fenced` for actionable changes
- asks for confirmation and optional shutdown handoff

Mutation planning model for `/configure-fence`:

- deterministic system prompt built from versioned files in
  `prompts/configure-fence/`
- canonical Fence domain reference injected into that system prompt
- dynamic request context kept in user prompt
- strict structured tool-call output contract (`valid`/`invalid`, then
  `write` or `edit` proposal)

### `/show-fence-config`

Runs:

```bash
fence config show --settings <agentDir>/fence/global.json
```

Displays Fence output **verbatim** (stderr chain + stdout effective
JSON) in a read-only viewer (starts at first line), without sending
that output through LLM context.

## Operations and recovery

### Launcher loop

After startup, launcher runs this loop:

1. launch PI (fenced by default)
2. when PI exits, run `pi-fenced-apply`
3. if no pending request exists, exit with PI exit code
4. otherwise log outcome and restart PI

### `/configure-fence` request flow

From PI:

1. run `/configure-fence <change request>`
2. if request text is missing, command shows usage/help and exits
3. if request is non-actionable, command warns and writes no files
4. if request is actionable, command writes:
   - `/tmp/pi-fenced/proposals/<id>.json`
   - `/tmp/pi-fenced/control/request-<id>.json`
5. command asks whether to shutdown for external apply handoff

### External apply checks

`pi-fenced-apply` enforces:

- no pending request -> `no-request` outcome
- multiple pending requests -> `conflict-cleanup` outcome (drops all
  requests and linked proposals)
- for a single pending request:
  - request schema validity
  - `scope === "global"`
  - request target path is `<agentDir>/fence/global.json`
  - proposal JSON validates through Fence
  - `baseSha256` matches current target content

Then it prompts **Yes/No**:

- Yes -> apply
- No -> reject

### Apply outcomes

- `no-request`: launcher exits (no action needed)
- `conflict-cleanup`: multiple requests found; all requests + linked
  proposals dropped; submit one fresh `/configure-fence` request
- `invalid-request`: malformed/invalid request or proposal; request and
  linked proposal dropped; submit a new request
- `base-hash-mismatch`: target changed since proposal creation; request
  dropped; regenerate from current config
- `rejected`: target unchanged; request/proposal cleaned
- `applied`: target updated; request/proposal cleaned
- `apply-failed`: apply or post-apply validation failed; rollback
  attempted; inspect backup under `/tmp/pi-fenced/backups/<id>/`
