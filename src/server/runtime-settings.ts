import {
  DEFAULT_CLAUDE_MODEL,
} from "../agent/claude-brain.js";
import {
  DEFAULT_OPENAI_MODEL,
} from "../agent/openai-brain.js";
import { DEFAULT_GEMINI_MODEL } from "../agent/gemini-brain.js";
import type { ProviderName } from "../agent/select-brain.js";

type ConfigurableProvider = "claude" | "openai" | "gemini";
type SecretSource = "environment" | "runtime" | "none";

export interface ProviderSettingsInput {
  apiKey?: string;
  clearKey?: boolean;
  model?: string;
}

export interface RuntimeSettingsInput {
  preferredProvider?: ProviderName;
  claude?: ProviderSettingsInput;
  openai?: ProviderSettingsInput;
  gemini?: ProviderSettingsInput;
}

export interface RuntimeSettingsView {
  preferredProvider: ProviderName;
  restartRequired: false;
  persistence: "runtime-only";
  providers: Record<
    ConfigurableProvider,
    { configured: boolean; source: SecretSource; model: string }
  >;
}

const providerNames = new Set<ProviderName>(["auto", "claude", "openai", "gemini", "offline"]);
const runtimeSecrets = new Set<ConfigurableProvider>();

const providerEnv: Record<
  ConfigurableProvider,
  { key: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GEMINI_API_KEY"; model: "ANTHROPIC_MODEL" | "OPENAI_MODEL" | "GEMINI_MODEL"; fallback: string }
> = {
  claude: {
    key: "ANTHROPIC_API_KEY",
    model: "ANTHROPIC_MODEL",
    fallback: DEFAULT_CLAUDE_MODEL,
  },
  openai: {
    key: "OPENAI_API_KEY",
    model: "OPENAI_MODEL",
    fallback: DEFAULT_OPENAI_MODEL,
  },
  gemini: {
    key: "GEMINI_API_KEY",
    model: "GEMINI_MODEL",
    fallback: DEFAULT_GEMINI_MODEL,
  },
};

function preferredProvider(): ProviderName {
  const configured = process.env["AIT_PROVIDER"] as ProviderName | undefined;
  return configured && providerNames.has(configured) ? configured : "auto";
}

function providerView(provider: ConfigurableProvider) {
  const names = providerEnv[provider];
  const configured = Boolean(process.env[names.key]?.trim());
  return {
    configured,
    source: configured
      ? runtimeSecrets.has(provider)
        ? ("runtime" as const)
        : ("environment" as const)
      : ("none" as const),
    model: process.env[names.model]?.trim() || names.fallback,
  };
}

/** A deliberately secret-free view safe to return to the technician browser. */
export function runtimeSettings(): RuntimeSettingsView {
  return {
    preferredProvider: preferredProvider(),
    restartRequired: false,
    persistence: "runtime-only",
    providers: {
      claude: providerView("claude"),
      openai: providerView("openai"),
      gemini: providerView("gemini"),
    },
  };
}

function validateSecret(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const secret = value.trim();
  if (secret.length < 8 || secret.length > 512 || /\s/.test(secret)) {
    throw new Error(`${label} must be between 8 and 512 characters with no spaces.`);
  }
  return secret;
}

function validateModel(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const model = value.trim();
  if (!model) return "";
  if (model.length > 128 || !/^[a-zA-Z0-9._:/-]+$/.test(model)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return model;
}

interface NormalizedProviderInput {
  apiKey?: string;
  clearKey: boolean;
  model?: string;
}

function normalizeProvider(
  provider: ConfigurableProvider,
  input?: ProviderSettingsInput,
): NormalizedProviderInput | undefined {
  if (!input) return undefined;
  if (input.clearKey && input.apiKey?.trim()) {
    throw new Error(`Choose either a new ${provider} key or remove the existing key, not both.`);
  }
  const apiKey = validateSecret(input.apiKey, `${provider} API key`);
  const model = validateModel(input.model, `${provider} model`);
  return {
    clearKey: input.clearKey === true,
    ...(apiKey ? { apiKey } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

function applyProvider(
  provider: ConfigurableProvider,
  input?: NormalizedProviderInput,
): void {
  if (!input) return;
  const names = providerEnv[provider];

  if (input.clearKey) {
    delete process.env[names.key];
    runtimeSecrets.delete(provider);
  } else {
    if (input.apiKey) {
      process.env[names.key] = input.apiKey;
      runtimeSecrets.add(provider);
    }
  }

  if (input.model === "") delete process.env[names.model];
  else if (input.model) process.env[names.model] = input.model;
}

/** Apply settings to future runs without persisting credentials to disk. */
export function applyRuntimeSettings(input: RuntimeSettingsInput): RuntimeSettingsView {
  if (!input || typeof input !== "object") throw new Error("Settings are required.");
  const requested = input.preferredProvider;
  if (requested !== undefined && !providerNames.has(requested)) {
    throw new Error(`Unknown provider "${String(requested)}".`);
  }

  const claude = normalizeProvider("claude", input.claude);
  const openai = normalizeProvider("openai", input.openai);
  const gemini = normalizeProvider("gemini", input.gemini);
  const willHaveClaude = claude?.clearKey
    ? false
    : Boolean(claude?.apiKey || process.env[providerEnv.claude.key]?.trim());
  const willHaveOpenAI = openai?.clearKey
    ? false
    : Boolean(openai?.apiKey || process.env[providerEnv.openai.key]?.trim());
  const willHaveGemini = gemini?.clearKey
    ? false
    : Boolean(gemini?.apiKey || process.env[providerEnv.gemini.key]?.trim());

  if (requested === "claude" && !willHaveClaude) {
    throw new Error("Add an Anthropic API key before making Claude the preferred provider.");
  }
  if (requested === "openai" && !willHaveOpenAI) {
    throw new Error("Add an OpenAI API key before making OpenAI the preferred provider.");
  }
  if (requested === "gemini" && !willHaveGemini) {
    throw new Error("Add a Gemini API key before making Gemini the preferred provider.");
  }

  applyProvider("claude", claude);
  applyProvider("openai", openai);
  applyProvider("gemini", gemini);
  if (requested) process.env["AIT_PROVIDER"] = requested;

  return runtimeSettings();
}
