/**
 * Checking that the configured model actually exists.
 *
 * Model names move faster than any codebase does. A hardcoded default that has
 * been renamed or retired fails at the worst possible moment - mid-ticket, as an
 * opaque 404 from inside a structured-output call - and the operator has no way
 * to know which names would have worked.
 *
 * So AIT asks. Both providers expose a models endpoint; this verifies the
 * configured id against it once at startup and, when it is wrong, says what is
 * available instead of guessing a replacement. Guessing is what got us here.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export interface ModelCheck {
  ok: boolean;
  model: string;
  /** Set when the check could not be performed at all (offline, no key). */
  skipped?: string;
  /** Model ids the provider reports, when the configured one was not found. */
  available?: string[];
  message: string;
}

const LIST_TIMEOUT_MS = 15_000;

/**
 * Verify a Claude model id.
 *
 * A miss is not fatal on its own - the list endpoint can be restricted by
 * workspace policy even when inference is permitted - so an inconclusive check
 * reports `skipped` rather than blocking a run that would have worked.
 */
export async function checkClaudeModel(
  model: string,
  client = new Anthropic(),
): Promise<ModelCheck> {
  try {
    const ids: string[] = [];
    for await (const entry of client.models.list()) ids.push(entry.id);

    if (ids.length === 0) {
      return {
        ok: true,
        model,
        skipped: "the models endpoint returned nothing",
        message: `Could not list Anthropic models; proceeding with "${model}".`,
      };
    }
    if (ids.includes(model)) {
      return { ok: true, model, message: `Anthropic model "${model}" is available.` };
    }
    return {
      ok: false,
      model,
      available: ids,
      message:
        `Anthropic model "${model}" was not found on this account. ` +
        `Available: ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", …" : ""}. ` +
        `Set ANTHROPIC_MODEL to one of these.`,
    };
  } catch (err) {
    return skipped(model, "Anthropic", err);
  }
}

/** Verify an OpenAI model id. Same posture: inconclusive is not a failure. */
export async function checkOpenAIModel(
  model: string,
  client = new OpenAI(),
): Promise<ModelCheck> {
  try {
    const response = await client.models.list();
    const ids = response.data.map((m) => m.id);

    if (ids.length === 0) {
      return {
        ok: true,
        model,
        skipped: "the models endpoint returned nothing",
        message: `Could not list OpenAI models; proceeding with "${model}".`,
      };
    }
    if (ids.includes(model)) {
      return { ok: true, model, message: `OpenAI model "${model}" is available.` };
    }

    // Surface the plausible alternatives first: a reasoning-capable list is
    // more useful than the first eight ids alphabetically.
    const likely = ids
      .filter((id) => /^(gpt|o\d)/.test(id) && !/(audio|realtime|image|tts|whisper|embed)/.test(id))
      .sort();
    return {
      ok: false,
      model,
      available: likely.length > 0 ? likely : ids,
      message:
        `OpenAI model "${model}" was not found on this account. ` +
        `Available: ${(likely.length > 0 ? likely : ids).slice(0, 8).join(", ")}${ids.length > 8 ? ", …" : ""}. ` +
        `Set OPENAI_MODEL to one of these.`,
    };
  } catch (err) {
    return skipped(model, "OpenAI", err);
  }
}

function skipped(model: string, provider: string, err: unknown): ModelCheck {
  const reason = err instanceof Error ? err.message : String(err);
  return {
    ok: true,
    model,
    skipped: reason,
    message: `Could not verify the ${provider} model list (${reason}); proceeding with "${model}".`,
  };
}

/**
 * Guard against a hung list call holding up a run.
 *
 * The timer is cleared whichever side wins. `Promise.race` settles the race but
 * does not cancel the loser, so an uncleared timer keeps the Node event loop
 * alive for its full duration - which turned a CLI that had finished its work
 * in 200ms into one that sat silent for another ten seconds.
 */
export function withTimeout<T>(promise: Promise<T>, fallback: T, ms = LIST_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
