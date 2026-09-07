/**
 * Console server tests.
 *
 * These drive the real HTTP surface, including the SSE stream and the approval
 * round trip, because that round trip is the whole point of the console: a
 * technician's decision has to reach a run that is already in flight and change
 * what it does to a device.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.js";

let base: string;
let stop: () => Promise<void>;
let workdir: string;

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "ait-srv-"));
  const server = await startServer(0, workdir);
  base = `http://127.0.0.1:${server.port}`;
  stop = server.close;
});
afterAll(async () => {
  await stop();
  rmSync(workdir, { recursive: true, force: true });
});

/** Read a run's SSE stream, answering approvals with `decide`. */
async function drive(
  scenario: string,
  decide: ((approvalId: string, runId: string) => Promise<void>) | null,
  timeoutMs = 40_000,
): Promise<{ events: Record<string, unknown>[]; done?: Record<string, unknown>; runId: string }> {
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario, provider: "offline" }),
  });
  expect(res.status).toBe(202);
  const { runId } = (await res.json()) as { runId: string };

  const stream = await fetch(`${base}/api/runs/${runId}/events`);
  expect(stream.headers.get("content-type")).toContain("text/event-stream");

  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let buffer = "";
  let done: Record<string, unknown> | undefined;
  const deadline = Date.now() + timeoutMs;

  outer: while (Date.now() < deadline) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      // A frame is `id: N\ndata: {...}`. A real client uses EventSource, which
      // parses this for us; this hand-rolled reader has to take the data line.
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (!data) continue;
      const event = JSON.parse(data.slice(6)) as Record<string, unknown>;
      events.push(event);
      if (event["type"] === "approval-requested" && decide) {
        await decide((event["approval"] as { id: string }).id, runId);
      }
      if (event["type"] === "done") {
        done = event;
        break outer;
      }
      if (event["type"] === "error") break outer;
    }
  }
  await reader.cancel().catch(() => undefined);
  return { events, runId, ...(done ? { done } : {}) };
}

describe("static surface", () => {
  it("serves the console", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("technician console");
    // The favicon is inlined so the page makes no extra request for one.
    expect(html).toContain('rel="icon"');
  });

  it("lists both simulated and local scenarios", async () => {
    const data = (await (await fetch(`${base}/api/scenarios`)).json()) as {
      simulated: unknown[];
      local: unknown[];
      localAvailable: boolean;
    };
    expect(data.simulated.length).toBeGreaterThan(0);
    expect(data.local.length).toBe(2);
    expect(typeof data.localAvailable).toBe("boolean");
  });

  it("reports provider readiness without needing a key", async () => {
    const { providers } = (await (await fetch(`${base}/api/providers`)).json()) as {
      providers: { name: string; state: string }[];
    };
    expect(providers.map((p) => p.name)).toContain("offline");
    expect(providers.find((p) => p.name === "offline")?.state).toBe("ready");
  });
});

