/**
 * Knowledge base tests.
 *
 * Two properties matter: a genuinely similar past ticket must be found, and a
 * coincidentally-worded one must not be. The second is the harder half - a
 * confidently wrong prior ticket sends the whole diagnosis down the wrong path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeStore, learnFromRun, retrieve, tokenize } from "../src/knowledge/index.js";
import { seedKnowledge } from "../src/demo/seed-knowledge.js";
import { runTicket } from "../src/agent/loop.js";
import { HeuristicBrain } from "../src/agent/heuristic-brain.js";
import { PolicyBoundGate } from "../src/control-plane/approvals.js";
import { makeMacDnsDevice, makeWindowsDnsDevice } from "../src/demo/devices.js";
import { DEVICE_FIELDS, TICKETS, USERS } from "../src/demo/scenarios.js";
import { toTicket } from "../src/integrations/zendesk/index.js";

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "ait-kb-"));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function store(): KnowledgeStore {
  return new KnowledgeStore(join(workdir, "kb.jsonl"));
}

function ticketFor(id: number) {
  const z = TICKETS.find((t) => t.id === id)!;
  return toTicket(z, USERS.find((u) => u.id === z.requester_id)!, {
    deviceFields: DEVICE_FIELDS,
  });
}

describe("tokenizer", () => {
  it("keeps error codes and filenames intact", () => {
    const tokens = tokenize("Outlook crashes with 0x80070005 in outlook.exe");
    expect(tokens).toContain("0x80070005");
    expect(tokens).toContain("outlook.exe");
  });

  it("strips service-desk filler", () => {
    const tokens = tokenize("Hi, I need help please, nothing is working today");
    expect(tokens).not.toContain("need");
    expect(tokens).not.toContain("help");
    expect(tokens).not.toContain("today");
  });

  it("folds simple plurals and gerunds so they match", () => {
    expect(tokenize("printers")).toEqual(tokenize("printer"));
    expect(tokenize("loading")).toEqual(tokenize("load"));
  });
});

describe("retrieval precision", () => {
  it("does not return a coincidental match on common words", () => {
    const kb = store();
    seedKnowledge(kb);
    // A DNS ticket against a knowledge base of VPN and mailbox entries: the
    // right answer is "nothing relevant", not the least-irrelevant entry.
    const hits = retrieve(kb.all(), {
      text: "Can't get onto the intranet, the page won't load and says the site can't be reached. I can still get to Google and my email is working.",
      platform: "windows",
      category: "connectivity",
    });
    expect(hits).toHaveLength(0);
  });

  it("finds a genuinely similar entry", () => {
    const kb = store();
    seedKnowledge(kb);
    const hits = retrieve(kb.all(), {
      text: "My VPN keeps dropping and disconnects every few minutes on wifi",
      platform: "windows",
      category: "connectivity",
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.entry.id).toBe("kb_seed_vpn");
    expect(hits[0]!.matched_terms.length).toBeGreaterThanOrEqual(2);
  });

  it("explains itself, so a bad suggestion can be diagnosed", () => {
    const kb = store();
    seedKnowledge(kb);
    const hits = retrieve(kb.all(), { text: "vpn disconnects every few minutes" });
    expect(hits[0]!.matched_terms).toContain("vpn");
    expect(hits[0]!.coverage).toBeGreaterThan(0);
  });
});

describe("learning from a run", () => {
  it("records what worked, from the evidence rather than the summary", async () => {
    const kb = store();
    const run = await runTicket({
      ticket: ticketFor(4821),
      brain: new HeuristicBrain(),
      knowledge: kb,
      session: makeWindowsDnsDevice(),
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
    });

    const learned = kb.all().find((e) => e.source_ticket_id === run.ticket.id);
    expect(learned).toBeDefined();
    expect(learned!.outcome).toBe("resolved");
    // The recorded steps are the commands that actually ran, in order.
    expect(learned!.diagnostic_steps).toContain("nslookup intranet.corp.local");
    expect(learned!.resolution_steps).toContain("ipconfig /flushdns");
  });

  it("records guardrail cautions on an escalated run", async () => {
    const kb = store();
    await runTicket({
      ticket: ticketFor(4823),
      brain: new HeuristicBrain(),
      knowledge: kb,
      session: makeWindowsDnsDevice(),
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
    });

    const learned = kb.all().find((e) => e.source_ticket_id === "zd-4823");
    expect(learned?.outcome).toBe("escalated");
    expect(learned?.cautions.join(" ")).toMatch(/credentials/);
  });

  it("carries a lesson from one platform to the next ticket on another", async () => {
    const kb = store();

    await runTicket({
      ticket: ticketFor(4821), // Windows
      brain: new HeuristicBrain(),
      knowledge: kb,
      session: makeWindowsDnsDevice(),
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
    });

    const second = await runTicket({
      ticket: ticketFor(4825), // macOS, same underlying fault
      brain: new HeuristicBrain(),
      knowledge: kb,
      session: makeMacDnsDevice(),
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
    });

    expect(second.knowledge_used.length).toBeGreaterThan(0);
    // The recalled entry leads the diagnosis and is cited by id.
    const lead = second.diagnosis!.hypotheses[second.diagnosis!.leading_index]!;
    expect(lead.prior_ticket_refs.length).toBeGreaterThan(0);
    expect(second.status).toBe("resolved");
  });

  it("survives a corrupt line in the store", () => {
    const kb = store();
    seedKnowledge(kb);
    const before = kb.size();
    // Simulate a truncated write, then reload.
    require("node:fs").appendFileSync(join(workdir, "kb.jsonl"), '{"id":"broken"\n');
    const reloaded = new KnowledgeStore(join(workdir, "kb.jsonl"));
    expect(reloaded.size()).toBe(before);
  });
});

describe("learning is skipped when there is nothing to learn", () => {
  it("does not record an entry for a run that did nothing", () => {
    const kb = store();
    const result = learnFromRun(kb, {
      contract_type: "technician.run",
      schema_version: "1.0.0",
      tenant_id: "t",
      trace_id: "tr",
      created_at: new Date().toISOString(),
      run_id: "r",
      ticket: ticketFor(4821),
      status: "resolved",
      intake: {
        summary: "s",
        category: "other",
        reported_symptoms: [],
        missing_information: [],
        out_of_scope: false,
        user_sentiment: "calm",
      },
      proposed: [],
      results: [],
      audit: [],
      knowledge_used: [],
      started_at: new Date().toISOString(),
    });
    expect(result.entry).toBeUndefined();
    expect(kb.size()).toBe(0);
  });
});

describe("precision on a seeded knowledge base", () => {
  function seeded(): KnowledgeStore {
    const store = new KnowledgeStore(join(workdir, "kb.jsonl"));
    seedKnowledge(store);
    return store;
  }

  function hitsFor(id: number): string[] {
    const t = TICKETS.find((x) => x.id === id)!;
    return retrieve(seeded().all(), { text: `${t.subject}\n${t.description}` }).map(
      (h) => h.entry.id,
    );
  }

  it("finds the phishing entry for a phishing ticket, not the mailbox one", () => {
    // Both entries contain "mailbox" and "email". Only one of them is about
    // what happened to this user.
    expect(hitsFor(4828)).toEqual(["kb_seed_phishing"]);
  });

  it("finds the mailbox entry for a mailbox-access request", () => {
    expect(hitsFor(4829)).toEqual(["kb_seed_mailbox"]);
  });

  it("finds the VPN entry for a dropping VPN", () => {
    expect(hitsFor(4827)).toEqual(["kb_seed_vpn"]);
  });

  it("returns nothing for the tickets no seeded entry covers", () => {
    // The DNS fault is deliberately absent from the seed data - the agent has
    // to find it by running the checks. A hit here would mean the demo was
    // proving retrieval rather than diagnosis.
    for (const id of [4821, 4822, 4824, 4825, 4826]) {
      expect(hitsFor(id), `ticket ${id}`).toEqual([]);
    }
  });

  it("rejects a match that covers a quarter of an entry's symptoms", () => {
    const store = seeded();
    const loose = retrieve(store.all(), {
      text: "It says the site is fine but I cannot get on before the end of the day",
      minCoverage: 0,
      minQueryCoverage: 0,
    });
    // With the gates off, something matches. With them on, nothing does.
    expect(loose.length).toBeGreaterThan(0);
    expect(
      retrieve(store.all(), {
        text: "It says the site is fine but I cannot get on before the end of the day",
      }),
    ).toEqual([]);
  });

  it("penalises an entry whose category contradicts the ticket's", () => {
    const store = seeded();
    const text = "OneDrive says sync is paused and files are not uploading";
    const asStorage = retrieve(store.all(), { text, category: "storage" });
    const asSecurity = retrieve(store.all(), { text, category: "security" });
    const storageScore = asStorage.find((h) => h.entry.id === "kb_seed_onedrive_full")!.score;
    const securityHit = asSecurity.find((h) => h.entry.id === "kb_seed_onedrive_full");
    expect(storageScore).toBeGreaterThan(securityHit?.score ?? 0);
  });

  it("reports how much of the query an entry accounted for", () => {
    const store = seeded();
    const [hit] = retrieve(store.all(), {
      text: "My VPN keeps dropping and reconnects on its own then drops again every few minutes",
    });
    expect(hit!.query_coverage).toBeGreaterThan(0.2);
    expect(hit!.query_coverage).toBeLessThanOrEqual(1);
  });
});
