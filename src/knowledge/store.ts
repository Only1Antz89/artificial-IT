/**
 * The knowledge base: what previous tickets taught us.
 *
 * An entry is written when a run resolves, and read at the start of the next
 * run. That loop is the whole "learn from previous jobs" requirement, and it is
 * deliberately built out of retrieval rather than fine-tuning: a technician can
 * read an entry, correct it, or delete it, and the change takes effect on the
 * very next ticket.
 *
 * Storage is a JSONL file. It is append-friendly, diffable in review, and
 * swappable for a database-backed store later without touching callers.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { IsoDateTime, nowIso } from "../contracts/index.js";

export const KnowledgeEntry = z.object({
  id: z.string().min(1),
  /** The ticket this was learned from. */
  source_ticket_id: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  platform: z.enum(["windows", "macos", "linux", "any"]).default("any"),
  /** How the problem presented, in the user's language, for matching. */
  symptoms: z.array(z.string()).default([]),
  root_cause: z.string(),
  /** The commands that proved the diagnosis, in order. */
  diagnostic_steps: z.array(z.string()).default([]),
  /** The fix that worked. */
  resolution_steps: z.array(z.string()).default([]),
  /** Guardrail categories this class of ticket tends to run into. */
  cautions: z.array(z.string()).default([]),
  /** Times this entry has been retrieved and led to a resolved run. */
  times_applied: z.number().int().min(0).default(0),
  outcome: z.enum(["resolved", "escalated"]),
  learned_at: IsoDateTime,
});
export type KnowledgeEntry = z.infer<typeof KnowledgeEntry>;

export class KnowledgeStore {
  #entries: KnowledgeEntry[] = [];

  constructor(private readonly path: string) {
    this.#load();
  }

  #load(): void {
    if (!existsSync(this.path)) return;
    const lines = readFileSync(this.path, "utf8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      // A malformed line is skipped rather than thrown on: one truncated write
      // should not stop the assistant using the other two hundred entries.
      // Both failure modes are caught - invalid JSON, and valid JSON that is
      // not a knowledge entry.
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = KnowledgeEntry.safeParse(raw);
      if (parsed.success) this.#entries.push(parsed.data);
    }
  }

  all(): KnowledgeEntry[] {
    return this.#entries.map((e) => ({ ...e }));
  }

  get(id: string): KnowledgeEntry | undefined {
    return this.#entries.find((e) => e.id === id);
  }

  add(entry: Omit<KnowledgeEntry, "learned_at"> & { learned_at?: string }): KnowledgeEntry {
    const full = KnowledgeEntry.parse({ learned_at: nowIso(), ...entry });
    this.#entries.push(full);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }

  size(): number {
    return this.#entries.length;
  }
}
