# Integration readiness

This file records what was actually inspected for the stakeholder proof of
concept. It distinguishes code being present from a service being connected.

## Audit result

| Component | In this repository? | Verified here | Current demo state |
|---|---:|---|---|
| AIT control/reasoning/execution layers | Yes | Typecheck, build, unit and end-to-end runs | Operable |
| MeshCentral server source | No | The AIT WebSocket adapter is tested against a protocol-faithful local server | Adapter ready; live server not configured |
| UI-TARS Desktop source | No | A curated sibling checkout was inspected; its `/invoke` contract matches AIT's client and session wrapper | Stateful simulation ready; live app not running |
| Curated OpenClaw source | No | An alternative project checkout was inspected; its desktop routes and authority schema match AIT's client | Client ready; gateway not configured/running |
| Zendesk | Adapter only | In-memory and HTTP clients share the same mapping/write-back path | Simulated unless credentials are set |

The open-source projects are therefore **not vendored into this Git repository**.
That is intentional: duplicating their source here would make ownership and
security updates ambiguous. AIT contains the adapters and contracts; the
curated projects remain independently deployable services.

On the audit host, the alternative project checkouts were at these revisions:

- OpenClaw `694c96a9cdf` (`2026.3.14`, governed runtime protocol v3)
- UI-TARS Desktop `9029924d` (governed desktop cancellation)
- UI-TARS executor `343980d` (fenced worker cancellation)

The generic public OpenClaw line has moved to a newer wire protocol. AIT does
not install the generic OpenClaw or UI-TARS npm packages because doing so would
bypass the curated authority, fencing and cancellation work. It integrates
through the curated HTTP boundary instead.

## How the pieces meet

```text
ticket / proactive pulse
          |
          v
AIT reasoning -> deterministic policy -> technician approval
          |                                |
          | read-only / shell              | approved UI action
          v                                v
MeshCentral DeviceSession          curated OpenClaw gateway
                                           |
                                  scoped token + execution
                                  context + fence generation
                                           |
                                           v
                                    UI-TARS Desktop RPC
                                           |
                                           v
                                  terminal re-check in AIT
```

`OpenClawControlledSession` composes a normal AIT `DeviceSession` with the
curated desktop bridge. Terminal diagnostics and verification can therefore
come from MeshCentral while the approved desktop action goes through OpenClaw
to UI-TARS. Its authority callback must be supplied by the durable runtime; AIT
does not mint a token or invent a fence number.

The prepared `wifi-disabled` scenario exercises that whole orchestration shape
without claiming a real device is attached:

1. capture the rendered Windows Settings state;
2. run `netsh interface show interface` and observe `Disabled`;
3. pause at `approve.ui-action`;
4. after a named technician approves, invoke
   `computer.execute_instruction` against the stateful simulated desktop;
5. retain the provider receipt as JSON evidence; and
6. re-run `netsh` and resolve only after it reports `Connected`.

## Live configuration

### MeshCentral

```bash
export MESHCENTRAL_URL=https://mesh.example.internal
export MESHCENTRAL_TOKEN=...
export MESHCENTRAL_MESH_ID=mesh/domain/id
export MESHCENTRAL_DEVICE_ID=node/domain/id
export MESHCENTRAL_DEVICE_NAME=LON-LT-2211
export MESHCENTRAL_DEVICE_PLATFORM=windows
```

Private certificate authorities stay enabled through Node's normal trust path:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/internal-ca.pem
```

### Curated OpenClaw and UI-TARS Desktop

OpenClaw must be configured with its own UI-TARS Desktop bridge URL and desktop
authority verification settings. AIT needs only the governed gateway boundary:

```bash
export OPENCLAW_BRIDGE_URL=http://127.0.0.1:18789
export OPENCLAW_BRIDGE_RUNTIME_TOKEN=...
```

AIT rejects non-loopback plain HTTP. Use HTTPS for a gateway on another host.
The Operations card's **Probe configured bridges** button calls
`/api/desktop/capabilities`; it reports `LIVE` only when OpenClaw
answers and says its UI-TARS RPC bridge is ready.

Executing a live action additionally requires an upstream-issued, short-lived
`desktopControlToken` and all of:

- tenant, authority and work-order identities;
- run, step and desktop-session identities;
- attempt and executor identity;
- unsigned decimal fence token; and
- cancellation generation.

The current standalone demo has no durable authority issuer, so it can probe a
live bridge but will not fabricate the credentials needed to drive it. That is
the remaining deployment dependency, not a hidden mock.

## Stakeholder demo order

1. Start `npm run serve` and show the Operations card's honest states.
2. Choose **Prepared → Wi-Fi switched off in Windows Settings** and the offline
   provider.
3. Run it, inspect the screenshot and diagnostic output, then approve the UI
   action. Point out the approval identity, JSON receipt and successful re-check.
4. Press **Run now** under Proactive pulse. Show endpoint, print-service and
   mobile/MDM results, all explicitly labelled `simulated`.
5. Open a proactive ticket from a finding and watch it enter the same inbox and
   guardrail workflow.
6. Probe integrations. Unconfigured systems stay grey; no adapter is presented
   as live merely because its code exists.

## Verification commands

```bash
npm run typecheck
npm run build
npm test
```

Focused integration coverage lives in:

- `tests/meshcentral.test.ts`
- `tests/openclaw.test.ts`
- `tests/openclaw-session.test.ts`
- `tests/pulse.test.ts`
- `tests/server.test.ts`
- `tests/scenarios.test.ts`
