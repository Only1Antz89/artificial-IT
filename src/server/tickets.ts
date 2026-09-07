/**
 * The ticket desk: what links the two surfaces.
 *
 * A user reports a problem in the portal; a technician watches AIT work it in
 * the console. Both are looking at the same ticket, and this is where it lives.
 *
 * The important design decision here is what each side is allowed to see.
 * A technician gets everything - commands, guardrail rule ids, the audit trail.
 * A user gets progress in their own language and nothing else. That is not
 * cosmetic: showing someone `net stop spooler` and `block.credentials` is how
 * you turn a support interaction into a support incident. `userView()` is the
 * only thing the portal ever sends, and it is built by allowing fields through
 * rather than by stripping fields out - so a new internal field added later
 * cannot leak by being forgotten.
 */
import { randomUUID } from "node:crypto";
import type { Run, Ticket } from "../contracts/index.js";
import type { RunSession, PendingQuestion } from "./run-registry.js";

export type DeskStatus =
  | "submitted"
  | "working"
  | "waiting-on-you"
  | "waiting-on-technician"
  | "resolved"
  | "escalated"
  | "failed";

export interface DeskTicket {
  id: string;
  /** Short human-facing reference, e.g. AIT-4F2A. */
  reference: string;
  submittedAt: string;
  reportedBy: string;
  summary: string;
  description: string;
  /** Which machine the user said it was about. */
  target: string;
  consentGranted: boolean;
  status: DeskStatus;
  /** The run working this ticket, once one has started. */
  runId?: string;
  /** Progress notes in the user's language, oldest first. */
  updates: { at: string; text: string }[];
  /** An outstanding question, when AIT is waiting on the user. */
  question?: PendingQuestion;
  /** The final reply, once the run has written one. */
  reply?: string;
  resolvedAt?: string;
}

/** What the portal is allowed to see. An allowlist, never a redaction. */
export interface UserFacingTicket {
  reference: string;
  submittedAt: string;
  summary: string;
  status: DeskStatus;
  statusLabel: string;
  updates: { at: string; text: string }[];
  question?: { id: string; question: string };
  reply?: string;
  resolvedAt?: string;
}

const STATUS_LABELS: Record<DeskStatus, string> = {
  submitted: "Received — waiting to be picked up",
  working: "Being looked at now",
  "waiting-on-you": "Waiting for your answer",
  "waiting-on-technician": "With one of our technicians",
  resolved: "Resolved",
  escalated: "Passed to a technician",
  failed: "Could not be completed automatically",
};

export function userView(ticket: DeskTicket): UserFacingTicket {
  return {
    reference: ticket.reference,
    submittedAt: ticket.submittedAt,
    summary: ticket.summary,
    status: ticket.status,
    statusLabel: STATUS_LABELS[ticket.status],
    updates: ticket.updates.map((u) => ({ ...u })),
    ...(ticket.question
      ? { question: { id: ticket.question.id, question: ticket.question.question } }
      : {}),
    ...(ticket.reply ? { reply: ticket.reply } : {}),
    ...(ticket.resolvedAt ? { resolvedAt: ticket.resolvedAt } : {}),
  };
}

/** What the console sees: everything, plus the run to drill into. */
export interface DeskEvent {
  type: "ticket" | "removed";
  ticket: DeskTicket;
}

type DeskSubscriber = (event: DeskEvent) => void;

/**
 * Every ticket on the desk.
 *
 * In memory, like the run registry, and for the same reason: this is a console
 * you watch while it happens, not a system of record. A real deployment reads
 * its queue from the help desk instead.
 */
export class TicketDesk {
  #tickets = new Map<string, DeskTicket>();
  #subscribers = new Set<DeskSubscriber>();

  constructor(private readonly maxTickets = 100) {}

