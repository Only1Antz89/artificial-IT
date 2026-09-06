/**
 * Append-only audit log.
 *
 * There is no update or delete. The log is the record of what the control plane
 * decided and why, and it is what gets attached to the ticket when a human asks
 * "why did the bot do that".
 */
import type { AuditEntry, AuditEventType } from "../contracts/index.js";
import { nowIso } from "../contracts/index.js";

export class AuditLog {
  #entries: AuditEntry[] = [];

  constructor(
    private readonly runId: string,
    private readonly ticketId: string,
  ) {}

  record(
    event: AuditEventType,
    actor: AuditEntry["actor"],
    summary: string,
    detail: Record<string, unknown> = {},
  ): AuditEntry {
    const entry: AuditEntry = {
      seq: this.#entries.length,
      event,
      at: nowIso(),
      run_id: this.runId,
      ticket_id: this.ticketId,
      actor,
      summary,
      detail,
    };
    this.#entries.push(entry);
    return entry;
  }

  /** A defensive copy - callers must not be able to rewrite history. */
  entries(): AuditEntry[] {
    return this.#entries.map((e) => ({ ...e }));
  }
}
