/**
 * Retrieval over past tickets.
 *
 * BM25 rather than embeddings, for three reasons that matter at service-desk
 * scale: it needs no model call on the hot path, it is explainable (you can see
 * which words matched, which a technician reviewing a bad suggestion will ask
 * for), and IT tickets are full of high-signal rare tokens - error codes, DLL
 * names, `0x80070005` - that lexical search is genuinely good at.
 *
 * Platform and category act as boosts rather than filters: a macOS entry can
 * still be the right lead for a Windows ticket about the same SaaS app, so it
 * is ranked lower rather than hidden.
 */
import type { KnowledgeEntry } from "./store.js";

const K1 = 1.5;
const B = 0.75;

/**
 * Words too common in ticket text to carry signal.
 *
 * Longer than a standard English stoplist because service-desk prose has its
 * own filler - "need", "working", "tried", "else". Those words are what make a
 * two-document knowledge base return a mailbox ticket for a DNS fault, and no
 * amount of IDF tuning fixes it while the corpus is small.
 */
const STOPWORDS = new Set([
  // ordinary English
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "to", "of", "in", "on", "at", "for", "with", "my", "i", "it", "this", "that",
  "have", "has", "had", "not", "no", "can", "cant", "cannot", "do", "does", "did",
  "when", "then", "there", "their", "they", "you", "your", "me", "am", "please",
  "we", "us", "as", "if", "so", "just", "very", "im", "its", "from", "by", "about",
  "would", "could", "should", "will", "wont", "been", "any", "all", "some", "one",
  "now", "still", "again", "also", "than", "them", "he", "she", "his", "her",
  // service-desk filler
  "hi", "hello", "thanks", "help", "issue", "problem", "user", "users", "get",
  "getting", "got", "need", "needs", "needed", "want", "wanted", "else", "thing",
  "things", "work", "works", "working", "worked", "use", "used", "using", "try",
  "tried", "trying", "see", "seeing", "look", "looking", "know", "think", "make",
  "made", "go", "going", "come", "coming", "put", "take", "day", "today",
  "yesterday", "morning", "afternoon", "week", "time", "times", "since", "asap",
  "urgent", "sorry", "hey", "team", "ticket", "request", "please", "kind",
  "regards", "cheers", "attached", "screenshot", "machine", "laptop", "computer",
  "pc", "device",
]);

/**
 * Light suffix stripping.
 *
 * Not a real stemmer - it exists so "loading" matches "load" and "printers"
 * matches "printer", which is most of the recall a ticket search needs. Applied
 * only to plain alphabetic tokens, so error codes and filenames survive intact.
 */
function stem(token: string): string {
  if (!/^[a-z]+$/.test(token) || token.length < 5) return token;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // Keep dotted/hex tokens whole: `0x80070005`, `outlook.exe`, `10.0.2.15`.
    .split(/[^a-z0-9._\-]+/)
    .map((t) => t.replace(/^[._-]+|[._-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem)
    .filter((t) => !STOPWORDS.has(t));
}

/**
 * The terms that actually identify an entry: its symptoms and title.
 *
 * Used for the coverage gate below. Matching a word that appears only in an
 * entry's resolution notes is far weaker evidence than matching how the problem
 * presented, and coverage is what separates the two.
 */
function headlineTerms(entry: KnowledgeEntry): Set<string> {
  return new Set([
    ...tokenize(entry.symptoms.join(" ")),
    ...tokenize(entry.title),
  ]);
}

/** All searchable text for an entry, weighted by repeating the strongest field. */
function entryTokens(entry: KnowledgeEntry): string[] {
  return [
    // Symptoms are how the *next* user will describe it, so they count double.
    ...tokenize(entry.symptoms.join(" ")),
    ...tokenize(entry.symptoms.join(" ")),
    ...tokenize(entry.title),
    ...tokenize(entry.root_cause),
    ...tokenize(entry.category),
    ...tokenize(entry.resolution_steps.join(" ")),
  ];
}

export interface RetrievalHit {
  entry: KnowledgeEntry;
  score: number;
  /** Which query terms matched - shown in the console and the audit log. */
  matched_terms: string[];
  /** Share of the entry's own headline terms the query hit, 0-1. */
  coverage: number;
}

export interface RetrievalQuery {
  text: string;
  platform?: "windows" | "macos" | "linux" | "unknown";
  category?: string;
  limit?: number;
  /** Hits below this score are dropped rather than padded out to `limit`. */
  minScore?: number;
  /**
   * Minimum share of an entry's headline terms the query must hit.
   *
   * This is the gate that stops a coincidental match on one common word from
   * being presented to the technician as a relevant prior ticket.
   */
  minCoverage?: number;
}

export function retrieve(
  entries: KnowledgeEntry[],
  query: RetrievalQuery,
): RetrievalHit[] {
  if (entries.length === 0) return [];

  const docs = entries.map(entryTokens);
  const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / docs.length;
  const queryTerms = [...new Set(tokenize(query.text))];

  // Document frequency per query term.
  const df = new Map<string, number>();
  for (const term of queryTerms) {
    df.set(term, docs.filter((d) => d.includes(term)).length);
  }

  const hits: RetrievalHit[] = entries.map((entry, i) => {
    const doc = docs[i]!;
    const headline = headlineTerms(entry);
    const len = doc.length || 1;
    const counts = new Map<string, number>();
    for (const t of doc) counts.set(t, (counts.get(t) ?? 0) + 1);

    let score = 0;
    const matched: string[] = [];
    for (const term of queryTerms) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) continue;
      matched.push(term);
      const n = df.get(term) ?? 0;
      // BM25 IDF, floored so a term present in every doc cannot go negative.
      const idf = Math.max(
        0.05,
        Math.log(1 + (entries.length - n + 0.5) / (n + 0.5)),
      );
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (len / avgLen))));
    }

    // Boosts: same platform, same category, and entries that have worked before.
    if (query.platform && (entry.platform === query.platform || entry.platform === "any")) {
      score *= 1.25;
    }
    if (query.category && entry.category === query.category) {
      score *= 1.35;
    }
    if (entry.outcome === "resolved") {
      score *= 1.15;
    }
    // A little credit for a track record, capped so it cannot dominate relevance.
    score *= 1 + Math.min(entry.times_applied, 5) * 0.04;

    const hitHeadline = matched.filter((t) => headline.has(t));
    const coverage = headline.size === 0 ? 0 : hitHeadline.length / headline.size;

    return { entry, score, matched_terms: matched, coverage };
  });

  const minScore = query.minScore ?? 0.6;
  const minCoverage = query.minCoverage ?? 0.12;

  return hits
    .filter(
      (h) =>
        h.score >= minScore &&
        // Two independent terms, or one that is a strong identifier on its own.
        h.matched_terms.length >= 2 &&
        h.coverage >= minCoverage,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, query.limit ?? 3);
}
