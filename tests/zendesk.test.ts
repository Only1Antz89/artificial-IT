/**
 * Zendesk integration tests.
 *
 * Covers the translation both ways: a Zendesk ticket becoming something the
 * agent can reason about, and a finished run becoming ticket updates, comments
 * and attachments a technician would be happy to find.
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryZendeskClient,
  publicReplyFor,
  renderInternalNote,
  ticketUpdateFor,
  toTicket,
} from "../src/integrations/zendesk/index.js";
import { DEVICE_FIELDS, TICKETS, USERS } from "../src/demo/scenarios.js";
import { runTicket } from "../src/agent/loop.js";
import { HeuristicBrain } from "../src/agent/heuristic-brain.js";
import { PolicyBoundGate } from "../src/control-plane/approvals.js";
import { KnowledgeStore } from "../src/knowledge/index.js";
import { makeWindowsPrintDevice, makeWindowsDnsDevice } from "../src/demo/devices.js";

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "ait-zd-"));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("mapping a Zendesk ticket inward", () => {
  it("normalises status, priority, requester and device", () => {
    const z = TICKETS.find((t) => t.id === 4821)!;
    const user = USERS.find((u) => u.id === z.requester_id)!;
    const ticket = toTicket(z, user, { deviceFields: DEVICE_FIELDS });

    expect(ticket.id).toBe("zd-4821");
    expect(ticket.external_id).toBe("4821");
    expect(ticket.device?.hostname).toBe("LON-LT-2211");
    expect(ticket.device?.platform).toBe("windows");
    expect(ticket.device?.consent_granted).toBe(true);
    expect(ticket.requester.vip).toBe(false);
  });

  it("reads the VIP flag from the requester's tags", () => {
    const z = TICKETS.find((t) => t.id === 4823)!;
    const user = USERS.find((u) => u.id === z.requester_id)!;
    expect(toTicket(z, user, { deviceFields: DEVICE_FIELDS }).requester.vip).toBe(true);
  });

  it("treats missing consent as not granted, never as granted", () => {
    const z = { ...TICKETS.find((t) => t.id === 4821)!, custom_fields: [
      { id: DEVICE_FIELDS.device_id, value: "dev-x" },
      { id: DEVICE_FIELDS.hostname, value: "HOST-X" },
      { id: DEVICE_FIELDS.platform, value: "windows" },
    ] };
    const user = USERS.find((u) => u.id === z.requester_id)!;
    expect(toTicket(z, user, { deviceFields: DEVICE_FIELDS }).device?.consent_granted).toBe(false);
  });

  it("marks an unrecognised platform unknown rather than guessing", () => {
    const z = { ...TICKETS.find((t) => t.id === 4821)!, custom_fields: [
      { id: DEVICE_FIELDS.device_id, value: "dev-x" },
      { id: DEVICE_FIELDS.hostname, value: "HOST-X" },
      { id: DEVICE_FIELDS.platform, value: "ChromeOS Flex" },
    ] };
    const user = USERS.find((u) => u.id === z.requester_id)!;
    expect(toTicket(z, user, { deviceFields: DEVICE_FIELDS }).device?.platform).toBe("unknown");
  });

  it("leaves the device off entirely when the ticket has no device fields", () => {
    const z = TICKETS.find((t) => t.id === 4824)!;
    const user = USERS.find((u) => u.id === z.requester_id)!;
    expect(toTicket(z, user, { deviceFields: DEVICE_FIELDS }).device).toBeUndefined();
  });
});

describe("writing back to Zendesk", () => {
  async function runAndWriteBack(ticketId: number, session: ReturnType<typeof makeWindowsDnsDevice> | undefined) {
    const zendesk = new InMemoryZendeskClient({ tickets: TICKETS, users: USERS });
    const z = await zendesk.getTicket(ticketId);
    const ticket = toTicket(z, await zendesk.getUser(z.requester_id), {
      deviceFields: DEVICE_FIELDS,
    });

    const run = await runTicket({
      ticket,
      brain: new HeuristicBrain(),
      knowledge: new KnowledgeStore(join(workdir, "kb.jsonl")),
      ...(session ? { session } : {}),
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
    });

    const tokens: string[] = [];
    for (const result of run.results) {
      for (const artifact of result.artifacts) {
        if (artifact.content_type !== "image/svg+xml") continue;
        const svg = readFileSync(artifact.uri.replace(/^file:\/\//, ""), "utf8");
        tokens.push((await zendesk.upload("shot.svg", "image/svg+xml", svg)).token);
      }
    }

    await zendesk.updateTicket(ticketId, ticketUpdateFor(run, tokens));
    const reply = publicReplyFor(run.documentation, run.escalation, []);
    if (reply) await zendesk.updateTicket(ticketId, reply);

    return { run, after: await zendesk.getTicket(ticketId) };
  }

  it("solves the ticket and attaches evidence when it resolved", async () => {
    const { run, after } = await runAndWriteBack(4822, makeWindowsPrintDevice());

    expect(run.status).toBe("resolved");
    expect(after.status).toBe("solved");
    expect(after.tags).toContain("ait-handled");
    expect(after.tags).toContain("ait-resolved");

    const internal = after.comments!.find((c) => !c.public);
    const publicReply = after.comments!.find((c) => c.public);
    expect(internal).toBeDefined();
    expect(publicReply).toBeDefined();

    // Screenshots are attached to the internal note, not lost.
    expect(internal!.attachments!.length).toBeGreaterThan(0);
    expect(internal!.attachments![0]!.content_type).toBe("image/svg+xml");
  });

  it("leaves an escalated ticket open and tagged for a human", async () => {
    const { run, after } = await runAndWriteBack(4823, makeWindowsDnsDevice());

    expect(run.status).toBe("escalated");
    expect(after.status).toBe("open");
    expect(after.tags).toContain("ait-escalated");
    expect(after.tags).toContain("ait-policy-block");

    const publicReply = after.comments!.find((c) => c.public)!;
    expect(publicReply.body).toMatch(/passed (it|the request)/i);
  });
});

describe("the internal note", () => {
  it("shows refused actions with the rule that refused them", async () => {
    const zendesk = new InMemoryZendeskClient({ tickets: TICKETS, users: USERS });
    const z = await zendesk.getTicket(4823);
    const run = await runTicket({
      ticket: toTicket(z, await zendesk.getUser(z.requester_id), {
        deviceFields: DEVICE_FIELDS,
      }),
      brain: new HeuristicBrain(),
      knowledge: new KnowledgeStore(join(workdir, "kb.jsonl")),
      session: makeWindowsDnsDevice(),
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
    });

    const note = renderInternalNote(run);
    expect(note).toContain("⛔");
    expect(note).toContain("block.credentials.password-change");
    expect(note).toMatch(/Escalated to/);
    expect(note).toMatch(/Handover/);
    expect(note).toContain(run.run_id);
  });
});
