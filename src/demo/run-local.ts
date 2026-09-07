/**
 * Running AIT against the machine it is installed on.
 *
 * Same loop, same guardrails, same write-up path as the simulated demo - the
 * only difference is that the device session is real. That is the point: if the
 * safety behaviour only held in simulation it would be worth nothing.
 */
import { mkdirSync } from "node:fs";
import { runTicket, type RunEvent } from "../agent/loop.js";
import { selectBrainChecked, type BrainSelection, type ProviderName } from "../agent/select-brain.js";
import { PolicyBoundGate, type ApprovalGate } from "../control-plane/approvals.js";
import type { Run, Ticket } from "../contracts/index.js";
import { KnowledgeStore } from "../knowledge/index.js";
import type { SessionCapabilities } from "../execution-plane/device.js";
import {
  hostPlatform,
  localDangerTicket,
  localHealthTicket,
  localSession,
} from "./local.js";

export type LocalScenarioKey = "local-health" | "local-danger";

export interface LocalRunOptions {
  scenario: LocalScenarioKey;
  provider?: ProviderName;
  gate?: ApprovalGate;
  workdir?: string;
  onEvent?: (event: RunEvent) => void;
}

export interface LocalRunResult {
  run: Run;
  selection: BrainSelection;
  capabilities: SessionCapabilities;
  ticket: Ticket;
}

export const LOCAL_SCENARIOS: {
  key: LocalScenarioKey;
  title: string;
  demonstrates: string;
}[] = [
  {
    key: "local-health",
    title: "Check over this machine",
    demonstrates:
      "Real commands against the real host. On a healthy machine it reports healthy and changes nothing - it does not invent a fault to have something to fix.",
  },
  {
    key: "local-danger",
    title: "Dangerous requests against this machine",
    demonstrates:
      "A ticket asking to reset your password, delete your home directory and disable your firewall - aimed at this actual machine. Watch nothing happen to it.",
  },
];

export async function runLocal(options: LocalRunOptions): Promise<LocalRunResult> {
  const workdir = options.workdir ?? "run-artifacts";
  mkdirSync(workdir, { recursive: true });

  if (hostPlatform() === "unknown") {
    throw new Error(
      `AIT does not have a diagnostic set for platform "${process.platform}".`,
    );
  }

  const selection = await selectBrainChecked(options.provider);
  const session = localSession();
  const capabilities = await session.capabilities();

  const ticket =
    options.scenario === "local-danger" ? localDangerTicket() : localHealthTicket();

  try {
    const run = await runTicket({
      ticket,
      brain: selection.brain,
      knowledge: new KnowledgeStore(`${workdir}/knowledge.jsonl`),
      session,
      gate: options.gate ?? new PolicyBoundGate(),
      evidenceRoot: workdir,
      stepBudget: 10,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });
    return { run, selection, capabilities, ticket };
  } finally {
    await session.end();
  }
}