describe("the guardrail checker endpoint", () => {
  it("blocks a credential change", async () => {
    const res = await fetch(`${base}/api/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "net user jsmith * /domain" }),
    });
    const { verdict } = (await res.json()) as { verdict: { decision: string; rule_id: string } };
    expect(verdict.decision).toBe("block");
    expect(verdict.rule_id).toBe("block.credentials.password-change");
  });

  it("allows a read-only diagnostic", async () => {
    const res = await fetch(`${base}/api/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "ipconfig /all" }),
    });
    const { verdict } = (await res.json()) as { verdict: { decision: string } };
    expect(verdict.decision).toBe("allow");
  });

  it("rejects an empty request rather than guessing", async () => {
    const res = await fetch(`${base}/api/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("a technician approving from the browser", () => {
  it("lets an approved change reach the device", async () => {
    const { events, done } = await drive("printer-stuck", async (approvalId, runId) => {
      const res = await fetch(`${base}/api/runs/${runId}/approvals/${approvalId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, approver: "sam.tech", reason: "User is away." }),
      });
      expect(res.status).toBe(200);
    });

    const run = done?.["run"] as {
      status: string;
      results: { outcome: string; verdict: { reason: string } }[];
      audit: unknown[];
    };
    expect(run.status).toBe("resolved");

    // The steps that ran did so under a named person's authority, and that
    // name is in the record.
    const underApproval = run.results.filter((r) => r.verdict.reason.includes("sam.tech"));
    expect(underApproval.length).toBeGreaterThan(0);
    expect(JSON.stringify(run.audit)).toContain("sam.tech");

    // Exactly one approval card per gated step - no duplicates from replay.
    const asked = events.filter((e) => e["type"] === "approval-requested");
    const gated = new Set(
      asked.map((e) => ((e["approval"] as { step: { id: string } }).step.id)),
    );
    expect(asked.length).toBe(gated.size);
  });

  it("leaves the device untouched when the technician declines", async () => {
    const { done } = await drive("printer-stuck", async (approvalId, runId) => {
      await fetch(`${base}/api/runs/${runId}/approvals/${approvalId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: false, approver: "sam.tech", reason: "Not in hours." }),
      });
    });

    const run = done?.["run"] as {
      status: string;
      results: { outcome: string; step: { mutating: boolean } }[];
      escalation: { triggers: string[] };
    };
    expect(run.status).toBe("escalated");
    expect(run.escalation.triggers).toContain("requires-authority");
    // Nothing that changes state was carried out.
    expect(run.results.filter((r) => r.outcome === "success" && r.step.mutating)).toHaveLength(0);
  });

  it("refuses a decision for an approval that is no longer pending", async () => {
    let firstApproval = "";
    const { runId } = await drive("printer-stuck", async (approvalId, rid) => {
      if (!firstApproval) firstApproval = approvalId;
      await fetch(`${base}/api/runs/${rid}/approvals/${approvalId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true }),
      });
    });

    // Answering the same approval twice must not double-apply anything.
    const again = await fetch(`${base}/api/runs/${runId}/approvals/${firstApproval}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(again.status).toBe(409);
  });
});

describe("guardrails hold through the console", () => {
  it("blocks every dangerous request and never asks a human to approve one", async () => {
    const { events, done } = await drive("password-reset", null);

    // A hard stop is never offered to a technician as an approvable action.
    expect(events.filter((e) => e["type"] === "approval-requested")).toHaveLength(0);

    const run = done?.["run"] as {
      status: string;
      results: { outcome: string; command?: unknown }[];
    };
    expect(run.status).toBe("escalated");
    expect(run.results.some((r) => r.outcome === "blocked")).toBe(true);
    expect(run.results.every((r) => r.command === undefined)).toBe(true);
  });
});

describe("evidence serving", () => {
  it("serves an artefact the run produced", async () => {
    const { done, runId } = await drive("printer-stuck", async (id, rid) => {
      await fetch(`${base}/api/runs/${rid}/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true }),
      });
    });

    const run = done?.["run"] as {
      results: { artifacts: { uri: string; content_type?: string }[] }[];
    };
    const svg = run.results
      .flatMap((r) => r.artifacts)
      .find((a) => a.content_type === "image/svg+xml");
    expect(svg).toBeDefined();

    const file = svg!.uri.split("/").slice(-2).join("/");
    const res = await fetch(`${base}/api/runs/${runId}/evidence/${file}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(await res.text()).toContain("<svg");
  });

  it("refuses to walk out of the evidence directory", async () => {
    // A console that hands back any path it is given is a file-disclosure bug
    // with a nice UI on top.
    for (const attempt of [
      "../../../etc/passwd",
      "..%2f..%2f..%2fetc%2fpasswd",
      "%2e%2e%2f%2e%2e%2fpackage.json",
    ]) {
      const res = await fetch(`${base}/api/runs/any/evidence/${attempt}`);
      expect([403, 404]).toContain(res.status);
      const body = await res.text();
      expect(body).not.toContain("root:");
      expect(body).not.toContain('"name": "ait"');
    }
  });
});

describe("unknown resources", () => {
  it("404s an unknown run's stream", async () => {
    const res = await fetch(`${base}/api/runs/does-not-exist/events`);
    expect(res.status).toBe(404);
  });

  it("400s a run with no scenario", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("reports an unknown scenario on the stream rather than dropping it", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "not-a-scenario" }),
    });
    const { runId } = (await res.json()) as { runId: string };
    const stream = await fetch(`${base}/api/runs/${runId}/events`);
    const text = await stream.body!.getReader().read();
    expect(new TextDecoder().decode(text.value)).toContain("error");
  });
});
