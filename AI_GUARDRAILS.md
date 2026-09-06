# AI development guardrails

Rules for automated agents and AI tools working on this repository. Violations
are defects, not style disagreements.

## Do not weaken the control plane

- **Never move policy enforcement into a prompt.** `src/control-plane/policy/`
  is deterministic code that does not call a model. If a change makes any part
  of an allow/block decision depend on model output, it is wrong.
- **Never add an override path from the agent loop to a `block` verdict.** The
  approval gate exists for `require_approval` only.
- **Never widen `READ_ONLY_COMMANDS` to make a demo pass.** Adding a command
  there is a reviewed decision, and it needs a test.
- **Never remove a guardrail test to make a change land.** If a rule is wrong,
  fix the rule and change the test deliberately, with the reasoning stated.

## Do not let the system claim things it did not do

- Documentation, ticket comments and user replies are derived from the run's
  evidence. Do not generate them from a model's recollection of what it did.
- Do not smooth over failures. A non-zero exit code is a failed step.
- Do not fabricate device output. A stub that returns empty output where a real
  session would act makes a run look successful while touching nothing.

## Keep the boundaries

- The reasoning layer never touches the device. It returns proposals.
- Help-desk-specific detail stays in `src/integrations/`.
- Sessions perform; they do not decide.
- Contracts are the only shapes crossing a plane boundary.

## General

- No hardcoded credentials, real hostnames, real phone numbers or real ticket
  data. Use obviously fictional placeholders.
- Add brief comments for non-obvious logic; skip them for the obvious.
- Prefer clarity over cleverness.
- Run `npm test` and `npm run typecheck` before proposing a change.
