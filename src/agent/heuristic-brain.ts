/**
 * The offline brain.
 *
 * Deterministic, no network, no API key. It exists so that `npm run demo` and
 * `npm test` work on a laptop with no credentials, and so the guardrail tests
 * exercise the real loop rather than a mocked one.
 *
 * It is a genuine (if narrow) technician: it matches the ticket to a playbook,
 * runs the playbook's read-only checks, reads the actual output for the fault
 * signal, applies the fix only when the signal is present, and verifies. What
 * it cannot do is reason about a ticket no playbook covers - and it says so
 * rather than improvising, which is the honest behaviour for a rule engine.
 */
import {
  newId,
  type Confidence,
  type Diagnosis,
  type Documentation,
  type Intake,
  type PlanStep,
  type StepResult,
} from "../contracts/index.js";
import type {
  Brain,
  DiagnoseInput,
  DocumentInput,
  IntakeInput,
  ProposeInput,
  ProposeOutput,
} from "./brain.js";
import {
  findPlaybook,
  findRequestedActions,
  type Playbook,
  type PlaybookStep,
} from "./playbooks.js";
import {
  checksForCategory,
  type HostPlatform,
  type LocalCheck,
  type TicketCategory,
} from "./local-playbooks.js";

/** Words in a ticket that mean the user cannot work right now. */
const BLOCKED = /\b(cannot work|can'?t work|completely|nothing works|blocked|stuck|down|outage|deadline|urgent|asap|client\s+(meeting|call))\b/i;
const FRUSTRATED = /\b(again|third time|still not|frustrat|ridiculous|unacceptable|every day|keeps happening)\b/i;

/** Requests that are not an IT technician's job, however they are phrased. */
const OUT_OF_SCOPE =
  /\b(holiday|annual leave|payslip|salary|expense|hr\b|recruit|onboarding paperwork|purchase order|invoice|contract review)\b/i;

export class HeuristicBrain implements Brain {
  readonly name = "heuristic";

  async intake(input: IntakeInput): Promise<Intake> {
    const { ticket } = input;
    const text = `${ticket.subject}\n${ticket.description}`;
    const playbook = findPlaybook(text);

    const symptoms = ticket.description
      .split(/[.\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 12)
      .slice(0, 4);

    const missing: string[] = [];
    if (!ticket.device) missing.push("Which device is affected.");
    else if (!ticket.device.consent_granted) {
      missing.push("The user's consent for a remote support session.");
    }
    if (!/\b(since|started|yesterday|today|this morning|after)\b/i.test(text)) {
      missing.push("When the problem started.");
    }

    return {
      summary: ticket.subject,
      category: playbook?.category ?? inferCategory(text),
      reported_symptoms: symptoms.length ? symptoms : [ticket.subject],
      missing_information: missing,
      out_of_scope: OUT_OF_SCOPE.test(text),
      user_sentiment: BLOCKED.test(text)
        ? "blocked"
        : FRUSTRATED.test(text)
          ? "frustrated"
          : ticket.priority === "urgent"
            ? "urgent"
            : "calm",
    };
  }

  async diagnose(input: DiagnoseInput): Promise<Diagnosis> {
    const { ticket, priorTickets } = input;
    const playbook = findPlaybook(`${ticket.subject}\n${ticket.description}`);

    // A close prior ticket is stronger evidence than a playbook pattern match,
    // so it leads and carries the prior's id.
    // An entry whose root cause was never established has nothing to offer as a
    // hypothesis - "the cause is unknown" is not a lead, it is noise.
    const usablePriors = priorTickets.filter(
      (hit) => !/^not established/i.test(hit.entry.root_cause),
    );

    const priorHypotheses = usablePriors.slice(0, 2).map((hit) => ({
      statement: `Same cause as ticket ${hit.entry.source_ticket_id}: ${hit.entry.root_cause}`,
      confidence: (hit.score > 3 ? "medium" : "low") as Confidence,
      supporting_evidence: [
        `Matched prior ticket on: ${hit.matched_terms.join(", ")}`,
      ],
      contradicting_evidence: [],
      prior_ticket_refs: [hit.entry.id],
    }));

    const playbookHypotheses = (playbook?.hypotheses ?? []).map((h) => ({
      statement: h.statement,
      confidence: h.confidence as Confidence,
      supporting_evidence: [],
      contradicting_evidence: [],
      prior_ticket_refs: [],
    }));

    const hypotheses = [...priorHypotheses, ...playbookHypotheses];
    if (hypotheses.length === 0) {
      hypotheses.push({
        statement:
          "No recognised pattern. The cause is not yet established and needs a technician's judgement.",
        confidence: "low" as Confidence,
        supporting_evidence: [],
        contradicting_evidence: [],
        prior_ticket_refs: [],
      });
    }

    return {
      hypotheses,
      leading_index: 0,
      confidence: usablePriors.length > 0 ? "medium" : playbook ? "medium" : "low",
    };
  }

  async propose(input: ProposeInput): Promise<ProposeOutput> {
    const { ticket, history, remainingBudget } = input;
    const text = `${ticket.subject}\n${ticket.description}`;
    const playbook = findPlaybook(text);
    const platform = ticket.device?.platform ?? "unknown";
    const attempted = new Set(history.map((h) => h.step.intent));

    // Whatever the user asked for in plain words is proposed first. Most of
    // these are things the control plane will refuse - which is the point: the
    // refusal, its reason and its audit entry are the product behaviour worth
    // showing, and they only happen if something tries.
    const requested = findRequestedActions(text).filter(
      (a) => !attempted.has(a.intent),
    );
    if (requested.length > 0) {
      return {
        steps: requested.slice(0, 3).map((a) => ({
          id: newId("step"),
          kind: "command" as const,
          intent: a.intent,
          payload: {
            command:
              (platform !== "unknown" ? a.platformCommands?.[platform] : undefined) ??
              a.command,
            requested_action: a.id,
          },
          mutating: true,
          ...(a.rollback ? { rollback: a.rollback } : {}),
        })),
        resolved: false,
        reasoning:
          "The ticket asks for these directly, so they are proposed for the control plane to rule on.",
      };
    }

    // Ask for the one fact that would most change the diagnosis, before
    // touching anything - but only when someone is there to answer. In an
    // unattended run the question would stall the ticket rather than improve
    // it, so the brain works with what it was given.
    // Only when the answer would actually change what happens next. A ticket
    // that already matches a playbook has a clear next step, and asking "when
    // did this start?" before running it is noise a real technician would skip.
    // A ticket nothing recognises is the opposite: there, one question is worth
    // more than any amount of guessing.
    const alreadyAsked = history.some((h) => h.step.kind === "ask_user");
    const missing = input.intake.missing_information[0];
    const wouldChangeTheApproach = !playbook && !isLocalTicket(ticket);
    if (input.canAskUser && !alreadyAsked && missing && wouldChangeTheApproach) {
      return {
        steps: [
          {
            id: newId("step"),
            kind: "ask_user",
            intent: `Ask the user for the one detail that would most change the diagnosis`,
            payload: { question: questionFor(missing) },
            mutating: false,
          },
        ],
        resolved: false,
        reasoning: `The ticket does not say: ${missing}`,
      };
    }

    // A ticket against the real host takes the local path: real checks, real
    // thresholds, and no fix applied unless a check genuinely showed a fault.
    if (isLocalTicket(ticket) && platform !== "unknown" && input.capabilities) {
      return this.#proposeLocal(input, platform, attempted);
    }

    if (!playbook || platform === "unknown") {
      return {
        steps: [],
        resolved: false,
        wants_human: true,
        reasoning: playbook
          ? "The device platform is unknown, so no safe platform-specific command can be chosen."
          : "No playbook matches this ticket; a technician needs to look at it.",
      };
    }

    // Capture the screen once, before touching anything, when the fault is
    // something the user can see. An annotated frame on the ticket is worth
    // more to the next technician than another paragraph of prose.
    //
    // Only where the device can actually produce one: a headless host would
    // turn this into a failed step, and a failed step reads like a fault.
    const tookShot = history.some((h) => h.step.kind === "screenshot");
    const canCapture = input.capabilities?.canCapture ?? true;
    if (!tookShot && canCapture && VISUAL_CATEGORIES.has(playbook.category)) {
      return {
        steps: [screenshotStep(playbook)],
        resolved: false,
        reasoning: "Capturing what the user is seeing before running diagnostics.",
      };
    }

    const diagnostics = playbook.diagnostics[platform];
    const fixes = playbook.fixes[platform];
    const ran = new Set(
      history
        .filter((h) => h.step.kind === "command")
        .map((h) => String(h.step.payload["command"])),
    );

    // Phase 1 - work through the read-only checks, one at a time, so each is
    // decided on the previous one's actual output.
    const nextDiagnostic = diagnostics.find((d) => !ran.has(d.command));
    if (nextDiagnostic) {
      return {
        steps: [toStep(nextDiagnostic, playbook)],
        resolved: false,
        reasoning: `Running the next read-only check for ${playbook.id}.`,
      };
    }

    // Phase 2 - only apply a fix if a diagnostic actually showed the fault.
    const faultFound = diagnostics.some((d) => {
      if (!d.faultSignal) return false;
      const result = history.find(
        (h) => String(h.step.payload["command"]) === d.command,
      );
      const output = `${result?.command?.stdout ?? ""}${result?.command?.stderr ?? ""}`;
      return output.toLowerCase().includes(d.faultSignal.toLowerCase());
    });

    if (!faultFound) {
      return {
        steps: [],
        resolved: false,
        wants_human: true,
        reasoning:
          "The read-only checks completed without showing the fault this playbook fixes, so applying its fix would be guesswork.",
      };
    }

    const nextFix = fixes.find((f) => !ran.has(f.command));
    if (nextFix) {
      return {
        steps: [toStep(nextFix, playbook)],
        resolved: false,
        root_cause: playbook.rootCause,
        reasoning: `The diagnostic showed the expected fault, so applying the ${playbook.id} fix.`,
      };
    }

    // Phase 3 - verify. A fix is not a resolution until something confirms it.
    const verifier = diagnostics.find((d) => d.faultSignal);
    const alreadyVerified = history.filter(
      (h) => String(h.step.payload["command"]) === verifier?.command,
    ).length;

    if (verifier && alreadyVerified < 2 && remainingBudget > 0) {
      return {
        steps: [
          {
            id: newId("step"),
            kind: "command",
            intent: `Re-run the check to confirm the fix held: ${verifier.intent.toLowerCase()}`,
            payload: { command: verifier.command },
            mutating: false,
          },
        ],
        resolved: false,
        root_cause: playbook.rootCause,
        reasoning: "Fix applied; verifying before calling this resolved.",
      };
    }

    // Did the verification actually pass?
    const verifyRuns = history.filter(
      (h) => String(h.step.payload["command"]) === verifier?.command,
    );
    const last = verifyRuns[verifyRuns.length - 1];
    const stillFaulty =
      verifier?.faultSignal !== undefined &&
      `${last?.command?.stdout ?? ""}${last?.command?.stderr ?? ""}`
        .toLowerCase()
        .includes(verifier.faultSignal.toLowerCase());

    if (stillFaulty) {
      return {
        steps: [],
        resolved: false,
        wants_human: true,
        root_cause: playbook.rootCause,
        reasoning: "The fix was applied but the fault signal is still present.",
      };
    }

    return {
      steps: [],
      resolved: true,
      root_cause: playbook.rootCause,
      reasoning: "Fix applied and confirmed by re-running the failing check.",
    };
  }

  /**
   * Work a real machine.
   *
   * Run every applicable read-only check once, then decide from what came back.
   * There is deliberately no fix branch here: the checks that exist are
   * diagnostic, and the faults they find (a full disk, a memory-hungry process)
   * are resolved by deleting someone's files or killing their work - decisions
   * a person makes, not an automated technician.
   */
  #proposeLocal(
    input: ProposeInput,
    platform: HostPlatform,
    attempted: Set<string>,
  ): ProposeOutput {
    // Targeted by what was actually reported. Handed "my wifi keeps dropping",
    // a technician does not begin by listing printers.
    const checks = checksForCategory(
      platform,
      input.capabilities!.availableCommands,
      input.intake.category as TicketCategory,
    );

    if (checks.length === 0) {
      return {
        steps: [],
        resolved: false,
        wants_human: true,
        reasoning: `This host has none of the diagnostic tools the local checks need (probed ${input.capabilities!.availableCommands.length} commands).`,
      };
    }

    const next = checks.filter((c) => !attempted.has(c.intent)).slice(0, 3);
    if (next.length > 0) {
      return {
        steps: next.map((check) => ({
          id: newId("step"),
          kind: "command" as const,
          intent: check.intent,
          payload: { command: check.command[platform]!, local_check: check.id },
          mutating: false,
        })),
        resolved: false,
        reasoning: `Running ${next.length} read-only check(s) against this machine.`,
      };
    }

    // Every check has run. Read the real output and say what is actually true.
    const findings = readFindings(checks, platform, input.history);

    if (findings.length === 0) {
      return {
        steps: [],
        resolved: true,
        root_cause:
          "No fault found. Every check ran clean against this machine's real state.",
        reasoning:
          "All checks completed within threshold. Nothing is wrong, so nothing was changed.",
      };
    }

    return {
      steps: [],
      resolved: false,
      wants_human: true,
      root_cause: findings.join(" "),
      reasoning:
        "The checks found real problems, but resolving them means deleting a user's data or ending their work, which needs a person.",
    };
  }

  async document(input: DocumentInput): Promise<Documentation> {
    const { ticket, intake, history, resolved, escalated } = input;
    const playbook = findPlaybook(`${ticket.subject}\n${ticket.description}`);

    const succeeded = history.filter((h) => h.outcome === "success");
    const refused = history.filter(
      (h) => h.outcome === "blocked" || h.outcome === "awaiting_approval",
    );

    // The root cause the loop established, not the one a matched playbook would
    // have predicted. A "sluggish machine" ticket matches the performance
    // playbook, but if the checks came back clean the write-up must say so
    // rather than borrowing that playbook's canned cause.
    const rootCause =
      input.diagnosis.root_cause ??
      (resolved
        ? (playbook?.rootCause ?? "Established during triage.")
        : "Not established during automated triage.");

    const writeup = [
      `Symptom: ${intake.summary}`,
      "",
      "Observed:",
      ...succeeded.map(
        (s) =>
          `- ${s.step.intent}${s.command ? ` (\`${s.command.command}\`, exit ${s.command.exit_code})` : ""}: ${s.observation}`,
      ),
      "",
      `Root cause: ${rootCause}`,
      "",
      resolved
        ? "Resolution: the fix was applied and confirmed by re-running the check that had been failing."
        : "Resolution: not completed automatically.",
    ];

    if (refused.length > 0) {
      writeup.push(
        "",
        "Not carried out:",
        ...refused.map((r) => `- ${r.step.intent}: ${r.verdict.reason}`),
      );
    }

    return {
      title: `${ticket.subject} — ${resolved ? "resolved" : escalated ? "escalated" : "in progress"}`,
      technical_writeup: writeup.join("\n"),
      user_reply: userReply({
        name: firstName(ticket.requester.name),
        resolved,
        escalated,
        ranChecks: succeeded.length > 0,
        changedAnything: succeeded.some((s) => s.step.mutating),
        checkedList: plainCheckNames(succeeded),
        refusedCategories: [
          ...new Set(
            refused.flatMap((r) => r.verdict.categories.filter((c) => c !== "routine")),
          ),
        ],
        cause: plainCause(playbook, rootCause),
      }),
      root_cause: rootCause,
      resolution: !resolved
        ? "No resolution applied automatically."
        : succeeded.some((s) => s.step.mutating)
          ? (playbook?.fixes[ticket.device?.platform ?? "unknown"]?.[0]?.intent ??
            "Fix applied.")
          : "No change was needed; the checks came back clean.",
      prevention: resolved ? (playbook?.prevention ?? []) : [],
      // Rough, and labelled as an estimate everywhere it is shown: the value of
      // the number is comparative across tickets, not absolute.
      time_saved_estimate_minutes: resolved ? 18 : escalated ? 6 : 0,
    };
  }
}

/**
 * The reply the user reads.
 *
 * Written from what actually happened, because the alternative is a message
 * that thanks someone for their patience while describing checks that never
 * ran. A reply that says "I did not touch your machine" when nothing was
 * touched is the difference between a support tool and a plausible one.
 */
function userReply(ctx: {
  name: string;
  resolved: boolean;
  escalated: boolean;
  ranChecks: boolean;
  changedAnything: boolean;
  refusedCategories: string[];
  cause: string;
  /** Plain-English names of the things actually checked. */
  checkedList: string[];
}): string {
  const {
    name,
    resolved,
    escalated,
    ranChecks,
    changedAnything,
    refusedCategories,
    cause,
    checkedList,
  } = ctx;

  // A clean bill of health is a different message from a fix. Saying "I've
  // applied the fix" when nothing was changed is the kind of small lie that
  // makes people stop trusting the whole system.
  if (resolved && !changedAnything) {
    // Name what was actually checked. Now that checks are chosen for the
    // complaint, a fixed list would claim to have looked at memory and
    // processes on a ticket where it looked at the network.
    const looked = checkedList.length
      ? `I looked at ${joinWords(checkedList)}, and everything came back within normal range.`
      : "The checks I ran all came back within normal range.";
    return `Hi ${name}, I've run some checks on your machine. ${looked} I haven't changed anything. If you're still seeing a problem, tell me what you were doing when it happened and I'll dig into that specifically.`;
  }

  if (resolved) {
    return `Hi ${name}, I've had a look at this. ${cause} I've applied the fix and confirmed it's working again from your machine. Please try what you were doing and let me know if anything is still not right.`;
  }

  // Something was refused on policy grounds. Say so, and say why, without
  // making it sound like the user did something wrong.
  if (refusedCategories.length > 0) {
    return `Hi ${name}, thanks for getting in touch. What you've asked for needs to go through one of our colleagues rather than being done automatically — ${explainCategories(refusedCategories)}. I haven't made any changes, and I've passed the request to the right team with everything they need, so you shouldn't have to explain it again.`;
  }

  if (escalated && ranChecks) {
    return `Hi ${name}, thanks for the details. I've run some initial checks on your machine and gathered what I found, but this one needs a colleague to take it further. I've passed everything over so they won't need to ask you to repeat yourself.`;
  }

  if (escalated) {
    return `Hi ${name}, thanks for the details. I wasn't able to get far enough on this one automatically, so I've passed it to a colleague along with everything you've told us. I haven't made any changes to your machine.`;
  }

  return `Hi ${name}, I've started looking into this and gathered some initial information. I'll come back to you shortly.`;
}

/**
 * What the run actually looked at, in words a user would recognise.
 *
 * Derived from the checks that ran rather than from a fixed list, so the reply
 * cannot claim to have examined something it never touched.
 */
function plainCheckNames(succeeded: StepResult[]): string[] {
  const names: Record<string, string> = {
    "check.disk": "disk space",
    "check.memory": "memory",
    "check.top-processes": "what is running",
    "check.dns": "name resolution",
    "check.network": "your network connection",
    "check.reachability": "whether the machine can reach the internet",
    "check.printers": "your printers",
    "check.power": "battery and power",
    "check.uptime": "how hard the machine is working",
    "check.identity": "the machine itself",
  };
  const seen = new Set<string>();
  for (const step of succeeded) {
    const id = String(step.step.payload["local_check"] ?? "");
    const name = names[id];
    // "the machine itself" is bookkeeping, not something a user cares was checked.
    if (name && id !== "check.identity") seen.add(name);
  }
  return [...seen];
}

/** "a, b and c" - because "a, b, c" reads like a machine wrote it. */
function joinWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Plain-English reason a category is off limits, for the user-facing reply. */
function explainCategories(categories: string[]): string {
  const reasons: Record<string, string> = {
    credentials:
      "anything involving passwords or account access has to be done by a person who can verify your identity first",
    identity:
      "creating or changing accounts and permissions is handled by a technician with the right authority",
    finance: "anything touching payments, cards or expenses sits outside IT support",
    "security-controls":
      "changes to security settings are only made by a technician",
    destructive: "this would remove data permanently, so a person needs to confirm it",
    "major-system-change":
      "changes this large go through our change process rather than being applied automatically",
    "network-infrastructure":
      "this affects shared network equipment that many people rely on",
    compliance: "this involves information we have to handle through a formal process",
    "data-exfiltration": "moving data off a device in bulk needs sign-off",
  };
  const listed = categories
    .map((c) => reasons[c])
    .filter((r): r is string => Boolean(r));
  if (listed.length === 0) return "it needs a person to authorise it";
  if (listed.length === 1) return listed[0]!;
  return `${listed.slice(0, -1).join("; ")}; and ${listed[listed.length - 1]}`;
}

/**
 * Category fallback when no playbook matches.
 *
 * A ticket with no playbook is still a ticket about something, and the category
 * drives knowledge-base retrieval and routing. "other" should be the answer
 * when nothing fits, not the answer whenever no playbook does.
 */
const CATEGORY_HINTS: [RegExp, Intake["category"]][] = [
  [/\b(password|locked out|mfa|2fa|sign ?in|log ?in|sso|authenticat)\b/i, "authentication"],
  [/\b(new starter|leaver|account|permission|access to|group|licence|license|seat)\b/i, "access-request"],
  [/\b(phish|malware|virus|ransom|breach|suspicious|encrypt)\b/i, "security"],
  [/\b(outlook|mailbox|inbox|email|calendar|teams meeting)\b/i, "email"],
  [/\b(screen|keyboard|battery|charger|dock|monitor|headset|webcam|broken)\b/i, "hardware"],
  [/\b(install|licence key|crash|error code|application|app\b|excel|word|update)\b/i, "software"],
];

function inferCategory(text: string): Intake["category"] {
  for (const [pattern, category] of CATEGORY_HINTS) {
    if (pattern.test(text)) return category;
  }
  return "other";
}

/**
 * Turn a missing-information note into something a person can answer.
 *
 * Intake records gaps as statements ("When the problem started"); a user needs
 * a question. Anything unrecognised is asked as-is rather than mangled.
 */
function questionFor(missing: string): string {
  const known: [RegExp, string][] = [
    [/when .* started/i, "When did this start, and had anything changed on the machine just before it?"],
    [/which device/i, "Which machine is this happening on?"],
    [/consent/i, "Are you happy for me to connect to your machine and run some checks?"],
  ];
  for (const [pattern, question] of known) {
    if (pattern.test(missing)) return question;
  }
  return missing.endsWith("?") ? missing : `Could you tell me: ${missing.replace(/\.$/, "")}?`;
}

/** Tickets raised against the machine this process is running on. */
export const LOCAL_TICKET_TAG = "local-machine";

function isLocalTicket(ticket: { tags: string[] }): boolean {
  return ticket.tags.includes(LOCAL_TICKET_TAG);
}

/**
 * Read the real command output back through each check's interpreter.
 *
 * This is where the local path earns its keep: the verdict comes from the
 * machine's actual numbers, so a healthy machine produces an empty list and the
 * run resolves as "nothing wrong" instead of inventing something to fix.
 */
function readFindings(
  checks: LocalCheck[],
  platform: HostPlatform,
  history: StepResult[],
): string[] {
  const findings: string[] = [];
  for (const check of checks) {
    const command = check.command[platform];
    const result = history.find(
      (h) => String(h.step.payload["command"]) === command && h.command,
    );
    if (!result?.command) continue;
    const finding = check.interpret(result.command);
    if (finding) findings.push(finding);
  }
  return findings;
}

/** Playbooks whose fault shows up on screen and is worth photographing. */
const VISUAL_CATEGORIES = new Set(["printing", "connectivity", "storage"]);

/**
 * A screenshot step with the annotation the technician would draw.
 *
 * The boxes are in the coordinate space of the simulated screens in
 * `src/demo/screen.ts`. On a real endpoint these would come from the model
 * looking at the captured frame.
 */
function screenshotStep(playbook: Playbook): PlanStep {
  const annotations =
    playbook.category === "printing"
      ? [
          {
            style: "problem" as const,
            box: { x: 52, y: 122, width: 520, height: 30 },
            label: "Queue is paused - the spooler service is not running",
          },
          {
            style: "info" as const,
            box: { x: 620, y: 200, width: 210, height: 180 },
            label: "Every job is sitting in Error state",
          },
        ]
      : [
          {
            style: "problem" as const,
            box: { x: 240, y: 228, width: 430, height: 96 },
            label: "Name lookup is failing, not the connection itself",
          },
          {
            style: "action" as const,
            box: { x: 56, y: 88, width: 792, height: 42 },
            label: "Address is correct, so the request never left the machine",
            arrowFrom: { x: 700, y: 200 },
          },
        ];

  return {
    id: newId("step"),
    kind: "screenshot",
    intent: "Capture what the user is seeing, and mark up the part that matters",
    payload: {
      caption:
        playbook.category === "printing"
          ? "Print queue at the point the user reported the fault"
          : "Browser error at the point the user reported the fault",
      annotations,
    },
    mutating: false,
  };
}

function toStep(step: PlaybookStep, playbook: Playbook): PlanStep {
  return {
    id: newId("step"),
    kind: "command",
    intent: step.intent,
    payload: { command: step.command, playbook: playbook.id },
    mutating: step.mutating,
    ...(step.rollback ? { rollback: step.rollback } : {}),
    ...(step.rollbackCommand ? { rollback_command: step.rollbackCommand } : {}),
  };
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

/** Turn the technical root cause into something worth reading in an email. */
function plainCause(playbook: Playbook | undefined, fallback: string): string {
  switch (playbook?.id) {
    case "pb.dns-resolution":
      return "Your machine was holding on to an out-of-date address for the site, which is why it wouldn't load even though your connection was fine.";
    case "pb.print-spooler":
      return "The printing service on your machine had stopped, so your jobs were queueing up instead of being sent to the printer.";
    default:
      return fallback;
  }
}
