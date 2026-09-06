/**
 * Append-only audit log entries.
 *
 * The control plane records *why* something was allowed, not just that it
 * happened. Entries are never
 * mutated or deleted - a correction is a new entry.
 */
import { z } from "zod";
import { IsoDateTime } from "./common.js";

export const AuditEventType = z.enum([
  "run.started",
  "run.finished",
  "intake.completed",
  "diagnosis.formed",
  "plan.proposed",
  "policy.evaluated",
  "approval.requested",
  "approval.granted",
  "approval.denied",
  "step.executed",
  "evidence.captured",
  "escalation.raised",
  "ticket.updated",
  "knowledge.retrieved",
  "knowledge.learned",
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

export const AuditEntry = z.object({
  seq: z.number().int().min(0),
  event: AuditEventType,
  at: IsoDateTime,
  run_id: z.string().min(1),
  ticket_id: z.string().min(1),
  actor: z.enum(["agent", "policy", "human", "system"]),
  summary: z.string().min(1),
  detail: z.record(z.string(), z.unknown()).default({}),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
