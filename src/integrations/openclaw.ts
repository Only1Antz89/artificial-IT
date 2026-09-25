/**
 * Governed OpenClaw -> UI-TARS Desktop bridge.
 *
 * This client deliberately does not create desktop authority. A caller may
 * discover the bridge without a run-scoped token, but an action is forwarded
 * only when the caller supplies both a desktop control token and a complete
 * execution context (including its fence and cancellation generation).
 */

export const OPENCLAW_ENV = {
  /** Base URL of the alternative project's curated OpenClaw HTTP gateway. */
  baseUrl: "OPENCLAW_BRIDGE_URL",
  /** Backwards-compatible base URL alias. */
  baseUrlFallback: "OPENCLAW_HTTP_URL",
  /** Preferred shared secret accepted by the curated bridge routes. */
  runtimeToken: "OPENCLAW_BRIDGE_RUNTIME_TOKEN",
  /** OpenClaw gateway-token fallback accepted by the curated routes. */
  gatewayTokenFallback: "OPENCLAW_GATEWAY_TOKEN",
  /** Master-agent runtime-token fallback accepted by the curated routes. */
  masterTokenFallback: "MASTER_AGENT_RUNTIME_SYNC_TOKEN",
  /** Optional request timeout in milliseconds (250-30000, default 5000). */
  timeoutMs: "OPENCLAW_BRIDGE_TIMEOUT_MS",
  /** Optional path dialect: `ait`, `aillium`, or unset to discover it. */
  dialect: "OPENCLAW_BRIDGE_DIALECT",
  /** Demo-only: permit HTTP to a single-label container service name. */
  allowContainerHttp: "OPENCLAW_BRIDGE_ALLOW_CONTAINER_HTTP",
} as const;

/**
 * The two path shapes a governed gateway is served under.
 *
 * `ait` is the boundary this client was written against. `aillium` is what the
 * gateway in the alternative project actually mounts - the bodies are the same,
 * only the prefix differs, so forking the client over it would be silly.
 *
 * Which one a deployment uses is a property of that deployment, not of the
 * protocol, so the client discovers it rather than being told.
 */
export const OPENCLAW_DESKTOP_DIALECTS = {
  ait: {
    capabilities: "/api/desktop/capabilities",
    invokeAction: "/api/desktop/invoke-action",
  },
  aillium: {
    capabilities: "/api/aillium/desktop/capabilities",
    invokeAction: "/api/aillium/desktop/invoke-action",
  },
} as const;

export type OpenClawDialect = keyof typeof OPENCLAW_DESKTOP_DIALECTS;

/** Dialects to try, in order, when none is pinned. */
export const OPENCLAW_DIALECT_ORDER: readonly OpenClawDialect[] = ["ait", "aillium"];

export function isOpenClawDialect(value: unknown): value is OpenClawDialect {
  return value === "ait" || value === "aillium";
}

/** Retained under its original name: the default dialect's paths. */
export const OPENCLAW_DESKTOP_PATHS = OPENCLAW_DESKTOP_DIALECTS.ait;

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 30_000;

export interface OpenClawConfig {
  baseUrl: string;
  runtimeToken: string;
  timeoutMs?: number;
  /** Demo-only allowance for a single-label service on a private container network. */
  allowContainerHttp?: boolean;
  /**
   * Pin the gateway's path dialect. Left unset, the client discovers it with a
   * read-only capabilities probe and then holds it for the rest of its life.
   */
  dialect?: OpenClawDialect;
}

export type OpenClawConfigurationStatus =
  | {
      state: "unconfigured";
      missing: Array<"baseUrl" | "runtimeToken">;
    }
  | {
      state: "configured";
      config: OpenClawConfig;
      missing: [];
    };

export type DesktopSurface =
  | "remote_browser"
  | "local_browser"
  | "local_computer";

export type DesktopCapabilityCategory =
  | "screen"
  | "browser"
  | "input"
  | "computer"
  | "agent"
  | "remote_resource";

export interface DesktopCapability {
  action: string;
  surface: DesktopSurface;
  category: DesktopCapabilityCategory;
  description: string;
}

export interface DesktopCapabilities {
  available: boolean;
  rpcReady: boolean;
  provider: string;
  launchUrl: string | null;
  surfaces: DesktopSurface[];
  operators: string[];
  capabilities: DesktopCapability[];
  note: string;
}

