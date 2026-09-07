/**
 * Intake, diagnosis and the remediation plan.
 *
 * The shape mirrors how a good technician actually works: restate the request,
 * form a hypothesis, then propose the smallest set of steps that would prove or
 * disprove it. Every step is a *proposal* - the control plane decides whether
 * it ever runs.
 */
import { z } from "zod";
import { Confidence, Envelope, IsoDateTime } from "./common.js";

/** What the user is actually asking for, extracted from free text. */
export const Intake = z.object({
  /** One-line restatement, used in the write-up and in ticket replies. */
  summary: z.string().min(1),
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
  /** Verbatim symptoms the user reported - never paraphrased away. */
  reported_symptoms: z.array(z.string()).default([]),
  /** Facts the technician still needs before acting. */
  missing_information: z.array(z.string()).default([]),
  /** True when the request itself is out of an IT technician's remit. */
  out_of_scope: z.boolean().default(false),
  user_sentiment: z.enum(["calm", "frustrated", "blocked", "urgent"]).default("calm"),
});
export type Intake = z.infer<typeof Intake>;

export const Hypothesis = z.object({
  statement: z.string().min(1),
  confidence: Confidence,
  /** What we'd expect to observe if this hypothesis is the right one. */
  supporting_evidence: z.array(z.string()).default([]),
  contradicting_evidence: z.array(z.string()).default([]),
  /** Ids of prior tickets that informed this hypothesis. */
  prior_ticket_refs: z.array(z.string()).default([]),
});
export type Hypothesis = z.infer<typeof Hypothesis>;

export const Diagnosis = z.object({
  hypotheses: z.array(Hypothesis).min(1),
  /** The hypothesis currently being pursued (index into `hypotheses`). */
  leading_index: z.number().int().min(0).default(0),
  root_cause: z.string().optional(),
  confidence: Confidence,
});
export type Diagnosis = z.infer<typeof Diagnosis>;

/**
 * The action kinds the executor knows how to perform.
 *
 * `command` covers terminal/shell work - the efficiency win the brief asked
 * for - and is the kind the policy engine scrutinises hardest.
 */
export const ActionKind = z.enum([
  "command",
  "screenshot",
  "ui_action",
  "read_file",
  "ask_user",
  "ticket_comment",
  "knowledge_lookup",
]);
export type ActionKind = z.infer<typeof ActionKind>;

/** A single proposed step. Never executed until the control plane clears it. */
export const PlanStep = z.object({
  id: z.string().min(1),
  kind: ActionKind,
  /** Human-readable intent - this is what a technician would read in the log. */
  intent: z.string().min(1),
  /** Kind-specific payload, e.g. `{ command: "ipconfig /all" }`. */
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Which hypothesis this step tests, if any. */
  tests_hypothesis: z.number().int().min(0).optional(),
  /** Whether the step changes device state. Read-only steps are cheap to allow. */
  mutating: z.boolean().default(false),
  /** How the technician would undo it, if it is mutating. */
  rollback: z.string().optional(),
  /**
   * The command that would actually undo it.
   *
   * Separate from `rollback` on purpose. The prose is for a human reading the
   * ticket ("the cache repopulates on its own"); this is the thing a machine
   * can run. Plenty of changes have an honest prose rollback and no command -
   * a flushed cache refills itself - and pretending otherwise would give the
   * console an Undo button that does nothing.
   */
  rollback_command: z.string().optional(),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const RemediationPlan = Envelope.extend({
  contract_type: z.literal("remediation.plan"),
  plan_id: z.string().min(1),
  ticket_id: z.string().min(1),
  intake: Intake,
  diagnosis: Diagnosis,
  steps: z.array(PlanStep).default([]),
  created_at: IsoDateTime,
});
export type RemediationPlan = z.infer<typeof RemediationPlan>;
