#!/usr/bin/env node
/**
 * AIT command line.
 *
 *   ait demo                 run every demo scenario
 *   ait demo <scenario>      run one
 *   ait scenarios            list them
 *   ait check "<command>"    ask the guardrails about a command, without running it
 *   ait serve                start the technician console
 *
 * `check` is there for a specific reason: a service-desk lead evaluating this
 * should be able to interrogate the guardrails directly, without going through
 * a model, and see exactly which rule fires and why.
 */
import { runDemo } from "./demo/run-demo.js";
import { SCENARIOS } from "./demo/scenarios.js";
import { evaluate } from "./control-plane/policy/engine.js";
import { newId } from "./contracts/index.js";
import type { RunEvent } from "./agent/loop.js";
import type { Scenario } from "./demo/scenarios.js";
import type { ProviderName } from "./agent/select-brain.js";
import { LOCAL_SCENARIOS, runLocal, type LocalScenarioKey } from "./demo/run-local.js";
import { selectBrain } from "./agent/select-brain.js";
import { checkClaudeModel, checkOpenAIModel, withTimeout } from "./agent/model-check.js";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function outcomeMark(outcome: string): string {
  switch (outcome) {
    case "success":
      return c.green("✓");
    case "blocked":
      return c.red("⛔");
    case "awaiting_approval":
      return c.yellow("⏸");
    case "awaiting_user":
      return c.yellow("👤");
    case "failed":
      return c.red("✗");
    default:
      return c.dim("·");
  }
}

function printEvent(scenario: Scenario, event: RunEvent): void {
  switch (event.type) {
    case "intake":
      console.log(`  ${c.dim("intake")}     ${event.intake.summary}`);
      console.log(
        `             ${c.dim(`category=${event.intake.category} sentiment=${event.intake.user_sentiment}${event.intake.out_of_scope ? " OUT-OF-SCOPE" : ""}`)}`,
      );
      break;
    case "knowledge":
      if (event.ticketIds.length) {
        console.log(`  ${c.cyan("recall")}     ${event.ticketIds.length} similar ticket(s): ${event.ticketIds.join(", ")}`);
      } else {
        console.log(`  ${c.dim("recall")}     nothing similar on file`);
      }
      break;
    case "diagnosis": {
      const lead = event.diagnosis.hypotheses[event.diagnosis.leading_index];
      console.log(`  ${c.blue("diagnose")}   ${lead?.statement ?? "-"}`);
      console.log(`             ${c.dim(`confidence=${event.diagnosis.confidence}, ${event.diagnosis.hypotheses.length} hypothesis/es`)}`);
      break;
    }
    case "step": {
      const r = event.result;
      const cmd = r.command ? c.dim(` $ ${r.command.command}`) : "";
      console.log(`  ${outcomeMark(r.outcome)} ${r.step.intent}${cmd}`);
      if (r.observation) console.log(`             ${c.dim(r.observation.slice(0, 160))}`);
      if (r.outcome === "blocked" || r.outcome === "awaiting_approval") {
        console.log(`             ${c.red(`guardrail ${r.verdict.rule_id}`)}: ${r.verdict.reason}`);
      } else if (r.verdict.reason.includes("Approved by")) {
        // A step that ran only because a human (or standing policy) cleared it
        // should say so - "it worked" and "it was allowed to" are different facts.
        console.log(`             ${c.yellow(`approved (${r.verdict.rule_id})`)}`);
      }
      if (r.artifacts.length) {
        console.log(`             ${c.dim(`evidence: ${r.artifacts.map((a) => a.uri.split("/").pop()).join(", ")}`)}`);
      }
      break;
    }
    case "escalation":
      if (event.escalation.triggered) {
        console.log(
          `  ${c.yellow("escalate")}   → ${event.escalation.route_to} (${event.escalation.triggers.join(", ")})`,
        );
        console.log(`             ${c.dim(event.escalation.ask)}`);
      }
      break;
    default:
      break;
  }
}

