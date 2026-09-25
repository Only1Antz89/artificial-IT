/**
 * A small proactive health monitor.
 *
 * Pulse never remediates. It gathers read-only evidence through the same
 * policy engine and executor as ticket work, classifies the observations, and
 * recommends the next workflow. A warning may suggest opening a ticket and a
 * critical result may suggest escalation, but this class never claims either
 * happened. That separation keeps an unattended timer from becoming a hidden
 * remote-control path.
 */
import { join } from "node:path";
import type { PlanStep } from "../contracts/index.js";
import { evaluate } from "../control-plane/policy/engine.js";
import { EvidenceStore } from "../execution-plane/evidence-store.js";
import { executeStep } from "../execution-plane/executor.js";
import type {
  PulseAlert,
  PulseCounts,
  PulseHealth,
  PulseMonitorState,
  PulseProbe,
  PulseProbeResult,
  PulseRecommendation,
  PulseRun,
  PulseRunStatus,
  PulseTarget,
  PulseTargetResult,
  PulseTrigger,
} from "./types.js";

export interface PulseMonitorOptions {
  targets: PulseTarget[];
  evidenceRoot?: string;
  historyLimit?: number;
  now?: () => Date;
  idFactory?: (at: Date, sequence: number) => string;
}

type PulseListener = (run: PulseRun) => void;

const HEALTH_RANK: Record<PulseHealth, number> = {
  healthy: 0,
  warning: 1,
  unavailable: 2,
  critical: 3,
};

function safeSegment(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "probe";
}

function worstHealth(values: PulseHealth[]): PulseHealth {
  if (values.length === 0) return "unavailable";
  return values.reduce((worst, value) =>
    HEALTH_RANK[value] > HEALTH_RANK[worst] ? value : worst,
  );
}

function recommendationFor(health: PulseHealth): PulseRecommendation {
  switch (health) {
    case "healthy":
      return "none";
    case "warning":
      return "open-ticket";
    case "critical":
      return "escalate";
    case "unavailable":
      return "investigate-monitoring";
  }
}

function countTargets(targets: PulseTargetResult[]): PulseCounts {
  const counts: PulseCounts = { healthy: 0, warning: 0, critical: 0, unavailable: 0 };
  for (const target of targets) counts[target.health] += 1;
  return counts;
}

function statusFor(counts: PulseCounts): PulseRunStatus {
  if (counts.critical > 0) return "critical";
  if (counts.warning > 0 || counts.unavailable > 0) return "degraded";
  return "healthy";
}

function asAlert(target: PulseTargetResult, probe: PulseProbeResult): PulseAlert | undefined {
  if (probe.health === "healthy" || probe.recommendation === "none") return undefined;
  return {
    target_id: target.target_id,
    target_name: target.target_name,
    kind: target.kind,
    probe_id: probe.probe_id,
    health: probe.health,
    summary: probe.summary,
    recommendation: probe.recommendation,
  };
}

export class PulseMonitor {
  readonly #targets: PulseTarget[];
  readonly #evidenceRoot: string;
  readonly #historyLimit: number;
  readonly #now: () => Date;
  readonly #idFactory: (at: Date, sequence: number) => string;
  readonly #listeners = new Set<PulseListener>();
  readonly #history: PulseRun[] = [];

  #timer?: ReturnType<typeof setInterval>;
  #intervalMs?: number;
  #nextRunAt?: string;
  #inFlight?: Promise<PulseRun>;
  #activeRunId?: string;
  #lastError?: string;
  #sequence = 0;

