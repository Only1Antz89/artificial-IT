/**
 * Guardrail vocabulary.
 *
 * The categories below are the "out of limits" list from the product brief.
 * They are contract-level rather than implementation-level on purpose: the
 * classifier, the audit log, the ticket write-up and the console all name the
 * same category, so a blocked action reads identically everywhere.
 */
import { z } from "zod";

export const RiskCategory = z.enum([
  /** Passwords, tokens, keys, certificates, credential stores. */
  "credentials",
  /** Payments, banking, purchasing, payroll, invoices. */
  "finance",
  /** Creating/deleting users, group membership, privilege escalation. */
  "identity",
  /** Irreversible data or system loss: formatting, mass deletion, wipes. */
  "destructive",
  /** Turning off AV/EDR/firewall/MFA or otherwise weakening defences. */
  "security-controls",
  /** Moving data off the device in bulk. */
  "data-exfiltration",
  /** OS reinstall, domain join/leave, boot/BIOS, disk partitioning. */
  "major-system-change",
  /** Routers, switches, DNS, DHCP, VPN concentrators - shared blast radius. */
  "network-infrastructure",
  /** Anything touching regulated or legally sensitive material. */
  "compliance",
  /** No special category - ordinary technician work. */
  "routine",
]);
export type RiskCategory = z.infer<typeof RiskCategory>;

/**
 * What the control plane decided to do with a proposed action.
 *
 * `block` is a hard stop: the agent may not retry it, reword it, or route
 * around it. `require_approval` pauses for a human technician.
 */
export const PolicyDecision = z.enum(["allow", "require_approval", "block"]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const PolicyVerdict = z.object({
  decision: PolicyDecision,
  categories: z.array(RiskCategory).default([]),
  /** Plain-English reason, shown to the user and written into the ticket. */
  reason: z.string().min(1),
  /** Id of the rule that fired, for audit and for tuning the ruleset. */
  rule_id: z.string().min(1),
  /** Set when the verdict itself demands a human takes over. */
  escalate: z.boolean().default(false),
});
export type PolicyVerdict = z.infer<typeof PolicyVerdict>;
