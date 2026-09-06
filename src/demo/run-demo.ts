/**
 * The demo runner.
 *
 * Wires the real components together - mock Zendesk in place of a live one, a
 * simulated device in place of a MeshCentral session - and runs the actual
 * agent loop. Nothing here is a special demo path: the same `runTicket` that
 * would run in production runs here, which is why the demo is worth watching.
 */
import { mkdirSync, rmSync } from "node:fs";
import { runTicket, type RunEvent } from "../agent/loop.js";
import { selectBrain, type BrainSelection, type ProviderName } from "../agent/select-brain.js";
import { PolicyBoundGate } from "../control-plane/approvals.js";
import type { Run } from "../contracts/index.js";
import {
  InMemoryZendeskClient,
  publicReplyFor,
  ticketUpdateFor,
  toTicket,
  type ZendeskClient,
} from "../integrations/zendesk/index.js";
import { KnowledgeStore } from "../knowledge/index.js";
import { seedKnowledge } from "./seed-knowledge.js";
import { DEVICE_FIELDS, SCENARIOS, TICKETS, USERS, type Scenario } from "./scenarios.js";
import { readFileSync } from "node:fs";

export interface DemoOptions {
  provider?: ProviderName;
  /** Scenario keys to run, in order. Defaults to all of them. */
  scenarios?: string[];
  workdir?: string;
  /** Start from an empty knowledge base each time. Default true. */
  fresh?: boolean;
  onEvent?: (scenario: Scenario, event: RunEvent) => void;
}

export interface DemoResult {
  scenario: Scenario;
  run: Run;
  /** The ticket as it looks in Zendesk after the run wrote back. */
  ticketAfter: Awaited<ReturnType<ZendeskClient["getTicket"]>>;
  /** Artefacts attached to the ticket, for the console to render. */
  attachments: { file_name: string; content_type: string; svg?: string }[];
}

export interface DemoSession {
  selection: BrainSelection;
  zendesk: InMemoryZendeskClient;
  knowledge: KnowledgeStore;
  results: DemoResult[];
}

export async function runDemo(options: DemoOptions = {}): Promise<DemoSession> {
  const workdir = options.workdir ?? "run-artifacts";
  if (options.fresh !== false) {
    rmSync(workdir, { recursive: true, force: true });
  }
  mkdirSync(workdir, { recursive: true });

  const selection = selectBrain(options.provider);
  const zendesk = new InMemoryZendeskClient({ tickets: TICKETS, users: USERS });
  const knowledge = new KnowledgeStore(`${workdir}/knowledge.jsonl`);
  seedKnowledge(knowledge);

  const keys = options.scenarios ?? SCENARIOS.map((s) => s.key);
  const results: DemoResult[] = [];

  for (const key of keys) {
    const scenario = SCENARIOS.find((s) => s.key === key);
    if (!scenario) throw new Error(`Unknown scenario "${key}".`);

    const zTicket = await zendesk.getTicket(scenario.ticketId);
    const requester = await zendesk.getUser(zTicket.requester_id);
    const ticket = toTicket(zTicket, requester, { deviceFields: DEVICE_FIELDS });

    const session = scenario.makeSession();

    const run = await runTicket({
      ticket,
      brain: selection.brain,
      knowledge,
      ...(session ? { session } : {}),
      // The standing-policy gate is what a service desk would actually deploy:
      // narrow pre-authorisation for reversible tier-1 work, humans for the rest.
      gate: new PolicyBoundGate(),
      evidenceRoot: workdir,
      stepBudget: 10,
      ...(options.onEvent
        ? { onEvent: (event: RunEvent) => options.onEvent!(scenario, event) }
        : {}),
    });

    await session?.end();

    // --- Write back to the help desk, attachments and all -------------------
    const attachments: DemoResult["attachments"] = [];
    const tokens: string[] = [];
    for (const result of run.results) {
      for (const artifact of result.artifacts) {
        if (artifact.content_type !== "image/svg+xml") continue;
        const path = artifact.uri.replace(/^file:\/\//, "");
        const svg = readFileSync(path, "utf8");
        const file_name = path.split("/").pop() ?? "capture.svg";
        const upload = await zendesk.upload(file_name, "image/svg+xml", svg);
        tokens.push(upload.token);
        attachments.push({ file_name, content_type: "image/svg+xml", svg });
      }
    }

    await zendesk.updateTicket(scenario.ticketId, ticketUpdateFor(run, tokens));
    const publicReply = publicReplyFor(run.documentation, run.escalation, []);
    if (publicReply) {
      await zendesk.updateTicket(scenario.ticketId, publicReply);
    }

    const ticketAfter = await zendesk.getTicket(scenario.ticketId);
    results.push({ scenario, run, ticketAfter, attachments });
  }

  return { selection, zendesk, knowledge, results };
}
