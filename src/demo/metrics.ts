/**
 * Shift metrics.
 *
 * The numbers a service-desk manager asks for, computed from finished runs
 * rather than asserted. Two rules shape what is in here:
 *
 *   - Anything derived from the model's own estimate is labelled an estimate.
 *     `time_saved_estimate_minutes` is a guess and is presented as one; the
 *     count of tickets resolved is a fact and is presented as one.
 *   - Nothing is inferred that the runs do not support. There is no
 *     "customer satisfaction" here because nothing in a run measures it.
 */
import type { Run } from "../contracts/index.js";

export interface ShiftMetrics {
  worked: number;
  resolved: number;
  escalated: number;
  /** Runs that ended without resolving or escalating - stuck on a person. */
  waiting: number;
  /** Share of tickets closed without a human, 0-1. */
  autoResolutionRate: number;
  escalationRate: number;
  /** Guardrail refusals across the shift. */
  blockedActions: number;
  /** Changes actually made to devices. */
  changesApplied: number;
  /** Steps held for a technician's decision. */
  approvalsRequested: number;
  /**
   * Mean wall-clock seconds per ticket, resolved ones only.
   *
   * Kept fractional. A simulated device answers instantly, so rounding to whole
   * seconds reported every run as taking 0s - which is not a measurement, it is
   * a rounding artefact.
   */
  meanTimeToResolveSeconds: number;
  /** Median, which is the honest one when a single ticket runs long. */
  medianTimeToResolveSeconds: number;
  /** Sum of the model's own per-ticket estimates. An estimate, not a measure. */
  estimatedMinutesSaved: number;
  /** Prior tickets recalled across the shift. */
  knowledgeHits: number;
  /** Guardrail categories that fired, most frequent first. */
  refusedCategories: { category: string; count: number }[];
}

function seconds(run: Run): number {
  if (!run.finished_at) return 0;
  return Math.max(
    0,
    (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000,
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function shiftMetrics(runs: Run[]): ShiftMetrics {
  const worked = runs.length;
  const resolved = runs.filter((r) => r.status === "resolved");
  const escalated = runs.filter((r) => r.status === "escalated");

  const categories = new Map<string, number>();
  let blockedActions = 0;
  let changesApplied = 0;
  let approvalsRequested = 0;

  for (const run of runs) {
    for (const result of run.results) {
      if (result.outcome === "blocked") {
        blockedActions += 1;
        for (const category of result.verdict.categories) {
          if (category === "routine") continue;
          categories.set(category, (categories.get(category) ?? 0) + 1);
        }
      }
      if (result.outcome === "awaiting_approval") approvalsRequested += 1;
      if (result.verdict.reason.includes("Approved by")) approvalsRequested += 1;
      if (result.outcome === "success" && result.step.mutating) changesApplied += 1;
    }
  }

  const resolvedTimes = resolved.map(seconds).filter((s) => s > 0);
  const mean =
    resolvedTimes.length === 0
      ? 0
      : resolvedTimes.reduce((a, b) => a + b, 0) / resolvedTimes.length;

  return {
    worked,
    resolved: resolved.length,
    escalated: escalated.length,
    waiting: worked - resolved.length - escalated.length,
    autoResolutionRate: worked === 0 ? 0 : resolved.length / worked,
    escalationRate: worked === 0 ? 0 : escalated.length / worked,
    blockedActions,
    changesApplied,
    approvalsRequested,
    // Three decimals, not two: a simulated device answers in single-digit
    // milliseconds, and two decimals rounds that to zero - reporting a real
    // measurement as if nothing had been measured.
    meanTimeToResolveSeconds: Number(mean.toFixed(3)),
    medianTimeToResolveSeconds: Number(median(resolvedTimes).toFixed(3)),
    estimatedMinutesSaved: runs.reduce(
      (sum, r) => sum + (r.documentation?.time_saved_estimate_minutes ?? 0),
      0,
    ),
    knowledgeHits: runs.reduce((sum, r) => sum + r.knowledge_used.length, 0),
    refusedCategories: [...categories.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
  };
}
