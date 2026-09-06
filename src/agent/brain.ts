/**
 * The brain interface.
 *
 * The agent loop owns the *process* - retrieve, propose, gate, execute, record.
 * The brain owns the *judgement* - what is probably wrong, what to try next,
 * how to explain it afterwards. Keeping them apart is what lets the guardrails
 * be trustworthy: the brain can propose anything at all, and the loop is what
 * decides whether it happens.
 *
 * Two implementations ship:
 *
 *   - `ClaudeBrain`    - Claude Opus 5, structured outputs, real judgement.
 *   - `HeuristicBrain` - a deterministic rule-based stand-in so the demo, the
 *                        tests and CI run with no API key and no network.
 *
 * Both satisfy the same contract, and the loop cannot tell them apart.
 */
import type {
  Diagnosis,
  Documentation,
  Intake,
  PlanStep,
  StepResult,
  Ticket,
} from "../contracts/index.js";
import type { RetrievalHit } from "../knowledge/index.js";

export interface IntakeInput {
  ticket: Ticket;
}

export interface DiagnoseInput {
  ticket: Ticket;
  intake: Intake;
  /** Similar tickets already resolved, best match first. */
  priorTickets: RetrievalHit[];
}

export interface ProposeInput {
  ticket: Ticket;
  intake: Intake;
  diagnosis: Diagnosis;
  priorTickets: RetrievalHit[];
  /** Everything that has happened so far this run. */
  history: StepResult[];
  /** How many steps the loop will still allow. */
  remainingBudget: number;
}

export interface ProposeOutput {
  /** Steps to try next. Empty means the brain has nothing further to offer. */
  steps: PlanStep[];
  /** The brain's read on whether the issue is now fixed and verified. */
  resolved: boolean;
  /** Updated root cause, once the evidence supports naming one. */
  root_cause?: string;
  /** Set when the brain itself wants a human, e.g. it is out of ideas. */
  wants_human?: boolean;
  reasoning: string;
}

export interface DocumentInput {
  ticket: Ticket;
  intake: Intake;
  diagnosis: Diagnosis;
  history: StepResult[];
  resolved: boolean;
  escalated: boolean;
}

export interface Brain {
  readonly name: string;
  intake(input: IntakeInput): Promise<Intake>;
  diagnose(input: DiagnoseInput): Promise<Diagnosis>;
  propose(input: ProposeInput): Promise<ProposeOutput>;
  document(input: DocumentInput): Promise<Documentation>;
}
