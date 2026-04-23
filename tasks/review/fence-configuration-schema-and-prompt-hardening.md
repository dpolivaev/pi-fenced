# Task: Fence configuration schema and prompt hardening
- **Task Identifier:** 2026-04-23-fence-schema-prompt
- **Scope:**
  Improve `/configure-fence` prompting and validation so the LLM has a
  reliable, explicit model of Fence configuration structure,
  placeholders, and precedence semantics before proposing mutations.
- **Motivation:**
  Fence config structure is non-trivial (extends chains, path/template
  resolution, merge semantics, and many field families). Mutation
  quality requires stronger domain grounding than generic JSON guidance.
- **Scenario:**
  User requests a nuanced Fence policy change. The system provides
  canonical Fence schema and rule semantics in prompt context, generates
  a proposal, validates it, and reports precise errors for repair when
  needed.
- **Constraints:**
  - Must remain global-only for current product scope.
  - Must not reintroduce scope-selection flow in this task.
  - Must preserve replace-only external apply contract.
  - Prompt content must come from versioned project files, not hidden
    ad-hoc strings.
- **Briefing:**
  Current mutation prompt focuses on mutation output shape and general
  JSON validity. It does not yet expose a complete, explicit Fence
  domain model for complex changes.
- **Research:**
  Verified source behavior and schema shape from Fence docs:
  - `../fence/docs/configuration.md` defines extends behavior,
    resolution, and merge semantics (append+dedupe, OR booleans,
    override-wins for enum/string/int, optional boolean inheritance).
  - `../fence/docs/schema/fence.schema.json` defines top-level keys,
    nested field names/types, and `additionalProperties: false` across
    major objects.
  - Current prompt template in
    `prompts/configure-fence/mutation-proposal.prompt.txt` defines
    mutation envelope semantics but does not include complete Fence
    domain semantics.
- **Design:**
  - Add a dedicated, versioned reference prompt file:
    - `prompts/configure-fence/fence-configuration-reference.prompt.txt`
    - includes explicit top-level model, per-section field guide,
      extends/resolution semantics, and merge/precedence behavior.
  - Add a dedicated mutation system prompt template:
    - `prompts/configure-fence/mutation-system.prompt.txt`
    - references `%%FENCE_CONFIGURATION_REFERENCE%%`.
  - Build a stable (deterministic) system prompt string from these
    static files and use it for every mutation call to maximize
    cache-friendliness and reduce heuristic prompt shaping.
  - Keep dynamic request context in user prompt only.
  - Keep global-only flow unchanged; this task only improves mutation
    reasoning context quality.
  - Export builders from `index.ts` for direct prompt-rendering tests.
- **Test specification:**
  - **Automated tests:**
    - mutation system prompt includes Fence reference text,
    - system prompt contains key schema/semantics markers (extends,
      merge, network/filesystem/command/ssh fields),
    - rendered system/user prompts have no unresolved placeholders,
    - system prompt output is deterministic across calls.
  - **Manual tests:**
    - run `/configure-fence` with nuanced requests (extends chain,
      command runtime policy, ssh allowlist/denylist),
    - verify generated proposals reflect canonical Fence field names and
      semantics.