  submit(input: {
    reportedBy: string;
    description: string;
    summary: string;
    target: string;
    consentGranted: boolean;
  }): DeskTicket {
    const id = randomUUID();
    const ticket: DeskTicket = {
      id,
      // Short enough to read out over the phone, which is what a reference is for.
      reference: `AIT-${id.slice(0, 4).toUpperCase()}`,
      submittedAt: new Date().toISOString(),
      reportedBy: input.reportedBy,
      summary: input.summary,
      description: input.description,
      target: input.target,
      consentGranted: input.consentGranted,
      status: "submitted",
      updates: [
        {
          at: new Date().toISOString(),
          text: "Thanks — we have your report and someone is picking it up now.",
        },
      ],
    };

    this.#evict();
    this.#tickets.set(id, ticket);
    this.#publish(ticket);
    return ticket;
  }

  get(id: string): DeskTicket | undefined {
    return this.#tickets.get(id);
  }

  byReference(reference: string): DeskTicket | undefined {
    const wanted = reference.trim().toUpperCase();
    return [...this.#tickets.values()].find((t) => t.reference === wanted);
  }

  list(): DeskTicket[] {
    return [...this.#tickets.values()].sort((a, b) =>
      b.submittedAt.localeCompare(a.submittedAt),
    );
  }

  /** Change a ticket and tell everyone watching. */
  update(id: string, change: (ticket: DeskTicket) => void): DeskTicket | undefined {
    const ticket = this.#tickets.get(id);
    if (!ticket) return undefined;
    change(ticket);
    this.#publish(ticket);
    return ticket;
  }

  /** Add a progress note in the user's language. */
  note(id: string, text: string): void {
    this.update(id, (ticket) => {
      const last = ticket.updates[ticket.updates.length - 1];
      // A run emits many events; the user does not need the same sentence twice.
      if (last?.text === text) return;
      ticket.updates.push({ at: new Date().toISOString(), text });
    });
  }

  subscribe(subscriber: DeskSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  #publish(ticket: DeskTicket): void {
    for (const subscriber of this.#subscribers) {
      try {
        subscriber({ type: "ticket", ticket });
      } catch {
        /* the subscriber has gone; its stream handler will clean up */
      }
    }
  }

  #evict(): void {
    if (this.#tickets.size < this.maxTickets) return;
    const settled = this.list()
      .filter((t) => t.status === "resolved" || t.status === "escalated" || t.status === "failed")
      .reverse();
    let over = this.#tickets.size - (this.maxTickets - 1);
    for (const victim of settled) {
      if (over <= 0) break;
      this.#tickets.delete(victim.id);
      over -= 1;
    }
  }
}

/**
 * Turn a run event into something worth telling the user.
 *
 * Deliberately sparse. A user does not want a running commentary of shell
 * commands - they want to know somebody is on it, whether they need to do
 * anything, and how it ended. Everything else is the technician's business.
 */
export function userUpdateFor(event: { type: string; [k: string]: unknown }): string | undefined {
  switch (event.type) {
    case "intake":
      return "We have read your report and understand what you are seeing.";
    case "diagnosis":
      return "We are checking a few things on your machine now.";
    case "step": {
      const result = event["result"] as { outcome: string; step: { mutating: boolean } };
      if (result.outcome === "success" && result.step.mutating) {
        return "We have made a change that should fix this, and are checking it worked.";
      }
      return undefined;
    }
    case "escalation": {
      const escalation = event["escalation"] as { triggered: boolean };
      return escalation.triggered
        ? "This one needs a person, so we have passed it to a technician with everything we found."
        : undefined;
    }
    default:
      return undefined;
  }
}

/** Where a finished run leaves the ticket. */
export function statusForRun(run: Run): DeskStatus {
  switch (run.status) {
    case "resolved":
      return "resolved";
    case "escalated":
      return "escalated";
    case "awaiting_approval":
      return "waiting-on-technician";
    case "awaiting_user":
      return "waiting-on-you";
    default:
      return "failed";
  }
}

export type { Run, Ticket, RunSession };
