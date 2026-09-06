/**
 * Zendesk <-> AIT translation.
 *
 * Everything help-desk-specific is confined to this file. The agent never sees
 * a Zendesk id, a Zendesk status or a Zendesk custom field - it sees a `Ticket`.
 * When a second help desk is added, this is the file that gets a sibling.
 */
import type {
  ArtifactRef,
  Documentation,
  Escalation,
  Run,
  Severity,
  Ticket,
  TicketComment,
  TicketStatus,
} from "../../contracts/index.js";
import type { DeviceInfo } from "../../contracts/ticket.js";
import type {
  TicketUpdate,
  ZendeskTicket,
  ZendeskUser,
} from "./types.js";

/** Zendesk has more states than AIT needs; `hold`/`closed` collapse inward. */
function mapStatus(status: ZendeskTicket["status"]): TicketStatus {
  switch (status) {
    case "new":
      return "new";
    case "open":
      return "open";
    case "pending":
    case "hold":
      return "pending";
    case "solved":
    case "closed":
      return "solved";
  }
}

/**
 * Device facts arrive as Zendesk custom fields, which are numeric ids per
 * instance. The mapping is configuration, not a constant, so a deployment
 * points these at whatever field ids that instance actually uses.
 */
export interface DeviceFieldMap {
  device_id: number;
  hostname: number;
  platform: number;
  os_version?: number;
  managed?: number;
  consent?: number;
}

export interface MapperConfig {
  deviceFields?: DeviceFieldMap;
  /** Tag marking a requester as a VIP; Zendesk has no first-class VIP flag. */
  vipTag?: string;
}

