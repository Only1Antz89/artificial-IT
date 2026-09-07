/**
 * Tests for the live-demo features.
 *
 * What ties these together is that each one turns something the demo could only
 * describe into something it can do: hand it a ticket on the spot, answer its
 * question, put a change back, and work a queue rather than a ticket.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adHocTicket, deriveSubject } from "../src/demo/adhoc.js";
import { shiftMetrics } from "../src/demo/metrics.js";
import { runQueue } from "../src/demo/run-queue.js";
import { undoableChanges, undoChange } from "../src/server/undo.js";
import { runTicket } from "../src/agent/loop.js";
import { HeuristicBrain } from "../src/agent/heuristic-brain.js";
import { PolicyBoundGate } from "../src/control-plane/approvals.js";
import { KnowledgeStore } from "../src/knowledge/index.js";
import { makeWindowsPrintDevice } from "../src/demo/devices.js";
import { startServer } from "../src/server/index.js";
import type { Run } from "../src/contracts/index.js";

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "ait-live-"));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Tickets typed on the spot
 * ------------------------------------------------------------------ */

describe("ad-hoc tickets", () => {
  it("takes free text and makes a workable ticket from it", () => {
    const ticket = adHocTicket({
      description:
        "The intranet page won't load. It says the site can't be reached. Everything else is fine.",
      target: "simulated-windows-laptop",
    });
    expect(ticket.subject).toBe("The intranet page won't load.");
    expect(ticket.device?.hostname).toBe("LON-LT-2211");
    expect(ticket.tags).toContain("ad-hoc");
  });

  it("routes a this-machine ticket down the local path", () => {
    const ticket = adHocTicket({ description: "My machine feels slow today, can you look?" });
    expect(ticket.tags).toContain("local-machine");
    expect(ticket.device?.hostname).toBeTruthy();
  });

  it("supports a request with no device at all", () => {
    const ticket = adHocTicket({
      description: "Please give Rachel access to the finance reporting share.",
      target: "no-device",
    });
    expect(ticket.device).toBeUndefined();
  });

  it("refuses a description too short to work from", () => {
    // A two-word ticket produces a two-word diagnosis; better to say so.
    expect(() => adHocTicket({ description: "broken" })).toThrow(/sentence or two/i);
  });

  it("derives a sensible subject and does not run on forever", () => {
    expect(deriveSubject("Wifi keeps dropping. It happens every ten minutes.")).toBe(
      "Wifi keeps dropping.",
    );
    const long = `${"a".repeat(300)}`;
    expect(deriveSubject(long).length).toBeLessThanOrEqual(90);
  });
});

/* ------------------------------------------------------------------ *
 * Asking the user something
 * ------------------------------------------------------------------ */

