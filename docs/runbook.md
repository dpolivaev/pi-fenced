# pi-fenced Runbook (global-only v1)

## Scope

This runbook documents operational behavior for the implemented
**global-only** flow.

Global target:

- `<agentDir>/fence/global.json`

`agentDir`:

- `PI_CODING_AGENT_DIR` when set
- otherwise `~/.pi/agent`

## Startup and bootstrap

On each launcher start, `pi-fenced` ensures:

1. `~/.config/fence/fence.json` exists
   - creates `{"extends":"code"}` when missing
2. `<agentDir>/fence/global.json` exists
   - creates `{"extends":"@base"}` when missing

Missing bootstrap files are created once and then reused.

## Standard operation

Run launcher (default fenced mode):

```bash
node launcher/pi-fenced.ts -- --model <provider/model>
```

The launcher loop is:

1. launch PI (fenced by default)
2. on PI exit, run external apply workflow
3. if no pending request -> launcher exits with PI exit code
4. otherwise log apply outcome and restart PI

This means apply outcomes other than `no-request` cause automatic
restart of PI.

### Mode flags

Fenced monitor mode:

```bash
node launcher/pi-fenced.ts --fence-monitor -- --model <provider/model>
```

Unfenced diagnostics mode (explicit unlock required):

```bash
node launcher/pi-fenced.ts --without-fence --allow-self-modify -- --model <provider/model>
```

Fenced unlock mode (maintenance/development):

```bash
node launcher/pi-fenced.ts --allow-self-modify -- --model <provider/model>
```

`--without-fence` is refused unless `--allow-self-modify` is set.

## Self-protection lock model

When `--allow-self-modify` is **not** set, fenced launcher mode builds a
runtime overlay config with `filesystem.denyWrite` for protected paths.

Protected paths include:

- control-plane artifacts: `launcher/**`, `apply/**`
- active config files and parent dirs:
  - `<agentDir>/fence/global.json`
  - `~/.config/fence/fence.json`

This blocks direct in-session writes to launcher/applier and active
config files. The intended config mutation path remains
`/configure-fence` -> external apply.

When `--allow-self-modify` is set, this lock is disabled for that
launcher run and a loud warning is emitted.

## Request flow

From PI:

1. `/configure-fence` produces:
   - proposal file: `/tmp/pi-fenced/proposals/<id>.json`
   - request file: `/tmp/pi-fenced/control/request-<id>.json`
2. PI can shutdown for handoff
3. launcher runs `pi-fenced-apply`
4. applier validates and prompts apply/reject
5. launcher restarts PI after outcome handling

## External apply behavior

`pi-fenced-apply` enforces:

- exactly one pending request (else conflict cleanup)
- request schema validity
- `scope === "global"`
- request target matches `<agentDir>/fence/global.json`
- proposal validates through Fence
- `baseSha256` matches current target content

On apply:

- backup old target content to `/tmp/pi-fenced/backups/<id>/...`
- atomic replace target
- validate resulting target
- rollback on failure

Diff shown to operator is unified full-file replace style.

## Outcome handling and operator action

### `no-request`

- Meaning: no pending request files.
- System behavior: launcher exits.
- Operator action: none.

### `conflict-cleanup`

- Meaning: more than one `request-*.json` was found.
- System behavior:
  - drops all pending request files
  - drops linked proposal files
  - warns loudly
  - launcher restarts PI
- Operator action:
  - rerun `/configure-fence` for one fresh request.

### `invalid-request`

- Meaning: malformed request, invalid scope/target, missing proposal,
  or proposal validation failure.
- System behavior:
  - drops request and linked proposal
  - launcher restarts PI
- Operator action:
  - run `/show-fence-config` if needed,
  - submit a new `/configure-fence` request.

### `base-hash-mismatch`

- Meaning: target changed after proposal was created.
- System behavior:
  - drops request and linked proposal
  - launcher restarts PI
- Operator action:
  - regenerate request via `/configure-fence` from current config.

### `rejected`

- Meaning: operator chose reject at apply prompt.
- System behavior:
  - target unchanged
  - request/proposal cleaned
  - launcher restarts PI
- Operator action: none, or create a revised request.

### `applied`

- Meaning: apply succeeded.
- System behavior:
  - target updated
  - request/proposal cleaned
  - launcher restarts PI
- Operator action: verify behavior in restarted PI session.

### `apply-failed`

- Meaning: apply or post-apply validation failed.
- System behavior:
  - rollback attempted automatically
  - request/proposal cleaned
  - launcher restarts PI
- Operator action:
  - inspect warning output,
  - inspect backup under `/tmp/pi-fenced/backups/<id>/`,
  - regenerate request when ready.

## `/show-fence-config`

Use inside managed PI runtime:

```text
/show-fence-config
```

Behavior:

- executes `fence config show --settings <agentDir>/fence/global.json`
- shows stderr and stdout output verbatim
- intended for transparency/debug, outside LLM context

## Manual verification checklist

1. Start fenced launcher mode and open PI.
2. Attempt direct write to `launcher/**`, `apply/**`, and active config
   files; verify writes are blocked.
3. Run `/show-fence-config`; verify output appears verbatim.
4. Run `/configure-fence` and create one request.
5. Accept apply; verify PI restarts and config changed.
6. Repeat and reject; verify PI restarts with unchanged target.
7. Create multi-request conflict in `/tmp/pi-fenced/control`; verify
   cleanup warning and automatic restart.
8. Start unlocked mode with `--allow-self-modify`; verify intentional
   maintenance edits are allowed.
