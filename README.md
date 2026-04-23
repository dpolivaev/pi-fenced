# pi-fenced

Launcher-managed PI runtime with Fence-first enforcement and
out-of-process policy apply.

## Implemented scope (v1)

Current implementation is **global scope only**.

Included components:

- launcher: `launcher/pi-fenced.ts`
- external applier: `apply/pi-fenced-apply.ts`
- PI extension commands: `/configure-fence`, `/show-fence-config`

The launcher runs PI, detects pending config requests, runs the external
apply flow, and restarts PI when needed.

## Runtime model

### Managed runtime guard

The extension requires launcher-managed runtime:

- `PI_FENCED_LAUNCHER=1` -> commands are available
- otherwise -> warn + graceful shutdown

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

In fenced mode, launcher generates a locked runtime settings overlay that
adds `filesystem.denyWrite` protections for:

- `launcher/**`
- `apply/**`
- `<agentDir>/fence/global.json` and its parent directory
- `~/.config/fence/fence.json` and its parent directory

This prevents direct in-session tampering of control-plane code and
active Fence config files. Normal config mutation path remains:
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

- always targets `<agentDir>/fence/global.json`
- creates proposal + request under `/tmp/pi-fenced`
- asks for confirmation and optional shutdown handoff

### `/show-fence-config`

Runs:

```bash
fence config show --settings <agentDir>/fence/global.json
```

Displays Fence output **verbatim** (stderr chain + stdout effective
JSON), without sending that output through LLM context.

## Recovery and operations

See `docs/runbook.md` for:

- apply/reject flow
- conflict cleanup behavior
- stale hash / invalid proposal / rollback recovery
- `/show-fence-config` operational usage
