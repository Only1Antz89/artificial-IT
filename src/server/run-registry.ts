/**
 * Live runs, held in memory.
 *
 * The batch console could just await a run and render the result. A technician
 * cannot: the whole point of the approval gate is that a person is asked
 * mid-run, so the run has to be observable while it is still going and
 * interruptible by a decision that arrives from outside it.
 *
 * So a run becomes a small state machine here: events accumulate and fan out to
 * whoever is watching, and a pending approval is a promise held open until
 * someone in a browser resolves it.
 *
 * Everything is per-process and non-durable. That is the right trade for a
 * console you watch while it happens; a queue that must survive a restart is a
 * different feature with a different backing store.
 */
import { randomUUID } from "node:crypto";
import type { RunEvent } from "../agent/loop.js";
import type { PlanStep, PolicyVerdict, Run } from "../contracts/index.js";
import type {
  ApprovalGate,
  ApprovalOutcome,
  ApprovalRequest,
} from "../control-plane/approvals.js";

export interface PendingApproval {
  id: string;
  step: PlanStep;
  verdict: PolicyVerdict;
  justification: string;
  requestedAt: string;
}

/** What the browser receives. A superset of RunEvent with the UI's own events. */
export type StreamEvent =
  | { type: "started"; runId: string; provider: string; model: string; note: string }
  | { type: "host"; hostname: string; platform: string; tools: number; canCapture: boolean; captureNote?: string }
  | RunEvent
  | { type: "approval-requested"; approval: PendingApproval }
  | { type: "approval-resolved"; id: string; approved: boolean; approver: string; reason: string }
  | { type: "error"; message: string }
  | { type: "done"; run: Run; internalNote: string };

type Subscriber = (event: StreamEvent) => void;

export class RunSession {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  status: "running" | "finished" | "failed" = "running";

  #events: StreamEvent[] = [];
  #subscribers = new Set<Subscriber>();
  #pending = new Map<string, { approval: PendingApproval; resolve: (o: ApprovalOutcome) => void }>();

  /** Replayed to a subscriber that connects mid-run, so nothing is missed. */
  history(): StreamEvent[] {
    return [...this.#events];
  }

  emit(event: StreamEvent): void {
    this.#events.push(event);
    for (const subscriber of this.#subscribers) {
      // One broken pipe must not stop the others - or the run.
      try {
        subscriber(event);
      } catch {
        /* the subscriber has gone; the SSE handler will clean it up */
      }
    }
  }

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  pending(): PendingApproval[] {
    return [...this.#pending.values()].map((p) => p.approval);
  }

  /**
   * The approval gate the browser drives.
   *
   * Returns a promise that stays unresolved until a person decides, or until
   * the timeout. The timeout denies rather than approves: if nobody is
   * watching, the safe answer is no.
   */
  gate(timeoutMs = 10 * 60 * 1000): ApprovalGate {
    const session = this;
    return {
      name: "browser",
      async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
        const approval: PendingApproval = {
          id: randomUUID(),
          step: request.step,
          verdict: request.verdict,
          justification: request.justification,
          requestedAt: new Date().toISOString(),
        };

        return new Promise<ApprovalOutcome>((resolve) => {
          const timer = setTimeout(() => {
            session.#pending.delete(approval.id);
            const outcome: ApprovalOutcome = {
              approved: false,
              approver: "timeout",
              reason: `Nobody answered within ${Math.round(timeoutMs / 60000)} minutes, so the change was not made.`,
            };
            session.emit({
              type: "approval-resolved",
              id: approval.id,
              approved: false,
              approver: outcome.approver,
              reason: outcome.reason,
            });
            resolve(outcome);
          }, timeoutMs);

          session.#pending.set(approval.id, {
            approval,
            resolve: (outcome) => {
              clearTimeout(timer);
              resolve(outcome);
            },
          });
          session.emit({ type: "approval-requested", approval });
        });
      },
    };
  }

  /** Resolve a pending approval from the browser. Returns false if unknown. */
  decide(id: string, approved: boolean, approver: string, reason: string): boolean {
    const entry = this.#pending.get(id);
    if (!entry) return false;
    this.#pending.delete(id);
    this.emit({ type: "approval-resolved", id, approved, approver, reason });
    entry.resolve({ approved, approver, reason });
    return true;
  }

  finish(status: "finished" | "failed"): void {
    this.status = status;
    // Any approval still outstanding is answered "no" - a finished run must not
    // leave a promise dangling that could later act on the device.
    for (const [id, entry] of this.#pending) {
      this.#pending.delete(id);
      entry.resolve({
        approved: false,
        approver: "system",
        reason: "The run ended before this was answered.",
      });
    }
  }
}

/**
 * All live runs.
 *
 * Bounded, because a long-lived console would otherwise accumulate every run
 * it has ever shown. Oldest finished runs are dropped first; a running one is
 * never evicted.
 */
export class RunRegistry {
  #runs = new Map<string, RunSession>();

  constructor(private readonly maxRuns = 25) {}

  create(): RunSession {
    this.#evict();
    const session = new RunSession();
    this.#runs.set(session.id, session);
    return session;
  }

  get(id: string): RunSession | undefined {
    return this.#runs.get(id);
  }

  list(): RunSession[] {
    return [...this.#runs.values()];
  }

  /**
   * Drop finished runs until the registry is back under its cap.
   *
   * Evicting one per create never converged: after a burst, the map stayed at
   * whatever high-water mark it reached. A running run is never evicted - it
   * may have a browser watching it and an approval waiting on a person - so a
   * genuinely concurrent burst can still exceed the cap, and that is the right
   * trade.
   */
  #evict(): void {
    if (this.#runs.size < this.maxRuns) return;

    const finished = [...this.#runs.values()]
      .filter((r) => r.status !== "running")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    // Room for the one about to be created, hence maxRuns - 1.
    let over = this.#runs.size - (this.maxRuns - 1);
    for (const victim of finished) {
      if (over <= 0) break;
      this.#runs.delete(victim.id);
      over -= 1;
    }
  }
}
