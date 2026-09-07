/**
 * Tickets typed on the spot.
 *
 * The fixtures make a demo repeatable; this makes it live. Someone in the room
 * describes a problem in their own words, you type it, and the same loop runs -
 * the same guardrails, the same approval gate, the same write-up.
 *
 * There is no hidden matching here. The ticket goes to whichever brain is
 * configured, and if that is the offline playbook engine it will only recognise
 * the families it has playbooks for. Saying "I can't place this, escalating" to
 * an unfamiliar problem is the correct answer, and a better demo moment than a
 * confident guess would be.
 */
import { hostname } from "node:os";
import { newId, nowIso, type Severity, type Ticket } from "../contracts/index.js";
import { LOCAL_TICKET_TAG } from "../agent/heuristic-brain.js";
import { localDevice, hostPlatform } from "./local.js";
import { WIN_LAPTOP, WIN_DESKTOP, MAC_LAPTOP } from "./devices.js";
import type { DeviceInfo } from "../contracts/ticket.js";

/** Which machine an ad-hoc ticket is about. */
export type AdHocTarget =
  | "this-machine"
  | "simulated-windows-laptop"
  | "simulated-windows-desktop"
  | "simulated-mac-laptop"
  | "no-device";

export interface AdHocRequest {
  /** What the user said, in their own words. */
  description: string;
  /** Optional one-line subject; derived from the description when absent. */
  subject?: string;
  requester?: string;
  vip?: boolean;
  priority?: Severity;
  target?: AdHocTarget;
}

export const AD_HOC_TARGETS: { key: AdHocTarget; label: string; note: string }[] = [
  {
    key: "this-machine",
    label: "This machine",
    note: "Real commands against the host you are running on.",
  },
  {
    key: "simulated-windows-laptop",
    label: "Simulated Windows laptop",
    note: "LON-LT-2211, with a stale DNS cache.",
  },
  {
    key: "simulated-windows-desktop",
    label: "Simulated Windows desktop",
    note: "MAN-DT-3480, with a stopped print spooler.",
  },
  {
    key: "simulated-mac-laptop",
    label: "Simulated MacBook",
    note: "LON-MB-1907, with a stale DNS cache.",
  },
  {
    key: "no-device",
    label: "No device attached",
    note: "A request with nothing to run against - access requests, questions.",
  },
];

function deviceFor(target: AdHocTarget): DeviceInfo | undefined {
  switch (target) {
    case "this-machine":
      return localDevice();
    case "simulated-windows-laptop":
      return WIN_LAPTOP;
    case "simulated-windows-desktop":
      return WIN_DESKTOP;
    case "simulated-mac-laptop":
      return MAC_LAPTOP;
    case "no-device":
      return undefined;
  }
}

/**
 * Derive a subject from free text.
 *
 * A real help desk gets a subject line and a body; someone typing at a console
 * gets one box. The first sentence is almost always the complaint, which is
 * what a subject is for.
 */
export function deriveSubject(description: string): string {
  const firstSentence = description
    .trim()
    .split(/(?<=[.!?])\s+|\n/)[0]
    ?.trim();
  const candidate = firstSentence && firstSentence.length >= 8 ? firstSentence : description.trim();
  const cleaned = candidate.replace(/\s+/g, " ");
  return cleaned.length > 90 ? `${cleaned.slice(0, 87)}…` : cleaned;
}

/** True when an ad-hoc ticket can be pointed at the real host. */
export function localTargetAvailable(): boolean {
  return hostPlatform() !== "unknown";
}

export function adHocTicket(request: AdHocRequest): Ticket {
  const target = request.target ?? "this-machine";
  if (target === "this-machine" && !localTargetAvailable()) {
    throw new Error(
      `AIT has no diagnostic set for platform "${process.platform}", so it cannot work this machine.`,
    );
  }

  const description = request.description.trim();
  if (description.length < 10) {
    // A two-word ticket produces a two-word diagnosis. Say so rather than
    // pretending the run was meaningful.
    throw new Error(
      "Describe the problem in a sentence or two - there is nothing to work from otherwise.",
    );
  }

  const device = deviceFor(target);
  const now = nowIso();

  return {
    id: newId("adhoc"),
    source: "manual",
    subject: request.subject?.trim() || deriveSubject(description),
    description,
    status: "new",
    priority: request.priority ?? "normal",
    // The local tag is what routes a real-host ticket down the local-checks
    // path rather than the simulated playbooks.
    tags: target === "this-machine" ? [LOCAL_TICKET_TAG, "ad-hoc"] : ["ad-hoc"],
    requester: {
      id: "adhoc-user",
      name: request.requester?.trim() || hostname(),
      vip: request.vip ?? false,
    },
    ...(device ? { device } : {}),
    comments: [],
    created_at: now,
    updated_at: now,
  };
}