async function cmdDemo(args: string[]): Promise<void> {
  const provider = readFlag(args, "--provider") as ProviderName | undefined;
  const keys = args.filter((a) => !a.startsWith("-"));

  const session = await runDemo({
    ...(provider ? { provider } : {}),
    ...(keys.length ? { scenarios: keys } : {}),
    onEvent: printEvent,
  });

  console.log(
    `\n${c.bold("AIT")} — reasoning provider: ${c.bold(session.selection.provider)} (${session.selection.model})`,
  );
  console.log(c.dim(`  ${session.selection.note}\n`));

  for (const result of session.results) {
    const { run, scenario } = result;
    console.log(
      `${c.bold(`── ${scenario.title}`)} ${c.dim(`[${scenario.key}] ticket ${run.ticket.id}`)}`,
    );
    console.log(c.dim(`   ${scenario.demonstrates}\n`));
    console.log(
      `   status: ${run.status === "resolved" ? c.green(run.status) : c.yellow(run.status)}` +
        `   steps: ${run.results.length}   audit entries: ${run.audit.length}`,
    );
    if (run.documentation) {
      console.log(`\n   ${c.bold("Reply to user")}`);
      for (const line of wrap(run.documentation.user_reply, 76)) {
        console.log(`     ${line}`);
      }
    }
    console.log("");
  }

  const resolved = session.results.filter((r) => r.run.status === "resolved").length;
  const escalated = session.results.filter((r) => r.run.status === "escalated").length;
  const blocked = session.results.reduce(
    (n, r) => n + r.run.results.filter((s) => s.outcome === "blocked").length,
    0,
  );
  console.log(c.bold("── Summary"));
  console.log(
    `   ${c.green(`${resolved} resolved`)}   ${c.yellow(`${escalated} escalated`)}   ${c.red(`${blocked} action(s) blocked by guardrails`)}`,
  );
  console.log(`   knowledge base now holds ${session.knowledge.size()} entries`);
  console.log(c.dim(`   evidence written to ./run-artifacts\n`));
}

