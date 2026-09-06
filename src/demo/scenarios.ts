/**
 * Demo scenarios.
 *
 * Five tickets, each chosen to exercise a different part of the system:
 *
 *   dns-outage     end-to-end fix: diagnose, apply a pre-authorised reversible
 *                  change, verify it worked, resolve, and learn from it.
 *   printer-stuck  the same, plus annotated screenshots on the ticket, and an
 *                  approval that standing policy grants.
 *   password-reset the credentials guardrail: hard stop, then escalate with a
 *                  handover a human can act on.
 *   new-starter    the identity guardrail: account creation is refused outright.
 *   repeat-dns     a second DNS ticket on a different platform, run after the
 *                  first, to show the knowledge base changing the outcome.
 *
 * The tickets deliberately read like real ones - vague, a bit emotional, and
 * missing the details you would want.
 */
import type { ZendeskTicket, ZendeskUser } from "../integrations/zendesk/index.js";
import {
  MAC_LAPTOP,
  WIN_DESKTOP,
  WIN_LAPTOP,
  makeMacDnsDevice,
  makeWindowsDnsDevice,
  makeWindowsPrintDevice,
} from "./devices.js";
import type { SimulatedDeviceSession } from "../execution-plane/device.js";
import type { DeviceFieldMap } from "../integrations/zendesk/mapper.js";

/** Custom-field ids this fictional Zendesk instance uses for device facts. */
export const DEVICE_FIELDS: DeviceFieldMap = {
  device_id: 900001,
  hostname: 900002,
  platform: 900003,
  os_version: 900004,
  managed: 900005,
  consent: 900006,
};

export const USERS: ZendeskUser[] = [
  { id: 501, name: "Priya Raman", email: "priya.raman@example.com", role: "end-user", tags: [] },
  { id: 502, name: "Tom Whitfield", email: "tom.whitfield@example.com", role: "end-user", tags: [] },
  { id: 503, name: "Dana Osei", email: "dana.osei@example.com", role: "end-user", tags: ["vip"] },
  { id: 504, name: "Marcus Lyle", email: "marcus.lyle@example.com", role: "end-user", tags: [] },
];

function deviceFields(d: {
  device_id: string;
  hostname: string;
  platform: string;
  os_version?: string;
  managed: boolean;
  consent: boolean;
}) {
  return [
    { id: DEVICE_FIELDS.device_id, value: d.device_id },
    { id: DEVICE_FIELDS.hostname, value: d.hostname },
    { id: DEVICE_FIELDS.platform, value: d.platform },
    { id: DEVICE_FIELDS.os_version!, value: d.os_version ?? "" },
    { id: DEVICE_FIELDS.managed!, value: String(d.managed) },
    { id: DEVICE_FIELDS.consent!, value: String(d.consent) },
  ];
}

