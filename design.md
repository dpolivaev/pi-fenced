# pi-fenced Design

## Status

Draft

## Context

This project defines a launcher-first runtime model for PI:

- PI must run through `pi-fenced` launcher.
- Launcher defaults to running PI inside Fence, with an explicit
  `--without-fence` mode for diagnostics.
- Sandbox policy changes are requested from inside PI but applied outside PI.
- Active Fence configuration files are not writable from inside PI when
  running fenced.
- Configuration precedence is strict and non-merged:
  `session > workspace > global`.

This design targets deterministic behavior and a clean privilege boundary.

## Goals

- Require launcher-mediated PI execution (`pi-fenced`) at all times.
- Use Fence as the default enforcement layer for PI tool execution.
- Keep policy mutation outside the PI process.
- Support explicit apply/reject with rollback safety.
- Preserve clear scope semantics for policy selection.

## Non-goals

- No in-process hot mutation of the active Fence config file.
- No config merging across scopes.
- No new Fence config syntax.

## Scope resolution (single scope)

At PI startup, the launcher selects exactly one active config:

1. Session config (if present)
2. Workspace config (if present)
3. Global config (if present)
4. Fence default behavior

Rules:

- Only one scope file is selected at a time.
- The selected file may use Fence inheritance (`extends`), including
  standard templates such as `"code"`.
- No merging happens across scope levels (`session`, `workspace`,
  `global`); any merge behavior comes only from Fence resolving the
  selected file's own extends chain.

## Runtime activation guard

The extension runs in one of three modes.

### 1) Launcher-managed fenced mode

Conditions:

- `PI_FENCED_LAUNCHER=1`
- `FENCE_SANDBOX=1`

Behavior:

- register `/configure-fence` and related functional handlers,
- set status line key `pi-fenced` to indicate managed fenced runtime.

### 2) Launcher-managed unfenced mode

Conditions:

- `PI_FENCED_LAUNCHER=1`
- `FENCE_SANDBOX` is not `1` (launcher `--without-fence` mode)

Behavior:

- register `/configure-fence` and related functional handlers,
- set status line key `pi-fenced` to indicate managed launcher runtime
  without Fence.

### 3) Unmanaged mode (outside launcher)

Condition:

- `PI_FENCED_LAUNCHER` is missing or not `1`

Behavior:

- refuse runtime outside launcher,
- do not register functional command/tool behavior,
- notify user to run PI through `pi-fenced`, then shutdown.

## Architecture

### 1) `pi-fenced` launcher (outside Fence)

Responsibilities:

- Resolve active config by strict precedence.
- Support launcher options:
  - `--fence-monitor` to pass monitor mode to Fence (`-m`),
  - `--without-fence` to run PI without Fence,
  - PI arguments pass-through after `--`.
- Start PI in one of two launcher-controlled modes:

Fenced (default):

```bash
fence [-m] --settings <active-config> -- pi <pi-args>
```

Unfenced (`--without-fence`):

```bash
pi <pi-args>
```

In both modes, set `PI_FENCED_LAUNCHER=1` in PI environment.

- After PI exits, inspect a control directory for config-change requests.
- If a request exists, run external apply workflow.
- Restart PI after apply or reject, preserving launcher mode and PI args.

### 2) PI extension (launcher-managed runtime)

Responsibilities:

- Evaluate launcher guard (`PI_FENCED_LAUNCHER`) on startup.
- Refuse runtime when guard fails (outside launcher).
- Detect fenced vs unfenced launcher mode via `FENCE_SANDBOX`.
- Publish `pi-fenced` status line for fenced/unfenced launcher modes.
- Register `/configure-fence` and related handlers only in
  launcher-managed modes.
- Build a proposal file and a request envelope in `/tmp/pi-fenced/...`.
- Never write active config files directly.
- Trigger graceful shutdown so the launcher can handle the request.

### 3) `pi-fenced-apply` (outside Fence)

Responsibilities:

- Read the request/proposal.
- Validate request integrity and base hash.
- Show a human-readable unified diff and request user approval.
- Apply or reject.
- On apply: backup + atomic replace + validation + restart handoff.
- On failure: rollback from backup.

## Files and directories

All ephemeral control files live under `/tmp/pi-fenced/`:

- `/tmp/pi-fenced/control/request-<id>.json`
- `/tmp/pi-fenced/proposals/<id>.json`
- `/tmp/pi-fenced/backups/<id>/...`

Scope targets:

- Session: `/tmp/pi-fenced/sessions/<session-id>/fence.json`
- Workspace: `<workspace>/fence.json`
- Global: `~/.config/fence/fence.json`

## Request envelope (v1)

```json
{
  "version": 1,
  "requestId": "uuid",
  "createdAt": "ISO-8601",
  "scope": "session|workspace|global",
  "targetPath": "absolute-path",
  "proposalPath": "absolute-path",
  "mutationType": "replace",
  "baseSha256": "hex",
  "requestedBy": "pi-fenced-extension",
  "summary": "human readable summary"
}
```

Notes:

- `mutationType` remains `replace` for deterministic atomic updates.
  Proposal content is stored as full file content, not as JSON Patch.
- `baseSha256` protects against stale apply.

## Apply flow

1. Read request envelope.
2. Verify `targetPath` matches allowed path for scope.
3. Verify `baseSha256` against current target file (or empty baseline).
4. Validate proposal with Fence tooling (including template extends
   resolution):

```bash
fence config show --settings <proposalPath>
```

5. Show unified diff (`current -> proposal`) and prompt:
   - Apply
   - Reject
6. If Apply:
   - create backup,
   - write temp file,
   - atomic rename to target,
   - re-validate target,
   - mark request complete.
7. If Reject:
   - mark request rejected, keep target unchanged.
8. On any apply failure:
   - rollback backup,
   - mark request failed.

## Security model

- Inside fenced PI:
  - deny write for workspace/global active config paths.
  - allow write only to `/tmp/pi-fenced/**` for requests/proposals.
- Extension runtime guard:
  - outside launcher-managed runtime, extension refuses startup and
    requests shutdown.
- Outside Fence:
  - only launcher/applier has permission to mutate active configs.
- Unfenced launcher mode:
  - intentionally bypasses sandboxing for diagnostics,
  - keeps launcher ownership and external apply boundaries.
- Supervisor executes with user-level privileges only (no sudo).

## Failure handling

- Stale base hash: reject with message; ask user to regenerate proposal.
- Invalid proposal config: reject with validation output.
- Crash during apply: recover from backup on next startup.
- Missing request/proposal file: ignore and continue normal startup.

## Implementation milestones

1. Scaffold `pi-fenced` launcher CLI with PI arg pass-through.
2. Add strict scope resolver (`session > workspace > global`).
3. Add launcher mode flags (`--fence-monitor`, `--without-fence`).
4. Add external `pi-fenced-apply` command with backup/rollback.
5. Build PI extension launcher-guard + request/proposal flow.
6. Add end-to-end tests for apply/reject/rollback/restart paths.
7. Add docs and operational runbook.

## Open questions

- Should session scope be opt-in or always available?
- How long should completed requests be retained in `/tmp/pi-fenced`?
- Should launcher support non-interactive apply modes for CI?