/** Run against the machine this process is on. */
async function cmdLocal(args: string[]): Promise<void> {
  const provider = readFlag(args, "--provider") as ProviderName | undefined;
  const positional = args.filter((a) => !a.startsWith("-"));
  const scenario = (positional[0] ?? "local-health") as LocalScenarioKey;

  if (!LOCAL_SCENARIOS.some((s) => s.key === scenario)) {
    console.error(
      `Unknown local scenario "${scenario}". Try: ${LOCAL_SCENARIOS.map((s) => s.key).join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const meta = LOCAL_SCENARIOS.find((s) => s.key === scenario)!;
  console.log(`\n${c.bold("AIT — running against this machine")}`);
  console.log(c.dim(`  ${meta.demonstrates}\n`));

  const { run, selection, capabilities, ticket } = await runLocal({
    scenario,
    ...(provider ? { provider } : {}),
    onEvent: (event) => printEvent({ key: scenario } as Scenario, event),
  });

  console.log(
    `\n  ${c.dim("host")}       ${ticket.device?.hostname} (${capabilities.platform}) · ${capabilities.availableCommands.length} diagnostic tools found`,
  );
  if (!capabilities.canCapture) {
    console.log(`  ${c.dim("screen")}     not capturable: ${capabilities.captureUnavailableReason}`);
  }
  console.log(`  ${c.dim("provider")}   ${selection.provider} (${selection.model})`);
  console.log(
    `  ${c.dim("outcome")}    ${run.status === "resolved" ? c.green(run.status) : c.yellow(run.status)} · ${run.results.length} step(s)`,
  );

  const blocked = run.results.filter((r) => r.outcome === "blocked");
  if (blocked.length > 0) {
    console.log(`\n  ${c.bold("Refused on this machine")}`);
    for (const b of blocked) {
      console.log(`    ${c.red("⛔")} ${b.step.intent}`);
      console.log(`       ${c.dim(String(b.step.payload["command"] ?? ""))}`);
      console.log(`       ${c.dim(b.verdict.rule_id)}`);
    }
  }

  const changed = run.results.filter((r) => r.outcome === "success" && r.step.mutating);
  console.log(
    `\n  ${changed.length === 0 ? c.green("Nothing on this machine was changed.") : c.yellow(`${changed.length} change(s) applied.`)}`,
  );

  if (run.documentation) {
    console.log(`\n  ${c.bold("Reply to user")}`);
    for (const line of wrap(run.documentation.user_reply, 76)) console.log(`    ${line}`);
  }
  console.log("");
}

/** Report which providers are configured, and whether their models exist. */
async function cmdProviders(): Promise<void> {
  console.log(`\n${c.bold("Reasoning providers")}\n`);

  const rows: [string, string, string][] = [];

  for (const provider of ["claude", "openai"] as const) {
    let selection;
    try {
      selection = selectBrain(provider);
    } catch (err) {
      rows.push([provider, c.dim("not configured"), err instanceof Error ? err.message : ""]);
      continue;
    }

    const check = await withTimeout(
      provider === "claude"
        ? checkClaudeModel(selection.model)
        : checkOpenAIModel(selection.model),
      {
        ok: true,
        model: selection.model,
        skipped: "timed out",
        message: "Model list did not respond in time.",
      },
    );

    const state = check.skipped
      ? c.yellow("unverified")
      : check.ok
        ? c.green("ready")
        : c.red("model not found");
    rows.push([provider, state, check.message]);
  }

  const offline = selectBrain("offline");
  rows.push(["offline", c.green("ready"), `${offline.model} - deterministic, no network`]);

  for (const [name, state, detail] of rows) {
    console.log(`  ${c.bold(name.padEnd(9))} ${state}`);
    for (const line of wrap(detail, 68)) console.log(`  ${" ".repeat(9)} ${c.dim(line)}`);
    console.log("");
  }

  const active = selectBrain();
  console.log(`  ${c.dim("auto would choose:")} ${c.bold(active.provider)} (${active.model})\n`);
}

function cmdScenarios(): void {
  console.log(`\n${c.bold("Demo scenarios")}\n`);
  for (const s of SCENARIOS) {
    console.log(`  ${c.bold(s.key.padEnd(16))} ${s.title}`);
    for (const line of wrap(s.demonstrates, 70)) {
      console.log(`  ${" ".repeat(16)} ${c.dim(line)}`);
    }
    console.log("");
  }

  console.log(`${c.bold("Against this machine")} ${c.dim("(ait local <key>)")}\n`);
  for (const s of LOCAL_SCENARIOS) {
    console.log(`  ${c.bold(s.key.padEnd(16))} ${s.title}`);
    for (const line of wrap(s.demonstrates, 70)) {
      console.log(`  ${" ".repeat(16)} ${c.dim(line)}`);
    }
    console.log("");
  }
}

/** Interrogate the guardrails directly - no model involved. */
function cmdCheck(args: string[]): void {
  const command = args.filter((a) => !a.startsWith("-")).join(" ");
  if (!command) {
    console.error('Usage: ait check "<command or intent>"');
    process.exitCode = 1;
    return;
  }

  const verdict = evaluate(
    {
      id: newId("check"),
      kind: "command",
      intent: command,
      payload: { command },
      mutating: false,
    },
    {
      device: {
        device_id: "check",
        hostname: "check",
        platform: "windows",
        consent_granted: true,
        managed: true,
      },
    },
  );

  const colour =
    verdict.decision === "allow"
      ? c.green
      : verdict.decision === "block"
        ? c.red
        : c.yellow;

  console.log(`\n  command   ${c.bold(command)}`);
  console.log(`  decision  ${colour(verdict.decision.toUpperCase())}`);
  console.log(`  rule      ${verdict.rule_id}`);
  console.log(`  category  ${verdict.categories.join(", ")}`);
  console.log(`  escalate  ${verdict.escalate ? "yes" : "no"}`);
  console.log(`  reason    ${verdict.reason}\n`);
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + word.length + 1 <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function usage(): void {
  console.log(`
${c.bold("AIT")} — AI IT technician

  ait demo [scenario...]      run the simulated demo (all scenarios by default)
  ait local [scenario]        run against THIS machine (local-health | local-danger)
  ait demo --provider openai  force a reasoning provider (claude|openai|offline)
  ait scenarios               list every scenario
  ait providers               show which providers are configured and verified
  ait check "<command>"       ask the guardrails about a command without running it
  ait serve                   start the technician console on :3000

Providers are chosen by AIT_PROVIDER, or automatically from whichever of
ANTHROPIC_API_KEY / OPENAI_API_KEY is set. With neither, AIT runs its
deterministic playbook engine so the demo still works offline.
`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "demo":
      await cmdDemo(args);
      break;
    case "local":
      await cmdLocal(args);
      break;
    case "providers":
      await cmdProviders();
      break;
    case "scenarios":
      cmdScenarios();
      break;
    case "check":
      cmdCheck(args);
      break;
    case "serve": {
      const { startServer } = await import("./server/index.js");
      await startServer();
      break;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(c.red(`\nAIT failed: ${err instanceof Error ? err.message : String(err)}\n`));
  process.exitCode = 1;
});
