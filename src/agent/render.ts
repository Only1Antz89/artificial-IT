/**
 * Rendering context for the model.
 *
 * Markdown rather than raw JSON for the ticket and the history: the model reads
 * it better, and - more usefully - a human debugging a bad decision can read the
 * exact context the model saw. JSON is kept for the structured objects the
 * model itself produced.
 */
import type {
  Diagnosis,
  Intake,
  StepResult,
  Ticket,
} from "../contracts/index.js";
import type { RetrievalHit } from "../knowledge/index.js";

export function renderTicket(ticket: Ticket): string {
  const lines = [
    `## Ticket ${ticket.id}`,
    `Subject: ${ticket.subject}`,
    `Priority: ${ticket.priority}${ticket.requester.vip ? " (requester is a VIP)" : ""}`,
    `Requester: ${ticket.requester.name}${ticket.requester.department ? `, ${ticket.requester.department}` : ""}`,
    "",
    `Description:`,
    ticket.description,
  ];

  if (ticket.device) {
    const d = ticket.device;
    lines.push(
      "",
      `Device: ${d.hostname} (${d.platform}${d.os_version ? ` ${d.os_version}` : ""})`,
      `Managed: ${d.managed ? "yes" : "no (BYOD)"} · Remote session consent: ${d.consent_granted ? "granted" : "not granted"}`,
    );
  } else {
    lines.push("", "Device: none attached to this ticket.");
  }

  const conversation = ticket.comments.filter((c) => c.public);
  if (conversation.length > 0) {
    lines.push("", "Conversation so far:");
    for (const c of conversation) {
      lines.push(`- [${c.author_role}] ${c.author}: ${c.body}`);
    }
  }

  return lines.join("\n");
}

export function renderPriorTickets(hits: RetrievalHit[]): string {
  if (hits.length === 0) {
    return "## Prior tickets\nNothing similar in the knowledge base.";
  }
  const lines = ["## Prior tickets (most similar first)"];
  for (const hit of hits) {
    const e = hit.entry;
    lines.push(
      "",
      `### ${e.id} — ${e.title}`,
      `From ticket ${e.source_ticket_id}, outcome: ${e.outcome}, applied ${e.times_applied}x. Matched on: ${hit.matched_terms.join(", ")}`,
      `Symptoms: ${e.symptoms.join("; ")}`,
      `Root cause: ${e.root_cause}`,
    );
    if (e.diagnostic_steps.length) {
      lines.push(`Diagnosed with: ${e.diagnostic_steps.join(" · ")}`);
    }
    if (e.resolution_steps.length) {
      lines.push(`Fixed with: ${e.resolution_steps.join(" · ")}`);
    }
    for (const c of e.cautions) lines.push(`Caution: ${c}`);
  }
  return lines.join("\n");
}

export function renderDiagnosisContext(intake: Intake, diagnosis: Diagnosis): string {
  const lines = [
    "## Current understanding",
    `Summary: ${intake.summary}`,
    `Category: ${intake.category} · sentiment: ${intake.user_sentiment}`,
    "",
    `Hypotheses (confidence ${diagnosis.confidence}):`,
  ];
  diagnosis.hypotheses.forEach((h, i) => {
    const lead = i === diagnosis.leading_index ? " ← pursuing" : "";
    lines.push(`${i}. ${h.statement} [${h.confidence}]${lead}`);
    for (const e of h.contradicting_evidence) lines.push(`   ruled out by: ${e}`);
  });
  if (diagnosis.root_cause) lines.push("", `Root cause so far: ${diagnosis.root_cause}`);
  return lines.join("\n");
}

/**
 * The evidence so far.
 *
 * Command output is included verbatim (trimmed) rather than summarised - the
 * whole point of the loop is that the next decision is made on what the machine
 * actually said, not on a paraphrase of it.
 */
export function renderHistory(history: StepResult[]): string {
  if (history.length === 0) return "## Steps so far\nNothing has been run yet.";

  const lines = ["## Steps so far"];
  for (const r of history) {
    lines.push("", `### ${r.step.intent} — ${r.outcome}`);
    if (r.command) {
      lines.push(`$ ${r.command.command}`, `exit ${r.command.exit_code}`);
      const stdout = r.command.stdout.trim();
      const stderr = r.command.stderr.trim();
      if (stdout) lines.push("```", clip(stdout), "```");
      if (stderr) lines.push("stderr:", "```", clip(stderr), "```");
    } else if (r.observation) {
      lines.push(r.observation);
    }
    if (r.outcome === "blocked" || r.outcome === "awaiting_approval") {
      lines.push(`Guardrail: ${r.verdict.reason} (${r.verdict.rule_id})`);
      lines.push("Do not propose this again. Work around it or escalate.");
    }
    if (r.artifacts.length) {
      lines.push(`Evidence captured: ${r.artifacts.map((a) => a.caption ?? a.uri).join(", ")}`);
    }
  }
  return lines.join("\n");
}

/** Keep a single command's output from crowding out the rest of the history. */
function clip(text: string, maxLines = 40): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [
    ...lines.slice(0, maxLines),
    `… [${lines.length - maxLines} further lines omitted]`,
  ].join("\n");
}