export interface DesktopExecutionContext {
  tenantId: string;
  authorityType: "user" | "agent";
  authorityId: string;
  workOrderId: string;
  runId: string;
  runStepId: string;
  desktopSessionId: string;
  attempt: number;
  executorId: string;
  /** Unsigned decimal lease/fence token. */
  fenceToken: string;
  cancellationGeneration: number;
}

export interface InvokeDesktopActionInput {
  tenantId: string;
  sessionId: string;
  sessionKey: string;
  action: string;
  requestedSurface?: DesktopSurface;
  arguments?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Run-scoped authority issued upstream. This client never creates it. */
  desktopControlToken: string;
  executionContext: DesktopExecutionContext;
}

export type OpenClawIntegrationReadiness =
  | {
      state: "unconfigured";
      gatewayReachable: false;
      desktopRpcReady: false;
      missing: Array<"baseUrl" | "runtimeToken">;
      message: string;
    }
  | {
      state: "configured";
      gatewayReachable: boolean;
      desktopRpcReady: false;
      missing: [];
      message: string;
      capabilities?: DesktopCapabilities;
    }
  | {
      state: "live";
      gatewayReachable: true;
      desktopRpcReady: true;
      missing: [];
      message: string;
      capabilities: DesktopCapabilities;
    };

export type OpenClawErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_AUTHORITY"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE";

/** Error messages intentionally exclude response bodies, URLs and secrets. */
export class OpenClawIntegrationError extends Error {
  constructor(
    message: string,
    readonly code: OpenClawErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenClawIntegrationError";
  }
}

interface ClientOptions {
  fetchImpl?: typeof fetch;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;

  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    octets[0] === "127"
  );
}

function normaliseBaseUrl(raw: string, allowContainerHttp = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpenClawIntegrationError(
      "OpenClaw base URL is invalid",
      "INVALID_CONFIG",
    );
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new OpenClawIntegrationError(
      "OpenClaw base URL must not contain credentials, a query, or a fragment",
      "INVALID_CONFIG",
    );
  }

  const containerHttp =
    allowContainerHttp &&
    url.protocol === "http:" &&
    /^[a-z0-9](?:[a-z0-9-]{0,62})$/i.test(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname)) &&
    !containerHttp
  ) {
    throw new OpenClawIntegrationError(
      "OpenClaw requires HTTPS except on a loopback host",
      "INVALID_CONFIG",
    );
  }

  return url.toString().replace(/\/+$/, "");
}

function parseTimeout(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    throw new OpenClawIntegrationError(
      `OpenClaw timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} milliseconds`,
      "INVALID_CONFIG",
    );
  }
  return timeout;
}

/**
 * Resolve configuration without guessing credentials. Token precedence mirrors
 * the curated gateway's accepted runtime-secret order.
 */
export function inspectOpenClawConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfigurationStatus {
  const baseUrl = env[OPENCLAW_ENV.baseUrl]?.trim()
    || env[OPENCLAW_ENV.baseUrlFallback]?.trim();
  const runtimeToken = env[OPENCLAW_ENV.runtimeToken]?.trim()
    || env[OPENCLAW_ENV.gatewayTokenFallback]?.trim()
    || env[OPENCLAW_ENV.masterTokenFallback]?.trim();
  const missing: Array<"baseUrl" | "runtimeToken"> = [];
  if (!baseUrl) missing.push("baseUrl");
  if (!runtimeToken) missing.push("runtimeToken");
  if (missing.length > 0) return { state: "unconfigured", missing };

  // An unrecognised dialect is left unset rather than rejected: discovery will
  // find the right one, and a typo in an optional hint should not take the
  // whole integration offline.
  const dialectHint = env[OPENCLAW_ENV.dialect]?.trim().toLowerCase();
  const allowContainerHttp = env[OPENCLAW_ENV.allowContainerHttp]?.trim() === "1";

  return {
    state: "configured",
    config: {
      baseUrl: normaliseBaseUrl(baseUrl!, allowContainerHttp),
      runtimeToken: runtimeToken!,
      timeoutMs: parseTimeout(env[OPENCLAW_ENV.timeoutMs]),
      ...(allowContainerHttp ? { allowContainerHttp: true } : {}),
      ...(isOpenClawDialect(dialectHint) ? { dialect: dialectHint } : {}),
    },
    missing: [],
  };
}

