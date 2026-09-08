/**
 * Working the queue.
 *
 * A service desk is not one ticket, it is a morning's worth of them, and the
 * question a manager actually asks is "how much of that can this take?" This
 * answers it by working every open ticket in order and reporting what happened
 * across the lot.
 *
 * It uses `listOpenTickets`, so it works the same against the in-memory help
 * desk and a real Zendesk instance - which is the point of the interface.
 */
import { runTicket, type RunEvent } from "../agent/loop.js";
import { selectBrainChecked, type BrainSelection, type ProviderName } from "../agent/select-brain.js";
import { PolicyBoundGate, type ApprovalGate } from "../control-plane/approvals.js";
import type { Run } from "../contracts/index.js";
import { KnowledgeStore } from "../knowledge/index.js";
import {
  publicReplyFor,
  selectHelpDesk,
  ticketUpdateFor,
  toTicket,
  type ZendeskClient,
} from "../integrations/zendesk/index.js";
import { seedKnowledge } from "./seed-knowledge.js";
import { DEVICE_FIELDS, SCENARIOS } from "./scenarios.js";
import { shiftMetrics, type ShiftMetrics } from "./metrics.js";
import { mkdirSync, existsSync, readFileSync } from "node:fs";

export interface QueueOptions {
  provider?: ProviderName;
  workdir?: string;
  gate?: ApprovalGate;
  /** Cap on how many tickets to take off the queue. */
  limit?: number;
  zendesk?: ZendeskClient;
  onTicketStart?: (ticketId: string, subject: string, index: number, total: number) => void;
  onEvent?: (ticketId: string, event: RunEvent) => void;
  onTicketDone?: (run: Run) => void;
}

export interface QueueResult {
  selection: BrainSelection;
  runs: Run[];
  metrics: ShiftMetrics;
  knowledgeSize: number;
  /** Which help desk the queue came from. */
  helpDesk: { kind: "zendesk" | "in-memory"; note: string };
}

/**
 * Map a ticket to the device it is about.
 *
 * In the demo the mapping comes from the scenario table; in a real deployment
 * it would come from the ticket's own device fields and a MeshCentral session.
 */
function sessionForTicket(externalId: string | undefined) {
  const scenario = SCENARIOS.find((s) => String(s.ticketId) === externalId);
  return scenario?.makeSession();
}

export async function runQueue(options: QueueOptions = {}): Promise<QueueResult> {
  const workdir = options.workdir ?? "run-artifacts";
  mkdirSync(workdir, { recursive: true });

  const selection = await selectBrainChecked(options.provider);
  // Live Zendesk when it is configured, the in-memory one otherwise. Reported
  // on the result so a queue run never leaves you guessing which it worked.
  const helpDesk = options.zendesk
    ? { client: options.zendesk, kind: "in-memory" as const, note: "supplied by the caller" }
    : selectHelpDesk();
  const zendesk = helpDesk.client;
  const knowledge = new KnowledgeStore(`${workdir}/knowledge.jsonl`);
  seedKnowledge(knowledge);

  const open = await zendesk.listOpenTickets(options.limit ?? 25);
  const runs: Run[] = [];

  for (const [index, zTicket] of open.entries()) {
    const requester = await zendesk.getUser(zTicket.requester_id);
    const ticket = toTicket(zTicket, requester, { deviceFields: DEVICE_FIELDS });
    options.onTicketStart?.(ticket.id, ticket.subject, index + 1, open.length);

    const session = sessionForTicket(zTicket.external_id ?? String(zTicket.id));

    const run = await runTicket({
      ticket,
      brain: selection.brain,
      knowledge,
      ...(session ? { session } : {}),
      // A queue run is unattended by definition, so the standing policy is what
      // decides. Anything outside it waits for a person, which is the answer.
      gate: options.gate ?? new PolicyBoundGate(),
      evidenceRoot: workdir,
      stepBudget: 10,
      ...(options.onEvent
        ? { onEvent: (event: RunEvent) => options.onEvent!(ticket.id, event) }
        : {}),
    });

    await session?.end();

    // Write back, so the queue afterwards looks like a queue that was worked.
    const tokens: string[] = [];
    for (const result of run.results) {
      for (const artifact of result.artifacts) {
        if (!artifact.content_type?.startsWith("image/")) continue;
        const path = artifact.uri.replace(/^file:\/\//, "");
        if (!existsSync(path)) continue;
        const upload = await zendesk.upload(
          path.split("/").pop()!,
          artifact.content_type,
          readFileSync(path, "utf8"),
        );
        tokens.push(upload.token);
      }
    }
    await zendesk.updateTicket(zTicket.id, ticketUpdateFor(run, tokens));
    const reply = publicReplyFor(run.documentation, run.escalation, []);
    if (reply) await zendesk.updateTicket(zTicket.id, reply);

    runs.push(run);
    options.onTicketDone?.(run);
  }

  return {
    selection,
    runs,
    metrics: shiftMetrics(runs),
    knowledgeSize: knowledge.size(),
    helpDesk: { kind: helpDesk.kind, note: helpDesk.note },
  };
}
