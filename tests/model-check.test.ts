/**
 * Model verification tests.
 *
 * The behaviour being pinned down: a wrong model id must fail loudly at startup
 * naming what would work, and an *inconclusive* check must not block a run that
 * would otherwise succeed. Those two pull in opposite directions, which is why
 * they are worth testing rather than assuming.
 */
import { describe, expect, it } from "vitest";
import { checkClaudeModel, checkOpenAIModel, withTimeout } from "../src/agent/model-check.js";

/** Minimal stand-ins shaped like the bits of each SDK the check touches. */
function anthropicStub(ids: string[] | Error) {
  return {
    models: {
      list: () => {
        if (ids instanceof Error) throw ids;
        return {
          async *[Symbol.asyncIterator]() {
            for (const id of ids) yield { id };
          },
        };
      },
    },
  } as never;
}

function openaiStub(ids: string[] | Error) {
  return {
    models: {
      list: async () => {
        if (ids instanceof Error) throw ids;
        return { data: ids.map((id) => ({ id })) };
      },
    },
  } as never;
}

describe("Anthropic model verification", () => {
  it("passes a model the account actually has", async () => {
    const check = await checkClaudeModel("claude-opus-5", anthropicStub(["claude-opus-5"]));
    expect(check.ok).toBe(true);
    expect(check.skipped).toBeUndefined();
  });

  it("fails a model it does not have, and names ones it does", async () => {
    const check = await checkClaudeModel(
      "claude-opus-9",
      anthropicStub(["claude-opus-5", "claude-sonnet-5"]),
    );
    expect(check.ok).toBe(false);
    expect(check.available).toContain("claude-opus-5");
    expect(check.message).toContain("claude-opus-5");
    expect(check.message).toMatch(/ANTHROPIC_MODEL/);
  });

  it("does not block a run when the list call is unavailable", async () => {
    // Listing models can be restricted by workspace policy even where
    // inference is allowed - that is not a reason to refuse to work.
    const check = await checkClaudeModel(
      "claude-opus-5",
      anthropicStub(new Error("403 forbidden")),
    );
    expect(check.ok).toBe(true);
    expect(check.skipped).toContain("403");
  });

  it("does not block when the list comes back empty", async () => {
    const check = await checkClaudeModel("claude-opus-5", anthropicStub([]));
    expect(check.ok).toBe(true);
    expect(check.skipped).toBeTruthy();
  });
});

describe("OpenAI model verification", () => {
  it("passes a model the account actually has", async () => {
    const check = await checkOpenAIModel("gpt-5", openaiStub(["gpt-5", "gpt-5-mini"]));
    expect(check.ok).toBe(true);
  });

  it("suggests reasoning models rather than the whole catalogue", async () => {
    const check = await checkOpenAIModel(
      "gpt-nope",
      openaiStub([
        "gpt-5",
        "o3",
        "whisper-1",
        "tts-1",
        "text-embedding-3-large",
        "gpt-4o-realtime-preview",
        "dall-e-3",
      ]),
    );
    expect(check.ok).toBe(false);
    expect(check.available).toEqual(["gpt-5", "o3"]);
    // Audio, image and embedding models are not useful suggestions here.
    expect(check.available).not.toContain("whisper-1");
    expect(check.available).not.toContain("gpt-4o-realtime-preview");
  });

  it("does not block a run when the list call fails", async () => {
    const check = await checkOpenAIModel("gpt-5", openaiStub(new Error("network down")));
    expect(check.ok).toBe(true);
    expect(check.skipped).toContain("network down");
  });
});

describe("timeout guard", () => {
  it("returns the fallback rather than hanging the run", async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, "fallback", 20)).resolves.toBe("fallback");
  });

  it("returns the real answer when it arrives in time", async () => {
    await expect(withTimeout(Promise.resolve("real"), "fallback", 1_000)).resolves.toBe("real");
  });
});
