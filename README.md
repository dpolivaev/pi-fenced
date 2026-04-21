# pi-fenced

Fence-first PI runtime with externalized configuration apply.

## Current status

This repository currently includes:

- architecture/design document: `design.md`
- initial `/configure-fence` extension scaffold:
  - `index.ts`
  - `configure-fence.ts`
  - `tests/configure-fence.test.ts`
  - `package.json`
  - `tsconfig.json`
- implementation plan with subtasks:
  `tasks/in-progress/fence-first-runtime-and-external-apply-workflow.md`

Launcher (`pi-fenced`) and external applier (`pi-fenced-apply`) are
planned but not implemented yet.

## Core model

- PI always runs inside Fence started by a launcher pi-fenced.
- Active config precedence is strict and non-merged:
  `session > workspace > global`.
- Active scope config files must not use top-level `extends`.
- `/configure-fence` creates proposal/request artifacts under
  `/tmp/pi-fenced` and hands off to the launcher starting an external apply flow.
- Extension runtime guard requires both `FENCE_SANDBOX=1` and
  `PI_FENCED_LAUNCHER=1` (set by `pi-fenced.sh`) for active mode;
  otherwise it self-disables functional behavior and reports inactive
  status.

## Key paths

- Proposal files: `/tmp/pi-fenced/proposals/<id>.json`
- Request files: `/tmp/pi-fenced/control/request-<id>.json`
- Session config: `/tmp/pi-fenced/sessions/<session-id>/fence.json`
- Workspace config: `<workspace>/fence.json`
- Global config: `~/.config/fence/fence.json`

## Next session entry points

1. Review `design.md` for architecture and contracts.
2. Use task file in `tasks/in-progress/` as execution source of truth.
3. Start with launcher + applier subtasks, then integrate restart loop.
