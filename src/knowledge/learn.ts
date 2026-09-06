/**
 * Turning a finished run into something the next run can use.
 *
 * The entry is built from the run's *evidence*, not from the model's summary of
 * it: the diagnostic steps recorded are the commands that actually ran and
 * succeeded, and the resolution steps are the mutating ones that were actually
 * approved and carried out. A run that escalated still produces an entry -
 * knowing that a class of ticket always needs a human is worth remembering.
 */
import type { Run } from "../contracts/index.js";
import { newId } from "../contracts/index.js";
import type { KnowledgeEntry, KnowledgeStore } from "./store.js";

export interface LearnResult {
  entry?: KnowledgeEntry;
  /** Why nothing was learned, when nothing was. */
  skipped_reason?: string;
}

export function learnFromRun(store: KnowledgeStore, run: Run): LearnResult {
  if (run.status !== "resolved" && run.status !== "escalated") {
    return { skipped_reason: `Run is still ${run.status}; nothing settled to learn from.` };
  }
  if (!run.intake) {
    return { skipped_reason: "Run never completed intake." };
  }

  const executed = run.results.filter((r) => r.outcome === "success");
  const diagnostic_steps = executed
    .filter((r) => r.step.kind === "command" && !r.step.mutating)
    .map((r) => String(r.step.payload["command"] ?? r.step.intent));
  const resolution_steps = executed
    .filter((r) => r.step.mutating)
    .map((r) => String(r.step.payload["command"] ?? r.step.intent));

  const refused = run.results.filter(
    (r) => r.outcome === "blocked" || r.outcome === "awaiting_approval",
  );

  // A run that observed nothing, changed nothing and was refused nothing has no
  // lesson in it - recording one would just add noise to future retrieval. But
  // a run where everything was refused is very much worth remembering: next
  // time this class of ticket arrives we already know where it ends up.
  if (
    diagnostic_steps.length === 0 &&
    resolution_steps.length === 0 &&
    refused.length === 0 &&
    !run.escalation?.triggered
  ) {
    return { skipped_reason: "Run produced nothing worth recording." };
  }

  const cautions = [
    ...new Set(
      refused.flatMap((r) => r.verdict.categories.filter((c) => c !== "routine")),
    ),
  ].map((c) => `Tickets like this tend to run into the "${c}" guardrail.`);

  if (run.escalation?.triggered) {
    cautions.push(
      `Previously escalated to ${run.escalation.route_to} (${run.escalation.triggers.join(", ")}).`,
    );
  }

  const entry = store.add({
    id: newId("kb"),
    source_ticket_id: run.ticket.id,
    title: run.documentation?.title ?? run.intake.summary,
    category: run.intake.category,
    platform: normalisePlatform(run.ticket.device?.platform),
    symptoms: run.intake.reported_symptoms.length
      ? run.intake.reported_symptoms
      : [run.ticket.subject],
    root_cause:
      run.documentation?.root_cause ??
      run.diagnosis?.root_cause ??
      "Not established.",
    diagnostic_steps,
    resolution_steps,
    cautions,
    times_applied: 0,
    outcome: run.status === "resolved" ? "resolved" : "escalated",
  });

  return { entry };
}

/** The device contract allows "unknown"; the knowledge base calls that "any". */
function normalisePlatform(
  platform: "windows" | "macos" | "linux" | "unknown" | undefined,
): KnowledgeEntry["platform"] {
  return platform === undefined || platform === "unknown" ? "any" : platform;
}
