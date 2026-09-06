/**
 * In-memory Zendesk.
 *
 * Backs the demo and the tests. It behaves like the real thing in the ways that
 * matter for this system - comments append, uploads produce tokens that attach
 * to the next comment, status transitions stick - so a demo run exercises the
 * same integration code that a live run would.
 */
import type { ZendeskClient } from "./client.js";
import type {
  TicketUpdate,
  ZendeskTicket,
  ZendeskUpload,
  ZendeskUser,
} from "./types.js";

export interface MockSeed {
  tickets: ZendeskTicket[];
  users: ZendeskUser[];
}

export class InMemoryZendeskClient implements ZendeskClient {
  readonly kind = "in-memory" as const;
  #tickets = new Map<number, ZendeskTicket>();
  #users = new Map<number, ZendeskUser>();
  #uploads = new Map<string, ZendeskUpload>();
  #nextId = 90_000;

  constructor(seed: MockSeed) {
    for (const t of seed.tickets) this.#tickets.set(t.id, structuredClone(t));
    for (const u of seed.users) this.#users.set(u.id, structuredClone(u));
  }

  async listOpenTickets(limit = 25): Promise<ZendeskTicket[]> {
    return [...this.#tickets.values()]
      .filter((t) => t.status !== "solved" && t.status !== "closed")
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit)
      .map((t) => structuredClone(t));
  }

  async getTicket(id: number): Promise<ZendeskTicket> {
    const ticket = this.#tickets.get(id);
    if (!ticket) throw new Error(`ticket ${id} not found`);
    return structuredClone(ticket);
  }

  async getUser(id: number): Promise<ZendeskUser> {
    const user = this.#users.get(id);
    if (!user) throw new Error(`user ${id} not found`);
    return structuredClone(user);
  }

  async upload(
    filename: string,
    contentType: string,
    body: string,
  ): Promise<ZendeskUpload> {
    this.#nextId += 1;
    const token = `upl_${this.#nextId.toString(36)}`;
    const upload: ZendeskUpload = {
      token,
      attachment: {
        id: this.#nextId,
        file_name: filename,
        content_url: `memory://uploads/${token}/${filename}`,
        content_type: contentType,
        size: Buffer.byteLength(body, "utf8"),
      },
    };
    this.#uploads.set(token, upload);
    return upload;
  }

  async updateTicket(id: number, update: TicketUpdate): Promise<ZendeskTicket> {
    const ticket = this.#tickets.get(id);
    if (!ticket) throw new Error(`ticket ${id} not found`);

    if (update.status) ticket.status = update.status;
    if (update.priority !== undefined) ticket.priority = update.priority;
    if (update.tags) ticket.tags = [...new Set([...ticket.tags, ...update.tags])];
    if (update.assignee_id !== undefined) ticket.assignee_id = update.assignee_id;
    if (update.group_id !== undefined) ticket.group_id = update.group_id;

    if (update.comment) {
      this.#nextId += 1;
      ticket.comments ??= [];
      ticket.comments.push({
        id: this.#nextId,
        author_id: 1,
        body: update.comment.body,
        public: update.comment.public,
        created_at: new Date().toISOString(),
        attachments: (update.comment.uploads ?? [])
          .map((token) => this.#uploads.get(token)?.attachment)
          .filter((a): a is NonNullable<typeof a> => Boolean(a)),
      });
    }

    ticket.updated_at = new Date().toISOString();
    return structuredClone(ticket);
  }
}
