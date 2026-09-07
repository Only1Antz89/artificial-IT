/**
 * Provider selection tests.
 *
 * The safety-relevant property here is that the fallback is never silent: a run
 * answered by the deterministic playbook engine must be distinguishable from
 * one answered by a frontier model, because the two are not equivalent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectBrain } from "../src/agent/select-brain.js";
import { toPlanStep } from "../src/agent/schemas.js";
import { clampIndex } from "../src/agent/claude-brain.js";
import { TECHNICIAN_SYSTEM } from "../src/agent/prompts.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function clearKeys() {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("AIT_PROVIDER", "");
}

describe("selecting a provider", () => {
  it("falls back to the offline brain and says so", () => {
    clearKeys();
    const selection = selectBrain("auto");
    expect(selection.provider).toBe("offline");
    expect(selection.brain.name).toBe("heuristic");
    // The note is what stops an operator mistaking this for a model run.
    expect(selection.note).toMatch(/no ANTHROPIC_API_KEY or OPENAI_API_KEY/);
  });

  it("prefers Claude when its key is present", () => {
    clearKeys();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const selection = selectBrain("auto");
    expect(selection.provider).toBe("claude");
    expect(selection.model).toBe("claude-opus-5");
  });

  it("uses OpenAI when only its key is present", () => {
    clearKeys();
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const selection = selectBrain("auto");
    expect(selection.provider).toBe("openai");
    expect(selection.brain.name).toBe("openai");
  });

  it("honours an explicit model override", () => {
    clearKeys();
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "gpt-5-mini");
    expect(selectBrain("openai").model).toBe("gpt-5-mini");
  });

  it("fails loudly when a provider is demanded without credentials", () => {
    clearKeys();
    expect(() => selectBrain("claude")).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => selectBrain("openai")).toThrow(/OPENAI_API_KEY/);
  });

  it("never silently substitutes a different provider than the one asked for", () => {
    clearKeys();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    // A key being present must not override an explicit choice of offline.
    expect(selectBrain("offline").provider).toBe("offline");
  });
});

describe("both providers share one technician persona", () => {
  it("states the hard limits in the system prompt", () => {
    for (const limit of [
      "Passwords, credentials",
      "Payments, purchasing",
      "Creating, deleting, disabling",
      "Irreversible destruction",
      "security control",
      "Major system changes",
    ]) {
      expect(TECHNICIAN_SYSTEM).toContain(limit);
    }
  });

  it("tells the model the prompt is not the enforcement mechanism", () => {
    // The model is told refusal happens downstream, so it does not waste turns
    // proposing work the control plane will reject.
    expect(TECHNICIAN_SYSTEM).toMatch(/control plane will refuse/i);
  });
});

describe("converting a model proposal into a plan step", () => {
  it("mints its own id rather than trusting the model's", () => {
    const a = toPlanStep({
      kind: "command", intent: "check", command: "ipconfig /all", question: null,
      path: null, caption: null, annotations: null, tests_hypothesis: null,
      mutating: false, rollback: null, rollback_command: null,
    });
    const b = toPlanStep({
      kind: "command", intent: "check", command: "ipconfig /all", question: null,
      path: null, caption: null, annotations: null, tests_hypothesis: null,
      mutating: false, rollback: null, rollback_command: null,
    });
    expect(a.id).not.toBe(b.id);
  });

  it("drops null fields instead of passing them to the executor", () => {
    const step = toPlanStep({
      kind: "command", intent: "check", command: "ipconfig /all", question: null,
      path: null, caption: null, annotations: null, tests_hypothesis: null,
      mutating: false, rollback: null, rollback_command: null,
    });
    expect(step.payload).toEqual({ command: "ipconfig /all" });
    expect(step.rollback).toBeUndefined();
    expect("question" in step.payload).toBe(false);
  });

  it("carries annotations through for screenshot steps", () => {
    const step = toPlanStep({
      kind: "screenshot", intent: "capture", command: null, question: null, path: null,
      caption: "The error",
      annotations: [
        { style: "problem", box: { x: 1, y: 2, width: 3, height: 4 }, label: "here" },
      ],
      tests_hypothesis: null, mutating: false, rollback: null, rollback_command: null,
    });
    expect(step.payload["caption"]).toBe("The error");
    expect((step.payload["annotations"] as unknown[]).length).toBe(1);
  });
});

describe("defensive handling of model output", () => {
  it("clamps an out-of-range hypothesis index instead of indexing nothing", () => {
    expect(clampIndex(9, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(Number.NaN, 3)).toBe(0);
    expect(clampIndex(1, 3)).toBe(1);
    expect(clampIndex(0, 0)).toBe(0);
  });
});
