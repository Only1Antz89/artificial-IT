/**
 * Execution results and the evidence trail.
 *
 * Every step that runs produces exactly one StepResult, and every StepResult is
 * appended to the run record. The ticket write-up is generated from these - it
 * is never written from the model's memory of what it did.
 */
import { z } from "zod";
import { ArtifactRef, IsoDateTime } from "./common.js";
import { PolicyVerdict } from "./policy.js";
import { PlanStep } from "./plan.js";

export const StepOutcome = z.enum([
  "success",
  "failed",
  "blocked",
  "awaiting_approval",
  "awaiting_user",
  "skipped",
]);
export type StepOutcome = z.infer<typeof StepOutcome>;

export const CommandResult = z.object({
  command: z.string(),
  exit_code: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  duration_ms: z.number().int().min(0),
  truncated: z.boolean().default(false),
});
export type CommandResult = z.infer<typeof CommandResult>;

export const StepResult = z.object({
  step: PlanStep,
  outcome: StepOutcome,
  verdict: PolicyVerdict,
  started_at: IsoDateTime,
  finished_at: IsoDateTime,
  /** Free-text observation - what a technician would write in their notes. */
  observation: z.string().default(""),
  command: CommandResult.optional(),
  artifacts: z.array(ArtifactRef).default([]),
  error: z.string().optional(),
});
export type StepResult = z.infer<typeof StepResult>;
