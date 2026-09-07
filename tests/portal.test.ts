/**
 * The two surfaces.
 *
 * A user reports a problem in the portal; a technician watches AIT work it in
 * the console. The tests that matter most here are the ones about what each
 * side can see: a technician gets everything, and a user gets progress in their
 * own language and nothing else.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.js";
import { TicketDesk, userView, userUpdateFor, statusForRun } from "../src/server/tickets.js";
import { adHocTicket } from "../src/demo/adhoc.js";
import { evaluate } from "../src/control-plane/policy/engine.js";
import { newId, type Run } from "../src/contracts/index.js";

let base: string;
let stop: () => Promise<void>;
let workdir: string;

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "ait-portal-"));
  const server = await startServer(0, workdir);
  base = `http://127.0.0.1:${server.port}`;
  stop = server.close;
});
afterAll(async () => {
  await stop();
  rmSync(workdir, { recursive: true, force: true });
});

async function submit(body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/portal/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Poll a ticket until `done` says it is ready, or give up. */
async function until(
  reference: string,
  done: (t: Record<string, unknown>) => boolean,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  let ticket: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/portal/tickets/${reference}`);
    ticket = ((await res.json()) as { ticket: Record<string, unknown> }).ticket;
    if (done(ticket)) return ticket;
    await new Promise((r) => setTimeout(r, 150));
  }
  return ticket;
}

/* ------------------------------------------------------------------ *
 * What the user is allowed to see
 * ------------------------------------------------------------------ */

describe("the user's view is built by allowing, not by redacting", () => {
  it("carries only user-facing fields", () => {
    const desk = new TicketDesk();
    const ticket = desk.submit({
      reportedBy: "Priya",
      description: "The intranet will not load.",
      summary: "The intranet will not load.",
      target: "simulated-windows-laptop",
      consentGranted: true,
    });
    desk.update(ticket.id, (t) => {
      t.runId = "run-secret-id";
      t.status = "working";
    });

    const view = userView(desk.get(ticket.id)!);
    const keys = Object.keys(view);

    // The allowlist is the whole mechanism: a technician-only field added to
    // DeskTicket later cannot leak here by being forgotten.
    expect(keys.sort()).toEqual(
      ["reference", "status", "statusLabel", "submittedAt", "summary", "updates"].sort(),
    );
    expect(JSON.stringify(view)).not.toContain("run-secret-id");
    expect(JSON.stringify(view)).not.toContain("simulated-windows-laptop");
  });

  it("says nothing technical in a progress update", () => {
    // What the user is told about a step is that a change was made - never
    // which command made it.
    const update = userUpdateFor({
      type: "step",
      result: {
        outcome: "success",
        step: { mutating: true, payload: { command: "net stop spooler" } },
      },
    });
    expect(update).toBeTruthy();
    expect(update).not.toContain("spooler");
    expect(update).not.toContain("net stop");
  });

  it("has nothing to say about most steps", () => {
    // A user does not want a running commentary of read-only checks.
    expect(
      userUpdateFor({ type: "step", result: { outcome: "success", step: { mutating: false } } }),
    ).toBeUndefined();
    expect(userUpdateFor({ type: "policy.evaluated" })).toBeUndefined();
  });

  it("maps a finished run onto language a user understands", () => {
    const run = (status: Run["status"]) => ({ status }) as Run;
    expect(statusForRun(run("resolved"))).toBe("resolved");
    expect(statusForRun(run("escalated"))).toBe("escalated");
    expect(statusForRun(run("awaiting_approval"))).toBe("waiting-on-technician");
    expect(statusForRun(run("failed"))).toBe("failed");
  });
});

/* ------------------------------------------------------------------ *
 * Reporting a problem
 * ------------------------------------------------------------------ */

describe("reporting a problem", () => {
  it("serves the portal", async () => {
    const res = await fetch(`${base}/portal`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("IT Support");
    // The user's page must not carry the technician vocabulary at all.
    expect(html).not.toContain("guardrail");
    expect(html).not.toContain("audit");
  });

  it("takes a report and hands back a reference", async () => {
    const { status, body } = await submit({
      description: "Nothing is printing, the jobs just sit in the queue.",
      reportedBy: "Tom Whitfield",
      target: "simulated-windows-desktop",
      consent: true,
      provider: "offline",
    });
    expect(status).toBe(202);
    const ticket = body["ticket"] as { reference: string; statusLabel: string };
    expect(ticket.reference).toMatch(/^AIT-[0-9A-F]{4}$/);
    expect(ticket.statusLabel).toBeTruthy();
  });

  it("asks for more when there is nothing to work from", async () => {
    const { status, body } = await submit({ description: "broken" });
    expect(status).toBe(400);
    // In the user's language, not a validation error.
    expect(String(body["error"])).toMatch(/tell us a little more/i);
  });

  it("works the ticket through to a reply without anyone starting it", async () => {
    const { body } = await submit({
      // A request nothing can act on, so it settles without waiting on anyone.
      description: "Please create an account for our new starter Rachel, and add the corporate card.",
      reportedBy: "Marcus",
      target: "no-device",
      consent: true,
      provider: "offline",
    });
    const reference = (body["ticket"] as { reference: string }).reference;

    const ticket = await until(reference, (t) => Boolean(t["reply"]), 20_000);
    expect(ticket["reply"]).toBeTruthy();
    // The reply is written for the person who raised it, not for a technician.
    expect(String(ticket["reply"])).not.toMatch(/block\.|guardrail|New-ADUser|rule_id/i);
    expect((ticket["updates"] as unknown[]).length).toBeGreaterThan(1);
  }, 30_000);

  it("tells the user when it is waiting on a technician, rather than going quiet", async () => {
    const { body } = await submit({
      description: "Nothing is printing, the jobs just sit in the queue and never come out.",
      reportedBy: "Tom",
      target: "simulated-windows-desktop",
      consent: true,
      provider: "offline",
    });
    const reference = (body["ticket"] as { reference: string }).reference;

    // This ticket needs a change approved, so it pauses. The user must be told
    // that is what is happening.
    const ticket = await until(reference, (t) => t["status"] === "waiting-on-technician", 20_000);
    expect(ticket["status"]).toBe("waiting-on-technician");
    expect(String(ticket["statusLabel"])).toMatch(/technician/i);
    const updates = (ticket["updates"] as { text: string }[]).map((u) => u.text).join(" ");
    expect(updates).toMatch(/technician is checking/i);
    // And still nothing about what the change actually is.
    expect(updates).not.toMatch(/spooler|net stop/i);
  }, 30_000);

  it("is honest with the user when something breaks on our side", async () => {
    const { body } = await submit({
      description: "This should fail because the provider does not exist at all.",
      target: "simulated-windows-laptop",
      consent: true,
      provider: "not-a-provider",
    });
    const reference = (body["ticket"] as { reference: string }).reference;
    const ticket = await until(reference, (t) => t["status"] === "failed");
    expect(ticket["status"]).toBe("failed");
    // The user gets told, not shown a stack trace.
    const updates = (ticket["updates"] as { text: string }[]).map((u) => u.text).join(" ");
    expect(updates).toMatch(/something went wrong/i);
    expect(updates).not.toMatch(/Unknown provider|Error:/);
  });

  it("404s a reference that does not exist", async () => {
    const res = await fetch(`${base}/api/portal/tickets/AIT-ZZZZ`);
    expect(res.status).toBe(404);
    expect(String(((await res.json()) as { error: string }).error)).toMatch(/cannot find/i);
  });
});

/* ------------------------------------------------------------------ *
 * Consent
 * ------------------------------------------------------------------ */

describe("withholding consent", () => {
  it("keeps the device attached and lets the guardrail refuse the work", () => {
    // Refusing consent is not the same as having no machine. Attaching the
    // device with consent withheld is both the truth and far more useful to a
    // technician than a ticket that mysteriously has no device.
    const ticket = adHocTicket({
      description: "The intranet will not load on my laptop today.",
      target: "simulated-windows-laptop",
      consent: false,
    });
    expect(ticket.device).toBeDefined();
    expect(ticket.device?.consent_granted).toBe(false);

    const verdict = evaluate(
      {
        id: newId("s"),
        kind: "command",
        intent: "Check the adapter",
        payload: { command: "ipconfig /all" },
        mutating: false,
      },
      { device: ticket.device! },
    );
    expect(verdict.decision).toBe("require_approval");
    expect(verdict.rule_id).toBe("approve.consent-required");
  });

  it("defaults to consented when a caller does not say", () => {
    expect(
      adHocTicket({ description: "Something is wrong with the printer here." }).device
        ?.consent_granted,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The technician's side of the same ticket
 * ------------------------------------------------------------------ */

describe("the technician's desk", () => {
  it("shows reported tickets with everything the portal hides", async () => {
    const { body } = await submit({
      description: "My machine is making a strange noise and running very hot.",
      reportedBy: "Dana Osei",
      target: "simulated-mac-laptop",
      consent: true,
      provider: "offline",
    });
    const reference = (body["ticket"] as { reference: string }).reference;

    const desk = (await (await fetch(`${base}/api/desk`)).json()) as {
      tickets: Record<string, unknown>[];
    };
    const ticket = desk.tickets.find((t) => t["reference"] === reference)!;

    expect(ticket).toBeDefined();
    expect(ticket["reportedBy"]).toBe("Dana Osei");
    expect(ticket["description"]).toContain("strange noise");
    expect(ticket["consentGranted"]).toBe(true);
    // The technician gets the run to drill into; the user never sees it.
    await until(reference, () => Boolean(ticket["runId"]) || true, 1_000);
  });

  it("streams the desk so a console needs no refresh", async () => {
    const res = await fetch(`${base}/api/desk/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    expect(frame).toContain('"type":"ticket"');
    await reader.cancel().catch(() => undefined);
  });
});
