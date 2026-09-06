# AIT — AI IT Technician

An AI technician that works a service desk queue: it reads the ticket, forms a
diagnosis, proves it with read-only commands, applies a fix when it is allowed
to, documents what it did, and hands over to a human when it should not proceed.

It is built around one idea: **the model proposes, the control plane disposes.**
The reasoning engine can suggest anything at all; a separate, deterministic
policy layer decides what is permitted to touch a user's machine. That layer is
not a prompt, and it does not consult the model.

```bash
npm install
npm run demo          # runs every scenario, no API key needed
npm run serve         # technician console on http://localhost:3000
```

---

## What it does

| Capability | Where it lives |
|---|---|
| Understands the request in the user's own words | `src/agent/prompts.ts`, `Intake` |
| Diagnoses with ranked hypotheses and stated confidence | `src/agent/*-brain.ts` |
| Acts to resolve — terminal commands, screenshots | `src/execution-plane/` |
| Stops at anything out of limits | `src/control-plane/policy/` |
| Documents the issue for technicians and for the user | `Documentation` in `src/contracts/run.ts` |
| Knows when to escalate, and hands over properly | `src/control-plane/escalation.ts` |
| Reads and updates Zendesk tickets | `src/integrations/zendesk/` |
| Attaches annotated screenshots to tickets | `src/execution-plane/annotate.ts` |
| Learns from previous tickets | `src/knowledge/` |

## The guardrails

The brief for this system was that it must stop at anything out of limits. Nine
categories are **hard stops** — not "ask nicely first", not "unless confident",
but refused, with no override reachable from the agent loop:

| Category | Examples |
|---|---|
| `credentials` | Password resets, reading key files, dumping credential vaults |
| `finance` | Payments, invoices, purchasing, payroll, corporate cards |
| `identity` | Creating/deleting accounts, group membership, admin rights |
| `destructive` | `rm -rf /`, formatting, mass deletion, dropping databases |
| `security-controls` | Disabling AV/EDR/firewall/MFA/disk encryption |
| `data-exfiltration` | Bulk-copying a user's data off the device |
| `major-system-change` | OS reinstall, domain join/leave, firmware, boot config |
| `network-infrastructure` | Routers, switches, DNS servers, domain controllers |
| `compliance` | Legal holds, another person's mailbox, regulated data |

Everything else is **deny-by-default**. A command is only run automatically if
it is on the read-only diagnostics allowlist; anything that changes device state
goes to a human, and anything unrecognised goes to a human too.

You can interrogate the guardrails directly, with no model in the loop:

```bash
npm run cli -- check "net user jsmith * /domain"
#   decision  BLOCK
#   rule      block.credentials.password-change
#   category  credentials

npm run cli -- check "ipconfig /all"
#   decision  ALLOW
#   rule      allow.read-only-diagnostic

npm run cli -- check "acme-repair --fix-all"
#   decision  REQUIRE_APPROVAL
#   rule      approve.unknown-command
```

## Reasoning providers

The same technician runs on either provider, with identical prompts, identical
structured outputs and identical guardrails. **The safety properties do not
depend on which model is answering.**

| `AIT_PROVIDER` | Engine | Needs |
|---|---|---|
| `claude` | Claude Opus 5, adaptive thinking, structured outputs | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI Responses API, strict structured outputs | `OPENAI_API_KEY` |
| `offline` | Deterministic playbook engine | nothing |
| `auto` *(default)* | First of the above that is configured | — |

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY=sk-...
npm run demo
```

With no key, `auto` falls back to the offline engine so the demo always runs.
That fallback is reported loudly in the CLI, the API response and the console —
a run answered by playbooks is a materially different thing from one answered by
a frontier model, and you should never have to guess which you got.

Models are overridable: `ANTHROPIC_MODEL`, `OPENAI_MODEL`.

## The demo

Five scenarios, each exercising a different part of the system:

```bash
npm run demo                    # all five
npm run demo -- dns-outage      # just one
npm run cli -- scenarios        # list them
```

| Scenario | What it shows |
|---|---|
| `dns-outage` | Full loop: triage over the terminal, a pre-authorised reversible fix, verification, write-up, knowledge entry |
| `printer-stuck` | Annotated screenshots on the ticket; a service restart through the approval gate |
| `password-reset` | The credentials guardrail: hard stop, no device work, escalation with a handover pack |
| `new-starter` | Identity **and** finance guardrails; every refused request reported, not just the first |
| `repeat-dns` | Learning: the entry written by `dns-outage` is recalled and shapes the diagnosis on a different platform |

The simulated devices have real mutable state. The agent has to read the command
output, notice the fault, apply the right fix and re-check — if it applies the
wrong fix, verification fails, exactly as it would on a real machine.

Evidence is written to `./run-artifacts/<run-id>/`: raw command output and
annotated SVG screenshots, each content-addressed by sha256.

## Architecture

Three planes, borrowed from the platform this reimagines, with the boundaries
kept sharp:

```
  Ticket (Zendesk)
        │
        ▼
  ┌───────────────────────────────────────────────┐
  │ CONTROL PLANE            src/control-plane/   │
  │   policy engine · approval gate               │
  │   append-only audit · escalation rules        │
  └───────────────────────────────────────────────┘
        │  proposes            │ clears
        ▼                      ▼
  ┌──────────────────┐   ┌──────────────────────────┐
  │ REASONING        │   │ EXECUTION PLANE          │
  │ src/agent/       │   │ src/execution-plane/     │
  │  Claude │ OpenAI │   │  terminal · screenshots  │
  │  │ offline       │   │  annotation · device     │
  └──────────────────┘   └──────────────────────────┘
        │                      │
        └──────────┬───────────┘
                   ▼
      ┌────────────────────────────┐
      │ KNOWLEDGE   src/knowledge/ │
      │  retrieval · learning      │
      └────────────────────────────┘
```

The invariant that matters: **the reasoning layer never touches the device.**
It returns proposals; `src/agent/loop.ts` evaluates every one against policy,
routes the gated ones to a human, and only then hands a cleared step to the
executor. There is no branch that skips the gate.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the detail, and
[SECURITY.md](SECURITY.md) for the trust model.

## Connecting real systems

Everything runs against simulated backends out of the box. To point it at real
ones:

```bash
# Zendesk
ZENDESK_SUBDOMAIN=acme
ZENDESK_EMAIL=svc-ait@acme.com
ZENDESK_API_TOKEN=...

# MeshCentral (remote device sessions)
MESHCENTRAL_URL=https://mesh.acme.internal
MESHCENTRAL_TOKEN=...
MESHCENTRAL_MESH_ID=...
```

`HttpZendeskClient` is complete and talks to the Zendesk Support API v2.
`MeshCentralSession` implements the boundary but not the relay transport — it
throws a clear error rather than silently returning empty output, because a run
that looks successful while touching nothing is the failure this codebase is
arranged to prevent.

## Development

```bash
npm test          # 127 tests
npm run typecheck
npm run build
```

The test suite leans hard on `tests/policy.test.ts` — 53 cases written as "what
a user or an over-eager model would actually try". Those are the most important
tests here; everything else is a convenience by comparison.
