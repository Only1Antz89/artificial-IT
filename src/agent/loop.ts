/**
 * The agent loop.
 *
 * This is the control-plane-owned process. Read it top to bottom and you have
 * the whole product: understand the request, recall what we learned last time,
 * form a diagnosis, then repeatedly propose -> gate -> execute -> observe until
 * the issue is fixed or it is time to fetch a human. Afterwards: document,
 * decide on escalation, write back to the help desk, and learn.
 *
 * The invariant that matters most: **the brain never touches the device.** It
 * returns proposals; this file evaluates each one against policy, routes the
 * gated ones to a human, and only then hands a cleared step to the executor.
 * There is no branch here that skips `evaluate()`.
 */
import type {
  Diagnosis,
  Documentation,
  Escalation,
  Intake,
  PlanStep,
  Run,
  StepResult,
  Ticket,
} from "../contracts/index.js";
import { SCHEMA_VERSION, newId, nowIso } from "../contracts/index.js";
import { AuditLog } from "../control-plane/audit.js";
import { assessEscalation } from "../control-plane/escalation.js";
import { evaluate } from "../control-plane/policy/engine.js";
import type { ApprovalGate } from "../control-plane/approvals.js";
import { AutoDenyGate } from "../control-plane/approvals.js";
import type { DeviceSession } from "../execution-plane/device.js";
import { EvidenceStore } from "../execution-plane/evidence-store.js";
import { executeStep } from "../execution-plane/executor.js";
import { learnFromRun, retrieve, type KnowledgeStore } from "../knowledge/index.js";
import type { Brain } from "./brain.js";

export interface RunOptions {
  ticket: Ticket;
  brain: Brain;
  knowledge: KnowledgeStore;
  session?: DeviceSession;
  gate?: ApprovalGate;
  tenantId?: string;
  /** Maximum steps this run may execute. Prevents an unbounded investigation. */
  stepBudget?: number;
  /** Where evidence files are written. */
  evidenceRoot?: string;
  /** Answers available to `ask_user` steps without waiting on a real person. */
  userAnswers?: Record<string, string>;
  /**
   * Put a question to the user and wait for the answer.
   *
   * When present, an `ask_user` step becomes a real pause rather than a dead
   * end: the console asks, someone types a reply, and the run carries on with
   * it. Absent, the step falls back to `userAnswers` and then to stopping -
   * which is right for an unattended run, where nobody is there to answer.
   */
  askUser?: (question: string, step: PlanStep) => Promise<string | undefined>;
  /** Called after each meaningful event, for the console and the CLI. */
  onEvent?: (event: RunEvent) => void;
  /** Write a knowledge entry when the run settles. Default true. */
  learn?: boolean;
}

export type RunEvent =
  | { type: "intake"; intake: Intake }
  | { type: "knowledge"; ticketIds: string[] }
  | { type: "diagnosis"; diagnosis: Diagnosis }
  | { type: "proposed"; steps: PlanStep[]; reasoning: string }
  | { type: "step"; result: StepResult }
  | { type: "documentation"; documentation: Documentation }
  | { type: "escalation"; escalation: Escalation }
  | { type: "finished"; run: Run };

