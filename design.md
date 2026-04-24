# pi-fenced Design

## Status

Implemented (v1, global scope only).

Finished tasks reflected here:

- `tasks/done/fence-first-runtime-and-external-apply-workflow.md`
- `tasks/done/fence-configuration-schema-and-prompt-hardening.md`

Deferred work:

- `tasks/backlog/multi-scope-configuration-chain-and-policy-reconciliation.md`

## Context

`pi-fenced` enforces a launcher-first runtime model for PI and keeps
Fence policy mutation outside the in-session PI process.

Current implemented scope is **global config only**. Session/workspace
selection and chain reconciliation are explicitly deferred.

## Goals (v1)

- Require launcher-managed runtime for extension functionality.
- Run PI fenced by default.
- Keep active policy mutation outside the PI session.
- Provide explicit human apply/reject decisions.
- Protect control-plane artifacts and active config files from direct
  in-session writes by default.
- Ground `/configure-fence` mutation generation in a canonical Fence
  domain reference.

## Non-goals (v1)

- Session/workspace scope selection and chain reconciliation.
- In-process mutation of active config files.
- Silent auto-apply of proposed changes.
- New Fence syntax beyond existing Fence schema/semantics.

## Runtime guard and operating modes

The extension is functional only in launcher-managed runtime:

1. **Launcher-managed fenced mode**
   - `PI_FENCED_LAUNCHER=1`
   - `FENCE_SANDBOX=1`
   - Registers `/configure-fence` and `/show-fence-config`
   - Sets status key `pi-fenced` to `🔒 fence`

2. **Launcher-managed unfenced mode (diagnostics/maintenance)**
   - `PI_FENCED_LAUNCHER=1`
   - `FENCE_SANDBOX != 1`
   - Registers the same commands
   - Sets status key `pi-fenced` to `yolo`
   - Launcher requires explicit unlock (`--allow-self-modify`) for
     `--without-fence`

3. **Unmanaged mode**
   - Missing or invalid `PI_FENCED_LAUNCHER`
   - Extension warns and shuts PI down gracefully
   - Functional command behavior is not available

## Architecture

### 1) `pi-fenced` launcher

Responsibilities:

- Parse launcher options:
  - `--fence-monitor`
  - `--without-fence`
  - `--allow-self-modify`
  - PI args pass-through after `--`
- Resolve paths:
  - `agentDir` from `PI_CODING_AGENT_DIR` or `~/.pi/agent`
  - global target `<agentDir>/fence/global.json`
  - Fence base `~/.config/fence/fence.json`
- Bootstrap missing config files:
  - `~/.config/fence/fence.json` with `{"extends":"code"}`
  - `<agentDir>/fence/global.json` with `{"extends":"@base"}`
- Enforce mode policy:
  - refuse `--without-fence` unless `--allow-self-modify` is set
  - warn loudly when unlock mode is active
- In fenced + locked mode, generate a per-run settings overlay:
  - `/tmp/pi-fenced/runtime/launcher-locked-settings.<run-id>.json`
  - overlay extends global config and injects `filesystem.denyWrite`
- Launch PI:
  - fenced default: `fence [-m] --settings <active> -- pi <args>`
  - unfenced unlock: `pi <args>`
  - always inject `PI_FENCED_LAUNCHER=1`
- Restart loop:
  - run PI
  - on PI exit run external apply workflow
  - restart unless apply outcome is `no-request`
- Cleanup:
  - remove this run's lock file on launcher exit
  - best-effort stale lock-file pruning on startup

### 2) PI extension (`index.ts`)

Responsibilities:

- Apply launcher-managed runtime guard.
- Publish runtime status (`🔒 fence` or `yolo`).
- Implement `/configure-fence` (global-only request path).
- Implement `/show-fence-config` for read-only effective config
  inspection.

`/configure-fence` flow:

- Require non-empty request text and selected model.
- Resolve global target path and read existing content.
- Build prompts:
  - deterministic system prompt from versioned template files
  - dynamic user prompt with request + existing content context
