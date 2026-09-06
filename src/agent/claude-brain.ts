/**
 * The Claude-backed brain (Anthropic API).
 *
 * Structured outputs throughout: every call comes back as a validated object
 * rather than prose the loop has to parse. That is what lets the control plane
 * treat the brain's output as a *proposal* with a known shape - a plan step
 * always has a kind, a command and a mutating flag, so the policy engine can
 * evaluate it without interpreting free text.
 *
 * The system prompt is a frozen constant sent first on every call, so it caches
 * cleanly across the several calls a single ticket makes.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type {
  Diagnosis,
  Documentation,
  Intake,
} from "../contracts/index.js";
import type {
  Brain,
  DiagnoseInput,
  DocumentInput,
  IntakeInput,
  ProposeInput,
  ProposeOutput,
} from "./brain.js";
import {
  DIAGNOSE_INSTRUCTIONS,
  DOCUMENT_INSTRUCTIONS,
  INTAKE_INSTRUCTIONS,
  PROPOSE_INSTRUCTIONS,
  TECHNICIAN_SYSTEM,
} from "./prompts.js";
import {
  renderDiagnosisContext,
  renderHistory,
  renderPriorTickets,
  renderTicket,
} from "./render.js";
import {
  WireDiagnosis,
  WireDocumentation,
  WireIntake,
  WireProposal,
  toPlanStep,
} from "./schemas.js";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeBrainOptions {
  client?: Anthropic;
  model?: string;
  /** Effort for the reasoning-heavy propose loop. Cheap calls step down. */
  effort?: Effort;
}

export class ClaudeBrain implements Brain {
  readonly name = "claude";
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #effort: Effort;

  constructor(opts: ClaudeBrainOptions = {}) {
    this.#client = opts.client ?? new Anthropic();
    this.#model = opts.model ?? process.env["ANTHROPIC_MODEL"] ?? DEFAULT_CLAUDE_MODEL;
    this.#effort = opts.effort ?? "high";
  }

  async #ask<T extends z.ZodType>(
    schema: T,
    instructions: string,
    context: string,
    effort: Effort = this.#effort,
  ): Promise<z.infer<T>> {
    const response = await this.#client.messages.parse({
      model: this.#model,
      max_tokens: 16000,
      // Frozen prefix first, volatile ticket context after, so the cache holds.
      system: [
        {
          type: "text",
          text: TECHNICIAN_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      thinking: { type: "adaptive" },
      output_config: { effort, format: zodOutputFormat(schema) },
      messages: [{ role: "user", content: `${instructions}\n\n${context}` }],
    });

    // A refusal is a legitimate outcome, not an exception to paper over: the
    // loop treats a thrown brain as a reason to escalate to a human.
    if (response.stop_reason === "refusal") {
      throw new Error(
        `Claude declined this request (${response.stop_details?.category ?? "unspecified"}).`,
      );
    }
    if (!response.parsed_output) {
      throw new Error("Claude returned no parsable structured output.");
    }
    return response.parsed_output;
  }

  async intake(input: IntakeInput): Promise<Intake> {
    const out = await this.#ask(
      WireIntake,
      INTAKE_INSTRUCTIONS,
      renderTicket(input.ticket),
      "medium",
    );
    return out;
  }

  async diagnose(input: DiagnoseInput): Promise<Diagnosis> {
    const context = [
      renderTicket(input.ticket),
      renderPriorTickets(input.priorTickets),
      `## Intake\n${JSON.stringify(input.intake, null, 2)}`,
    ].join("\n\n");
    const out = await this.#ask(WireDiagnosis, DIAGNOSE_INSTRUCTIONS, context);
    return {
      hypotheses: out.hypotheses,
      leading_index: clampIndex(out.leading_index, out.hypotheses.length),
      ...(out.root_cause ? { root_cause: out.root_cause } : {}),
      confidence: out.confidence,
    };
  }

  async propose(input: ProposeInput): Promise<ProposeOutput> {
    const context = [
      renderTicket(input.ticket),
      renderDiagnosisContext(input.intake, input.diagnosis),
      renderPriorTickets(input.priorTickets),
      renderHistory(input.history),
      `## Budget\nYou may propose at most ${input.remainingBudget} more step(s) across all remaining turns.`,
    ].join("\n\n");

    const out = await this.#ask(WireProposal, PROPOSE_INSTRUCTIONS, context);
    return {
      steps: out.steps.slice(0, 3).map(toPlanStep),
      resolved: out.resolved,
      ...(out.root_cause ? { root_cause: out.root_cause } : {}),
      wants_human: out.wants_human,
      reasoning: out.reasoning,
    };
  }

  async document(input: DocumentInput): Promise<Documentation> {
    const context = [
      renderTicket(input.ticket),
      renderDiagnosisContext(input.intake, input.diagnosis),
      renderHistory(input.history),
      `## Outcome\nresolved=${input.resolved} escalated=${input.escalated}`,
    ].join("\n\n");
    return this.#ask(WireDocumentation, DOCUMENT_INSTRUCTIONS, context, "medium");
  }
}

/** A model that miscounts its own list should not index out of bounds. */
export function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(Math.trunc(index), Math.max(0, length - 1));
}

/** True when a Claude brain can actually be constructed in this environment. */
export function claudeAvailable(): boolean {
  return Boolean(
    process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"],
  );
}