/** Anything we do not recognise is "unknown" rather than guessed at. */
function parsePlatform(raw: string | undefined): DeviceInfo["platform"] {
  switch ((raw ?? "").toLowerCase()) {
    case "windows":
      return "windows";
    case "macos":
    case "mac":
    case "osx":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}

function customField(
  ticket: ZendeskTicket,
  id: number | undefined,
): string | undefined {
  if (id === undefined) return undefined;
  const field = ticket.custom_fields?.find((f) => f.id === id);
  if (field == null || field.value == null) return undefined;
  return String(field.value);
}

export function toTicket(
  zTicket: ZendeskTicket,
  requester: ZendeskUser,
  config: MapperConfig = {},
): Ticket {
  const vipTag = config.vipTag ?? "vip";
  const fields = config.deviceFields;

  const comments: TicketComment[] = (zTicket.comments ?? []).map((c) => ({
    id: String(c.id),
    author: c.author_id === requester.id ? requester.name : `zendesk-user-${c.author_id}`,
    author_role: c.author_id === requester.id ? "requester" : "agent",
    body: c.body,
    created_at: c.created_at,
    public: c.public,
    attachments: (c.attachments ?? []).map<ArtifactRef>((a) => ({
      uri: a.content_url,
      content_type: a.content_type,
      size_bytes: a.size,
      caption: a.file_name,
    })),
  }));

  const platform = parsePlatform(customField(zTicket, fields?.platform));

  const deviceId = customField(zTicket, fields?.device_id);
  const device = deviceId
    ? {
        device_id: deviceId,
        hostname: customField(zTicket, fields?.hostname) ?? deviceId,
        platform,
        os_version: customField(zTicket, fields?.os_version),
        // Consent is opt-in: absent means not granted, never assumed.
        consent_granted: customField(zTicket, fields?.consent) === "true",
        managed: customField(zTicket, fields?.managed) !== "false",
      }
    : undefined;

  return {
    id: `zd-${zTicket.id}`,
    external_id: String(zTicket.id),
    source: "zendesk",
    subject: zTicket.subject,
    description: zTicket.description,
    status: mapStatus(zTicket.status),
    priority: (zTicket.priority ?? "normal") as Severity,
    tags: zTicket.tags,
    requester: {
      id: String(requester.id),
      name: requester.name,
      ...(requester.email ? { email: requester.email } : {}),
      vip: (requester.tags ?? []).includes(vipTag),
    },
    ...(device ? { device } : {}),
    comments,
    created_at: zTicket.created_at,
    updated_at: zTicket.updated_at,
  };
}

/* ------------------------------------------------------------------ *
 * Writing back
 * ------------------------------------------------------------------ */

/**
 * The internal note left on the ticket.
 *
 * This is the technician-facing record: what was wrong, what was done, what was
 * refused and why. It is generated from the run's evidence, so it cannot claim
 * an action that did not run.
 */
export function renderInternalNote(run: Run): string {
  const lines: string[] = [];
  const doc = run.documentation;

  lines.push(`**AIT — automated triage**`);
  lines.push("");
  if (doc) {
    lines.push(`**Root cause:** ${doc.root_cause}`);
    lines.push(`**Resolution:** ${doc.resolution}`);
    lines.push("");
  }

  if (run.diagnosis) {
    lines.push(`**Diagnosis** (${run.diagnosis.confidence} confidence)`);
    run.diagnosis.hypotheses.forEach((h, i) => {
      const lead = i === run.diagnosis!.leading_index ? " ← pursued" : "";
      lines.push(`- ${h.statement} (${h.confidence})${lead}`);
    });
    lines.push("");
  }

  lines.push(`**Steps taken**`);
  if (run.results.length === 0) {
    lines.push("- None.");
  }
  for (const r of run.results) {
    const marker =
      r.outcome === "success"
        ? "✅"
        : r.outcome === "blocked"
          ? "⛔"
          : r.outcome === "awaiting_approval"
            ? "⏸️"
            : r.outcome === "failed"
              ? "❌"
              : "•";
    const cmd = r.command ? ` \`${r.command.command}\`` : "";
    lines.push(`- ${marker} ${r.step.intent}${cmd}`);
    if (r.observation) lines.push(`  - ${r.observation}`);
    if (r.outcome === "blocked" || r.outcome === "awaiting_approval") {
      lines.push(`  - _Guardrail (${r.verdict.rule_id}): ${r.verdict.reason}_`);
    }
  }
  lines.push("");

  if (run.knowledge_used.length > 0) {
    lines.push(`**Prior tickets consulted:** ${run.knowledge_used.join(", ")}`);
    lines.push("");
  }

  if (run.escalation?.triggered) {
    lines.push(`**Escalated to ${run.escalation.route_to}** (${run.escalation.urgency})`);
    lines.push(`_${run.escalation.ask}_`);
    lines.push("");
    lines.push(`**Handover**`);
    for (const [heading, items] of [
      ["What we know", run.escalation.handover.what_we_know],
      ["What we tried", run.escalation.handover.what_we_tried],
      ["What we could not do", run.escalation.handover.what_we_could_not_do],
      ["Suggested next steps", run.escalation.handover.suggested_next_steps],
    ] as const) {
      if (items.length === 0) continue;
      lines.push(`_${heading}_`);
      for (const item of items) lines.push(`- ${item}`);
    }
    lines.push("");
  }

  if (doc?.prevention.length) {
    lines.push(`**Prevention**`);
    for (const p of doc.prevention) lines.push(`- ${p}`);
    lines.push("");
  }

  lines.push(`_Run ${run.run_id} · trace ${run.trace_id} · ${run.results.length} step(s) · ${run.audit.length} audit entries_`);
  return lines.join("\n");
}

/** Where the run should leave the ticket. */
export function ticketUpdateFor(
  run: Run,
  uploadTokens: string[],
): TicketUpdate {
  const escalated = run.escalation?.triggered ?? false;
  const tags = ["ait-handled", `ait-${run.status}`];
  if (escalated) tags.push("ait-escalated", ...run.escalation!.triggers.map((t) => `ait-${t}`));

  return {
    // A resolved run solves the ticket; anything else leaves it open for a human.
    status: run.status === "resolved" ? "solved" : escalated ? "open" : "pending",
    tags,
    comment: {
      body: renderInternalNote(run),
      public: false,
      ...(uploadTokens.length ? { uploads: uploadTokens } : {}),
    },
  };
}

/** The public reply the user actually reads. */
export function publicReplyFor(
  documentation: Documentation | undefined,
  escalation: Escalation | undefined,
  uploadTokens: string[],
): TicketUpdate | undefined {
  const body = documentation?.user_reply;
  if (!body) return undefined;

  const suffix = escalation?.triggered
    ? `\n\nI've passed this to a colleague on our ${escalation.route_to.replace(/-/g, " ")} team, who will follow up.`
    : "";

  return {
    comment: {
      body: `${body}${suffix}`,
      public: true,
      ...(uploadTokens.length ? { uploads: uploadTokens } : {}),
    },
  };
}
