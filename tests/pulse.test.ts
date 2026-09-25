import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandResult } from "../src/contracts/index.js";
import type { DeviceInfo } from "../src/contracts/ticket.js";
import type {
  DeviceSession,
  ScreenCapture,
  SessionCapabilities,
} from "../src/execution-plane/device.js";
import {
  createDemoPulseMonitor,
  PulseMonitor,
  type PulseTarget,
} from "../src/pulse/index.js";

const temporary: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "ait-pulse-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("demo pulse", () => {
  it("gathers honest endpoint, service and mobile evidence on a manual run", async () => {
    const monitor = createDemoPulseMonitor({
      evidenceRoot: tempRoot(),
      now: () => new Date("2026-09-24T09:30:00.000Z"),
      idFactory: () => "pulse-demo-001",
    });

    const run = await monitor.runNow();

    expect(run.run_id).toBe("pulse-demo-001");
    expect(run.trigger).toBe("manual");
    expect(run.status).toBe("critical");
    expect(run.targets.map((target) => target.kind)).toEqual([
      "endpoint",
      "service",
      "mobile",
    ]);
    expect(run.targets.every((target) => target.source === "simulated")).toBe(true);

    const endpoint = run.targets.find((target) => target.kind === "endpoint")!;
    expect(endpoint.probes[0]).toMatchObject({
      health: "healthy",
      policy: { decision: "allow", rule_id: "allow.read-only-diagnostic" },
    });
    expect(endpoint.probes[0]!.evidence?.stdout).toContain("0% loss");
    expect(endpoint.probes[1]).toMatchObject({
      health: "critical",
      metric: "NXDOMAIN",
      recommendation: "escalate",
    });
    expect(endpoint.probes[1]!.evidence?.stdout).toMatch(/can't find/i);

    const service = run.targets.find((target) => target.kind === "service")!;
    expect(service.probes[0]).toMatchObject({ health: "critical", metric: "stopped" });
    expect(service.probes[0]!.evidence?.stdout).toContain("STOPPED");

    const mobile = run.targets.find((target) => target.kind === "mobile")!;
    expect(mobile.connector).toBe("mdm");
    expect(mobile.probes[0]).toMatchObject({
      health: "warning",
      recommendation: "open-ticket",
    });
    expect(mobile.probes[0]!.evidence?.stdout).toContain('"source":"simulated-mdm"');

    expect(run.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "endpoint", recommendation: "escalate" }),
        expect.objectContaining({ kind: "service", recommendation: "escalate" }),
        expect.objectContaining({ kind: "mobile", recommendation: "open-ticket" }),
      ]),
    );

    const artifact = endpoint.probes[1]!.evidence!.artifacts[0]!;
    const artifactPath = new URL(artifact.uri);
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, "utf8")).toContain("nslookup intranet.corp.local");
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

class RecordingSession implements DeviceSession {
  readonly device: DeviceInfo = {
    device_id: "managed-1",
    hostname: "MANAGED-1",
    platform: "linux",
    consent_granted: true,
    managed: true,
  };
  readonly sessionId = "recording-session";
  execCalls = 0;
  ended = false;

  constructor(private readonly responder: (command: string) => Promise<CommandResult>) {}

  async exec(command: string): Promise<CommandResult> {
    this.execCalls += 1;
    return this.responder(command);
  }

  async capture(): Promise<ScreenCapture> {
    throw new Error("not used by pulse");
  }

  async capabilities(): Promise<SessionCapabilities> {
    return { platform: "linux", availableCommands: [], canCapture: false };
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

function oneTarget(session: RecordingSession, command = "uptime"): PulseTarget {
  return {
    id: "managed-1",
    name: "MANAGED-1",
    kind: "endpoint",
    source: "simulated",
    connector: "endpoint-agent",
    device: session.device,
    openSession: () => session,
    probes: [
      {
        id: "uptime",
        name: "Uptime",
        command,
        interpret: (result) => ({
          health: result.exit_code === 0 ? "healthy" : "warning",
          summary: result.stdout || result.stderr,
        }),
      },
    ],
  };
}

describe("pulse safety boundary", () => {
  it("never executes a command the policy engine blocks or holds", async () => {
    const session = new RecordingSession(async () => {
      throw new Error("must not run");
    });
    const monitor = new PulseMonitor({
      targets: [oneTarget(session, "rm -rf /")],
      evidenceRoot: tempRoot(),
      idFactory: () => "pulse-blocked",
    });

    const run = await monitor.runNow();
    const probe = run.targets[0]!.probes[0]!;

    expect(session.execCalls).toBe(0);
    expect(session.ended).toBe(true);
    expect(probe.health).toBe("unavailable");
    expect(probe.policy.decision).toBe("block");
    expect(probe.evidence).toBeUndefined();
    expect(run.status).toBe("degraded");
  });
});

describe("pulse scheduling", () => {
  it("exposes interval state, runs on the timer, and stops cleanly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T10:00:00.000Z"));
    const sessions: RecordingSession[] = [];
    const target: PulseTarget = {
      ...oneTarget(
        new RecordingSession(async () => ({
          command: "uptime",
          exit_code: 0,
          stdout: "up 3 days, load average: 0.25",
          stderr: "",
          duration_ms: 4,
          truncated: false,
        })),
      ),
      openSession: () => {
        const session = new RecordingSession(async (command) => ({
          command,
          exit_code: 0,
          stdout: "up 3 days, load average: 0.25",
          stderr: "",
          duration_ms: 4,
          truncated: false,
        }));
        sessions.push(session);
        return session;
      },
    };
    let sequence = 0;
    const monitor = new PulseMonitor({
      targets: [target],
      evidenceRoot: tempRoot(),
      now: () => new Date(),
      idFactory: () => `pulse-scheduled-${++sequence}`,
    });

    expect(monitor.state()).toMatchObject({ enabled: false, phase: "stopped" });
    const started = monitor.start(1_000);
    expect(started).toMatchObject({
      enabled: true,
      phase: "scheduled",
      interval_ms: 1_000,
      next_run_at: "2026-09-24T10:00:01.000Z",
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(monitor.history()).toHaveLength(1);
    expect(monitor.history()[0]).toMatchObject({
      run_id: "pulse-scheduled-1",
      trigger: "scheduled",
      status: "healthy",
    });
    expect(sessions[0]?.ended).toBe(true);
    expect(monitor.state()).toMatchObject({
      enabled: true,
      phase: "scheduled",
      next_run_at: "2026-09-24T10:00:02.000Z",
      last_run: { run_id: "pulse-scheduled-1", status: "healthy" },
    });

    monitor.stop();
    expect(monitor.state()).toMatchObject({ enabled: false, phase: "stopped" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(monitor.history()).toHaveLength(1);
  });

  it("coalesces overlapping manual requests instead of hitting a target twice", async () => {
    let release!: (result: CommandResult) => void;
    const pending = new Promise<CommandResult>((resolve) => {
      release = resolve;
    });
    const session = new RecordingSession(() => pending);
    const monitor = new PulseMonitor({
      targets: [oneTarget(session)],
      evidenceRoot: tempRoot(),
      idFactory: () => "pulse-one",
    });

    const first = monitor.runNow();
    const second = monitor.runNow();
    expect(second).toBe(first);
    release({
      command: "uptime",
      exit_code: 0,
      stdout: "up 1 day",
      stderr: "",
      duration_ms: 2,
      truncated: false,
    });

    await expect(first).resolves.toMatchObject({ run_id: "pulse-one", status: "healthy" });
    expect(session.execCalls).toBe(1);
    expect(monitor.history()).toHaveLength(1);
  });
});