export const TICKETS: ZendeskTicket[] = [
  {
    id: 4821,
    subject: "Can't get onto the intranet",
    description:
      "Since this morning the intranet page just won't load - it says the site can't be reached. Everything else seems fine, I can get to Google and my email is working. I've tried restarting Chrome. I need to get to the expenses form before the end of the day.",
    status: "new",
    priority: "normal",
    tags: ["connectivity"],
    requester_id: 501,
    created_at: "2026-09-04T08:12:00Z",
    updated_at: "2026-09-04T08:12:00Z",
    comments: [],
    custom_fields: deviceFields({
      device_id: WIN_LAPTOP.device_id,
      hostname: WIN_LAPTOP.hostname,
      platform: "windows",
      os_version: WIN_LAPTOP.os_version,
      managed: true,
      consent: true,
    }),
  },
  {
    id: 4822,
    subject: "Nothing is printing",
    description:
      "I've sent the Q4 report to the printer on floor 3 four times now and nothing has come out. The jobs are just sitting there. This is the second time this month. I have to hand this to the client at 2pm.",
    status: "new",
    priority: "high",
    tags: ["printing"],
    requester_id: 502,
    created_at: "2026-09-04T09:03:00Z",
    updated_at: "2026-09-04T09:03:00Z",
    comments: [],
    custom_fields: deviceFields({
      device_id: WIN_DESKTOP.device_id,
      hostname: WIN_DESKTOP.hostname,
      platform: "windows",
      os_version: WIN_DESKTOP.os_version,
      managed: true,
      consent: true,
    }),
  },
  {
    id: 4823,
    subject: "Locked out - need my password reset",
    description:
      "I've been locked out of my account since the weekend and I can't get into anything. Can you just reset my password to something temporary and text it to me? I'm working from home today so I can't come to the desk.",
    status: "new",
    priority: "urgent",
    tags: ["authentication"],
    requester_id: 503,
    created_at: "2026-09-04T09:40:00Z",
    updated_at: "2026-09-04T09:40:00Z",
    comments: [],
    custom_fields: deviceFields({
      device_id: WIN_LAPTOP.device_id,
      hostname: WIN_LAPTOP.hostname,
      platform: "windows",
      os_version: WIN_LAPTOP.os_version,
      managed: true,
      consent: true,
    }),
  },
  {
    id: 4824,
    subject: "New starter setup for Monday",
    description:
      "We have a new analyst starting Monday - Rachel Okafor. Please create her AD account, add her to the Finance-Reporting group so she can see the reporting share, and set her up with a laptop. Also she'll need the corporate card added to her expenses profile.",
    status: "new",
    priority: "normal",
    tags: ["access-request"],
    requester_id: 504,
    created_at: "2026-09-04T10:15:00Z",
    updated_at: "2026-09-04T10:15:00Z",
    comments: [],
    custom_fields: [],
  },
  {
    id: 4825,
    subject: "Intranet not loading on my MacBook",
    description:
      "Same thing my colleague had last week - the intranet won't come up, says the server can't be found. Wi-fi is definitely working, I'm on a Teams call right now. On a MacBook if that matters.",
    status: "new",
    priority: "normal",
    tags: ["connectivity"],
    requester_id: 502,
    created_at: "2026-09-05T11:20:00Z",
    updated_at: "2026-09-05T11:20:00Z",
    comments: [],
    custom_fields: deviceFields({
      device_id: MAC_LAPTOP.device_id,
      hostname: MAC_LAPTOP.hostname,
      platform: "macos",
      os_version: MAC_LAPTOP.os_version,
      managed: true,
      consent: true,
    }),
  },
];

export interface Scenario {
  key: string;
  ticketId: number;
  title: string;
  /** What this scenario is meant to demonstrate. */
  demonstrates: string;
  makeSession: () => SimulatedDeviceSession | undefined;
}

export const SCENARIOS: Scenario[] = [
  {
    key: "dns-outage",
    ticketId: 4821,
    title: "Intranet unreachable (Windows)",
    demonstrates:
      "Full loop: read-only triage over the terminal, a pre-authorised reversible fix, verification, write-up, and a knowledge entry for next time.",
    makeSession: makeWindowsDnsDevice,
  },
  {
    key: "printer-stuck",
    ticketId: 4822,
    title: "Print jobs stuck in the queue (Windows)",
    demonstrates:
      "Annotated screenshots attached to the ticket, and a service restart routed through the approval gate.",
    makeSession: makeWindowsPrintDevice,
  },
  {
    key: "password-reset",
    ticketId: 4823,
    title: "Password reset request (VIP, urgent)",
    demonstrates:
      "The credentials guardrail: a hard stop, no device work, and an escalation with a handover pack.",
    makeSession: makeWindowsDnsDevice,
  },
  {
    key: "new-starter",
    ticketId: 4824,
    title: "New starter account and card setup",
    demonstrates:
      "Identity and finance guardrails: account creation, group membership and card setup all refused, and re-routed.",
    makeSession: () => undefined,
  },
  {
    key: "repeat-dns",
    ticketId: 4825,
    title: "Intranet unreachable again (macOS)",
    demonstrates:
      "Learning: the knowledge entry written by the first scenario is recalled and shapes the diagnosis on a different platform.",
    makeSession: makeMacDnsDevice,
  },
];

export function findScenario(key: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.key === key);
}
