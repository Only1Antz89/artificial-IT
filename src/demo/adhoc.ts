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
import { WIN_LAPTOP, WIN_DESKTOP, WIN_FIELD, MAC_LAPTOP, MAC_DESIGNER } from "./devices.js";
import { meshConfigFromEnv } from "../execution-plane/remote.js";
import type { DeviceInfo } from "../contracts/ticket.js";

/** Which machine an ad-hoc ticket is about. */
export type AdHocTarget =
  | "this-machine"
  | "remote-device"
  | "simulated-windows-laptop"
  | "simulated-windows-desktop"
  | "simulated-mac-laptop"
  | "simulated-mac-designer"
  | "simulated-windows-field-laptop"
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
  /**
   * Whether the user agreed to checks on their machine.
   *
   * Refusing is not the same as having no machine. The device stays attached
   * with consent withheld, so the consent guardrail is what stops the work -
   * which is both the truth and a far more useful thing to show a technician
   * than a ticket that mysteriously has no device.
   */
  consent?: boolean;
}

export const AD_HOC_TARGETS: { key: AdHocTarget; label: string; note: string }[] = [
  {
    key: "this-machine",
    label: "This machine",
    note: "Real commands against the host you are running on.",
  },
  {
    key: "remote-device",
    label: "Remote device (MeshCentral)",
    note: "A managed endpoint reached over a remote-support session.",
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
    key: "simulated-mac-designer",
    label: "Simulated MacBook (full disk)",
    note: "LDN-MB-4412, 96% full with Photoshop unable to save.",
  },
  {
    key: "simulated-windows-field-laptop",
    label: "Simulated Windows laptop (weak wi-fi)",
    note: "BHM-LT-7781, on a 28% guest wireless signal with the VPN dropping.",
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
    case "remote-device":
      return remoteDevice();
    case "simulated-windows-laptop":
      return WIN_LAPTOP;
    case "simulated-windows-desktop":
      return WIN_DESKTOP;
    case "simulated-mac-laptop":
      return MAC_LAPTOP;
    case "simulated-mac-designer":
      return MAC_DESIGNER;
    case "simulated-windows-field-laptop":
      return WIN_FIELD;
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
  if (cleaned.length <= 90) return cleaned;

  // Cut at a word boundary. A subject line ending "re-verify my pa…" is the
  // first thing the user reads back on their own ticket, and it reads as a
  // glitch rather than as a summary.
  const cut = cleaned.slice(0, 87);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = (lastSpace > 50 ? cut.slice(0, lastSpace) : cut).replace(
    /[\s,;:.\-]+$/,
    "",
  );
  return `${trimmed}…`;
}

/** True when an ad-hoc ticket can be pointed at the real host. */
export function localTargetAvailable(): boolean {
  return hostPlatform() !== "unknown";
}

/**
 * The remote endpoint, when one is configured.
 *
 * `MESHCENTRAL_DEVICE_ID` names which managed machine to work on; without it
 * there is a server but no device, which is not a target you can aim a ticket
 * at. Platform comes from `MESHCENTRAL_DEVICE_PLATFORM` because MeshCentral
 * knows it and we have not asked yet - guessing it would pick the wrong
 * diagnostics.
 */
export function remoteDevice(): DeviceInfo | undefined {
  const config = meshConfigFromEnv();
  const deviceId = process.env["MESHCENTRAL_DEVICE_ID"];
  if (!config || !deviceId) return undefined;

  const declared = (process.env["MESHCENTRAL_DEVICE_PLATFORM"] ?? "").toLowerCase();
  const platform: DeviceInfo["platform"] =
    declared === "windows" || declared === "macos" || declared === "linux"
      ? declared
      : "unknown";

  return {
    device_id: deviceId,
    hostname: process.env["MESHCENTRAL_DEVICE_NAME"] ?? deviceId,
    platform,
    // Consent for a remote-support session is granted in MeshCentral itself,
    // by the user accepting the connection prompt.
    consent_granted: true,
    managed: true,
  };
}

/** True when a ticket can be aimed at a real remote endpoint. */
export function remoteTargetAvailable(): boolean {
  return remoteDevice() !== undefined;
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

  const base = deviceFor(target);
  const consent = request.consent ?? true;
  const device = base ? { ...base, consent_granted: consent } : undefined;
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
    // Both a real local host and a real remote endpoint take the local-checks
    // path: real commands, real thresholds, no scripted fixtures.
    tags:
      target === "this-machine" || target === "remote-device"
        ? [LOCAL_TICKET_TAG, "ad-hoc"]
        : ["ad-hoc"],
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