export function openClawConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig | undefined {
  const status = inspectOpenClawConfiguration(env);
  return status.state === "configured" ? status.config : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isDesktopSurface(value: unknown): value is DesktopSurface {
  return value === "remote_browser"
    || value === "local_browser"
    || value === "local_computer";
}

function isCapabilityCategory(value: unknown): value is DesktopCapabilityCategory {
  return value === "screen"
    || value === "browser"
    || value === "input"
    || value === "computer"
    || value === "agent"
    || value === "remote_resource";
}

function parseCapabilities(value: unknown): DesktopCapabilities {
  const record = asRecord(value);
  if (!record || typeof record.available !== "boolean" || typeof record.rpcReady !== "boolean") {
    throw new OpenClawIntegrationError(
      "OpenClaw returned an invalid capabilities response",
      "INVALID_RESPONSE",
    );
  }

  const declaredSurfaces = Array.isArray(record.surfaces)
    ? record.surfaces.filter(isDesktopSurface)
    : [];
  // The gateway reports `operators`; the desktop bridge underneath it reports
  // the single `activeOperator` it is currently set to. Both are the same fact
  // at different altitudes, and a technician wants to see it either way.
  const operators = Array.isArray(record.operators)
    ? record.operators.filter((item): item is string => typeof item === "string")
    : nonBlank(record.activeOperator)
      ? [record.activeOperator]
      : [];
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.flatMap((item): DesktopCapability[] => {
        const candidate = asRecord(item);
        if (
          !candidate
          || !nonBlank(candidate.action)
          || !isDesktopSurface(candidate.surface)
          || !isCapabilityCategory(candidate.category)
          || !nonBlank(candidate.description)
        ) return [];
        return [{
          action: candidate.action,
          surface: candidate.surface,
          category: candidate.category,
          description: candidate.description,
        }];
      })
    : [];

  // A bridge that lists its capabilities has told you its surfaces whether or
  // not it also named them, so derive rather than report none.
  const surfaces = declaredSurfaces.length > 0
    ? declaredSurfaces
    : [...new Set(capabilities.map((item) => item.surface))];

  return {
    available: record.available,
    rpcReady: record.rpcReady,
    provider: nonBlank(record.provider) ? record.provider : "unknown",
    launchUrl: typeof record.launchUrl === "string" ? record.launchUrl : null,
    surfaces,
    operators,
    capabilities,
    note: typeof record.note === "string" ? record.note : "",
  };
}

function requireNonBlank(value: unknown, field: string): asserts value is string {
  if (!nonBlank(value)) {
    throw new OpenClawIntegrationError(
      `Desktop authority is incomplete (${field})`,
      "INVALID_AUTHORITY",
    );
  }
}

function validateActionAuthority(input: InvokeDesktopActionInput): void {
  if (!input || typeof input !== "object") {
    throw new OpenClawIntegrationError(
      "Desktop authority is incomplete (request)",
      "INVALID_AUTHORITY",
    );
  }

  requireNonBlank(input.desktopControlToken, "desktopControlToken");
  requireNonBlank(input.tenantId, "tenantId");
  requireNonBlank(input.sessionId, "sessionId");
  requireNonBlank(input.sessionKey, "sessionKey");
  requireNonBlank(input.action, "action");
  if (input.requestedSurface !== undefined && !isDesktopSurface(input.requestedSurface)) {
    throw new OpenClawIntegrationError(
      "Desktop action has an invalid requested surface",
      "INVALID_AUTHORITY",
    );
  }
  if (input.arguments !== undefined && !asRecord(input.arguments)) {
    throw new OpenClawIntegrationError(
      "Desktop action arguments must be an object",
      "INVALID_AUTHORITY",
    );
  }
  if (input.metadata !== undefined && !asRecord(input.metadata)) {
    throw new OpenClawIntegrationError(
      "Desktop action metadata must be an object",
      "INVALID_AUTHORITY",
    );
  }

  const context = input.executionContext;
  if (!context || typeof context !== "object") {
    throw new OpenClawIntegrationError(
      "Desktop authority is incomplete (executionContext)",
      "INVALID_AUTHORITY",
    );
  }
  requireNonBlank(context.tenantId, "executionContext.tenantId");
  requireNonBlank(context.authorityId, "executionContext.authorityId");
  requireNonBlank(context.workOrderId, "executionContext.workOrderId");
  requireNonBlank(context.runId, "executionContext.runId");
  requireNonBlank(context.runStepId, "executionContext.runStepId");
  requireNonBlank(context.desktopSessionId, "executionContext.desktopSessionId");
  requireNonBlank(context.executorId, "executionContext.executorId");
  requireNonBlank(context.fenceToken, "executionContext.fenceToken");

  if (context.authorityType !== "user" && context.authorityType !== "agent") {
    throw new OpenClawIntegrationError(
      "Desktop authority is incomplete (executionContext.authorityType)",
      "INVALID_AUTHORITY",
    );
  }
  if (!Number.isInteger(context.attempt) || context.attempt < 1) {
    throw new OpenClawIntegrationError(
      "Desktop authority is incomplete (executionContext.attempt)",
      "INVALID_AUTHORITY",
    );
  }
  if (!/^\d+$/.test(context.fenceToken)) {
    throw new OpenClawIntegrationError(
      "Desktop authority is incomplete (executionContext.fenceToken)",
      "INVALID_AUTHORITY",
    );
  }
  if (!Number.isInteger(context.cancellationGeneration) || context.cancellationGeneration < 0) {
    throw new OpenClawIntegrationError(
      "Desktop authority is incomplete (executionContext.cancellationGeneration)",
      "INVALID_AUTHORITY",
    );
  }
  if (input.tenantId !== context.tenantId) {
    throw new OpenClawIntegrationError(
      "Desktop authority tenant does not match the execution context",
      "INVALID_AUTHORITY",
    );
  }
  if (input.sessionId !== context.desktopSessionId) {
    throw new OpenClawIntegrationError(
      "Desktop session does not match the execution context",
      "INVALID_AUTHORITY",
    );
  }
}

export class OpenClawDesktopClient {
  readonly #baseUrl: string;
  readonly #runtimeToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  /**
   * The dialect this gateway answers on, once known.
   *
   * Discovery is deliberately confined to `capabilities`, which is read-only
   * and idempotent. An action is never replayed against a second path: a
   * gateway that accepted the request and then failed downstream may well have
   * already moved the user's mouse, and "try the other URL" would move it
   * twice. So `invokeAction` resolves the dialect first, with a probe, and only
   * then posts - once.
   */
  #dialect: OpenClawDialect | undefined;

  constructor(config: OpenClawConfig, options: ClientOptions = {}) {
    if (!nonBlank(config.runtimeToken)) {
      throw new OpenClawIntegrationError(
        "OpenClaw runtime token is required",
        "INVALID_CONFIG",
      );
    }
    this.#baseUrl = normaliseBaseUrl(config.baseUrl, config.allowContainerHttp === true);
    this.#runtimeToken = config.runtimeToken.trim();
    this.#timeoutMs = config.timeoutMs === undefined
      ? DEFAULT_TIMEOUT_MS
      : parseTimeout(String(config.timeoutMs));
    this.#fetch = options.fetchImpl ?? fetch;
    this.#dialect = config.dialect;
  }

  /** The dialect in use, or undefined until one has been discovered. */
  get dialect(): OpenClawDialect | undefined {
    return this.#dialect;
  }

  async #post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#runtimeToken}`,
        },
        body: JSON.stringify(body),
        signal: timeoutSignal,
      });
    } catch {
      if (timeoutSignal.aborted) {
        throw new OpenClawIntegrationError(
          "OpenClaw request timed out",
          "TIMEOUT",
        );
      }
      throw new OpenClawIntegrationError(
        "OpenClaw request could not be completed",
        "NETWORK_ERROR",
      );
    }

    if (!response.ok) {
      // Do not include an untrusted response body: upstream errors have been
      // observed to echo request fields, which can include scoped credentials.
      throw new OpenClawIntegrationError(
        `OpenClaw request failed with HTTP ${response.status}`,
        "HTTP_ERROR",
        response.status,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new OpenClawIntegrationError(
        "OpenClaw returned an invalid JSON response",
        "INVALID_RESPONSE",
      );
    }
  }

  async capabilities(includeRuntimeHints = false): Promise<DesktopCapabilities> {
    const body = { includeRuntimeHints };

    if (this.#dialect) {
      return parseCapabilities(
        await this.#post(OPENCLAW_DESKTOP_DIALECTS[this.#dialect].capabilities, body),
      );
    }

    // Discovery. Only a 404 means "wrong path here" - a 401 is a bad token on
    // the right gateway and a 5xx is a gateway in trouble, and trying the other
    // prefix would turn either into a misleading "not configured".
    let lastError: unknown;
    for (const dialect of OPENCLAW_DIALECT_ORDER) {
      try {
        const parsed = parseCapabilities(
          await this.#post(OPENCLAW_DESKTOP_DIALECTS[dialect].capabilities, body),
        );
        this.#dialect = dialect;
        return parsed;
      } catch (err) {
        lastError = err;
        const notFound =
          err instanceof OpenClawIntegrationError && err.status === 404;
        if (!notFound) throw err;
      }
    }
    throw lastError;
  }

  async invokeAction(input: InvokeDesktopActionInput): Promise<Record<string, unknown>> {
    validateActionAuthority(input);
    // Build an allow-listed payload rather than spreading an object supplied by
    // the caller. This prevents accidental forwarding of ambient credentials or
    // unrelated authority fields added by an upstream request handler.
    const context = input.executionContext;
    const payload: Record<string, unknown> = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      action: input.action,
      desktopControlToken: input.desktopControlToken,
      executionContext: {
        tenantId: context.tenantId,
        authorityType: context.authorityType,
        authorityId: context.authorityId,
        workOrderId: context.workOrderId,
        runId: context.runId,
        runStepId: context.runStepId,
        desktopSessionId: context.desktopSessionId,
        attempt: context.attempt,
        executorId: context.executorId,
        fenceToken: context.fenceToken,
        cancellationGeneration: context.cancellationGeneration,
      },
      ...(input.requestedSurface ? { requestedSurface: input.requestedSurface } : {}),
      ...(input.arguments ? { arguments: input.arguments } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    // Resolve the dialect before acting, never by retrying the action itself.
    if (!this.#dialect) await this.capabilities();
    const paths = OPENCLAW_DESKTOP_DIALECTS[this.#dialect ?? "ait"];
    const result = await this.#post(paths.invokeAction, payload);
    const record = asRecord(result);
    if (!record) {
      throw new OpenClawIntegrationError(
        "OpenClaw returned an invalid action response",
        "INVALID_RESPONSE",
      );
    }
    return record;
  }
}

/**
 * A live state means both the curated gateway and its governed UI-TARS RPC
 * bridge answered. Merely having environment variables is only configured.
 */
export async function probeOpenClawIntegration(
  env: NodeJS.ProcessEnv = process.env,
  options: ClientOptions = {},
): Promise<OpenClawIntegrationReadiness> {
  let configuration: OpenClawConfigurationStatus;
  try {
    configuration = inspectOpenClawConfiguration(env);
  } catch (error) {
    const message = error instanceof OpenClawIntegrationError
      ? error.message
      : "OpenClaw configuration is invalid";
    return {
      state: "configured",
      gatewayReachable: false,
      desktopRpcReady: false,
      missing: [],
      message,
    };
  }

  if (configuration.state === "unconfigured") {
    return {
      state: "unconfigured",
      gatewayReachable: false,
      desktopRpcReady: false,
      missing: configuration.missing,
      message: `OpenClaw is missing ${configuration.missing.join(" and ")}`,
    };
  }

  try {
    const capabilities = await new OpenClawDesktopClient(
      configuration.config,
      options,
    ).capabilities();
    if (capabilities.available && capabilities.rpcReady) {
      return {
        state: "live",
        gatewayReachable: true,
        desktopRpcReady: true,
        missing: [],
        message: "OpenClaw and the governed UI-TARS Desktop RPC bridge are ready",
        capabilities,
      };
    }
    return {
      state: "configured",
      gatewayReachable: true,
      desktopRpcReady: false,
      missing: [],
      message: "OpenClaw is reachable, but UI-TARS Desktop RPC is not ready",
      capabilities,
    };
  } catch (error) {
    return {
      state: "configured",
      gatewayReachable: false,
      desktopRpcReady: false,
      missing: [],
      message: error instanceof OpenClawIntegrationError
        ? error.message
        : "OpenClaw readiness probe failed",
    };
  }
}