  constructor(options: PulseMonitorOptions) {
    if (options.targets.length === 0) throw new Error("Pulse needs at least one target.");
    this.#targets = [...options.targets];
    this.#evidenceRoot = options.evidenceRoot ?? join("run-artifacts", "pulse");
    this.#historyLimit = options.historyLimit ?? 20;
    if (!Number.isInteger(this.#historyLimit) || this.#historyLimit < 1) {
      throw new Error("historyLimit must be a positive integer.");
    }
    this.#now = options.now ?? (() => new Date());
    this.#idFactory =
      options.idFactory ??
      ((at, sequence) => `pulse_${at.getTime().toString(36)}_${sequence.toString(36)}`);
  }

  /** Current scheduler state; returned by value so callers cannot mutate it. */
  state(): PulseMonitorState {
    const last = this.#history[0];
    return {
      enabled: this.#timer !== undefined,
      phase: this.#inFlight ? "running" : this.#timer ? "scheduled" : "stopped",
      ...(this.#intervalMs !== undefined ? { interval_ms: this.#intervalMs } : {}),
      ...(this.#nextRunAt ? { next_run_at: this.#nextRunAt } : {}),
      ...(this.#activeRunId ? { active_run_id: this.#activeRunId } : {}),
      ...(last
        ? {
            last_run: {
              run_id: last.run_id,
              trigger: last.trigger,
              status: last.status,
              finished_at: last.finished_at,
              counts: { ...last.counts },
            },
          }
        : {}),
      ...(this.#lastError ? { last_error: this.#lastError } : {}),
    };
  }

  /** Newest first; snapshots themselves are immutable-by-convention DTOs. */
  history(): PulseRun[] {
    return [...this.#history];
  }

  subscribe(listener: PulseListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Run one pulse immediately. Concurrent requests share the same run. */
  runNow(): Promise<PulseRun> {
    return this.#begin("manual");
  }

  /** Enable recurring checks. Calling start again changes the interval safely. */
  start(intervalMs: number): PulseMonitorState {
    if (!Number.isInteger(intervalMs) || intervalMs < 250) {
      throw new Error("Pulse interval must be an integer of at least 250ms.");
    }
    if (this.#timer) clearInterval(this.#timer);
    this.#intervalMs = intervalMs;
    this.#setNextRun();
    this.#timer = setInterval(() => {
      this.#setNextRun();
      void this.#begin("scheduled").catch((error: unknown) => {
        this.#lastError = error instanceof Error ? error.message : String(error);
      });
    }, intervalMs);
    // A demo process can still exit cleanly if the only work left is Pulse.
    this.#timer.unref?.();
    return this.state();
  }

  stop(): PulseMonitorState {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#intervalMs = undefined;
    this.#nextRunAt = undefined;
    return this.state();
  }

  #setNextRun(): void {
    this.#nextRunAt = new Date(this.#now().getTime() + (this.#intervalMs ?? 0)).toISOString();
  }

  #begin(trigger: PulseTrigger): Promise<PulseRun> {
    if (this.#inFlight) return this.#inFlight;

    const started = this.#now();
    this.#sequence += 1;
    const runId = this.#idFactory(started, this.#sequence);
    this.#activeRunId = runId;
    this.#lastError = undefined;

    const work = this.#execute(runId, trigger, started)
      .then((run) => {
        this.#history.unshift(run);
        if (this.#history.length > this.#historyLimit) this.#history.length = this.#historyLimit;
        for (const listener of this.#listeners) listener(run);
        return run;
      })
      .catch((error: unknown) => {
        this.#lastError = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        this.#inFlight = undefined;
        this.#activeRunId = undefined;
      });

    this.#inFlight = work;
    return work;
  }

  async #execute(runId: string, trigger: PulseTrigger, started: Date): Promise<PulseRun> {
    const evidence = new EvidenceStore(this.#evidenceRoot, runId);
    const targets: PulseTargetResult[] = [];
    // Sequential order makes a projected demo feed stable and avoids a pulse
    // stampeding every endpoint at once when the timer fires.
    for (const target of this.#targets) {
      targets.push(await this.#checkTarget(runId, target, evidence));
    }

    const counts = countTargets(targets);
    const alerts = targets.flatMap((target) =>
      target.probes.flatMap((probe) => {
        const alert = asAlert(target, probe);
        return alert ? [alert] : [];
      }),
    );

    return {
      run_id: runId,
      trigger,
      status: statusFor(counts),
      started_at: started.toISOString(),
      finished_at: this.#now().toISOString(),
      counts,
      targets,
      alerts,
    };
  }

  async #checkTarget(
    runId: string,
    target: PulseTarget,
    evidence: EvidenceStore,
  ): Promise<PulseTargetResult> {
    let session: Awaited<ReturnType<PulseTarget["openSession"]>> | undefined;
    const probes: PulseProbeResult[] = [];

    try {
      session = await target.openSession();
      for (const probe of target.probes) {
        probes.push(await this.#checkProbe(runId, target, probe, session, evidence));
      }
    } catch (error) {
      const summary = `Could not open the ${target.connector} health channel: ${
        error instanceof Error ? error.message : String(error)
      }`;
      for (const probe of target.probes) {
        probes.push({
          probe_id: probe.id,
          probe_name: probe.name,
          checked_at: this.#now().toISOString(),
          health: "unavailable",
          summary,
          policy: {
            decision: "block",
            categories: ["routine"],
            reason: "No health session was available, so no command was attempted.",
            rule_id: "block.no-pulse-session",
            escalate: false,
          },
          recommendation: "investigate-monitoring",
        });
      }
    } finally {
      await session?.end().catch(() => undefined);
    }

    return {
      target_id: target.id,
      target_name: target.name,
      kind: target.kind,
      source: target.source,
      connector: target.connector,
      device: { ...target.device },
      health: worstHealth(probes.map((probe) => probe.health)),
      probes,
    };
  }

  async #checkProbe(
    runId: string,
    target: PulseTarget,
    probe: PulseProbe,
    session: Awaited<ReturnType<PulseTarget["openSession"]>>,
    evidence: EvidenceStore,
  ): Promise<PulseProbeResult> {
    const step: PlanStep = {
      id: `${safeSegment(runId)}-${safeSegment(target.id)}-${safeSegment(probe.id)}`,
      kind: "command",
      intent: `Periodic read-only health check: ${probe.name}`,
      payload: { command: probe.command },
      mutating: false,
    };
    const policy = evaluate(step, { device: session.device });
    const checkedAt = this.#now().toISOString();

    if (policy.decision !== "allow") {
      return {
        probe_id: probe.id,
        probe_name: probe.name,
        checked_at: checkedAt,
        health: "unavailable",
        summary: `Pulse did not run this probe: ${policy.reason}`,
        policy,
        recommendation: "investigate-monitoring",
      };
    }

    const executed = await executeStep(step, policy, { session, evidence });
    if (!executed.command) {
      return {
        probe_id: probe.id,
        probe_name: probe.name,
        checked_at: checkedAt,
        health: "unavailable",
        summary: executed.error ?? executed.observation,
        policy,
        recommendation: "investigate-monitoring",
      };
    }

    try {
      const finding = probe.interpret(executed.command);
      return {
        probe_id: probe.id,
        probe_name: probe.name,
        checked_at: checkedAt,
        ...finding,
        policy,
        recommendation: recommendationFor(finding.health),
        evidence: {
          command: executed.command.command,
          exit_code: executed.command.exit_code,
          stdout: executed.command.stdout,
          stderr: executed.command.stderr,
          duration_ms: executed.command.duration_ms,
          truncated: executed.command.truncated,
          artifacts: [...executed.artifacts],
        },
      };
    } catch (error) {
      return {
        probe_id: probe.id,
        probe_name: probe.name,
        checked_at: checkedAt,
        health: "unavailable",
        summary: `The diagnostic ran, but its output could not be interpreted: ${
          error instanceof Error ? error.message : String(error)
        }`,
        policy,
        recommendation: "investigate-monitoring",
        evidence: {
          command: executed.command.command,
          exit_code: executed.command.exit_code,
          stdout: executed.command.stdout,
          stderr: executed.command.stderr,
          duration_ms: executed.command.duration_ms,
          truncated: executed.command.truncated,
          artifacts: [...executed.artifacts],
        },
      };
    }
  }
}

