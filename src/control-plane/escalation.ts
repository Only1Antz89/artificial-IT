/**
 * When to hand the ticket to a human.
 *
 * Knowing when to stop is the part of this job that matters most, so the rules
 * are explicit and evaluated over the finished run rather than decided by the
 * model in the moment. The model can *ask* to escalate; it cannot decline to.
 */
import type {
  Diagnosis,
  RiskCategory,
  Escalation,
  EscalationTrigger,
  Intake,
  Severity,
  StepResult,
  Ticket,
} from "../contracts/index.js";
import { nowIso } from "../contracts/index.js";

export interface EscalationInput {
  ticket: Ticket;
  intake?: Intake;
  diagnosis?: Diagnosis;
  results: StepResult[];
  /** True when the loop hit its step budget without resolving. */
  budgetExhausted: boolean;
  /** True when the agent believes the issue is fixed and verified. */
  resolved: boolean;
  /**
   * True when the agent asked to stop and hand over.
   *
   * The agent can ask; it cannot decline to escalate. Passing this in rather
   * than letting the caller force-trigger the escalation afterwards means the
   * routing and the handover are built the same way for every escalation,
   * instead of an agent-requested one arriving at the default queue with a
   * placeholder trigger.
   */
  wantsHuman?: boolean;
}

/** Phrases that mean "I want a person", checked against the user's own words. */
const HUMAN_REQUEST = /\b(speak|talk|escalate)\b[^\n]{0,20}\b(human|person|someone|technician|engineer|manager)\b|\b(real|actual)\s+(person|human)\b|\bstop\s+the\s+bot\b/i;

