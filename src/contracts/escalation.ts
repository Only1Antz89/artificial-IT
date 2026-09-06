/**
 * Escalation to a human technician.
 *
 * An escalation is a first-class outcome, not a failure mode. The handover pack
 * exists so the human does not have to re-run the diagnosis from scratch.
 */
import { z } from "zod";
import { IsoDateTime, Severity } from "./common.js";

export const EscalationTrigger = z.enum([
  /** A guardrail category blocked the only viable fix. */
  "policy-block",
  /** The request needs authority the agent does not have (approvals, budget). */
  "requires-authority",
  /** Diagnosis never got above low confidence. */
  "low-confidence",
  /** Remediation attempts kept failing. */
  "repeated-failure",
  /** The request is not an IT technician task at all. */
  "out-of-scope",
  /** User is blocked/urgent, or is a VIP, and the fix is not immediate. */
  "user-impact",
  /** The user asked for a human. Always honoured immediately. */
  "user-requested",
  /** Needed hardware, physical access, or a site visit. */
  "needs-hands-on",
  /** Ran out of the step budget for this run. */
  "budget-exhausted",
]);
export type EscalationTrigger = z.infer<typeof EscalationTrigger>;

export const Escalation = z.object({
  triggered: z.boolean(),
  triggers: z.array(EscalationTrigger).default([]),
  urgency: Severity.default("normal"),
  /** The queue/team a human should pick this up from. */
  route_to: z.string().default("service-desk-tier-2"),
  /** What the agent wants the human to do next, in one sentence. */
  ask: z.string().default(""),
  /** Everything the human needs so they don't start from zero. */
  handover: z.object({
    what_we_know: z.array(z.string()).default([]),
    what_we_tried: z.array(z.string()).default([]),
    what_we_could_not_do: z.array(z.string()).default([]),
    suggested_next_steps: z.array(z.string()).default([]),
  }),
  raised_at: IsoDateTime.optional(),
});
export type Escalation = z.infer<typeof Escalation>;
