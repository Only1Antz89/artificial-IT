/**
 * The policy engine.
 *
 * Every proposed step passes through `evaluate()` before it can run. There is
 * no other path to the executor - `src/agent/loop.ts` calls this, and the
 * executor refuses a step that does not carry a verdict.
 *
 * Evaluation order is deliberate:
 *
 *   1. Blocking rules, over the whole action surface (intent + payload).
 *      Checked first so that a dangerous intent is caught even when the
 *      command itself looks innocuous.
 *   2. Consent and device posture.
 *   3. Approval rules, which catch mutating-but-legitimate work.
 *   4. The read-only allowlist, which is the only route to an automatic allow
 *      for a command.
 *   5. Deny-by-default: anything unrecognised is held for a human.
 */
import type {
  PlanStep,
  PolicyVerdict,
  RiskCategory,
} from "../../contracts/index.js";
import type { DeviceInfo } from "../../contracts/ticket.js";
import {
  APPROVAL_RULES,
  BLOCKING_RULES,
  READ_ONLY_COMMANDS,
  type GuardrailRule,
} from "./rules.js";

export interface PolicyContext {
  device?: DeviceInfo;
  /** Set when the user explicitly asked for a human - short-circuits to escalate. */
  user_requested_human?: boolean;
}

/**
 * Flatten a step into the single string the rules match against.
 *
 * Both the stated intent and the payload are included. A model that writes
 * `intent: "reset the user's password"` with a harmless-looking command still
 * trips the credentials rule, and a model that writes a bland intent over a
 * destructive command trips it from the payload side.
 */
export function actionSurface(step: PlanStep): string {
  const payload = Object.entries(step.payload ?? {})
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return `${step.intent} ${payload}`;
}

/**
 * Normalise the surface before matching.
 *
 * This collapses the cheapest evasions (padded whitespace, quote-splitting like
 * `pass"w"ord`, case). It is defence in depth and not a shell parser - the real
 * guarantee is that unrecognised commands are held for approval rather than
 * allowed, so an evasion that beats these patterns still does not auto-run.
 */
