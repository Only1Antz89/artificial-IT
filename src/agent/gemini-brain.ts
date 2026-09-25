/** Google Gemini implementation of the governed technician brain. */
import { GoogleGenAI } from "@google/genai";
import { z, type ZodType } from "zod";
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

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-pro";

export interface GeminiBrainOptions {
  client?: GoogleGenAI;
  model?: string;
}

export class GeminiBrain implements Brain {
  readonly name = "gemini";
  readonly #client: GoogleGenAI;
  readonly #model: string;

  constructor(opts: GeminiBrainOptions = {}) {
    this.#client = opts.client ?? new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"] });
    this.#model = opts.model ?? process.env["GEMINI_MODEL"] ?? DEFAULT_GEMINI_MODEL;
  }

  async #ask<T extends ZodType>(
    schema: T,
    instructions: string,
    context: string,
  ): Promise<z.infer<T>> {
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    // Gemini accepts JSON Schema, but the dialect declaration is unnecessary
    // and older API versions reject it even though the schema itself is valid.
    delete jsonSchema["$schema"];

    const response = await this.#client.models.generateContent({
      model: this.#model,
      contents: `${instructions}\n\n${context}`,
      config: {
        systemInstruction: TECHNICIAN_SYSTEM,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchema,
      },
    });

    const text = response.text;
    if (!text) throw new Error("Gemini returned no structured output.");
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new Error("Gemini returned invalid JSON structured output.");
    }
    return schema.parse(decoded);
  }

  async intake(input: IntakeInput): Promise<Intake> {
    return this.#ask(WireIntake, INTAKE_INSTRUCTIONS, renderTicket(input.ticket));
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
    return this.#ask(WireDocumentation, DOCUMENT_INSTRUCTIONS, context);
  }
}

export function geminiAvailable(): boolean {
  return Boolean(process.env["GEMINI_API_KEY"]);
}
