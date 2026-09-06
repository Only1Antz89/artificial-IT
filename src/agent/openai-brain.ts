/**
 * The OpenAI-backed brain.
 *
 * The same technician, on a different engine. It implements the identical
 * `Brain` contract as `ClaudeBrain`, uses the identical prompts, and returns
 * the identical structured shapes - so the control plane, the guardrails and
 * the audit trail behave the same whichever provider is in use. That symmetry
 * is the point: the safety properties of this system must not depend on which
 * model is answering.
 *
 * Uses the Responses API with strict structured outputs (`zodTextFormat`),
 * which is why `schemas.ts` avoids optionals and defaults.
 */
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import type { Diagnosis, Documentation, Intake } from "../contracts/index.js";
import type {
  Brain,
  DiagnoseInput,
  DocumentInput,
  IntakeInput,
  ProposeInput,
  ProposeOutput,
} from "./brain.js";
import { clampIndex } from "./claude-brain.js";
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

/**
 * Overridable via `OPENAI_MODEL`, because model names move faster than this
 * file does and a deployment should not need a code change to follow them.
 */
export const DEFAULT_OPENAI_MODEL = "gpt-5";

export interface OpenAIBrainOptions {
  client?: OpenAI;
  model?: string;
  /** Maps to the Responses API `reasoning.effort`. */
  effort?: "low" | "medium" | "high";
}

export class OpenAIBrain implements Brain {
  readonly name = "openai";
  readonly #client: OpenAI;
  readonly #model: string;
  readonly #effort: NonNullable<OpenAIBrainOptions["effort"]>;

  constructor(opts: OpenAIBrainOptions = {}) {
    this.#client = opts.client ?? new OpenAI();
    this.#model = opts.model ?? process.env["OPENAI_MODEL"] ?? DEFAULT_OPENAI_MODEL;
    this.#effort = opts.effort ?? "high";
  }

  async #ask<T extends z.ZodType>(
    schema: T,
    schemaName: string,
    instructions: string,
    context: string,
    effort: NonNullable<OpenAIBrainOptions["effort"]> = this.#effort,
  ): Promise<z.infer<T>> {
    const response = await this.#client.responses.parse({
      model: this.#model,
      instructions: TECHNICIAN_SYSTEM,
      input: `${instructions}\n\n${context}`,
      reasoning: { effort },
      text: { format: zodTextFormat(schema, schemaName) },
    });

    if (response.status === "incomplete") {
      throw new Error(
        `OpenAI response was incomplete (${response.incomplete_details?.reason ?? "unspecified"}).`,
      );
    }
    if (!response.output_parsed) {
      // A refusal arrives as a content part rather than a thrown error, so dig
      // it out and report the model's own wording.
      const refusal = findRefusal(response.output);
      throw new Error(
        refusal
          ? `OpenAI declined this request: ${refusal}`
          : "OpenAI returned no parsable structured output.",
      );
    }
    return response.output_parsed as z.infer<T>;
  }

  async intake(input: IntakeInput): Promise<Intake> {
    return this.#ask(
      WireIntake,
      "intake",
      INTAKE_INSTRUCTIONS,
      renderTicket(input.ticket),
      "low",
    );
  }

  async diagnose(input: DiagnoseInput): Promise<Diagnosis> {
    const context = [
      renderTicket(input.ticket),
      renderPriorTickets(input.priorTickets),
      `## Intake\n${JSON.stringify(input.intake, null, 2)}`,
    ].join("\n\n");
    const out = await this.#ask(
      WireDiagnosis,
      "diagnosis",
      DIAGNOSE_INSTRUCTIONS,
      context,
    );
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

    const out = await this.#ask(
      WireProposal,
      "proposal",
      PROPOSE_INSTRUCTIONS,
      context,
    );
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
    return this.#ask(
      WireDocumentation,
      "documentation",
      DOCUMENT_INSTRUCTIONS,
      context,
      "low",
    );
  }
}

/**
 * Walk the Responses output for a refusal part.
 *
 * Typed loosely on purpose: the SDK's parsed-output union does not narrow to
 * refusal parts, and this path only runs when something has already gone wrong.
 */
function findRefusal(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  for (const item of output as Record<string, unknown>[]) {
    const content = item?.["content"];
    if (!Array.isArray(content)) continue;
    for (const part of content as Record<string, unknown>[]) {
      if (typeof part?.["refusal"] === "string") return part["refusal"] as string;
    }
  }
  return undefined;
}

/** True when an OpenAI brain can actually be constructed in this environment. */
export function openaiAvailable(): boolean {
  return Boolean(process.env["OPENAI_API_KEY"]);
}
