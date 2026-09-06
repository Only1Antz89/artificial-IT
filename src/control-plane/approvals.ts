/**
 * The human approval gate.
 *
 * The gate is an interface rather than a concrete queue so the same agent loop
 * can run three ways without changing:
 *
 *   - `AutoDenyGate`    - unattended runs. Anything needing a human escalates.
 *   - `PolicyBoundGate` - the demo default. Approves low-impact reversible work
 *                         within a standing policy, escalates the rest.
 *   - `InteractiveGate` - a real technician answering at a console.
 *
 * A gate can never turn a `block` into an approval. `requestApproval` is only
 * ever called for `require_approval` verdicts; see `src/agent/loop.ts`.
 */
import type { PlanStep, PolicyVerdict } from "../contracts/index.js";

export interface ApprovalRequest {
  step: PlanStep;
  verdict: PolicyVerdict;
  /** Why the agent believes the step is worth doing. */
  justification: string;
}

export interface ApprovalOutcome {
  approved: boolean;
  approver: string;
  reason: string;
}

export interface ApprovalGate {
  readonly name: string;
  requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome>;
}

/** Unattended posture: no human is watching, so nothing gated gets through. */
export class AutoDenyGate implements ApprovalGate {
  readonly name = "auto-deny";

  async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    return {
      approved: false,
      approver: "policy",
      reason: `No technician is attached to this run, so "${request.step.intent}" was not carried out.`,
    };
  }
}

/**
 * Standing-policy gate.
 *
 * A service desk usually pre-authorises a narrow band of reversible fixes -
 * flushing DNS, restarting the print spooler, clearing a cache. This gate
 * encodes that standing authorisation and refuses everything else, which is
 * what makes the demo do useful work without inventing consent it doesn't have.
 */
export class PolicyBoundGate implements ApprovalGate {
  readonly name = "standing-policy";

  constructor(
    private readonly preAuthorisedRules: Set<string> = new Set([
      "approve.registry-and-config-write",
      "approve.service-restart",
    ]),
    /** Rollback text is mandatory: no undo plan, no standing approval. */
    private readonly requireRollback = true,
  ) {}

  async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const { step, verdict } = request;

    if (!this.preAuthorisedRules.has(verdict.rule_id)) {
      return {
        approved: false,
        approver: "standing-policy",
        reason: `"${step.intent}" falls outside the standing authorisation for unattended fixes (${verdict.rule_id}).`,
      };
    }

    if (this.requireRollback && !step.rollback) {
      return {
        approved: false,
        approver: "standing-policy",
        reason: `"${step.intent}" has no stated rollback, so it is not covered by standing authorisation.`,
      };
    }

    return {
      approved: true,
      approver: "standing-policy",
      reason: `Covered by standing authorisation for reversible tier-1 fixes; rollback on file: ${step.rollback}.`,
    };
  }
}

/** Wraps a callback, e.g. a console prompt or a Zendesk side-conversation. */
export class InteractiveGate implements ApprovalGate {
  readonly name = "interactive";

  constructor(
    private readonly ask: (request: ApprovalRequest) => Promise<ApprovalOutcome>,
  ) {}

  async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    return this.ask(request);
  }
}
