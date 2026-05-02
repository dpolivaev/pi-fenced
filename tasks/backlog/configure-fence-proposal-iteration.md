# Task: `/configure-fence` proposal iteration via prefilled follow-up command
- **Task Identifier:** 2026-05-02-configure-fence-proposal-iteration
- **Status:** in-progress
- **Scope:**
  Improve `/configure-fence` rejection UX so users can continue with full
  control by editing a prefilled next command, instead of losing context
  after pressing “No”.
- **Motivation:**
  Current flow is single-shot: rejecting a proposal ends the command and
  requires manually reconstructing context.
- **Scenario:**
  User runs `/configure-fence ...`, sees proposal preview, presses “No”,
  then receives a prefilled command containing the original request and
  prior proposal context. User edits `user_feedback` and re-runs.
- **Constraints:**
  - Keep global-only target behavior unchanged.
  - Keep external apply contract unchanged (replace-only request file).
  - Keep deterministic prompt + structured tool contract.
  - No direct write to active Fence config; proposal/request artifacts
    remain under `/tmp/pi-fenced`.
- **Briefing:**
  Current handler in `index.ts` returns immediately when
  `allowChange === false` with message `/configure-fence cancelled by user`.
  Replace this with a prefill handoff.
- **Design decision (v1, final):**
  1. On proposal rejection, do not regenerate in-place.
  2. Prefill editor with a follow-up command template using consistent
     underscore keys:
     ```text
     /configure-fence original_request: <...>; proposal_1: <...>; user_feedback: <edit_this>
     ```
  3. On later rejections of subsequent runs, increment proposal key:
     - `proposal_2`, `proposal_3`, ...
  4. Keep proposal payload concise (short proposal description / effect),
     not full JSON diff.
  5. Keep acceptance path unchanged (write artifacts, optional shutdown).
- **Out of scope for v1:**
  - In-command multi-iteration regeneration loop.
  - Freeform conversational back-and-forth inside one command execution.
- **Test specification:**
  - **Automated tests:**
    - rejection pre-fills editor with command using
      `original_request`, `proposal_1`, `user_feedback`;
    - second-run rejection uses incremented key (`proposal_2`) when prior
      proposal context is present in request text;
    - acceptance path remains unchanged.
  - **Manual tests:**
    - run `/configure-fence`, reject proposal, confirm prefilled command
      appears, edit `user_feedback`, re-run, and validate improved
      proposal flow.
