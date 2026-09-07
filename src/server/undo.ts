/**
 * Undoing a change from the console.
 *
 * A rollback that only exists as a sentence in a ticket is a promise, not a
 * capability. This runs the recorded `rollback_command` against the same
 * device, through the same policy engine, and records it in the same way.
 *
 * Three things it deliberately does not do:
 *
 *   - It does not trust the stored command. An undo goes through `evaluate()`
 *     exactly as the original step did, and a rollback that would cross a
 *     guardrail is refused like anything else. "It is only an undo" is not a
 *     reason to skip the gate.
 *   - It does not invent a rollback where none was recorded. A flushed DNS
 *     cache refills itself and has no undo; offering one would be a lie.
 *   - It does not run twice. An undo already applied is reported as such
 *     rather than repeated.
 */
import { evaluate } from "../control-plane/policy/engine.js";
import { executeStep } from "../execution-plane/executor.js";
import { EvidenceStore } from "../execution-plane/evidence-store.js";
import { newId, nowIso, type PlanStep, type Run, type StepResult } from "../contracts/index.js";
import type { DeviceSession } from "../execution-plane/device.js";

export interface UndoableChange {
  /** The id of the step that made the change. */
  stepId: string;
  intent: string;
  command: string;
  rollback: string;
  rollbackCommand: string;
  /** Set once this change has been undone. */
  undone?: boolean;
}

/**
 * The changes in a finished run that could still be reversed.
 *
 * A step qualifies only if it actually ran, actually changed something, and
 * recorded a command that would reverse it.
 */
export function undoableChanges(run: Run): UndoableChange[] {
  return run.results
    .filter(
      (r) =>
        r.outcome === "success" &&
        r.step.mutating &&
        typeof r.step.rollback_command === "string" &&
        r.step.rollback_command.trim() !== "",
    )
    .map((r) => ({
      stepId: r.step.id,
      intent: r.step.intent,
      command: String(r.step.payload["command"] ?? ""),
      rollback: r.step.rollback ?? "",
      rollbackCommand: r.step.rollback_command!,
    }));
}

export interface UndoOutcome {
  ok: boolean;
  result?: StepResult;
  error?: string;
}

export async function undoChange(
  run: Run,
  stepId: string,
  session: DeviceSession | undefined,
  evidenceRoot: string,
  approver: string,
): Promise<UndoOutcome> {
  const change = undoableChanges(run).find((c) => c.stepId === stepId);
  if (!change) {
    return { ok: false, error: "That step is not one this run can undo." };
  }
  if (!session) {
    return { ok: false, error: "The device session for that run is no longer open." };
  }

  const step: PlanStep = {
    id: newId("undo"),
    kind: "command",
    intent: `Undo: ${change.intent}`,
    payload: { command: change.rollbackCommand, undoes: change.stepId },
    mutating: true,
    // Reversing the reversal is the original command.
    rollback: `Re-apply the original change with \`${change.command}\`.`,
    rollback_command: change.command,
  };

  // Same gate as any other change. An undo is still a change.
  const verdict = evaluate(step, {
    ...(run.ticket.device ? { device: run.ticket.device } : {}),
  });

  if (verdict.decision === "block") {
    return {
      ok: false,
      error: `The rollback itself crosses a guardrail (${verdict.rule_id}): ${verdict.reason}`,
    };
  }

  // A technician clicking Undo *is* the approval, and it is recorded as theirs.
  const cleared = {
    ...verdict,
    decision: "allow" as const,
    reason: `${verdict.reason} Undo authorised by ${approver} at the console.`,
  };

  const evidence = new EvidenceStore(evidenceRoot, run.run_id);
  const result = await executeStep(step, cleared, { session, evidence });

  // Recorded on the run itself, so the ticket and the audit trail show the
  // change and its reversal rather than only the change.
  run.results.push(result);
  run.audit.push({
    seq: run.audit.length,
    event: "step.executed",
    at: nowIso(),
    run_id: run.run_id,
    ticket_id: run.ticket.id,
    actor: "human",
    summary: `${result.outcome}: undo of "${change.intent}" by ${approver}`,
    detail: {
      undoes: change.stepId,
      command: change.rollbackCommand,
      exit_code: result.command?.exit_code ?? null,
    },
  });

  return { ok: result.outcome === "success", result };
}