/** Phrases implying someone has to physically touch the machine. */
const HANDS_ON = /\b(replace|swap|plug|unplug|cable|screen\s+cracked|won'?t\s+power|dead\s+battery|new\s+(laptop|machine|device)|collect|courier|desk\s+visit)\b/i;

const ORDER: Severity[] = ["low", "normal", "high", "urgent"];
function highest(a: Severity, b: Severity): Severity {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

export function assessEscalation(input: EscalationInput): Escalation {
  const { ticket, intake, diagnosis, results, budgetExhausted, resolved } = input;
  const triggers = new Set<EscalationTrigger>();
  let urgency: Severity = ticket.priority;

  const userText = [
    ticket.description,
    ...ticket.comments.filter((c) => c.author_role === "requester").map((c) => c.body),
  ].join("\n");

  // The user asking for a person is honoured unconditionally, even mid-fix.
  if (HUMAN_REQUEST.test(userText)) {
    triggers.add("user-requested");
    urgency = highest(urgency, "high");
  }

  if (HANDS_ON.test(userText)) {
    triggers.add("needs-hands-on");
  }

  if (intake?.out_of_scope) {
    triggers.add("out-of-scope");
  }

  // A guardrail block means the fix needs authority the agent does not have.
  const blocked = results.filter((r) => r.outcome === "blocked");
  if (blocked.length > 0) {
    triggers.add("policy-block");
    if (blocked.some((b) => b.verdict.escalate)) {
      urgency = highest(urgency, "high");
    }
  }

  // Work that stopped at the approval gate, in a run with no human attached.
  // Only when the run did not otherwise succeed: a resolved ticket that also
  // skipped one optional gated check is finished, not escalated.
  if (!resolved && results.some((r) => r.outcome === "awaiting_approval")) {
    triggers.add("requires-authority");
  }

  if (!resolved && diagnosis && diagnosis.confidence === "low") {
    triggers.add("low-confidence");
  }

  // Three or more failed executions means the approach is wrong, not unlucky.
  const failures = results.filter((r) => r.outcome === "failed").length;
  if (!resolved && failures >= 3) {
    triggers.add("repeated-failure");
  }

  if (budgetExhausted && !resolved) {
    triggers.add("budget-exhausted");
  }

  // The agent ran out of things it could safely try. That is a real trigger,
  // not a fallback: it is the honest answer on a ticket whose fix is a decision
  // rather than a command. Which of the two it is depends on whether a cause
  // was actually established - "fresh eyes needed" on a ticket where the cause
  // is sitting in the write-up sends the technician looking for nothing.
  if (input.wantsHuman && !resolved) {
    const established =
      Boolean(diagnosis?.root_cause) && diagnosis?.confidence !== "low";
    triggers.add(established ? "no-safe-action" : "low-confidence");
  }

  // Someone who cannot work, or a VIP, should not sit in a queue behind a bot.
  const blockedUser =
    intake?.user_sentiment === "blocked" || intake?.user_sentiment === "urgent";
  if (!resolved && (ticket.requester.vip || blockedUser || ticket.priority === "urgent")) {
    triggers.add("user-impact");
    urgency = highest(urgency, ticket.requester.vip ? "high" : urgency);
  }

  const triggered = triggers.size > 0;
  if (!triggered) {
    return {
      triggered: false,
      triggers: [],
      urgency,
      route_to: "service-desk-tier-2",
      ask: "",
      handover: {
        what_we_know: [],
        what_we_tried: [],
        what_we_could_not_do: [],
        suggested_next_steps: [],
      },
    };
  }

  return {
    triggered: true,
    triggers: [...triggers],
    urgency,
    route_to: routeFor([...triggers], input),
    ask: askFor([...triggers]),
    handover: buildHandover(input),
    raised_at: nowIso(),
  };
}

/**
 * The team a blocked risk category actually belongs to.
 *
 * Routing every guardrail block to tier 2 is what makes an escalation feel
 * like a dead end: a request to disable Defender is not a service-desk
 * decision, and a request to read a colleague's mailbox is not a technical one
 * at all. Ordered by which team should see it first when more than one
 * category fired.
 */
const TEAM_FOR_CATEGORY: [RiskCategory, string][] = [
  ["security-controls", "security-operations"],
  ["data-exfiltration", "security-operations"],
  ["compliance", "information-governance"],
  ["finance", "finance-systems"],
  ["identity", "identity-and-access"],
  ["credentials", "identity-and-access"],
  ["network-infrastructure", "network-engineering"],
  ["major-system-change", "endpoint-engineering"],
];

/** Send the ticket where the authority to act actually sits. */
function routeFor(triggers: EscalationTrigger[], input: EscalationInput): string {
  if (triggers.includes("needs-hands-on")) return "field-services";

  if (triggers.includes("policy-block")) {
    const blockedCategories = new Set(
      input.results
        .filter((r) => r.outcome === "blocked")
        .flatMap((r) => r.verdict.categories),
    );
    for (const [category, team] of TEAM_FOR_CATEGORY) {
      if (blockedCategories.has(category)) return team;
    }
    return "service-desk-tier-2";
  }

  // Nothing was blocked, but the ticket itself is a security report. Those go
  // to the people who can look at the mail gateway, not to a desk technician.
  if (input.intake?.category === "security") return "security-operations";

  if (triggers.includes("requires-authority")) return "service-desk-tier-2";
  if (triggers.includes("out-of-scope")) return "service-desk-triage";
  return "service-desk-tier-2";
}

function askFor(triggers: EscalationTrigger[]): string {
  if (triggers.includes("user-requested")) {
    return "The user asked to speak to a person - please pick this up directly.";
  }
  if (triggers.includes("policy-block")) {
    return "The remaining fix crosses a guardrail the assistant may not cross. Please review the blocked action and decide.";
  }
  if (triggers.includes("requires-authority")) {
    return "A change is ready to go but needs a technician to authorise it.";
  }
  if (triggers.includes("needs-hands-on")) {
    return "This needs someone physically at the device.";
  }
  if (triggers.includes("no-safe-action")) {
    return "The cause is identified and in the write-up. There is no safe automated action for it, so it needs a person to decide.";
  }
  if (triggers.includes("low-confidence")) {
    return "Diagnosis did not get above low confidence. Fresh eyes needed on the evidence collected.";
  }
  if (triggers.includes("repeated-failure")) {
    return "Several remediation attempts failed. The approach is likely wrong - see what was tried.";
  }
  if (triggers.includes("out-of-scope")) {
    return "This is not an IT technician task. Please re-route it.";
  }
  return "Please review and take over.";
}

/** The pack a human reads instead of re-running the whole investigation. */
function buildHandover(input: EscalationInput): Escalation["handover"] {
  const { intake, diagnosis, results } = input;

  const what_we_know: string[] = [];
  if (intake) {
    what_we_know.push(`Request: ${intake.summary}`);
    what_we_know.push(`Category: ${intake.category}`);
    for (const s of intake.reported_symptoms) what_we_know.push(`Reported: ${s}`);
  }
  if (diagnosis) {
    const lead = diagnosis.hypotheses[diagnosis.leading_index] ?? diagnosis.hypotheses[0];
    if (lead) {
      what_we_know.push(
        `Leading hypothesis (${lead.confidence} confidence): ${lead.statement}`,
      );
    }
    for (const h of diagnosis.hypotheses) {
      for (const e of h.contradicting_evidence) what_we_know.push(`Ruled out: ${e}`);
    }
  }

  const what_we_tried = results
    .filter((r) => r.outcome === "success" || r.outcome === "failed")
    .map((r) => {
      const status = r.outcome === "success" ? "ok" : "failed";
      const note = r.observation ? ` - ${r.observation}` : "";
      return `[${status}] ${r.step.intent}${note}`;
    });

  const what_we_could_not_do = results
    .filter((r) => r.outcome === "blocked" || r.outcome === "awaiting_approval")
    .map((r) => `${r.step.intent} - ${r.verdict.reason}`);

  const suggested_next_steps: string[] = [];
  if (diagnosis?.root_cause) {
    suggested_next_steps.push(`Confirm root cause: ${diagnosis.root_cause}`);
  }
  for (const r of results) {
    if (r.outcome === "awaiting_approval") {
      suggested_next_steps.push(`Authorise and run: ${r.step.intent}`);
    }
    if (r.outcome === "blocked" && r.verdict.decision === "block") {
      suggested_next_steps.push(
        `Handle manually under change control: ${r.step.intent} (${r.verdict.categories.join(", ")})`,
      );
    }
  }
  if (suggested_next_steps.length === 0) {
    suggested_next_steps.push("Review the evidence attached to the ticket and continue triage.");
  }

  return { what_we_know, what_we_tried, what_we_could_not_do, suggested_next_steps };
}
