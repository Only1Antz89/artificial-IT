/**
 * Zendesk client.
 *
 * `ZendeskClient` is an interface with two implementations: `HttpZendeskClient`
 * talks to a real Zendesk instance, and `InMemoryZendeskClient` (in
 * `mock.ts`) backs the demo and the tests. Everything upstream depends on the
 * interface, so a demo run and a production run take exactly the same code
 * path through the agent.
 *
 * Auth is API-token basic auth (`{email}/token:{token}`), which is what Zendesk
 * expects for a service integration.
 */
import type {
  TicketUpdate,
  ZendeskTicket,
  ZendeskUpload,
  ZendeskUser,
} from "./types.js";

export interface ZendeskClient {
  readonly kind: "http" | "in-memory";
  listOpenTickets(limit?: number): Promise<ZendeskTicket[]>;
  getTicket(id: number): Promise<ZendeskTicket>;
  getUser(id: number): Promise<ZendeskUser>;
  /** Upload an attachment and return the token to attach to a comment. */
  upload(filename: string, contentType: string, body: string): Promise<ZendeskUpload>;
  updateTicket(id: number, update: TicketUpdate): Promise<ZendeskTicket>;
}

export interface ZendeskConfig {
  /** Subdomain only, e.g. "acme" for acme.zendesk.com. */
  subdomain: string;
  email: string;
  apiToken: string;
}

export function zendeskConfigFromEnv(): ZendeskConfig | undefined {
  const subdomain = process.env["ZENDESK_SUBDOMAIN"];
  const email = process.env["ZENDESK_EMAIL"];
  const apiToken = process.env["ZENDESK_API_TOKEN"];
  if (!subdomain || !email || !apiToken) return undefined;
  return { subdomain, email, apiToken };
}

export class ZendeskError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ZendeskError";
  }
}

export class HttpZendeskClient implements ZendeskClient {
  readonly kind = "http" as const;
  readonly #base: string;
  readonly #auth: string;

  constructor(config: ZendeskConfig) {
    this.#base = `https://${config.subdomain}.zendesk.com/api/v2`;
    this.#auth = Buffer.from(
      `${config.email}/token:${config.apiToken}`,
      "utf8",
    ).toString("base64");
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.#base}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${this.#auth}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ZendeskError(
        `Zendesk ${init.method ?? "GET"} ${path} failed with ${response.status}`,
        response.status,
        text,
      );
    }
    return JSON.parse(text) as T;
  }

  async listOpenTickets(limit = 25): Promise<ZendeskTicket[]> {
    // Search rather than /tickets.json so the queue filter lives server-side.
    const query = encodeURIComponent("type:ticket status<solved");
    const data = await this.#request<{ results: ZendeskTicket[] }>(
      `/search.json?query=${query}&sort_by=created_at&sort_order=asc`,
    );
    return data.results.slice(0, limit);
  }

  async getTicket(id: number): Promise<ZendeskTicket> {
    const [ticket, comments] = await Promise.all([
      this.#request<{ ticket: ZendeskTicket }>(`/tickets/${id}.json`),
      this.#request<{ comments: ZendeskTicket["comments"] }>(
        `/tickets/${id}/comments.json`,
      ),
    ]);
    return { ...ticket.ticket, comments: comments.comments ?? [] };
  }

  async getUser(id: number): Promise<ZendeskUser> {
    const data = await this.#request<{ user: ZendeskUser }>(`/users/${id}.json`);
    return data.user;
  }

  async upload(
    filename: string,
    contentType: string,
    body: string,
  ): Promise<ZendeskUpload> {
    // The uploads endpoint takes a raw body, not JSON, and the filename goes in
    // the query string.
    const response = await fetch(
      `${this.#base}/uploads.json?filename=${encodeURIComponent(filename)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${this.#auth}`,
          "Content-Type": contentType,
        },
        body,
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new ZendeskError(
        `Zendesk upload failed with ${response.status}`,
        response.status,
        text,
      );
    }
    return (JSON.parse(text) as { upload: ZendeskUpload }).upload;
  }

  async updateTicket(id: number, update: TicketUpdate): Promise<ZendeskTicket> {
    const data = await this.#request<{ ticket: ZendeskTicket }>(
      `/tickets/${id}.json`,
      { method: "PUT", body: JSON.stringify({ ticket: update }) },
    );
    return data.ticket;
  }
}
