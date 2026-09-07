# Security & trust model

## What this system is trusted to do

AIT runs read-only diagnostic commands on a consenting, managed device without
asking, and applies a narrow band of pre-authorised reversible fixes under a
standing policy. That is the whole of its unattended authority.

## What it is not trusted to do

Nine categories are refused outright, with no path to an override from inside
the agent loop:

`credentials` · `finance` · `identity` · `destructive` · `security-controls` ·
`data-exfiltration` · `major-system-change` · `network-infrastructure` ·
`compliance`

A refusal is not a dead end. The run escalates with a handover pack, so a human
with the right authority picks it up with the evidence already gathered.

## Where enforcement lives

**In `src/control-plane/policy/engine.ts`, not in a prompt.**

The system prompt tells the model what is out of bounds, but only so it does not
waste turns proposing work that will be refused. The prompt is context, never
the control. Enforcement is deterministic code that does not call a model, is
covered by 53 tests, and can be interrogated directly:

```bash
npm run cli -- check "net user jsmith * /domain"
```

If a future change moves any part of the decision into the prompt, that is a
security regression regardless of how well it appears to behave.

## Design properties

**Deny by default.** A command runs automatically only if it is on the read-only
allowlist. Unrecognised commands go to a human. Widening the allowlist is a
reviewed decision; nothing widens it at runtime.

**Both sides of the action are checked.** Rules match the stated intent *and*
the payload, so a dangerous intent behind a bland command and a bland intent
over a dangerous command both trip.

**Pipelines are checked segment by segment.** A pipeline is only as safe as its
most dangerous segment. Command substitution and dynamic evaluation
(`$(...)`, `iex`, `eval`) are held rather than allowed, since a command that
builds another command cannot be reviewed in advance.

**The executor re-checks.** It refuses any step whose verdict is not `allow`,
even though the loop should never hand it one. A second check that never fires
is cheap; the absence of one is not.

**The local runner cannot chain.** `LocalDeviceSession` spawns with
`shell: false`, so `;` and `&&` are arguments rather than separators.

**Consent is explicit and is not authority.** A device with no recorded consent
gets no commands at all. Consent that *is* granted is permission to help, not
permission to do anything — hard stops still apply.

**Approval cannot upgrade a block.** The approval gate is consulted only for
`require_approval` verdicts. Granting approval converts that verdict to `allow`
for one step and records who did it.

**The audit log is append-only.** Every policy decision, approval, execution and
artefact is recorded with its reason. `AuditLog.entries()` returns copies, so a
caller cannot rewrite history.

**Evidence is content-addressed.** Every artefact carries a sha256, so an
attachment on a ticket can be checked against the audit entry that produced it.

## Known limits

These are real, and stated plainly rather than left for someone to discover:

- **Pattern matching is not semantic analysis.** The rules catch the phrasings a
  user or a model actually produces, and normalisation collapses the cheapest
  evasions. A determined adversary constructing novel obfuscation may evade a
  specific pattern. The mitigation is structural, not textual: an evasion that
  beats the patterns still lands in "unrecognised command", which goes to a
  human rather than running. Deny-by-default is what carries the weight here,
  not the regexes.

- **Prompt injection via ticket content.** Ticket text is untrusted input and
  reaches the model. A crafted ticket could persuade a model to propose
  something harmful — which is precisely why the guardrails do not consult the
  model. Injection can influence what is *proposed*; it cannot influence what is
  *permitted*.

- **The knowledge base is a trusted store.** Entries are written by the system
  and read back as context. A poisoned entry could mislead a diagnosis. Entries
  are plain JSONL, reviewable and deletable, and they cannot widen policy.

- **Remote sessions run commands through an interactive shell.** `exec` bounds a
  command's output with a sentinel; a command that deliberately printed the
  sentinel followed by digits could misreport its own exit code. It cannot
  escape the policy engine that way — the command still had to be cleared to run
  at all — but treat remote exit codes as reported, not proven.

- **TLS verification is never disabled**, in any code path. MeshCentral installs
  commonly use a private CA; trust it via `NODE_EXTRA_CA_CERTS` rather than
  weakening verification.

- **The console has no authentication.** It is a local operator tool that binds
  a port and exposes run control, approvals and evidence to anyone who can reach
  it. Bind it to loopback, or put an authenticating proxy in front, before it
  goes anywhere shared. Evidence paths are confined to the evidence directory,
  but that is path-traversal defence, not access control.

- **Approvals are held in memory.** A restart drops pending approvals and every
  run's history. That is the right trade for a console you watch while it
  happens, and the wrong one for a durable work queue.

- **The offline brain is not a safety feature.** It is a deterministic stand-in
  for demos and tests. It deliberately proposes what users literally ask for —
  including things that will be blocked — because guardrails that nothing ever
  tests prove nothing.

## Reporting

Security issues in this repository should be raised privately with the
maintainers rather than opened as public issues.
