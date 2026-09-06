/**
 * The run record: one attempt by AIT to resolve one ticket.
 *
 * This is the single artefact everything else reads from. The ticket write-up,
 * the user-facing feedback, the escalation handover and the knowledge-base
 * entry are all *derived* from a completed run, which is why the run has to
 * carry the evidence rather than a summary of it.
 */
import { z } from "zod";
import { Envelope, IsoDateTime } from "./common.js";
import { Ticket } from "./ticket.js";
import { Diagnosis, Intake, PlanStep } from "./plan.js";
import { StepResult } from "./evidence.js";
import { AuditEntry } from "./audit.js";
import { Escalation } from "./escalation.js";

export const RunStatus = z.enum([
  "running",
  "resolved",
  "escalated",
  "awaiting_approval",
  "awaiting_user",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatus>;

/** The write-up left on the ticket, and the friendlier note sent to the user. */
export const Documentation = z.object({
  title: z.string(),
  /** Internal note: symptom, root cause, actions, evidence, prevention. */
  technical_writeup: z.string(),
  /** Public reply: plain language, no jargon, says what changed and why. */
  user_reply: z.string(),
  root_cause: z.string(),
  resolution: z.string(),
  prevention: z.array(z.string()).default([]),
  time_saved_estimate_minutes: z.number().int().min(0).optional(),
});
export type Documentation = z.infer<typeof Documentation>;

export const Run = Envelope.extend({
  contract_type: z.literal("technician.run"),
  run_id: z.string().min(1),
  ticket: Ticket,
  status: RunStatus,
  intake: Intake.optional(),
  diagnosis: Diagnosis.optional(),
  /** Steps the brain proposed, in the order proposed. */
  proposed: z.array(PlanStep).default([]),
  /** What actually happened to each step the control plane considered. */
  results: z.array(StepResult).default([]),
  documentation: Documentation.optional(),
  escalation: Escalation.optional(),
  audit: z.array(AuditEntry).default([]),
  /** Prior ticket ids the knowledge base surfaced for this run. */
  knowledge_used: z.array(z.string()).default([]),
  started_at: IsoDateTime,
  finished_at: IsoDateTime.optional(),
});
export type Run = z.infer<typeof Run>;