describe("asking the user", () => {
  const vague = () =>
    adHocTicket({
      description: "Something is wrong with my machine and I'm not sure what. It isn't behaving.",
      target: "simulated-windows-laptop",
    });

  it("asks when nothing is recognised and someone can answer", async () => {
    const asked: string[] = [];
    const run = await runTicket({
      ticket: vague(),
      brain: new HeuristicBrain(),
      knowledge: new KnowledgeStore(join(workdir, "kb.jsonl")),
      session: makeWindowsPrintDevice(),
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
      askUser: async (question) => {
        asked.push(question);
        return "It started this morning after a Windows update.";
      },
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/when did this start/i);
    // The answer is on the record, not just in the model's head.
    expect(JSON.stringify(run.audit)).toContain("Windows update");
  });

  it("does not ask when nobody can answer", async () => {
    // An unattended run must work with what the ticket says rather than
    // stalling on a question nobody will see.
    let asked = 0;
    const run = await runTicket({
      ticket: vague(),
      brain: new HeuristicBrain(),
      knowledge: new KnowledgeStore(join(workdir, "kb.jsonl")),
      session: makeWindowsPrintDevice(),
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
    });
    expect(asked).toBe(0);
    expect(run.results.filter((r) => r.step.kind === "ask_user")).toHaveLength(0);
  });

  it("does not interrupt a ticket it already understands", async () => {
    // A recognised problem has a clear next step; asking "when did this start?"
    // before running it is noise a technician would skip.
    const asked: string[] = [];
    await runTicket({
      ticket: adHocTicket({
        description:
          "Nothing is printing. The jobs just sit in the queue and never come out.",
        target: "simulated-windows-desktop",
      }),
      brain: new HeuristicBrain(),
      knowledge: new KnowledgeStore(join(workdir, "kb.jsonl")),
      session: makeWindowsPrintDevice(),
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
      askUser: async (q) => {
        asked.push(q);
        return "this morning";
      },
    });
    expect(asked).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Undo
 * ------------------------------------------------------------------ */

describe("putting a change back", () => {
  async function printerRun() {
    const session = makeWindowsPrintDevice();
    const run = await runTicket({
      ticket: adHocTicket({
        description: "Nothing is printing, the jobs sit in the queue and never come out.",
        target: "simulated-windows-desktop",
      }),
      brain: new HeuristicBrain(),
      knowledge: new KnowledgeStore(join(workdir, "kb.jsonl")),
      session,
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
    });
    return { run, session };
  }

  it("offers only changes that actually ran and can actually be reversed", async () => {
    const { run } = await printerRun();
    const undoable = undoableChanges(run);
    expect(undoable.length).toBeGreaterThan(0);
    for (const change of undoable) {
      expect(change.rollbackCommand.trim()).not.toBe("");
      const original = run.results.find((r) => r.step.id === change.stepId)!;
      expect(original.outcome).toBe("success");
      expect(original.step.mutating).toBe(true);
    }
    // A flushed DNS cache has honest prose but no command; it is not offered.
    expect(undoable.every((u) => u.rollbackCommand !== undefined)).toBe(true);
  });

  it("actually reverses the change on the device", async () => {
    const { run, session } = await printerRun();
    expect(session.state["spooler_running"]).toBe(true);

    // Undo the last change - starting the spooler - and the device follows.
    const startStep = undoableChanges(run).find((u) => u.command === "net start spooler")!;
    const outcome = await undoChange(run, startStep.stepId, session, workdir, "sam.tech");

    expect(outcome.ok).toBe(true);
    expect(outcome.result?.command?.command).toBe("net stop spooler");
    // Recorded against the run, with who did it.
    expect(JSON.stringify(run.audit)).toContain("sam.tech");
    expect(run.results.some((r) => r.step.intent.startsWith("Undo:"))).toBe(true);
  });

  it("puts an undo through the guardrails like any other change", async () => {
    const { run, session } = await printerRun();
    const change = undoableChanges(run)[0]!;

    // A rollback that would cross a guardrail is refused. "It is only an undo"
    // is not a reason to skip the gate.
    const original = run.results.find((r) => r.step.id === change.stepId)!;
    original.step.rollback_command = "rm -rf /";

    const outcome = await undoChange(run, change.stepId, session, workdir, "sam.tech");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/guardrail/i);
  });

  it("refuses to undo something it did not do", async () => {
    const { run, session } = await printerRun();
    const outcome = await undoChange(run, "no-such-step", session, workdir, "t");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/not one this run can undo/i);
  });
});

/* ------------------------------------------------------------------ *
 * Queue and metrics
 * ------------------------------------------------------------------ */

describe("working the queue", () => {
  it("takes every open ticket and reports on the shift", async () => {
    const { runs, metrics } = await runQueue({ provider: "offline", workdir });

    expect(runs.length).toBeGreaterThan(1);
    expect(metrics.worked).toBe(runs.length);
    expect(metrics.resolved + metrics.escalated + metrics.waiting).toBe(metrics.worked);
    expect(metrics.autoResolutionRate).toBeGreaterThan(0);
    expect(metrics.autoResolutionRate).toBeLessThanOrEqual(1);
    // Guardrails fire across a real queue, and the categories are named.
    expect(metrics.blockedActions).toBeGreaterThan(0);
    expect(metrics.refusedCategories.length).toBeGreaterThan(0);
  });

  it("counts what happened rather than asserting it", () => {
    const run = (status: Run["status"], blocked: number, saved: number): Run =>
      ({
        status,
        started_at: "2026-01-01T00:00:00.000Z",
        finished_at: "2026-01-01T00:00:30.000Z",
        knowledge_used: [],
        audit: [],
        results: Array.from({ length: blocked }, () => ({
          outcome: "blocked",
          step: { mutating: false },
          verdict: { categories: ["credentials"], reason: "" },
        })),
        documentation: { time_saved_estimate_minutes: saved },
      }) as unknown as Run;

    const m = shiftMetrics([run("resolved", 0, 20), run("escalated", 2, 5), run("resolved", 0, 20)]);
    expect(m.worked).toBe(3);
    expect(m.resolved).toBe(2);
    expect(m.autoResolutionRate).toBeCloseTo(2 / 3);
    expect(m.blockedActions).toBe(2);
    expect(m.estimatedMinutesSaved).toBe(45);
    expect(m.medianTimeToResolveSeconds).toBe(30);
    expect(m.refusedCategories[0]).toEqual({ category: "credentials", count: 2 });
  });

  it("reports zeroes rather than dividing by nothing on an empty queue", () => {
    const m = shiftMetrics([]);
    expect(m.worked).toBe(0);
    expect(m.autoResolutionRate).toBe(0);
    expect(m.medianTimeToResolveSeconds).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Knowledge a technician can correct
 * ------------------------------------------------------------------ */

describe("correcting the knowledge base", () => {
  it("removes an entry from memory and from disk", async () => {
    const path = join(workdir, "kb.jsonl");
    const store = new KnowledgeStore(path);
    store.add({
      id: "kb_wrong",
      source_ticket_id: "zd-1",
      title: "A lesson that turned out to be wrong",
      category: "connectivity",
      platform: "any",
      symptoms: ["something"],
      root_cause: "Not actually this",
      diagnostic_steps: ["df -h"],
      resolution_steps: [],
      cautions: [],
      times_applied: 0,
      outcome: "resolved",
    });
    expect(store.size()).toBe(1);

    expect(store.remove("kb_wrong")).toBe(true);
    expect(store.size()).toBe(0);
    // The file is rewritten, so what is on disk is what will be used.
    expect(readFileSync(path, "utf8").trim()).toBe("");
    expect(new KnowledgeStore(path).size()).toBe(0);

    expect(store.remove("kb_wrong")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The endpoints behind all of it
 * ------------------------------------------------------------------ */

describe("live endpoints", () => {
  let base: string;
  let stop: () => Promise<void>;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ait-live-srv-"));
    const server = await startServer(0, dir);
    base = `http://127.0.0.1:${server.port}`;
    stop = server.close;
  });
  afterAll(async () => {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("offers the machines an ad-hoc ticket can be aimed at", async () => {
    const data = (await (await fetch(`${base}/api/scenarios`)).json()) as {
      targets: { key: string }[];
    };
    expect(data.targets.map((t) => t.key)).toContain("simulated-windows-desktop");
  });

  it("starts a run from typed text", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket: {
          description: "Nothing is printing and the jobs sit in the queue.",
          target: "simulated-windows-desktop",
        },
        provider: "offline",
      }),
    });
    expect(res.status).toBe(202);
    const started = (await res.json()) as { runId: string };
    expect(started.runId).toBeTruthy();
  });

  it("rejects a run with neither a scenario nor a description", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("serves and prunes the knowledge base", async () => {
    const listed = (await (await fetch(`${base}/api/knowledge`)).json()) as {
      entries: { id: string }[];
    };
    expect(Array.isArray(listed.entries)).toBe(true);

    const missing = await fetch(`${base}/api/knowledge/not-a-real-entry`, { method: "DELETE" });
    expect(missing.status).toBe(404);
  });
});
