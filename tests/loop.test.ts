/**
 * End-to-end tests over the real agent loop.
 *
 * These run the actual `runTicket` with the offline brain, a simulated device
 * and the in-memory help desk - no mocks of our own components. The point is to
 * verify the properties that matter regardless of which brain is plugged in:
 * that a fix is verified before it is claimed, that a guardrail stops the run,
 * and that nothing reaches the device without a verdict.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTicket } from "../src/agent/loop.js";
import { HeuristicBrain } from "../src/agent/heuristic-brain.js";
import { AutoDenyGate, PolicyBoundGate } from "../src/control-plane/approvals.js";
import { KnowledgeStore } from "../src/knowledge/index.js";
import {
  makeMacFullDiskDevice,
  makeWindowsDnsDevice,
  makeWindowsPrintDevice,
} from "../src/demo/devices.js";
import { DEVICE_FIELDS, TICKETS, USERS } from "../src/demo/scenarios.js";
import { toTicket } from "../src/integrations/zendesk/index.js";
import type { Ticket } from "../src/contracts/index.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "ait-test-"));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function ticketFor(id: number): Ticket {
  const z = TICKETS.find((t) => t.id === id)!;
  const user = USERS.find((u) => u.id === z.requester_id)!;
  return toTicket(z, user, { deviceFields: DEVICE_FIELDS });
}

function newRun(overrides: Partial<Parameters<typeof runTicket>[0]> = {}) {
  return runTicket({
    ticket: ticketFor(4821),
    brain: new HeuristicBrain(),
    knowledge: new KnowledgeStore(join(workdir, "kb.jsonl")),
    session: makeWindowsDnsDevice(),
    gate: new PolicyBoundGate(),
    evidenceRoot: workdir,
    ...overrides,
  });
}

describe("resolving a ticket", () => {
  it("diagnoses, fixes and verifies before claiming success", async () => {
    const run = await newRun();

    expect(run.status).toBe("resolved");

    const commands = run.results
      .filter((r) => r.step.kind === "command")
      .map((r) => String(r.step.payload["command"]));

    // The fix must be preceded by a check that showed the fault, and followed
    // by the same check passing. A "fix" with no before and after is a guess.
    const fixIndex = commands.indexOf("ipconfig /flushdns");
    expect(fixIndex).toBeGreaterThan(-1);
    expect(commands.slice(0, fixIndex)).toContain("nslookup intranet.corp.local");
    expect(commands.slice(fixIndex + 1)).toContain("nslookup intranet.corp.local");

    const lastCheck = [...run.results]
      .reverse()
      .find((r) => String(r.step.payload["command"]) === "nslookup intranet.corp.local");
    expect(lastCheck?.command?.stdout).toContain("10.44.12.40");
  });

  it("records every step against a policy verdict", async () => {
    const run = await newRun();
    for (const result of run.results) {
      expect(result.verdict.rule_id, `${result.step.intent} ran without a rule`).toBeTruthy();
    }
    // Anything that actually executed must have been cleared, not merely seen.
    for (const result of run.results.filter((r) => r.outcome === "success")) {
      expect(result.verdict.decision).toBe("allow");
    }
  });

  it("captures evidence for each executed step", async () => {
    const run = await newRun();
    const executed = run.results.filter((r) => r.outcome === "success");
    expect(executed.length).toBeGreaterThan(0);
    for (const result of executed) {
      expect(result.artifacts.length).toBeGreaterThan(0);
      for (const artifact of result.artifacts) {
        expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });

  it("writes an audit entry for every policy decision", async () => {
    const run = await newRun();
    const evaluated = run.audit.filter((a) => a.event === "policy.evaluated");
    expect(evaluated.length).toBe(run.results.length);
    expect(run.audit[0]?.event).toBe("run.started");
    expect(run.audit.map((a) => a.seq)).toEqual(run.audit.map((_, i) => i));
  });
});

describe("guardrails inside the loop", () => {
  it("stops at a hard block and does not touch the device", async () => {
    const session = makeWindowsDnsDevice();
    const run = await runTicket({
      ticket: ticketFor(4823), // password reset request
      brain: new HeuristicBrain(),
      knowledge: new KnowledgeStore(join(workdir, "kb.jsonl")),
      session,
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
    });

    expect(run.status).toBe("escalated");

    const blocked = run.results.filter((r) => r.outcome === "blocked");
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]!.verdict.categories).toContain("credentials");

    // Nothing ran on the machine, so no command output exists at all.
    expect(run.results.every((r) => r.command === undefined)).toBe(true);
    // And the device's own state is untouched.
    expect(session.state["dns_cache_stale"]).toBe(true);
  });

  it("reports every refused request, not just the first", async () => {
    const run = await runTicket({
      ticket: ticketFor(4824), // new starter: account, group and card
      brain: new HeuristicBrain(),
      knowledge: new KnowledgeStore(join(workdir, "kb.jsonl")),
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
    });

    const categories = new Set(run.results.flatMap((r) => r.verdict.categories));
    expect(categories.has("identity")).toBe(true);
    expect(categories.has("finance")).toBe(true);
    expect(run.results.filter((r) => r.outcome === "blocked").length).toBeGreaterThan(1);
  });

  it("escalates instead of acting when no human can approve", async () => {
    const session = makeWindowsPrintDevice();
    const run = await runTicket({
      ticket: ticketFor(4822), // needs a service restart
      brain: new HeuristicBrain(),
      knowledge: new KnowledgeStore(join(workdir, "kb.jsonl")),
      session,
      gate: new AutoDenyGate(),
      evidenceRoot: workdir,
    });

    expect(run.status).toBe("escalated");
    expect(run.escalation?.triggers).toContain("requires-authority");
    // The spooler was never restarted, because nobody was there to say yes.
    expect(session.state["spooler_running"]).toBe(false);
  });

  it("hands over enough for a human to continue", async () => {
    const run = await runTicket({
      ticket: ticketFor(4823),
      brain: new HeuristicBrain(),
      knowledge: new KnowledgeStore(join(workdir, "kb.jsonl")),
      session: makeWindowsDnsDevice(),
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
    });

    const handover = run.escalation!.handover;
    expect(handover.what_we_know.length).toBeGreaterThan(0);
    expect(handover.what_we_could_not_do.length).toBeGreaterThan(0);
    expect(handover.suggested_next_steps.length).toBeGreaterThan(0);
    expect(run.escalation!.route_to).toBeTruthy();
  });
});

describe("the write-up describes what actually happened", () => {
  it("does not claim checks it never ran", async () => {
    const run = await runTicket({
      ticket: ticketFor(4824), // blocked immediately, no device
      brain: new HeuristicBrain(),
      knowledge: new KnowledgeStore(join(workdir, "kb.jsonl")),
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
    });

    const reply = run.documentation!.user_reply.toLowerCase();
    expect(reply).not.toContain("i've run some initial checks");
    expect(reply).toContain("haven't made any changes");
  });

  it("names the fix and the cause when it did resolve", async () => {
    const run = await newRun();
    expect(run.documentation!.root_cause).not.toMatch(/not established/i);
    expect(run.documentation!.user_reply).toMatch(/confirmed/i);
    expect(run.documentation!.prevention.length).toBeGreaterThan(0);
  });
});

describe("the step budget is enforced", () => {
  it("stops and escalates rather than running forever", async () => {
    const run = await newRun({ stepBudget: 2 });
    expect(run.results.length).toBeLessThanOrEqual(2);
    expect(run.status).toBe("escalated");
    expect(run.escalation?.triggers).toContain("budget-exhausted");
  });
});

describe("what a hard block freezes, and what it does not", () => {
  it("keeps investigating read-only after refusing the user's request", async () => {
    const run = await newRun({
      ticket: ticketFor(4826),
      session: makeMacFullDiskDevice(),
    });

    const blocked = run.results.filter((r) => r.outcome === "blocked");
    expect(blocked.length).toBeGreaterThan(0);

    // The refusal came first, and read-only work carried on after it.
    const firstBlock = run.results.indexOf(blocked[0]!);
    const laterCommands = run.results
      .slice(firstBlock + 1)
      .filter((r) => r.outcome === "success" && r.command);
    expect(laterCommands.length).toBeGreaterThan(0);
    expect(laterCommands.every((r) => r.step.mutating === false)).toBe(true);
  });

  it("never runs a mutating step once a guardrail has fired", async () => {
    const run = await newRun({
      ticket: ticketFor(4826),
      session: makeMacFullDiskDevice(),
    });
    for (const r of run.results) {
      if (r.step.mutating) expect(r.command).toBeUndefined();
    }
  });

  it("never reports a frozen run as resolved", async () => {
    const run = await newRun({
      ticket: ticketFor(4826),
      session: makeMacFullDiskDevice(),
    });
    expect(run.status).toBe("escalated");
    expect(run.escalation!.triggers).toContain("policy-block");
  });

  it("does not ask the user a question it cannot act on after a refusal", async () => {
    // A ticket with no device and nothing but refused requests in it. Asking
    // "which machine is this?" would leave the user waiting for nothing.
    const run = await newRun({
      ticket: ticketFor(4824),
      session: undefined,
      askUser: async () => "a laptop",
    });
    expect(run.results.some((r) => r.step.kind === "ask_user")).toBe(false);
    expect(run.status).toBe("escalated");
  });

  it("still refuses the rest of the same request in the batch it was refused in", async () => {
    const run = await newRun({ ticket: ticketFor(4824), session: undefined });
    const notAttempted = run.results.filter(
      (r) => r.outcome === "blocked" || r.outcome === "skipped",
    );
    expect(notAttempted.length).toBeGreaterThanOrEqual(2);
    expect(notAttempted.every((r) => r.command === undefined)).toBe(true);
  });
});
