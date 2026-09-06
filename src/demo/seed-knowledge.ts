/**
 * Seed knowledge base.
 *
 * A brand-new service desk has no history, which makes the "learn from previous
 * tickets" behaviour invisible in a demo. These are two entries a real desk
 * would have accumulated in its first month - neither of them covers the DNS
 * fault in the demo scenarios, so the knowledge base starts genuinely useful
 * without giving the answer away.
 */
import type { KnowledgeStore } from "../knowledge/index.js";

export function seedKnowledge(store: KnowledgeStore): void {
  if (store.size() > 0) return;

  store.add({
    id: "kb_seed_vpn",
    source_ticket_id: "zd-4390",
    title: "VPN disconnects every few minutes on Wi-Fi",
    category: "connectivity",
    platform: "windows",
    symptoms: [
      "VPN keeps dropping",
      "disconnects every few minutes",
      "reconnects on its own then drops again",
    ],
    root_cause:
      "The Wi-Fi adapter's power-saving setting was suspending the radio during idle periods, dropping the tunnel.",
    diagnostic_steps: ["ipconfig /all", "netsh wlan show interfaces"],
    resolution_steps: [
      "Disable power management on the Wi-Fi adapter via the managed device policy",
    ],
    cautions: [],
    times_applied: 3,
    outcome: "resolved",
  });

  store.add({
    id: "kb_seed_mailbox",
    source_ticket_id: "zd-4402",
    title: "Request for access to a colleague's mailbox",
    category: "access-request",
    platform: "any",
    symptoms: [
      "need access to someone else's mailbox",
      "colleague is on leave and I need their email",
    ],
    root_cause:
      "Not a fault. Delegated mailbox access is an authorisation decision, not a technical one.",
    diagnostic_steps: [],
    resolution_steps: [],
    cautions: [
      'Tickets like this tend to run into the "compliance" guardrail.',
      "Previously escalated to service-desk-tier-2 (policy-block, out-of-scope).",
    ],
    times_applied: 2,
    outcome: "escalated",
  });
}
