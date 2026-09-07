/**
 * Choosing a brain.
 *
 * Three providers, one interface. The choice is a deployment decision, not a
 * code change:
 *
 *   AIT_PROVIDER=claude     Anthropic API      (ANTHROPIC_API_KEY)
 *   AIT_PROVIDER=openai     OpenAI API         (OPENAI_API_KEY)
 *   AIT_PROVIDER=offline    deterministic playbooks, no network
 *   AIT_PROVIDER=auto       (default) first configured of the above
 *
 * `auto` falling back to `offline` is what makes `npm run demo` work on a
 * machine with no credentials. It is reported loudly rather than silently -
 * a run answered by the playbook engine is a materially different thing from a
 * run answered by a frontier model, and the operator should never have to guess
 * which one they got.
 */
import type { Brain } from "./brain.js";
import { checkClaudeModel, checkOpenAIModel, withTimeout, type ModelCheck } from "./model-check.js";
import { ClaudeBrain, claudeAvailable, DEFAULT_CLAUDE_MODEL } from "./claude-brain.js";
import { HeuristicBrain } from "./heuristic-brain.js";
import { DEFAULT_OPENAI_MODEL, OpenAIBrain, openaiAvailable } from "./openai-brain.js";

export type ProviderName = "claude" | "openai" | "offline" | "auto";

export interface BrainSelection {
  brain: Brain;
  provider: Exclude<ProviderName, "auto">;
  model: string;
  /** Human-readable note explaining why this provider was chosen. */
  note: string;
}

/**
 * Pick a provider *and* confirm its model exists.
 *
 * Separate from `selectBrain` because it does network I/O: the synchronous
 * version stays usable in tests and in paths that must not block. Call this one
 * at startup, where a wrong model name is cheap to report and expensive to
 * discover later.
 */
export async function selectBrainChecked(
  requested?: ProviderName,
): Promise<BrainSelection & { modelCheck?: ModelCheck }> {
  const selection = selectBrain(requested);
  if (selection.provider === "offline") return selection;

  const check = await withTimeout(
    selection.provider === "claude"
      ? checkClaudeModel(selection.model)
      : checkOpenAIModel(selection.model),
    {
      ok: true,
      model: selection.model,
      skipped: "the model list did not respond in time",
      message: `Model verification timed out; proceeding with "${selection.model}".`,
    },
  );

  if (!check.ok) {
    // A wrong model id is a configuration error, and it is far better to say so
    // here - naming the ids that would work - than to fail inside a ticket.
    throw new Error(check.message);
  }

  return {
    ...selection,
    modelCheck: check,
    note: check.skipped ? `${selection.note} (${check.message})` : selection.note,
  };
}

export function selectBrain(requested?: ProviderName): BrainSelection {
  const provider =
    requested ?? ((process.env["AIT_PROVIDER"] as ProviderName | undefined) ?? "auto");

  switch (provider) {
    case "claude":
      if (!claudeAvailable()) {
        throw new Error(
          "AIT_PROVIDER=claude but no ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is set.",
        );
      }
      return claude("selected explicitly");

    case "openai":
      if (!openaiAvailable()) {
        throw new Error("AIT_PROVIDER=openai but no OPENAI_API_KEY is set.");
      }
      return openai("selected explicitly");

    case "offline":
      return offline("selected explicitly");

    case "auto":
      if (claudeAvailable()) return claude("auto-selected: ANTHROPIC_API_KEY present");
      if (openaiAvailable()) return openai("auto-selected: OPENAI_API_KEY present");
      return offline(
        "auto-selected: no ANTHROPIC_API_KEY or OPENAI_API_KEY found, so reasoning is served by the deterministic playbook engine",
      );

    default:
      throw new Error(`Unknown provider "${provider}".`);
  }
}

function claude(note: string): BrainSelection {
  return {
    brain: new ClaudeBrain(),
    provider: "claude",
    model: process.env["ANTHROPIC_MODEL"] ?? DEFAULT_CLAUDE_MODEL,
    note,
  };
}

function openai(note: string): BrainSelection {
  return {
    brain: new OpenAIBrain(),
    provider: "openai",
    model: process.env["OPENAI_MODEL"] ?? DEFAULT_OPENAI_MODEL,
    note,
  };
}

function offline(note: string): BrainSelection {
  return {
    brain: new HeuristicBrain(),
    provider: "offline",
    model: "playbooks",
    note,
  };
}
