/**
 * Pulling the symptoms out of what a user wrote.
 *
 * A ticket description is mostly not symptoms. It is context, deadlines,
 * apology, and the things the user already tried. Storing all of it as
 * `reported_symptoms` has two costs, and the second one is the expensive one:
 *
 *  1. A technician reading the intake sees "I need the expenses form before the
 *     end of the day" listed as a symptom of a DNS fault.
 *  2. Those sentences end up in the knowledge entry the run writes, where they
 *     become the text future tickets are matched against - so a ticket about
 *     expenses retrieves a DNS outage, and a genuine repeat of the DNS fault
 *     matches poorly because the entry is padded with prose that has nothing to
 *     do with it.
 *
 * So this is deliberately conservative: a sentence has to look like a fault
 * report to survive, and what survives is trimmed to the part that describes
 * the fault.
 */

/** Words and forms that mean "something is not working". */
const FAULT_MARKER =
  /\b(won'?t|wont|will\s+not|can'?t|cant|cannot|unable|doesn'?t|does\s+not|didn'?t|isn'?t|not\s+working|no\s+(sound|audio|internet|network|access|response)|fail(s|ed|ing)?|error|errors?|crash(es|ed|ing)?|freez(e|es|ing)|hang(s|ing)?|stuck|slow|sluggish|lag(s|ging)?|broken|dead|drop(s|ping|ped)?|disconnect(s|ing|ed)?|offline|unreachable|timed?\s*out|blocked|missing|corrupt|full|refus(es|ed)|reject(s|ed)?|denied|locked\s+out|greyed?\s+out|garbled|spinning|blue\s+screen|bsod|prompt(s|ing)?\s+for|sitting\s+there|nothing\s+(has\s+)?come\s+out|keeps?\s+\w+ing|over\s+quota|suspicious|phish\w*|scam|spoofed?|malware|ransomware|virus)\b/i;

/** Sentences that are about the user's day, not the machine. */
const NOT_A_SYMPTOM =
  /\b(need(s|ed)?\s+(it|this|that|to\s+get)|before\s+the\s+end\s+of\s+the\s+day|by\s+\d|hand\s+this|client\s+(at|meeting|call)|deadline|working\s+from\s+home|come\s+to\s+the\s+desk|if\s+that\s+(matters|helps)|thanks|thank\s+you|sorry|please\s+(can|could)|let\s+me\s+know|any\s+help|failing\s+that|should\s+i\s+be\s+worried)\b/i;

/**
 * Sentences describing what the *user* did or did not do.
 *
 * "I didn't type anything in" contains a negation and reads to a naive matcher
 * like a fault report. It is the opposite: it is the user telling you the bad
 * thing did not happen. Stored as a symptom it would match every future ticket
 * about typing, and tell a technician nothing.
 */
const USER_ACTION =
  /^(i|we)\s+(did\s*n[o']?t|do\s*n[o']?t|have\s*n[o']?t|hadn'?t|never|just|only|also|then)\b/i;

/** Requests, not reports. A ticket asking for something has no symptoms. */
const A_REQUEST =
  /\b(can\s+you|could\s+you|please\s+(set|add|create|grant|give|forward|reset)|i'?d\s+like|would\s+like|give\s+me\s+access)\b/i;

/** Openers that carry no diagnostic weight and dilute a stored symptom. */
const LEADING_FILLER =
  /^(since\s+(this\s+)?\w+\s*,?\s*|same\s+thing[^-]{0,40}-\s*|this\s+(morning|afternoon)\s*,?\s*|basically\s+|honestly\s+|so\s+|and\s+|but\s+|also\s+|i\s+think\s+|it\s+(seems|looks)\s+like\s+)/i;

/** Words the user uses about their own attempts, which are not symptoms. */
const ALREADY_TRIED = /\b(i'?ve\s+tried|i\s+tried|i\s+have\s+tried|already\s+tried|restarted?\s+(it|chrome|the\s+\w+)|emptied\s+the\s+bin)\b/i;

const MAX_WORDS = 14;

/**
 * Extract the reported symptoms from a ticket description.
 *
 * Returns short phrases, in the user's own words, in the order they were
 * written. Falls back to the subject when nothing in the body reads as a fault
 * report - a one-line ticket is still a ticket.
 */
export function extractSymptoms(description: string, subject: string): string[] {
  const sentences = description
    .split(/(?<=[.!?])\s+|\n+/)
    .flatMap((s) => s.split(/\s+-\s+/))
    .map((s) => s.trim().replace(/^[-–—•*]\s*/, ""))
    .filter((s) => s.length > 8);

  const symptoms: string[] = [];
  for (const sentence of sentences) {
    if (NOT_A_SYMPTOM.test(sentence)) continue;
    if (USER_ACTION.test(sentence)) continue;
    if (A_REQUEST.test(sentence)) continue;
    if (ALREADY_TRIED.test(sentence)) continue;
    if (!FAULT_MARKER.test(sentence)) continue;
    const trimmed = condense(sentence);
    if (trimmed.length > 8 && !symptoms.includes(trimmed)) symptoms.push(trimmed);
    if (symptoms.length === 4) break;
  }

  return symptoms.length > 0 ? symptoms : [subject];
}

/**
 * Cut a sentence down to the clause that carries the fault.
 *
 * Long stored symptoms are what make retrieval coverage meaningless: an entry
 * whose symptoms are three twenty-word sentences can never be well covered by a
 * different user's wording of the same problem.
 */
function condense(sentence: string): string {
  let text = sentence.replace(LEADING_FILLER, "").trim();

  // Prefer the clause that actually contains the fault marker.
  if (text.split(/\s+/).length > MAX_WORDS) {
    const clauses = text.split(/,\s*|\s+(?:and|but|so|because|which)\s+/i);
    const faulty = clauses.find((c) => FAULT_MARKER.test(c));
    if (faulty) text = faulty.trim();
  }

  const words = text.split(/\s+/);
  if (words.length > MAX_WORDS) text = words.slice(0, MAX_WORDS).join(" ");

  // A hard word cap loves to stop on "with a" or "and the". Strip dangling
  // function words until the symptom ends on something meaningful - one pass is
  // not enough, because the cap regularly leaves two of them in a row.
  const DANGLING = /[\s.,;:]+$|\s+(a|an|the|with|for|to|of|and|or|in|on|at|from|that|which|but|so|is|was)$/i;
  let out = text;
  while (DANGLING.test(out)) out = out.replace(DANGLING, "");
  return out.trim();
}
