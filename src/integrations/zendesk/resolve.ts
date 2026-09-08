/**
 * Choosing a help desk.
 *
 * `HttpZendeskClient` has existed and worked since the first commit, and
 * nothing ever constructed it - so setting `ZENDESK_*` did nothing at all while
 * the README said it would. This is the missing half: the one place that
 * decides which client the rest of the system gets.
 *
 * The choice is reported rather than silent, for the same reason the reasoning
 * provider is: a run against a live help desk and a run against an in-memory
 * one are materially different, and nobody should have to guess which they got.
 */
import {
  HttpZendeskClient,
  zendeskConfigFromEnv,
  type ZendeskClient,
} from "./client.js";
import { InMemoryZendeskClient } from "./mock.js";
import { TICKETS, USERS } from "../../demo/scenarios.js";

export interface HelpDeskSelection {
  client: ZendeskClient;
  kind: "zendesk" | "in-memory";
  /** Human-readable note explaining what was chosen and why. */
  note: string;
}

export function selectHelpDesk(): HelpDeskSelection {
  const config = zendeskConfigFromEnv();
  if (config) {
    return {
      client: new HttpZendeskClient(config),
      kind: "zendesk",
      note: `live Zendesk at ${config.subdomain}.zendesk.com as ${config.email}`,
    };
  }
  return {
    client: new InMemoryZendeskClient({ tickets: TICKETS, users: USERS }),
    kind: "in-memory",
    note:
      "in-memory help desk with the demo tickets - set ZENDESK_SUBDOMAIN, ZENDESK_EMAIL and ZENDESK_API_TOKEN to use a real one",
  };
}
