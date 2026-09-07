# Architecture

## The shape of the problem

An IT technician's job is mostly judgement about *whether to act*, not skill at
acting. Running `ipconfig /flushdns` is trivial; knowing that the evidence
supports it, that it is reversible, that the user consented, and that this is
not actually a request to reset someone's password wearing a disguise — that is
the job.

So the system is split along that line. One half reasons. The other half decides
what reasoning is allowed to become action. They do not share code, and the
second half does not consult the first.

## The planes

### Contracts — `src/contracts/`

Zod schemas for everything that crosses a boundary. Every envelope carries
tenancy, a trace id and a schema version, so the control plane can audit an
object without inferring where it came from.

The important type is `Run` (`src/contracts/run.ts`): one attempt at one ticket,
carrying the evidence rather than a summary of it. The ticket write-up, the user
reply, the escalation handover and the knowledge entry are all *derived* from a
completed run. None of them is written from the model's recollection.

### Control plane — `src/control-plane/`

Owns policy, approvals, audit and escalation.

**`policy/rules.ts`** is the guardrail ruleset, kept as data rather than code so
a service-desk manager can review it without reading TypeScript, and so the
audit log can name the exact rule that fired. Two design decisions:

1. `block` rules are absolute. No confidence threshold, no override flag
   reachable from the agent loop. A human takes over instead.
2. Matching is deliberately broad. A false positive costs one escalation; a
   false negative costs a reset password or a wiped disk. Ambiguous patterns go
   to `require_approval`, never to `allow`.

**`policy/engine.ts`** evaluates in a fixed order:

1. Hard stops, over the *whole* action surface — the stated intent **and** the
   payload. A model that writes `intent: "reset the user's password"` with a
   harmless command trips the credentials rule; one that writes a bland intent
   over `rm -rf /` trips it from the payload side.
2. Device posture: no device, no consent, or an unmanaged device.
3. Approval rules, catching mutating-but-legitimate work.
4. The read-only allowlist — the only route to an automatic `allow`.
5. Deny by default.

Pipelines are split and every segment checked independently, because a pipeline
is only as safe as its most dangerous segment. Command substitution is held
rather than allowed, since a command that builds another command cannot be
reviewed ahead of time.

The normalisation step (`normalise`) collapses the cheapest evasions — padding,
`pass"w"ord`, case. It is defence in depth, not a shell parser. The real
guarantee is step 5: an evasion that beats the patterns still lands in
"unrecognised", which goes to a human.

**`approvals.ts`** is an interface with three implementations, so the same loop
runs unattended, under standing policy, or with a technician at a console. A
gate can never turn a `block` into an approval — it is only ever consulted for
`require_approval` verdicts.

**`escalation.ts`** decides when to fetch a human. The model can *ask* to
escalate; it cannot decline to. Triggers are evaluated over the finished run:
policy blocks, work stuck at the approval gate, low confidence, repeated
failure, out-of-scope requests, user impact, hands-on needs, budget exhaustion,
and — unconditionally, even mid-fix — the user asking for a person.

Escalation produces a **handover pack** so the human does not re-run the whole
investigation: what we know, what we tried, what we could not do, what to do
next.

**`audit.ts`** is append-only. No update, no delete; a correction is a new
entry. Every policy decision, approval, execution and evidence capture is
recorded with its reason.

### Reasoning — `src/agent/`

`Brain` (`brain.ts`) is a four-method interface: `intake`, `diagnose`,
`propose`, `document`. Three implementations satisfy it, and the loop cannot
tell them apart:

- **`claude-brain.ts`** — Claude Opus 5. Adaptive thinking, structured outputs
  via `messages.parse`, frozen system prefix for prompt caching.
- **`openai-brain.ts`** — OpenAI Responses API with strict structured outputs.
- **`heuristic-brain.ts`** — deterministic playbooks, no network. Exists so the
  demo and CI run without credentials, and so the guardrail tests exercise the
  real loop rather than a mocked one.

`schemas.ts` holds the wire shapes both providers fill in. They are *not* the
contract types: no defaults (a default silently substitutes for a missing
answer), no optionals (OpenAI strict mode requires every property), and no step
ids (minted on our side so a model cannot collide or reuse one). `toPlanStep`
drops anything the model invented outside the schema rather than passing it to
the executor.

`prompts.ts` states the hard limits to the model as *context*, so it does not
waste turns proposing work that will be refused. The prompt is not the
enforcement mechanism and must never become it.

### Execution plane — `src/execution-plane/`

`DeviceSession` is the "hands": requested, consented to, used, ended, and
attributable throughout. Three implementations — simulated, local, and
MeshCentral. Sessions are deliberately dumb: the control plane decides, the
session performs.

Every session reports its own `capabilities()` rather than having them assumed
from its platform. A stripped container has no `ping`; a headless host has no
display. Proposing `dig` on a machine without `dig` wastes a step and produces a
failure that looks like a fault, so the brain is told what is actually there.

A `ScreenCapture` carries either real pixels (`source: "screen-capture"`, base64
PNG) or a frame rendered from known state (`source: "rendered"`, SVG). The
distinction is stamped onto the annotated image itself, because a technician
reading a ticket must be able to tell whether they are looking at the user's
screen or a diagram of it.

