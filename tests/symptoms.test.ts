/**
 * Symptom extraction.
 *
 * These strings become the text the knowledge base matches future tickets
 * against, so what gets in matters more than it looks. A deadline stored as a
 * symptom is not a cosmetic problem: it makes an expenses ticket retrieve a DNS
 * outage.
 */
import { describe, expect, it } from "vitest";
import { extractSymptoms } from "../src/agent/symptoms.js";

describe("extracting symptoms from what a user wrote", () => {
  it("keeps the sentences that describe a fault", () => {
    const s = extractSymptoms(
      "Since this morning the intranet page just won't load - it says the site can't be reached. Everything else seems fine.",
      "Can't get onto the intranet",
    );
    expect(s.some((x) => /intranet page just won't load/i.test(x))).toBe(true);
    expect(s.some((x) => /site can't be reached/i.test(x))).toBe(true);
  });

  it("drops the deadline, which is not a symptom of anything", () => {
    const s = extractSymptoms(
      "The printer won't print. I need to hand this to the client at 2pm.",
      "Nothing is printing",
    );
    expect(s.join(" ")).not.toMatch(/client at 2pm|hand this/i);
  });

  it("drops what the user already tried", () => {
    const s = extractSymptoms(
      "The page won't load. I've tried restarting Chrome.",
      "Page won't load",
    );
    expect(s.join(" ")).not.toMatch(/restarting Chrome/i);
  });

  it("does not treat 'I didn't click it' as a fault report", () => {
    const s = extractSymptoms(
      "I got an email saying my mailbox was over quota. I didn't type anything in.",
      "Phishing email",
    );
    expect(s.join(" ")).not.toMatch(/didn't type anything/i);
    expect(s.join(" ")).toMatch(/over quota/i);
  });

  it("does not mine a pure request for symptoms", () => {
    const subject = "New starter setup for Monday";
    const s = extractSymptoms(
      "We have a new analyst starting Monday. Please create her AD account and add her to the Finance-Reporting group.",
      subject,
    );
    expect(s).toEqual([subject]);
  });

  it("keeps stored symptoms short enough for coverage to mean something", () => {
    const s = extractSymptoms(
      "Since this morning the intranet page just won't load and it has been like this for hours and hours and I am completely stuck and cannot do any work at all today",
      "Intranet down",
    );
    for (const symptom of s) {
      expect(symptom.split(/\s+/).length).toBeLessThanOrEqual(14);
    }
  });

  it("never ends a trimmed symptom on a dangling function word", () => {
    const s = extractSymptoms(
      "I got an email this morning saying my mailbox was over quota with a link to re-verify my password",
      "Phishing",
    );
    for (const symptom of s) {
      expect(symptom).not.toMatch(/\s(a|an|the|with|for|to|of|and|or)$/i);
    }
  });

  it("falls back to the subject rather than returning nothing", () => {
    expect(extractSymptoms("Hello, thanks for your help.", "Something odd")).toEqual([
      "Something odd",
    ]);
  });
});
