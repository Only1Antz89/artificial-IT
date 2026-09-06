/**
 * The support ticket as AIT sees it.
 *
 * This is a *normalised* ticket: `src/integrations/zendesk/mapper.ts` converts
 * Zendesk's shape into this one, so nothing downstream of intake knows or
 * cares which help desk the work came from.
 */
import { z } from "zod";
import { ArtifactRef, IsoDateTime, Severity } from "./common.js";

export const TicketStatus = z.enum([
  "new",
  "open",
  "pending",
  "solved",
  "escalated",
]);
export type TicketStatus = z.infer<typeof TicketStatus>;

/** The person who raised the ticket, and what we know about their machine. */
export const Requester = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email().optional(),
  /** Used by the escalation rules - VIPs get a human sooner. */
  vip: z.boolean().default(false),
  department: z.string().optional(),
});
export type Requester = z.infer<typeof Requester>;

export const DeviceInfo = z.object({
  device_id: z.string().min(1),
  hostname: z.string().min(1),
  platform: z.enum(["windows", "macos", "linux", "unknown"]),
  os_version: z.string().optional(),
  /** Whether the user has consented to a remote-control session right now. */
  consent_granted: z.boolean().default(false),
  /** Managed devices allow a wider command allowlist than BYOD. */
  managed: z.boolean().default(true),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

export const TicketComment = z.object({
  id: z.string().min(1),
  author: z.string().min(1),
  author_role: z.enum(["requester", "agent", "system"]),
  body: z.string(),
  created_at: IsoDateTime,
  public: z.boolean().default(true),
  attachments: z.array(ArtifactRef).default([]),
});
export type TicketComment = z.infer<typeof TicketComment>;

export const Ticket = z.object({
  id: z.string().min(1),
  external_id: z.string().optional(),
  source: z.enum(["zendesk", "manual", "chat", "email"]).default("zendesk"),
  subject: z.string().min(1),
  description: z.string(),
  status: TicketStatus.default("new"),
  priority: Severity.default("normal"),
  tags: z.array(z.string()).default([]),
  requester: Requester,
  device: DeviceInfo.optional(),
  comments: z.array(TicketComment).default([]),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type Ticket = z.infer<typeof Ticket>;
