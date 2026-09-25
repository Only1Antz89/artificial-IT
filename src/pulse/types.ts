import type {
  ArtifactRef,
  CommandResult,
  PolicyVerdict,
} from "../contracts/index.js";
import type { DeviceInfo } from "../contracts/ticket.js";
import type { DeviceSession } from "../execution-plane/device.js";

/** The three surfaces the stakeholder demo promises to watch. */
export type PulseTargetKind = "endpoint" | "service" | "mobile";

/** A probe is observational: remediation is deliberately a separate workflow. */
export type PulseHealth = "healthy" | "warning" | "critical" | "unavailable";
export type PulseTrigger = "manual" | "scheduled";
export type PulseRunStatus = "healthy" | "degraded" | "critical";
export type PulseSource = "simulated" | "live";
export type PulseConnector =
  | "endpoint-agent"
  | "meshcentral"
  | "service-api"
  | "mdm";

export interface PulseFinding {
  health: PulseHealth;
  summary: string;
  /** A short value suitable for a fleet card, for example `96% used`. */
  metric?: string;
}

export interface PulseProbe {
  id: string;
  name: string;
  /** Must be a read-only command accepted by the existing policy engine. */
  command: string;
  interpret: (result: CommandResult) => PulseFinding;
}

export interface PulseTarget {
  id: string;
  name: string;
  kind: PulseTargetKind;
  source: PulseSource;
  connector: PulseConnector;
  device: DeviceInfo;
  openSession: () => DeviceSession | Promise<DeviceSession>;
  probes: PulseProbe[];
}

/** Exact output retained from the session, plus the content-addressed artefact. */
export interface PulseEvidence {
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  truncated: boolean;
  artifacts: ArtifactRef[];
}

export type PulseRecommendation =
  | "none"
  | "open-ticket"
  | "escalate"
  | "investigate-monitoring";

export interface PulseProbeResult extends PulseFinding {
  probe_id: string;
  probe_name: string;
  checked_at: string;
  policy: PolicyVerdict;
  recommendation: PulseRecommendation;
  evidence?: PulseEvidence;
}

export interface PulseTargetResult {
  target_id: string;
  target_name: string;
  kind: PulseTargetKind;
  source: PulseSource;
  connector: PulseConnector;
  device: DeviceInfo;
  health: PulseHealth;
  probes: PulseProbeResult[];
}

export interface PulseAlert {
  target_id: string;
  target_name: string;
  kind: PulseTargetKind;
  probe_id: string;
  health: Exclude<PulseHealth, "healthy">;
  summary: string;
  recommendation: Exclude<PulseRecommendation, "none">;
}

export interface PulseCounts {
  healthy: number;
  warning: number;
  critical: number;
  unavailable: number;
}

export interface PulseRun {
  run_id: string;
  trigger: PulseTrigger;
  status: PulseRunStatus;
  started_at: string;
  finished_at: string;
  counts: PulseCounts;
  targets: PulseTargetResult[];
  alerts: PulseAlert[];
}

export interface PulseMonitorState {
  enabled: boolean;
  phase: "stopped" | "scheduled" | "running";
  interval_ms?: number;
  next_run_at?: string;
  active_run_id?: string;
  last_run?: Pick<PulseRun, "run_id" | "trigger" | "status" | "finished_at" | "counts">;
  last_error?: string;
}