- Call structured mutation tool with retry/validation loop.
- If request is non-actionable, return explicit guidance and do not
  write artifacts.
- For valid mutation:
  - accept `write` (full content) or `edit` (exact, unique,
    non-overlapping edits)
  - enforce resulting content is a JSON object
- Ask user confirmation.
- Write proposal and request artifacts under `/tmp/pi-fenced`.
- Optionally shutdown PI for launcher handoff.

`/show-fence-config` flow:

- Run `fence config show --settings <global-target>`.
- Combine stderr+stdout verbatim.
- Render output in a read-only scrollable viewer.

### 3) `pi-fenced-apply` (external applier)

Responsibilities:

- Reject direct invocation; allow only launcher handoff via
  `PI_FENCED_APPLY_CALLER=pi-fenced`.
- Ensure control directories exist.
- Enforce pending-request policy:
  - zero requests -> `no-request`
  - multiple requests -> cleanup all requests + linked proposals
- Parse and validate request envelope.
- Enforce global-only target policy:
  - `scope` must be `global`
  - `targetPath` must match resolved `<agentDir>/fence/global.json`
- Validate proposal through Fence tooling.
- Check `baseSha256` against current target content.
- Show full-replace unified diff and prompt apply/reject.
- Apply path:
  - backup original state
  - atomic replace via temp file + rename
  - post-apply Fence validation
  - rollback on failure
- Cleanup processed request/proposal artifacts.

## Prompting and schema hardening (implemented)

`/configure-fence` mutation planning now uses versioned, file-based
prompt assets:

- `prompts/configure-fence/mutation-system.prompt.txt`
- `prompts/configure-fence/fence-configuration-reference.prompt.txt`
- `prompts/configure-fence/mutation-proposal.prompt.txt`

Design properties:

- Canonical Fence domain model is injected into the mutation system
  prompt (field names, merge semantics, precedence rules).
- System prompt is deterministic and cache-friendly.
- Dynamic request context stays in the user prompt.
- Output contract remains strict structured tool arguments.

## Runtime files and directories

All operational control artifacts live under `/tmp/pi-fenced`:

- requests: `/tmp/pi-fenced/control/request-<id>.json`
- proposals: `/tmp/pi-fenced/proposals/<id>.json`
- backups: `/tmp/pi-fenced/backups/<id>/...`
- lock overlays:
  `/tmp/pi-fenced/runtime/launcher-locked-settings.<run-id>.json`

Global target paths:

- Fence base: `~/.config/fence/fence.json`
- PI global config: `<agentDir>/fence/global.json`

## Request envelope (v1, active)

```json
{
  "version": 1,
  "requestId": "uuid",
  "createdAt": "ISO-8601",
  "scope": "global",
  "targetPath": "absolute-path",
  "proposalPath": "absolute-path",
  "mutationType": "replace",
  "baseSha256": "hex",
  "requestedBy": "pi-fenced-extension",
  "summary": "human readable summary"
}
```

## Self-protection model (default locked mode)

When fenced and not explicitly unlocked, deny-write protection covers:

- full `pi-fenced` package root
- `<agentDir>/fence/global.json` and parent directory
- `~/.config/fence/fence.json` and parent directory

Unlock mode (`--allow-self-modify`) intentionally disables this lock for
that launcher run and is required for `--without-fence` mode.

## Failure and recovery semantics

- Multiple pending requests: conflict cleanup of all pending requests
  and linked proposals.
- Invalid request/proposal: request/proposal cleanup with explicit
  outcome.
- Base hash mismatch: reject and clean request/proposal.
- Apply failure: rollback attempted from backup.
- Unexpected apply workflow exception: launcher warns and continues loop.

## Deferred design (not implemented yet)

The following remains intentionally deferred to backlog:

- session/workspace/global chain model
- contradiction reconciliation policy across scopes
- scope-selection UX/tooling strategy for multi-scope behavior
- transactional semantics for multi-file apply
