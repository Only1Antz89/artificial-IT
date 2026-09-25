import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectBrain } from "../src/agent/select-brain.js";
import {
  applyRuntimeSettings,
  runtimeSettings,
} from "../src/server/runtime-settings.js";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_MODEL", "");
  vi.stubEnv("OPENAI_MODEL", "");
  vi.stubEnv("GEMINI_MODEL", "");
  vi.stubEnv("AIT_PROVIDER", "offline");
});

afterEach(() => {
  applyRuntimeSettings({
    preferredProvider: "offline",
    claude: { clearKey: true, model: "" },
    openai: { clearKey: true, model: "" },
    gemini: { clearKey: true, model: "" },
  });
  vi.unstubAllEnvs();
});

describe("runtime reasoning settings", () => {
  it("applies a key to future runs without returning it", () => {
    const secret = "sk-test-secret-value";
    const settings = applyRuntimeSettings({
      preferredProvider: "openai",
      openai: { apiKey: secret, model: "gpt-test" },
    });

    expect(settings.preferredProvider).toBe("openai");
    expect(settings.providers.openai).toEqual({
      configured: true,
      source: "runtime",
      model: "gpt-test",
    });
    expect(JSON.stringify(settings)).not.toContain(secret);
    expect(selectBrain().provider).toBe("openai");
  });

  it("does not mutate configuration when validation fails", () => {
    const before = runtimeSettings();
    expect(() =>
      applyRuntimeSettings({
        preferredProvider: "openai",
        claude: { apiKey: "sk-ant-would-have-been-applied" },
      }),
    ).toThrow(/OpenAI API key/);
    expect(runtimeSettings()).toEqual(before);
  });

  it("removes a runtime key explicitly", () => {
    applyRuntimeSettings({
      preferredProvider: "claude",
      claude: { apiKey: "sk-ant-test-value" },
    });
    const settings = applyRuntimeSettings({
      preferredProvider: "offline",
      claude: { clearKey: true },
    });
    expect(settings.providers.claude.configured).toBe(false);
    expect(settings.preferredProvider).toBe("offline");
  });

  it("supports a write-only Gemini key and model", () => {
    const secret = "gemini-test-secret-value";
    const settings = applyRuntimeSettings({
      preferredProvider: "gemini",
      gemini: { apiKey: secret, model: "gemini-2.5-flash" },
    });
    expect(settings.providers.gemini).toEqual({
      configured: true,
      source: "runtime",
      model: "gemini-2.5-flash",
    });
    expect(JSON.stringify(settings)).not.toContain(secret);
    expect(selectBrain().provider).toBe("gemini");
  });
});
