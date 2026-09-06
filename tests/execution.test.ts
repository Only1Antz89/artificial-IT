/**
 * Executor, session and approval-gate tests.
 *
 * The property under test throughout: nothing reaches the device without an
 * `allow` verdict, and what did happen is recorded truthfully - including when
 * it went wrong.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeStep } from "../src/execution-plane/executor.js";
import { EvidenceStore } from "../src/execution-plane/evidence-store.js";
import { LocalDeviceSession, SimulatedDeviceSession } from "../src/execution-plane/device.js";
import { MeshCentralSession } from "../src/execution-plane/remote.js";
import {
  AutoDenyGate,
  InteractiveGate,
  PolicyBoundGate,
} from "../src/control-plane/approvals.js";
import { makeWindowsDnsDevice, WIN_LAPTOP } from "../src/demo/devices.js";
import type { PlanStep, PolicyVerdict } from "../src/contracts/index.js";

let workdir: string;
let evidence: EvidenceStore;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "ait-exec-"));
  evidence = new EvidenceStore(workdir, "run-1");
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const ALLOW: PolicyVerdict = {
  decision: "allow",
  categories: ["routine"],
  reason: "ok",
  rule_id: "allow.test",
  escalate: false,
};
const BLOCK: PolicyVerdict = { ...ALLOW, decision: "block", rule_id: "block.test", reason: "no" };
const GATED: PolicyVerdict = { ...ALLOW, decision: "require_approval", rule_id: "approve.test" };

function step(overrides: Partial<PlanStep>): PlanStep {
  return {
    id: "s1",
    kind: "command",
    intent: "do a thing",
    payload: {},
    mutating: false,
    ...overrides,
  } as PlanStep;
}

describe("the executor refuses anything not cleared", () => {
  it("does not run a blocked step", async () => {
    const session = makeWindowsDnsDevice();
    const result = await executeStep(
      step({ payload: { command: "ipconfig /flushdns" } }),
      BLOCK,
      { session, evidence },
    );
    expect(result.outcome).toBe("blocked");
    expect(result.command).toBeUndefined();
    // The device was genuinely not touched.
    expect(session.state["dns_cache_stale"]).toBe(true);
  });

  it("does not run a step still awaiting approval", async () => {
    const session = makeWindowsDnsDevice();
    const result = await executeStep(
      step({ payload: { command: "ipconfig /flushdns" } }),
      GATED,
      { session, evidence },
    );
    expect(result.outcome).toBe("awaiting_approval");
    expect(session.state["dns_cache_stale"]).toBe(true);
  });
});

describe("the executor reports the truth", () => {
  it("marks a non-zero exit as failed and keeps the output", async () => {
    const result = await executeStep(
      step({ payload: { command: "nslookup intranet.corp.local" } }),
      ALLOW,
      { session: makeWindowsDnsDevice(), evidence },
    );
    expect(result.outcome).toBe("failed");
    expect(result.command?.exit_code).toBe(1);
    expect(result.error).toBeTruthy();
    expect(result.artifacts.length).toBe(1);
  });

  it("does not invent output for a command the device does not have", async () => {
    const result = await executeStep(
      step({ payload: { command: "totally-made-up-tool --go" } }),
      ALLOW,
      { session: makeWindowsDnsDevice(), evidence },
    );
    expect(result.outcome).toBe("failed");
    expect(result.command?.exit_code).toBe(127);
    expect(result.command?.stdout).toBe("");
  });

  it("pauses rather than fabricating an answer from the user", async () => {
    const result = await executeStep(
      step({ kind: "ask_user", payload: { question: "When did it start?" } }),
      ALLOW,
      { evidence },
    );
    expect(result.outcome).toBe("awaiting_user");
  });

  it("uses an answer when one is available", async () => {
    const result = await executeStep(
      step({ kind: "ask_user", payload: { question: "When did it start?" } }),
      ALLOW,
      { evidence, userAnswers: { "When did it start?": "Tuesday" } },
    );
    expect(result.outcome).toBe("success");
    expect(result.observation).toContain("Tuesday");
  });

  it("turns a thrown session error into a failed step, not a crash", async () => {
    const result = await executeStep(
      step({ payload: { command: "ipconfig /all" } }),
      ALLOW,
      { evidence }, // no session
    );
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/no device session/i);
  });
});

describe("simulated sessions behave like sessions", () => {
  it("mutates state so a later check sees the fix", async () => {
    const session = makeWindowsDnsDevice();
    const before = await session.exec("nslookup intranet.corp.local");
    expect(before.exit_code).toBe(1);
    await session.exec("ipconfig /flushdns");
    const after = await session.exec("nslookup intranet.corp.local");
    expect(after.exit_code).toBe(0);
    expect(after.stdout).toContain("10.44.12.40");
  });

  it("refuses to work once ended", async () => {
    const session = makeWindowsDnsDevice();
    await session.end();
    await expect(session.exec("ipconfig /all")).rejects.toThrow(/ended/);
  });
});

describe("real sessions fail loudly rather than silently", () => {
  it("a local session cannot capture a screen", async () => {
    const session = new LocalDeviceSession(WIN_LAPTOP);
    await expect(session.capture()).rejects.toThrow(/not available/i);
  });

  it("an unwired MeshCentral session says so instead of returning nothing", async () => {
    const session = new MeshCentralSession(
      WIN_LAPTOP,
      { serverUrl: "https://mesh.test", operatorToken: "t", meshId: "m" },
      {
        tenant_id: "t",
        task_id: "k",
        trace_id: "tr",
        device_id: WIN_LAPTOP.device_id,
        operator_id: "op",
        requested_at: new Date().toISOString(),
      },
    );
    await expect(session.exec("ipconfig /all")).rejects.toThrow(/not wired up/i);
    expect(session.status).toBe("failed");
  });

  it("a local session runs without a shell, so it cannot chain commands", async () => {
    const session = new LocalDeviceSession({ ...WIN_LAPTOP, platform: "linux" });
    const result = await session.exec("echo one; echo two");
    // The `;` is an argument, not a separator - "two" never runs as a command.
    expect(result.stdout.trim()).toBe("one; echo two");
  });
});

describe("approval gates", () => {
  const request = {
    step: step({ intent: "Flush DNS", rollback: "Cache repopulates on its own." }),
    verdict: { ...GATED, rule_id: "approve.registry-and-config-write" },
    justification: "The resolver cache is stale.",
  };

  it("an unattended run approves nothing", async () => {
    const outcome = await new AutoDenyGate().requestApproval(request);
    expect(outcome.approved).toBe(false);
  });

  it("standing policy approves pre-authorised reversible work", async () => {
    const outcome = await new PolicyBoundGate().requestApproval(request);
    expect(outcome.approved).toBe(true);
    expect(outcome.reason).toMatch(/rollback/i);
  });

  it("standing policy refuses work with no stated rollback", async () => {
    const outcome = await new PolicyBoundGate().requestApproval({
      ...request,
      step: step({ intent: "Flush DNS" }), // no rollback
    });
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toMatch(/no stated rollback/i);
  });

  it("standing policy refuses anything outside its narrow list", async () => {
    const outcome = await new PolicyBoundGate().requestApproval({
      ...request,
      verdict: { ...GATED, rule_id: "approve.software-change" },
    });
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toMatch(/standing authorisation/i);
  });

  it("an interactive gate defers to the person", async () => {
    const gate = new InteractiveGate(async () => ({
      approved: true,
      approver: "j.smith",
      reason: "Fine, the user is off the phone.",
    }));
    const outcome = await gate.requestApproval(request);
    expect(outcome.approved).toBe(true);
    expect(outcome.approver).toBe("j.smith");
  });
});