export async function runTicket(options: RunOptions): Promise<Run> {
  const {
    ticket,
    brain,
    knowledge,
    session,
    gate = new AutoDenyGate(),
    tenantId = "demo-tenant",
    stepBudget = 12,
    evidenceRoot = "run-artifacts",
    userAnswers,
    askUser,
    onEvent,
    learn = true,
  } = options;

  const run_id = newId("run");
  const trace_id = newId("trace");
  const audit = new AuditLog(run_id, ticket.id);
  const evidence = new EvidenceStore(evidenceRoot, run_id);
  const results: StepResult[] = [];
  const proposed: PlanStep[] = [];
  /** Questions put to the user during the run, and what they said. */
  const userSaid: { question: string; answer: string }[] = [];

  // Probe the machine once, up front. Everything downstream reasons about what
  // this host actually has rather than what its platform usually has.
  const capabilities = session ? await session.capabilities() : undefined;

  audit.record("run.started", "system", `Run started for ticket ${ticket.id}.`, {
    brain: brain.name,
    gate: gate.name,
    step_budget: stepBudget,
    device: ticket.device?.hostname ?? null,
    capabilities: capabilities
      ? {
          platform: capabilities.platform,
          tools: capabilities.availableCommands.length,
          can_capture: capabilities.canCapture,
        }
      : null,
  });

  const emit = (event: RunEvent) => onEvent?.(event);

  // ---- 1. Understand the request ------------------------------------------
  const intake = await brain.intake({ ticket });
  audit.record("intake.completed", "agent", intake.summary, {
    category: intake.category,
    out_of_scope: intake.out_of_scope,
    sentiment: intake.user_sentiment,
    missing_information: intake.missing_information,
  });
  emit({ type: "intake", intake });

  // ---- 2. Recall similar tickets ------------------------------------------
  const priorTickets = retrieve(knowledge.all(), {
    text: `${ticket.subject} ${ticket.description} ${intake.reported_symptoms.join(" ")}`,
    ...(ticket.device ? { platform: ticket.device.platform } : {}),
    category: intake.category,
    limit: 3,
  });
  const knowledge_used = priorTickets.map((h) => h.entry.id);
  if (knowledge_used.length > 0) {
    audit.record(
      "knowledge.retrieved",
      "agent",
      `Recalled ${knowledge_used.length} similar ticket(s).`,
      {
        entries: priorTickets.map((h) => ({
          id: h.entry.id,
          source_ticket: h.entry.source_ticket_id,
          score: Number(h.score.toFixed(3)),
          matched_terms: h.matched_terms,
        })),
      },
    );
  }
  emit({ type: "knowledge", ticketIds: knowledge_used });

  // ---- 3. Diagnose ---------------------------------------------------------
  const diagnosis = await brain.diagnose({
    ticket,
    intake,
    priorTickets,
    ...(capabilities ? { capabilities } : {}),
  });
  audit.record(
    "diagnosis.formed",
    "agent",
    diagnosis.hypotheses[diagnosis.leading_index]?.statement ?? "No hypothesis.",
    { confidence: diagnosis.confidence, hypotheses: diagnosis.hypotheses.length },
  );
  emit({ type: "diagnosis", diagnosis });

  // ---- 4. Propose -> gate -> execute --------------------------------------
  let executed = 0;
  let resolved = false;
  let wantsHuman = false;
  let rootCause = diagnosis.root_cause;

  // An out-of-scope request is not investigated at all. Running diagnostics on
  // a machine to answer an HR question would be an intrusion, not a service.
  if (intake.out_of_scope) {
    wantsHuman = true;
    audit.record(
      "escalation.raised",
      "policy",
      "Request is not an IT technician task; no device work attempted.",
    );
  }

  while (!resolved && !wantsHuman && executed < stepBudget) {
    const proposal = await brain.propose({
      ticket: userSaid.length
        ? {
            ...ticket,
            // The brain sees the answers as part of the conversation, which is
            // where a technician would find them on a real ticket.
            comments: [
              ...ticket.comments,
              ...userSaid.map((said, i) => ({
                id: `answer-${i}`,
                author: ticket.requester.name,
                author_role: "requester" as const,
                body: `${said.question} — ${said.answer}`,
                created_at: nowIso(),
                public: true,
                attachments: [],
              })),
            ],
          }
        : ticket,
      intake,
      diagnosis,
      priorTickets,
      history: results,
      remainingBudget: stepBudget - executed,
      ...(capabilities ? { capabilities } : {}),
      canAskUser: Boolean(askUser),
    });

    if (proposal.root_cause) rootCause = proposal.root_cause;

    if (proposal.steps.length === 0) {
      audit.record("plan.proposed", "agent", "No further steps proposed.", {
        reasoning: proposal.reasoning,
        wants_human: proposal.wants_human ?? false,
      });
      resolved = proposal.resolved;
      wantsHuman = proposal.wants_human ?? !proposal.resolved;
      break;
    }

    proposed.push(...proposal.steps);
    audit.record(
      "plan.proposed",
      "agent",
      `Proposed ${proposal.steps.length} step(s).`,
      { reasoning: proposal.reasoning, steps: proposal.steps.map((s) => s.intent) },
    );
    emit({ type: "proposed", steps: proposal.steps, reasoning: proposal.reasoning });

    // Set once a hard block fires. The rest of the batch is still evaluated and
    // recorded - a technician picking this up wants the full list of what was
    // refused, not just the first thing - but nothing further is executed.
    let halted = false;

    for (const step of proposal.steps) {
      if (executed >= stepBudget) break;

      // --- The gate. Every step, no exceptions. ---
      const verdict = evaluate(step, {
        ...(ticket.device ? { device: ticket.device } : {}),
      });

      if (halted) {
        audit.record(
          "policy.evaluated",
          "policy",
          `${verdict.decision} (not attempted): ${step.intent}`,
          { rule_id: verdict.rule_id, categories: verdict.categories },
        );
        const skipped: StepResult = {
          step,
          verdict,
          outcome: verdict.decision === "block" ? "blocked" : "skipped",
          started_at: nowIso(),
          finished_at: nowIso(),
          observation:
            verdict.decision === "block"
              ? verdict.reason
              : "Not attempted: the run had already stopped at a guardrail.",
          artifacts: [],
        };
        results.push(skipped);
        emit({ type: "step", result: skipped });
        continue;
      }
      audit.record("policy.evaluated", "policy", `${verdict.decision}: ${step.intent}`, {
        rule_id: verdict.rule_id,
        categories: verdict.categories,
        reason: verdict.reason,
      });

      let cleared = verdict;

      if (verdict.decision === "require_approval") {
        audit.record("approval.requested", "agent", `Approval needed: ${step.intent}`, {
          rule_id: verdict.rule_id,
        });
        const outcome = await gate.requestApproval({
          step,
          verdict,
          justification: proposal.reasoning,
        });
        audit.record(
          outcome.approved ? "approval.granted" : "approval.denied",
          "human",
          outcome.reason,
          { approver: outcome.approver, step: step.intent },
        );
        if (outcome.approved) {
          // Approval converts the verdict to `allow` for this step only, and
          // records who did it. It never upgrades a `block`.
          cleared = {
            ...verdict,
            decision: "allow",
            reason: `${verdict.reason} Approved by ${outcome.approver}: ${outcome.reason}`,
          };
        }
      }

      // A question the operator can actually answer is asked here, before the
      // executor sees the step, so the answer arrives as an ordinary result.
      let answers = userAnswers;
      if (step.kind === "ask_user" && askUser) {
        const question = String(step.payload["question"] ?? step.intent);
        if (answers?.[question] === undefined) {
          audit.record("approval.requested", "agent", `Asked the user: ${question}`, {
            step: step.id,
          });
          const answer = await askUser(question, step);
          if (answer !== undefined && answer.trim() !== "") {
            answers = { ...(answers ?? {}), [question]: answer };
            // Kept on the run so the write-up and the ticket carry what the
            // user actually said, not a paraphrase of it.
            userSaid.push({ question, answer });
            audit.record("step.executed", "human", `User answered: ${answer}`, {
              question,
            });
          }
        }
      }

      const result = await executeStep(step, cleared, {
        ...(session ? { session } : {}),
        evidence,
        ...(answers ? { userAnswers: answers } : {}),
      });
      results.push(result);
      executed += 1;

      audit.record("step.executed", "agent", `${result.outcome}: ${step.intent}`, {
        exit_code: result.command?.exit_code ?? null,
        observation: result.observation,
      });
      if (result.artifacts.length > 0) {
        audit.record(
          "evidence.captured",
          "agent",
          `Captured ${result.artifacts.length} artefact(s).`,
          { artifacts: result.artifacts.map((a) => ({ uri: a.uri, sha256: a.sha256 })) },
        );
      }
      emit({ type: "step", result });

      // A hard block ends the investigation. Continuing to poke at the machine
      // after being told to stop is exactly the behaviour the guardrails exist
      // to prevent - so nothing further executes, though the remaining
      // proposals are still evaluated above for the handover.
      if (result.outcome === "blocked" && cleared.escalate) {
        wantsHuman = true;
        halted = true;
        continue;
      }
      // A refused approval ends it too. "No" means no to the change, and the
      // steps that follow are usually the rest of the same change - asking to
      // start a service a technician has just refused to let us stop is not a
      // second question, it is the same question asked again.
      if (result.outcome === "awaiting_approval") {
        wantsHuman = true;
        halted = true;
        continue;
      }
      // Waiting on a person is a pause, not a failure - stop and hand over.
      if (result.outcome === "awaiting_user") {
        wantsHuman = true;
        halted = true;
        continue;
      }
    }
  }

  const budgetExhausted = executed >= stepBudget && !resolved;

  // ---- 5. Decide on escalation --------------------------------------------
  const escalation = assessEscalation({
    ticket,
    intake,
    diagnosis: { ...diagnosis, ...(rootCause ? { root_cause: rootCause } : {}) },
    results,
    budgetExhausted,
    resolved,
  });
  // The brain can ask for a human; it can never refuse to hand over.
  if (wantsHuman && !escalation.triggered) {
    escalation.triggered = true;
    escalation.triggers = ["low-confidence"];
    escalation.ask = "The assistant ran out of things it could safely try.";
    escalation.raised_at = nowIso();
  }
  if (escalation.triggered) {
    audit.record(
      "escalation.raised",
      "policy",
      `Escalated to ${escalation.route_to}: ${escalation.triggers.join(", ")}`,
      { urgency: escalation.urgency, ask: escalation.ask },
    );
  }
  emit({ type: "escalation", escalation });

  // ---- 6. Write it up ------------------------------------------------------
  const documentation = await brain.document({
    ticket,
    intake,
    diagnosis: { ...diagnosis, ...(rootCause ? { root_cause: rootCause } : {}) },
    history: results,
    resolved,
    escalated: escalation.triggered,
    ...(capabilities ? { capabilities } : {}),
  });
  audit.record("run.finished", "agent", documentation.title, {
    resolved,
    escalated: escalation.triggered,
    steps_executed: executed,
  });
  emit({ type: "documentation", documentation });

  const status: Run["status"] = resolved
    ? "resolved"
    : escalation.triggered
      ? "escalated"
      : results.some((r) => r.outcome === "awaiting_approval")
        ? "awaiting_approval"
        : results.some((r) => r.outcome === "awaiting_user")
          ? "awaiting_user"
          : "failed";

  const run: Run = {
    contract_type: "technician.run",
    schema_version: SCHEMA_VERSION,
    tenant_id: tenantId,
    trace_id,
    created_at: nowIso(),
    run_id,
    ticket,
    status,
    intake,
    diagnosis: { ...diagnosis, ...(rootCause ? { root_cause: rootCause } : {}) },
    proposed,
    results,
    documentation,
    escalation,
    audit: audit.entries(),
    knowledge_used,
    started_at: audit.entries()[0]?.at ?? nowIso(),
    finished_at: nowIso(),
  };

  // ---- 7. Learn ------------------------------------------------------------
  if (learn) {
    const learned = learnFromRun(knowledge, run);
    if (learned.entry) {
      // Recorded on the run's own audit copy so the entry is traceable to the
      // run that produced it.
      run.audit.push({
        seq: run.audit.length,
        event: "knowledge.learned",
        at: nowIso(),
        run_id,
        ticket_id: ticket.id,
        actor: "system",
        summary: `Recorded "${learned.entry.title}" in the knowledge base.`,
        detail: { entry_id: learned.entry.id, outcome: learned.entry.outcome },
      });
    }
  }

  emit({ type: "finished", run });
  return run;
}
