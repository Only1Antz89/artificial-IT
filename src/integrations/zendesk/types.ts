/**
 * The subset of the Zendesk Support API this integration touches.
 *
 * Only the fields actually used are modelled. A partial type that is honest
 * about being partial is easier to reason about than a hand-copied full schema
 * that drifts.
 *
 * Reference: Zendesk Support API v2, /api/v2/tickets.
 */

export interface ZendeskUser {
  id: number;
  name: string;
  email?: string;
  role?: "end-user" | "agent" | "admin";
  organization_id?: number;
  /** Zendesk has no "vip" field; teams conventionally use a tag or org. */
  tags?: string[];
}

export interface ZendeskAttachment {
  id: number;
  file_name: string;
  content_url: string;
  content_type: string;
  size: number;
}

export interface ZendeskComment {
  id: number;
  author_id: number;
  body: string;
  html_body?: string;
  public: boolean;
  created_at: string;
  attachments?: ZendeskAttachment[];
}

export interface ZendeskTicket {
  id: number;
  external_id?: string | null;
  subject: string;
  description: string;
  status: "new" | "open" | "pending" | "hold" | "solved" | "closed";
  priority: "low" | "normal" | "high" | "urgent" | null;
  tags: string[];
  requester_id: number;
  assignee_id?: number | null;
  group_id?: number | null;
  created_at: string;
  updated_at: string;
  /** Populated by this integration from a sideload or a follow-up fetch. */
  comments?: ZendeskComment[];
  custom_fields?: { id: number; value: string | number | boolean | null }[];
}

/** An upload token from /api/v2/uploads.json, attached to the next comment. */
export interface ZendeskUpload {
  token: string;
  attachment: ZendeskAttachment;
}

export interface TicketUpdate {
  status?: ZendeskTicket["status"];
  priority?: ZendeskTicket["priority"];
  tags?: string[];
  assignee_id?: number | null;
  group_id?: number | null;
  comment?: {
    body: string;
    public: boolean;
    uploads?: string[];
  };
}
