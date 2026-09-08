/**
 * Escalation tests.
 *
 * Knowing when to stop is the judgement the product is really selling, so these
 * cover the triggers individually rather than only through a full run.
 */
import { describe, expect, it } from "vitest";
import { assessEscalation } from "../src/control-plane/escalation.js";
import type { Intake, StepResult, Ticket } from "../src/contracts/index.js";

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "t-1",
    source: "zendesk",
    subject: "Something is wrong",
    description: "It stopped working this morning.",
    status: "open",
    priority: "normal",
    tags: [],
    requester: { id: "u1", name: "Sam Doe", vip: false },
    comments: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const intake: Intake = {
  summary: "Something is wrong",
  category: "other",
  reported_symptoms: ["It stopped working"],
  missing_information: [],
  out_of_scope: false,
  user_sentiment: "calm",
};

function result(overrides: Partial<StepResult>): StepResult {
  return {
    step: { id: "s", kind: "command", intent: "do a thing", payload: {}, mutating: false },
    outcome: "success",
    verdict: {
      decision: "allow",
      categories: ["routine"],
      reason: "ok",
      rule_id: "allow.test",
      escalate: false,
    },
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    observation: "",
    artifacts: [],
    ...overrides,
  } as StepResult;
}

describe("escalation triggers", () => {
  it("does not escalate a clean resolution", () => {
    const e = assessEscalation({
      ticket: ticket(),
      intake,
      results: [result({})],
      budgetExhausted: false,
      resolved: true,
    });
    expect(e.triggered).toBe(false);
  });

  it("always honours a user asking for a person", () => {
    const e = assessEscalation({
      ticket: ticket({ description: "Can I speak to a human please, this bot isn't helping." }),
      intake,
      results: [],
      budgetExhausted: false,
      // Even on an otherwise successful run.
      resolved: true,
    });
    expect(e.triggered).toBe(true);
    expect(e.triggers).toContain("user-requested");
    expect(e.ask).toMatch(/asked to speak to a person/i);
  });

  it("escalates on a guardrail block and routes to a team with authority", () => {
    const e = assessEscalation({
      ticket: ticket(),
      intake,
      results: [
        result({
          outcome: "blocked",
          verdict: {
            decision: "block",
            categories: ["credentials"],
            reason: "no",
            rule_id: "block.credentials.password-change",
            escalate: true,
          },
        }),
      ],
      budgetExhausted: false,
      resolved: false,
    });
    expect(e.triggers).toContain("policy-block");
    // A credentials block is an identity decision, not a desk one.
    expect(e.route_to).toBe("identity-and-access");
    expect(e.urgency).toBe("high");
  });

  it("routes each blocked risk category to the team that owns it", () => {
    const cases: [string, string][] = [
      ["security-controls", "security-operations"],
      ["data-exfiltration", "security-operations"],
      ["compliance", "information-governance"],
      ["finance", "finance-systems"],
      ["identity", "identity-and-access"],
      ["network-infrastructure", "network-engineering"],
    ];
    for (const [category, team] of cases) {
      const e = assessEscalation({
        ticket: ticket({}),
        intake,
        results: [
          result({
            outcome: "blocked",
            verdict: {
              decision: "block",
              categories: [category as never],
              reason: "no",
              rule_id: `block.${category}`,
              escalate: true,
            },
          }),
        ],
        budgetExhausted: false,
        resolved: false,
      });
      expect(e.route_to, `${category} should route to ${team}`).toBe(team);
    }
  });

  it("routes a security report to security operations even with nothing blocked", () => {
    const e = assessEscalation({
      ticket: ticket({ description: "I got a phishing email and downloaded the attachment." }),
      intake: { ...intake, category: "security" },
      results: [],
      budgetExhausted: false,
      resolved: false,
      wantsHuman: true,
    });
    expect(e.triggered).toBe(true);
    expect(e.route_to).toBe("security-operations");
  });

  it("treats the agent asking for a human as a real trigger, not a fallback", () => {
    const e = assessEscalation({
      ticket: ticket({}),
      intake,
      results: [],
      budgetExhausted: false,
      resolved: false,
      wantsHuman: true,
    });
    expect(e.triggered).toBe(true);
    expect(e.triggers).toContain("low-confidence");
    expect(e.handover.suggested_next_steps.length).toBeGreaterThan(0);
  });

  it("does not escalate a resolved run just because the agent stopped", () => {
    const e = assessEscalation({
      ticket: ticket({}),
      intake,
      results: [],
      budgetExhausted: false,
      resolved: true,
      wantsHuman: true,
    });
    expect(e.triggered).toBe(false);
  });

  it("routes hardware faults to field services", () => {
    const e = assessEscalation({
      ticket: ticket({ description: "The screen cracked when I dropped it." }),
      intake,
      results: [],
      budgetExhausted: false,
      resolved: false,
    });
    expect(e.triggers).toContain("needs-hands-on");
    expect(e.route_to).toBe("field-services");
  });

  it("escalates after repeated failures rather than trying forever", () => {
    const failures = [1, 2, 3].map(() => result({ outcome: "failed" }));
    const e = assessEscalation({
      ticket: ticket(),
      intake,
      results: failures,
      budgetExhausted: false,
      resolved: false,
    });
    expect(e.triggers).toContain("repeated-failure");
  });

  it("treats a blocked VIP as higher urgency", () => {
    const e = assessEscalation({
      ticket: ticket({ requester: { id: "u2", name: "Dana Osei", vip: true } }),
      intake: { ...intake, user_sentiment: "blocked" },
      results: [],
      budgetExhausted: false,
      resolved: false,
    });
    expect(e.triggers).toContain("user-impact");
    expect(e.urgency).toBe("high");
  });

  it("re-routes an out-of-scope request without investigating it", () => {
    const e = assessEscalation({
      ticket: ticket(),
      intake: { ...intake, out_of_scope: true },
      results: [],
      budgetExhausted: false,
      resolved: false,
    });
    expect(e.triggers).toContain("out-of-scope");
    expect(e.route_to).toBe("service-desk-triage");
  });

  it("builds a handover a human can act on", () => {
    const e = assessEscalation({
      ticket: ticket(),
      intake,
      diagnosis: {
        hypotheses: [
          {
            statement: "The resolver cache is stale",
            confidence: "medium",
            supporting_evidence: [],
            contradicting_evidence: ["Gateway is reachable, so it is not the link"],
            prior_ticket_refs: [],
          },
        ],
        leading_index: 0,
        confidence: "medium",
        root_cause: "Stale DNS cache",
      },
      results: [
        result({ observation: "Adapter has an address" }),
        result({
          outcome: "awaiting_approval",
          verdict: {
            decision: "require_approval",
            categories: ["routine"],
            reason: "needs sign-off",
            rule_id: "approve.service-restart",
            escalate: false,
          },
        }),
      ],
      budgetExhausted: false,
      resolved: false,
    });

    expect(e.handover.what_we_know.join(" ")).toMatch(/stale/i);
    expect(e.handover.what_we_know.join(" ")).toMatch(/ruled out/i);
    expect(e.handover.what_we_tried.join(" ")).toMatch(/\[ok\]/);
    expect(e.handover.what_we_could_not_do.join(" ")).toMatch(/sign-off/);
    expect(e.handover.suggested_next_steps.join(" ")).toMatch(/authorise/i);
  });
});