`remote.ts` implements MeshCentral properly rather than describing it. The
server offers no request/response API for running a command — it offers an
interactive relay, so the client drives it the way a person would: open
`control.ashx`, fetch the browser and agent cookies, ask the agent to dial into
a relay id you invent, join the same relay, wait for `c`/`cr`, select protocol 1.
From there it is a terminal, and a terminal has no end-of-output marker, so
`exec` appends a sentinel echo and reads until the *expanded* form of it appears
— not the echoed one, which arrives before the command has run at all. Commands
are serialised through one shell: a terminal has one cursor, and two concurrent
commands would interleave into output neither could be trusted from.

`LocalDeviceSession` spawns with `shell: false` and an argv array, so a command
*cannot* grow a second command through `;` or `&&`. The policy engine already
splits pipelines; a runner that cannot express one is a better second line than
one that can and promises not to.

`executor.ts` performs one cleared step and returns one `StepResult`. It refuses
any step whose verdict is not `allow` — belt-and-braces against a future caller
that forgets to check — and records failures honestly. Nothing smooths over a
non-zero exit code, because the write-up depends on the results being true.

`annotate.ts` renders a technician's marks — a box round the fault, an arrow to
the button, a caption — as SVG over the capture. SVG rather than raster because
it composes without an image library, stays legible when Zendesk scales it, and
keeps the annotation text selectable and searchable inside the ticket.

`evidence-store.ts` content-addresses everything: the sha256 in the
`ArtifactRef` means a screenshot attached to a ticket can be checked against the
audit entry claiming to have produced it.

### Knowledge — `src/knowledge/`

An entry is written when a run settles, and read at the start of the next one.
That loop is the entire "learn from previous jobs" requirement, built from
retrieval rather than fine-tuning: a technician can read an entry, correct it or
delete it, and the change takes effect on the very next ticket.

Retrieval is BM25, chosen over embeddings for three reasons at service-desk
scale: no model call on the hot path, explainable (you can see which words
matched — which a technician reviewing a bad suggestion will ask for), and IT
tickets are full of high-signal rare tokens (`0x80070005`, `outlook.exe`) that
lexical search handles well.

Two refinements earn their place. The stoplist is longer than a standard English
one because service-desk prose has its own filler — "need", "working", "tried",
"else" — and those words are what make a small knowledge base return a mailbox
ticket for a DNS fault. And a **coverage gate** requires a hit to touch a real
share of an entry's own headline terms, not just score well: a confidently wrong
prior ticket sends the whole diagnosis down the wrong path, so precision matters
more than recall here.

Entries are recorded from evidence: the diagnostic steps are the commands that
actually ran and succeeded, the resolution steps are the mutating ones that were
actually approved and carried out. A run where everything was *refused* still
produces an entry — knowing that a class of ticket always needs a human is worth
remembering.

### Integrations — `src/integrations/zendesk/`

Everything help-desk-specific is confined here. The agent never sees a Zendesk
id, status or custom field — it sees a `Ticket`. Adding a second help desk means
adding a sibling to `mapper.ts`, nothing more.

`ZendeskClient` is an interface with an HTTP implementation and an in-memory
one, so a demo run and a live run take the same code path through the agent.

### Console — `src/server/`

The batch console could await a run and render the result. A technician cannot:
the whole point of the approval gate is that a person is asked *mid-run*, so the
run has to be observable while it is still going and interruptible by a decision
arriving from outside it.

So `run-registry.ts` turns a run into a small state machine. Events accumulate
and fan out to whoever is watching over SSE, and a pending approval is a promise
held open until someone in a browser resolves it. Two details carry weight:

- **The timeout denies.** If nobody answers, the safe default is no.
- **Finishing a run answers everything outstanding.** A finished run must not
  leave a promise dangling that could later act on a device.

Replay is by history alone. A browser connecting mid-run receives every event so
far; an approval still pending is simply one with no `approval-resolved` after
it. Re-announcing pending approvals separately would render the same card twice
and let a technician answer it twice.

Evidence is served from a path taken off the request, so it is resolved and
confined to the evidence directory. A console that hands back any path it is
given is a file-disclosure bug with a nice UI on top.

## The loop

`src/agent/loop.ts`, read top to bottom, is the whole product:

1. **Intake** — understand the request.
2. **Recall** — retrieve similar resolved tickets.
3. **Diagnose** — ranked hypotheses with stated confidence.
4. **Propose → gate → execute → observe**, until resolved, out of ideas, or out
   of budget. Every proposed step is evaluated; gated ones go to the approval
   gate; only cleared ones reach the executor.
5. **Escalate** — assessed over the finished run.
6. **Document** — from the evidence.
7. **Write back** — internal note, public reply, attachments.
8. **Learn** — record the entry.

Two behaviours in the loop are worth calling out:

**An out-of-scope request is never investigated.** Running diagnostics on a
machine to answer an HR question would be an intrusion, not a service.

**A hard block halts execution but not evaluation.** The remaining proposals in
the batch are still evaluated and recorded, so the technician picking the ticket
up gets the full list of what was refused rather than only the first thing. No
device work happens after the halt.

## Extending it

- **A new guardrail** — add a rule to `BLOCKING_RULES` or `APPROVAL_RULES` and a
  case to `tests/policy.test.ts`. Nothing else changes.
- **A new help desk** — implement `ZendeskClient`'s shape and a mapper.
- **A new device backend** — implement `DeviceSession`.
- **A new reasoning provider** — implement `Brain` and add it to `selectBrain`.
  The guardrails apply unchanged, which is the point.
- **A new local diagnostic** — add a `LocalCheck` in `local-playbooks.ts` with
  the tool it needs and an interpreter for its output. It will be proposed only
  on hosts that actually have that tool.
