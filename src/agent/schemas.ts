/**
 * Wire schemas for the model providers.
 *
 * These are *not* the contract types. They are the shapes the model is asked to
 * fill in, and they differ from the contracts in three deliberate ways:
 *
 *   - No `.default()`. A default silently substitutes for a missing answer; we
 *     want the model to state every field so a gap is visible.
 *   - No `.optional()`. OpenAI's strict structured-output mode requires every
 *     property to be required, so absence is expressed as `.nullable()`, which
 *     both providers accept.
 *   - Step ids are absent. They are minted on our side so the model cannot
 *     reuse or collide with one.
 *
 * `toPlanStep` and the mappers in the brains convert these into contract types.
 */
import { z } from "zod";
import { newId, type PlanStep } from "../contracts/index.js";

const Confidence = z.enum(["low", "medium", "high"]);

export const WireIntake = z.object({
  summary: z.string(),
  category: z.enum([
    "connectivity",
    "authentication",
    "hardware",
    "software",
    "performance",
    "printing",
    "email",
    "storage",
    "security",
    "access-request",
    "other",
  ]),
  reported_symptoms: z.array(z.string()),
  missing_information: z.array(z.string()),
  out_of_scope: z.boolean(),
  user_sentiment: z.enum(["calm", "frustrated", "blocked", "urgent"]),
});

export const WireDiagnosis = z.object({
  hypotheses: z.array(
    z.object({
      statement: z.string(),
      confidence: Confidence,
      supporting_evidence: z.array(z.string()),
      contradicting_evidence: z.array(z.string()),
      prior_ticket_refs: z.array(z.string()),
    }),
  ),
  leading_index: z.number().int(),
  root_cause: z.string().nullable(),
  confidence: Confidence,
});

export const WireStep = z.object({
  kind: z.enum([
    "command",
    "screenshot",
    "ui_action",
    "read_file",
    "ask_user",
    "knowledge_lookup",
  ]),
  intent: z.string(),
  command: z.string().nullable(),
  question: z.string().nullable(),
  path: z.string().nullable(),
  caption: z.string().nullable(),
  annotations: z
    .array(
      z.object({
        style: z.enum(["problem", "action", "info"]),
        box: z.object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }),
        label: z.string(),
      }),
    )
    .nullable(),
  tests_hypothesis: z.number().int().nullable(),
  mutating: z.boolean(),
  rollback: z.string().nullable(),
  /** A command that reverses this step, or null when nothing can. */
  rollback_command: z.string().nullable(),
});
export type WireStep = z.infer<typeof WireStep>;

export const WireProposal = z.object({
  reasoning: z.string(),
  steps: z.array(WireStep),
  resolved: z.boolean(),
  root_cause: z.string().nullable(),
  wants_human: z.boolean(),
});

export const WireDocumentation = z.object({
  title: z.string(),
  technical_writeup: z.string(),
  user_reply: z.string(),
  root_cause: z.string(),
  resolution: z.string(),
  prevention: z.array(z.string()),
  time_saved_estimate_minutes: z.number().int(),
});

/**
 * Convert a model-proposed step into a contract PlanStep.
 *
 * Only the fields the executor understands are carried across. Anything the
 * model invented outside the schema is dropped rather than passed through -
 * the executor should never receive a payload key nobody has reasoned about.
 */
export function toPlanStep(s: WireStep): PlanStep {
  const payload: Record<string, unknown> = {};
  if (s.command) payload["command"] = s.command;
  if (s.question) payload["question"] = s.question;
  if (s.path) payload["path"] = s.path;
  if (s.caption) payload["caption"] = s.caption;
  if (s.annotations) payload["annotations"] = s.annotations;

  return {
    id: newId("step"),
    kind: s.kind,
    intent: s.intent,
    payload,
    ...(s.tests_hypothesis !== null ? { tests_hypothesis: s.tests_hypothesis } : {}),
    mutating: s.mutating,
    ...(s.rollback ? { rollback: s.rollback } : {}),
    ...(s.rollback_command ? { rollback_command: s.rollback_command } : {}),
  };
}
