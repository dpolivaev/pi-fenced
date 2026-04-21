# pi-fenced Design

## Status

Draft

## Context

This project defines a Fence-first runtime model for PI:

- PI always runs inside Fence.
- Sandbox policy changes are requested from inside PI but applied outside PI.
- Active Fence configuration files are not writable from inside PI.
- Configuration precedence is strict and non-merged:
  `session > workspace > global`.

This design targets deterministic behavior and a clean privilege boundary.

## Goals

- Use Fence as the single enforcement layer for PI tool execution.
- Keep policy mutation outside the fenced PI process.
- Support explicit apply/reject with rollback safety.
- Preserve clear scope semantics for policy selection.

## Non-goals

- No in-process hot mutation of the active Fence config file.
- No config merging across scopes.
- No new Fence config syntax.

## Scope resolution (no merge)

At PI startup, the launcher selects exactly one active config:

1. Session config (if present)
2. Workspace config (if present)
3. Global config (if present)
4. Fence default behavior

Rules:

- Only one config is active at a time.
- No `extends` usage in active scope files.
- If `extends` is found in an active-scope file, fail fast with guidance.

## Runtime activation guard

The extension runs in one of two modes.

Active mode (full feature registration) requires both conditions:

- `FENCE_SANDBOX=1` (set by Fence runtime)
- `PI_FENCED_LAUNCHER=1` (set by `pi-fenced.sh` launcher)

When active mode is satisfied, the extension:

- registers `/configure-fence` and related functional handlers,
- sets status line key `pi-fenced` to indicate managed Fence runtime is
  active.

When either guard condition is missing, the extension enters disabled
mode:

- it does not register functional command/tool behavior,
- it still sets status line key `pi-fenced` to indicate no managed
  Fence runtime is active.

## Architecture

### 1) `pi-fenced` launcher (outside Fence)

Responsibilities:

- Resolve active config by strict precedence.
- Start PI under Fence:

```bash
fence --settings <active-config> -- pi <args>
```

- After PI exits, inspect a control directory for config-change requests.
- If a request exists, run external apply workflow.
- Restart PI after apply or reject.

### 2) PI extension (inside Fence)

Responsibilities:

- Evaluate runtime guard (`FENCE_SANDBOX` +
  `PI_FENCED_LAUNCHER`) on startup.
- Publish `pi-fenced` status line in both active and disabled modes.
- Register `/configure-fence` and related handlers only in active mode.
- Build a proposal file and a request envelope in `/tmp/pi-fenced/...`.
- Never write active config files directly.
- Trigger graceful shutdown so the launcher can handle the request.

### 3) `pi-fenced-apply` (outside Fence)

Responsibilities:

- Read the request/proposal.
- Validate request integrity and base hash.
- Show diff and request user approval.
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

- `mutationType` is `replace` for deterministic atomic updates.
- `baseSha256` protects against stale apply.

## Apply flow

1. Read request envelope.
2. Verify `targetPath` matches allowed path for scope.
3. Verify `baseSha256` against current target file (or empty baseline).
4. Validate proposal with Fence tooling:

```bash
fence config show --settings <proposalPath>
```

5. Show diff (`current -> proposal`) and prompt:
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
  - outside managed runtime, extension self-disables functional
    behavior and shows status that no managed Fence runtime is active.
- Outside Fence:
  - only launcher/applier has permission to mutate active configs.
- Supervisor executes with user-level privileges only (no sudo).

## Failure handling

- Stale base hash: reject with message; ask user to regenerate proposal.
- Invalid proposal config: reject with validation output.
- Crash during apply: recover from backup on next startup.
- Missing request/proposal file: ignore and continue normal startup.

## Implementation milestones

1. Scaffold `pi-fenced` launcher CLI.
2. Add strict scope resolver (`session > workspace > global`).
3. Add external `pi-fenced-apply` command with backup/rollback.
4. Build PI extension request/proposal flow.
5. Add end-to-end tests for apply/reject/rollback paths.
6. Add docs and operational runbook.

## Open questions

- Should session scope be opt-in or always available?
- How long should completed requests be retained in `/tmp/pi-fenced`?
- Should launcher support non-interactive apply modes for CI?
