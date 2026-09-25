# The demo stack

One command stands up the stakeholder demo as five containers that talk over
real HTTP and WebSocket relays:

```bash
cp .env.demo.example .env      # set the two tokens
npm run demo:stack             # docker compose up --build
```

- **Technician console** → http://localhost:3110
- **User portal** → http://localhost:3111
- **MeshCentral lab** → https://localhost:20443

The console's **Options & settings** page can attach an Anthropic, OpenAI or
Gemini key to the running AIT container for live model-backed reasoning. Keys entered in
the browser are runtime-only and are cleared when that container is recreated;
use environment variables or Docker secrets when persistence is required.

Stop it with `npm run demo:stack:down`.

The browser verifier uses those same defaults. If you remap either host port,
set `AIT_DEMO_URL` and `AIT_DEMO_PORTAL_URL` before running
`npm run verify:demo`.

## What is in it

```text
  ┌──────────────┐  ticket, diagnosis, guardrails, approvals, pulse
  │     ait      │
  └──┬────────┬──┘
     │        │ approved desktop action
     │        │ gateway token
     │        ▼
     │  ┌───────────────┐
     │  │   openclaw    │  checks the governed authority, then forwards
     │  └───────┬───────┘
     │          │ bridge token
     │          ▼
     │  ┌────────────────────────────────────────────┐
     │  │             desktop-bridge                 │
     │  │   UI-TARS Desktop RPC contract + a shell   │
     │  └────────────────────────────────────────────┘
     │
     │ live MeshCentral control + terminal relay
     ▼
  ┌───────────────┐       enrolled agent       ┌─────────────────┐
  │  meshcentral  │◀──────────────────────────▶│  mesh-endpoint  │
  └───────────────┘                            └─────────────────┘
```

The desktop bridge is the stateful *simulated graphical machine*: the fix goes
in through the governed desktop path and is read back through its separate
shell. Alongside it, the MeshCentral endpoint is a real agent and terminal
relay on an isolated Linux container. The two demonstrations stay visibly
distinct so a simulated click is never presented as control of a real desktop.

Two separate credentials, on purpose. AIT presents one to the gateway; the
gateway presents another to the bridge. Holding either must not get you the
other, and `tests/sim-stack.test.ts` checks it.

## Why containers rather than an in-process simulation

AIT already ships a simulation that runs in one process, and it is enough to
show the workflow. What it cannot show is anything that happens at a boundary:
a token that is wrong, a bridge that is down, a 404 on the wrong path, a
timeout halfway through an action, a gateway that refuses a request before it
reaches a desktop. None of those happen to a function call, and all of them
happen in front of an audience.

So the stack runs the real wire protocols over real sockets. The Operations
card's `LIVE` is then earned: something answered.

## What this is not

It is a simulation, and every part of it says so rather than relying on this
file being read:

| Piece | What is real | What is simulated |
|---|---|---|
| AIT | everything: guardrails, approvals, audit, evidence, pulse | — |
| Transport | HTTP, both tokens, both path dialects, status codes, timeouts | — |
| OpenClaw gateway | route contract, authority **shape** validation, refusal before forwarding | signature verification: nothing signs the token |
| UI-TARS bridge | RPC contract, capability descriptors, action receipts | the desktop: no screen is driven, no input is injected |
| MeshCentral | official server, login-token auth, control channel, relay and a real enrolled Linux agent | the target is a disposable container, not a person's workstation |
| MDM / mobile | — | entirely: there is no MDM connector yet |

The bridge reports its provider as `simulated-ui-tars-desktop`, never
`ui-tars-desktop`. The gateway attaches a note to every capabilities response
saying the authority was shape-checked and not signature-verified. Both strings
reach the console, so a stakeholder reading the screen is told what they are
looking at without anyone having to remember to say it.

## Desktop authority

AIT does not mint desktop authority; the token is short-lived and run-scoped
and belongs to whatever knows if this run is still current. There are three
states, set by environment:

| Setting | Behaviour |
|---|---|
| `AIT_DESKTOP_AUTHORITY_URL` (+ `_TOKEN`) | ask that issuer, once per action |
| `AIT_SIMULATED_DESKTOP_AUTHORITY=1` | mint an obviously-labelled simulation grant |
| neither | no desktop control; the session says why |

The simulated grant fills every governed field so the real validation path is
exercised, and its token begins `simulated-` so a receipt on a ticket cannot be
read as evidence that a real authority issued it. It is opt-in for that reason.

## Running the pieces without Docker

```bash
# three terminals, or use the compose file
AILLIUM_DESKTOP_BRIDGE_TOKEN=bridge-tok npm run sim:bridge
OPENCLAW_BRIDGE_RUNTIME_TOKEN=gw-tok \
  AILLIUM_DESKTOP_BRIDGE_URL=http://127.0.0.1:47891 \
  AILLIUM_DESKTOP_BRIDGE_TOKEN=bridge-tok npm run sim:gateway
OPENCLAW_BRIDGE_URL=http://127.0.0.1:18789 \
  OPENCLAW_BRIDGE_RUNTIME_TOKEN=gw-tok \
  AILLIUM_DESKTOP_BRIDGE_URL=http://127.0.0.1:47891 \
  AILLIUM_DESKTOP_BRIDGE_TOKEN=bridge-tok \
  AIT_SIMULATED_DESKTOP_AUTHORITY=1 npm run serve
```

Then in the console: **Type one now** → *"Wi-Fi is switched off and I cannot
turn it back on"* → target **Simulated host over the demo stack** → Run →
approve the desktop action. The run resolves only because the terminal
re-check, over a different channel, reports the interface connected.

## Pointing it at the real thing

Replace a simulated service with the real one by pointing AIT at it; nothing
else changes.

```bash
# the alternative project's gateway, whichever prefix it serves
OPENCLAW_BRIDGE_URL=https://openclaw.internal
OPENCLAW_BRIDGE_RUNTIME_TOKEN=...
# optional: skip discovery if you already know
OPENCLAW_BRIDGE_DIALECT=aillium
```

AIT discovers whether a gateway serves `/api/desktop/*` or
`/api/aillium/desktop/*` with a read-only probe and then holds the answer. An
action is never replayed against a second path: a gateway that accepted a
request and then failed downstream may already have moved the user's mouse.

Plain `http://` is accepted only for a loopback gateway. Anything else must be
HTTPS.

The Compose stack makes one narrow exception: it opts into HTTP for the
single-label `openclaw` service name on its private Docker network. The flag
does not permit dotted remote hosts, which continue to require HTTPS.

## What is still missing for a genuinely live demo

The code path is complete; these are deployment dependencies, not gaps in the
repository:

1. A desktop authority issuer, and the EdDSA keypair it signs with — private
   key to the issuer, public key to UI-TARS Desktop.
2. UI-TARS Desktop installed on a Mac, with Screen Recording and Accessibility
   granted.
3. A real user workstation enrolled in MeshCentral; the included endpoint is a disposable Linux lab container.
4. An MDM connector — Intune, Jamf or similar. Until one exists, the mobile
   third of AIT Pulse stays simulated and is labelled as such.

Items 1-3 replace a simulated service each. Item 4 is new work.