export function normalise(surface: string): string {
  return surface
    .toLowerCase()
    .replace(/[`'"^]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull the base command out of a command string, e.g. `sudo ip -4 addr` -> `ip`. */
export function baseCommand(command: string): string {
  const tokens = command
    .trim()
    .split(/[\s|;&]+/)
    .filter(Boolean);
  let index = 0;
  // Skip elevation prefixes and env assignments so `sudo -n ls` reads as `ls`.
  while (index < tokens.length) {
    const token = tokens[index]!.toLowerCase();
    if (token === "sudo" || token === "doas" || token === "runas" || token === "env") {
      index += 1;
      continue;
    }
    if (/^-/.test(token) || /^[a-z_][a-z0-9_]*=/i.test(token)) {
      index += 1;
      continue;
    }
    break;
  }
  const raw = tokens[index] ?? "";
  // Strip a path prefix and a Windows extension: `/usr/bin/ping` -> `ping`.
  const leaf = raw.split(/[\\/]/).pop() ?? raw;
  return leaf.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

function matchRules(
  surface: string,
  rules: GuardrailRule[],
): GuardrailRule[] {
  return rules.filter((rule) => rule.patterns.some((p) => p.test(surface)));
}

function verdict(
  rule: GuardrailRule,
  extra?: Partial<PolicyVerdict>,
): PolicyVerdict {
  return {
    decision: rule.decision,
    categories: [rule.category],
    reason: rule.reason,
    rule_id: rule.id,
    escalate: rule.escalate ?? false,
    ...extra,
  };
}

/**
 * Evaluate one proposed step.
 *
 * Always returns a verdict - it never throws, because a thrown error in the
 * guardrail path would be indistinguishable from "no rule matched".
 */
export function evaluate(step: PlanStep, ctx: PolicyContext = {}): PolicyVerdict {
  const surface = normalise(actionSurface(step));

  // 1. Hard stops first, and over the whole surface.
  const blocked = matchRules(surface, BLOCKING_RULES);
  if (blocked.length > 0) {
    const headline = blocked[0]!;
    const categories = [...new Set(blocked.map((r) => r.category))] as RiskCategory[];
    return {
      ...verdict(headline),
      categories,
      escalate: true,
    };
  }

  // Steps that never touch the device are safe by construction.
  if (step.kind === "ask_user" || step.kind === "knowledge_lookup") {
    return {
      decision: "allow",
      categories: ["routine"],
      reason: "Non-invasive step; nothing on the device is read or changed.",
      rule_id: "allow.non-invasive",
      escalate: false,
    };
  }

  if (step.kind === "ticket_comment") {
    return {
      decision: "allow",
      categories: ["routine"],
      reason: "Writing to the ticket does not touch the user's device.",
      rule_id: "allow.ticket-write",
      escalate: false,
    };
  }

  // 2. Device posture. No consent means no device access at all.
  const needsDevice =
    step.kind === "command" ||
    step.kind === "screenshot" ||
    step.kind === "ui_action" ||
    step.kind === "read_file";

  if (needsDevice) {
    if (!ctx.device) {
      return {
        decision: "block",
        categories: ["routine"],
        reason:
          "No device is attached to this ticket, so there is nothing to run against.",
        rule_id: "block.no-device",
        escalate: false,
      };
    }
    if (!ctx.device.consent_granted) {
      return {
        decision: "require_approval",
        categories: ["routine"],
        reason:
          "The user has not yet granted a remote-support session on this device.",
        rule_id: "approve.consent-required",
        escalate: false,
      };
    }
    if (!ctx.device.managed && step.mutating) {
      return {
        decision: "require_approval",
        categories: ["routine"],
        reason:
          "This is an unmanaged (BYOD) device, so any change to it needs a technician present.",
        rule_id: "approve.unmanaged-device",
        escalate: false,
      };
    }
  }

  // Screenshots and UI actions: looking is fine, driving the UI is not
  // something we do unattended.
  if (step.kind === "screenshot") {
    return {
      decision: "allow",
      categories: ["routine"],
      reason: "Capturing the screen is read-only and is recorded as evidence.",
      rule_id: "allow.screenshot",
      escalate: false,
    };
  }
  if (step.kind === "ui_action") {
    return {
      decision: "require_approval",
      categories: ["routine"],
      reason:
        "Driving the user's desktop directly is always confirmed with a technician first.",
      rule_id: "approve.ui-action",
      escalate: false,
    };
  }
  if (step.kind === "read_file") {
    return {
      decision: "allow",
      categories: ["routine"],
      reason: "Reading a diagnostic file is read-only.",
      rule_id: "allow.read-file",
      escalate: false,
    };
  }

  // 3-5. Commands: approval rules, then the read-only allowlist, then deny.
  const command = String(step.payload?.["command"] ?? "").trim();
  if (command === "") {
    return {
      decision: "block",
      categories: ["routine"],
      reason: "The step claims to run a command but carries no command to run.",
      rule_id: "block.malformed-step",
      escalate: false,
    };
  }

  // A pipeline is only as safe as its most dangerous segment, so every segment
  // is checked independently rather than trusting the leading command.
  //
  // Newlines and carriage returns are command *terminators* in shell grammar -
  // handled before word splitting - so `df -h /\nacme-repair` is two commands,
  // not one command with an argument. Missing them meant an unreviewed command
  // could ride through on the allowlisted one in front of it.
  //
  // Tab is deliberately not in this list: it is an IFS word separator, so
  // `df -h /<tab>acme-repair` passes acme-repair to df as an argument and never
  // executes it.
  const segments = command
    .split(/\|\||&&|[|;&\n\r]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const approvals = matchRules(normalise(command), APPROVAL_RULES);
  if (approvals.length > 0) {
    return verdict(approvals[0]!);
  }

  const unknown = segments.filter((seg) => !READ_ONLY_COMMANDS.has(baseCommand(seg)));
  if (unknown.length > 0) {
    return {
      decision: "require_approval",
      categories: ["routine"],
      reason: `\`${baseCommand(unknown[0]!)}\` is not on the read-only diagnostics list, so a technician reviews it before it runs.`,
      rule_id: "approve.unknown-command",
      escalate: false,
    };
  }

  // Command substitution can smuggle an unreviewed command past segment
  // splitting, so it is held rather than allowed.
  if (/\$\(|`|\bstart-process\b|\biex\b|\binvoke-expression\b|\beval\b/i.test(command)) {
    return {
      decision: "require_approval",
      categories: ["routine"],
      reason:
        "The command builds or evaluates another command at runtime, which cannot be reviewed ahead of time.",
      rule_id: "approve.dynamic-command",
      escalate: false,
    };
  }

  if (step.mutating) {
    return {
      decision: "require_approval",
      categories: ["routine"],
      reason:
        "The step is marked as changing device state, so it is held for technician sign-off.",
      rule_id: "approve.declared-mutating",
      escalate: false,
    };
  }

  return {
    decision: "allow",
    categories: ["routine"],
    reason: "Read-only diagnostic command on the approved list.",
    rule_id: "allow.read-only-diagnostic",
    escalate: false,
  };
}
