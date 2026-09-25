import { describe, expect, it, vi } from "vitest";
import {
  inspectOpenClawConfiguration,
  openClawConfigFromEnv,
  OpenClawDesktopClient,
  OpenClawIntegrationError,
  probeOpenClawIntegration,
  type InvokeDesktopActionInput,
} from "../src/integrations/openclaw.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function capabilityPayload(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    rpcReady: true,
    launchUrl: "http://localhost:3000",
    provider: "ui-tars-desktop",
    surfaces: ["remote_browser", "local_browser", "local_computer"],
    operators: ["Local Computer Operator"],
    capabilities: [{
      action: "mouse.click",
      surface: "local_computer",
      category: "input",
      description: "Click a point on the governed desktop",
    }],
    note: "Scoped desktop authority is required.",
    ...overrides,
  };
}

function governedAction(): InvokeDesktopActionInput {
  return {
    tenantId: "tenant-1",
    sessionId: "desktop-session-1",
    sessionKey: "session-key-1",
    action: "mouse.click",
    requestedSurface: "local_computer",
    arguments: { x: 400, y: 220 },
    metadata: { source: "stakeholder-demo" },
    desktopControlToken: "run-scoped-desktop-token",
    executionContext: {
      tenantId: "tenant-1",
      authorityType: "agent",
      authorityId: "ait-demo-agent",
      workOrderId: "wo-42",
      runId: "run-42",
      runStepId: "step-3",
      desktopSessionId: "desktop-session-1",
      attempt: 1,
      executorId: "desktop-executor-1",
      fenceToken: "12",
      cancellationGeneration: 0,
    },
  };
}

describe("OpenClaw configuration", () => {
  it("reports missing configuration without inventing values", () => {
    expect(inspectOpenClawConfiguration({})).toEqual({
      state: "unconfigured",
      missing: ["baseUrl", "runtimeToken"],
    });
  });

  it("uses the curated gateway token precedence and bounds the timeout", () => {
    const status = inspectOpenClawConfiguration({
      OPENCLAW_BRIDGE_URL: "http://localhost:18789/",
      OPENCLAW_BRIDGE_RUNTIME_TOKEN: "preferred-token",
      OPENCLAW_GATEWAY_TOKEN: "fallback-token",
      OPENCLAW_BRIDGE_TIMEOUT_MS: "1250",
    });
    expect(status).toEqual({
      state: "configured",
      missing: [],
      config: {
        baseUrl: "http://localhost:18789",
        runtimeToken: "preferred-token",
        timeoutMs: 1250,
      },
    });
  });

  it.each([
    "http://openclaw.example.com",
    "ftp://localhost:18789",
    "https://user:secret@openclaw.example.com",
  ])("rejects unsafe gateway URL %s", (baseUrl) => {
    expect(() => inspectOpenClawConfiguration({
      OPENCLAW_BRIDGE_URL: baseUrl,
      OPENCLAW_BRIDGE_RUNTIME_TOKEN: "runtime-secret",
    })).toThrow(OpenClawIntegrationError);
  });

  it.each([
    "http://127.0.0.1:18789",
    "http://127.12.34.56:18789",
    "http://[::1]:18789",
    "https://openclaw.example.com",
  ])("allows loopback HTTP or remote HTTPS: %s", (baseUrl) => {
    expect(inspectOpenClawConfiguration({
      OPENCLAW_BRIDGE_URL: baseUrl,
      OPENCLAW_BRIDGE_RUNTIME_TOKEN: "runtime-secret",
    }).state).toBe("configured");
  });

  it("allows an explicitly scoped Compose service name over HTTP", () => {
    expect(inspectOpenClawConfiguration({
      OPENCLAW_BRIDGE_URL: "http://openclaw:18789",
      OPENCLAW_BRIDGE_RUNTIME_TOKEN: "runtime-secret",
      OPENCLAW_BRIDGE_ALLOW_CONTAINER_HTTP: "1",
    })).toEqual({
      state: "configured",
      missing: [],
      config: {
        baseUrl: "http://openclaw:18789",
        runtimeToken: "runtime-secret",
        timeoutMs: 5000,
        allowContainerHttp: true,
      },
    });
  });

  it("does not let the container HTTP flag weaken remote transport", () => {
    expect(() => inspectOpenClawConfiguration({
      OPENCLAW_BRIDGE_URL: "http://openclaw.example.com",
      OPENCLAW_BRIDGE_RUNTIME_TOKEN: "runtime-secret",
      OPENCLAW_BRIDGE_ALLOW_CONTAINER_HTTP: "1",
    })).toThrow(/HTTPS/);
  });
});

describe("OpenClaw desktop bridge", () => {
  it("discovers capabilities using the runtime token and fixed curated path", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(capabilityPayload()));
    const client = new OpenClawDesktopClient(
      {
        baseUrl: "http://localhost:18789",
        runtimeToken: "runtime-secret",
      },
      { fetchImpl: fetchMock },
    );

    const capabilities = await client.capabilities();

    expect(capabilities.provider).toBe("ui-tars-desktop");
    expect(capabilities.rpcReady).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:18789/api/desktop/capabilities");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer runtime-secret");
    expect(JSON.parse(String(init?.body))).toEqual({ includeRuntimeHints: false });
  });

  it("forwards an action only with caller-supplied scoped authority", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      ok: true,
      observation: "The target received the click",
    }));
    const client = new OpenClawDesktopClient(
      {
        baseUrl: "https://openclaw.example.com",
        runtimeToken: "runtime-secret",
        dialect: "ait",
      },
      { fetchImpl: fetchMock },
    );
    const input = Object.assign(governedAction(), {
      ambientCredentialThatMustNotCrossBoundary: "do-not-forward",
    });

    await expect(client.invokeAction(input)).resolves.toMatchObject({ ok: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://openclaw.example.com/api/desktop/invoke-action");
    const body = JSON.parse(String(init?.body)) as InvokeDesktopActionInput;
    expect(body.desktopControlToken).toBe(input.desktopControlToken);
    expect(body.executionContext).toEqual(input.executionContext);
    expect(body.arguments).toEqual({ x: 400, y: 220 });
    expect(body).not.toHaveProperty("ambientCredentialThatMustNotCrossBoundary");
  });

  it.each([
    ["desktop token", (input: InvokeDesktopActionInput) => ({ ...input, desktopControlToken: "" })],
    ["execution context", (input: InvokeDesktopActionInput) => ({ ...input, executionContext: undefined })],
    ["fence", (input: InvokeDesktopActionInput) => ({
      ...input,
      executionContext: { ...input.executionContext, fenceToken: "not-a-fence" },
    })],
    ["tenant binding", (input: InvokeDesktopActionInput) => ({ ...input, tenantId: "other-tenant" })],
    ["session binding", (input: InvokeDesktopActionInput) => ({ ...input, sessionId: "other-session" })],
    ["surface", (input: InvokeDesktopActionInput) => ({ ...input, requestedSurface: "untrusted_surface" })],
  ])("refuses incomplete or mismatched %s authority before any request", async (_name, mutate) => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = new OpenClawDesktopClient(
      { baseUrl: "http://localhost:18789", runtimeToken: "runtime-secret" },
      { fetchImpl: fetchMock },
    );

    await expect(client.invokeAction(
      mutate(governedAction()) as InvokeDesktopActionInput,
    )).rejects.toMatchObject({ code: "INVALID_AUTHORITY" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not expose an upstream body that echoes secrets", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      error: "bad token runtime-secret / run-scoped-desktop-token",
    }, 500));
    const client = new OpenClawDesktopClient(
      { baseUrl: "http://localhost:18789", runtimeToken: "runtime-secret" },
      { fetchImpl: fetchMock },
    );

    const error = await client.invokeAction(governedAction()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenClawIntegrationError);
    expect(String(error)).not.toContain("runtime-secret");
    expect(String(error)).not.toContain("run-scoped-desktop-token");
    expect(error).toMatchObject({ code: "HTTP_ERROR", status: 500 });
  });
});

describe("OpenClaw readiness", () => {
  it("distinguishes unconfigured, configured and live states", async () => {
    await expect(probeOpenClawIntegration({})).resolves.toMatchObject({
      state: "unconfigured",
      gatewayReachable: false,
      desktopRpcReady: false,
    });

    const configuredFetch = vi.fn<typeof fetch>(async () => jsonResponse(capabilityPayload({
      available: false,
      rpcReady: false,
      note: "Desktop bridge is not configured.",
    })));
    await expect(probeOpenClawIntegration({
      OPENCLAW_BRIDGE_URL: "http://localhost:18789",
      OPENCLAW_BRIDGE_RUNTIME_TOKEN: "runtime-secret",
    }, { fetchImpl: configuredFetch })).resolves.toMatchObject({
      state: "configured",
      gatewayReachable: true,
      desktopRpcReady: false,
    });

    const liveFetch = vi.fn<typeof fetch>(async () => jsonResponse(capabilityPayload()));
    await expect(probeOpenClawIntegration({
      OPENCLAW_BRIDGE_URL: "http://localhost:18789",
      OPENCLAW_BRIDGE_RUNTIME_TOKEN: "runtime-secret",
    }, { fetchImpl: liveFetch })).resolves.toMatchObject({
      state: "live",
      gatewayReachable: true,
      desktopRpcReady: true,
    });
  });

  it("keeps a failed, sanitized probe at configured rather than claiming live", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("connect ECONNREFUSED runtime-secret");
    });
    const readiness = await probeOpenClawIntegration({
      OPENCLAW_BRIDGE_URL: "http://localhost:18789",
      OPENCLAW_BRIDGE_RUNTIME_TOKEN: "runtime-secret",
    }, { fetchImpl: fetchMock });

    expect(readiness).toMatchObject({
      state: "configured",
      gatewayReachable: false,
      desktopRpcReady: false,
      message: "OpenClaw request could not be completed",
    });
    expect(readiness.message).not.toContain("runtime-secret");
  });
});

describe("talking to whichever gateway is actually deployed", () => {
  /**
   * The gateway in the alternative project mounts its desktop routes under
   * `/api/aillium/desktop/*`; this client was written against
   * `/api/desktop/*`. The bodies are identical, so the difference is a
   * deployment detail rather than a protocol one, and the client discovers it.
   */
  const notFound = () =>
    new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });

  function clientWith(handler: (url: string) => Response, dialect?: "ait" | "aillium") {
    const fetchMock = vi.fn<typeof fetch>(async (input) => handler(String(input)));
    const client = new OpenClawDesktopClient(
      {
        baseUrl: "http://localhost:18789",
        runtimeToken: "runtime-secret",
        ...(dialect ? { dialect } : {}),
      },
      { fetchImpl: fetchMock },
    );
    return { client, fetchMock };
  }

  it("falls through to the aillium prefix when the ait one is not there", async () => {
    const { client, fetchMock } = clientWith((url) =>
      url.endsWith("/api/aillium/desktop/capabilities")
        ? jsonResponse(capabilityPayload())
        : notFound(),
    );

    await expect(client.capabilities()).resolves.toMatchObject({ rpcReady: true });
    expect(client.dialect).toBe("aillium");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:18789/api/desktop/capabilities",
      "http://localhost:18789/api/aillium/desktop/capabilities",
    ]);
  });

  it("remembers the dialect instead of probing again", async () => {
    const { client, fetchMock } = clientWith((url) =>
      url.endsWith("/api/aillium/desktop/capabilities")
        ? jsonResponse(capabilityPayload())
        : notFound(),
    );

    await client.capabilities();
    await client.capabilities();
    expect(fetchMock.mock.calls.map(([url]) => String(url)).slice(2)).toEqual([
      "http://localhost:18789/api/aillium/desktop/capabilities",
    ]);
  });

  it("sends an action to the discovered prefix, and sends it once", async () => {
    // The important half of this test is the count. A gateway that accepted a
    // request and then failed downstream may already have moved the user's
    // mouse; retrying the same action against a second URL would move it
    // twice. Discovery is confined to the read-only probe for that reason.
    const { client, fetchMock } = clientWith((url) => {
      if (url.endsWith("/api/aillium/desktop/capabilities")) {
        return jsonResponse(capabilityPayload());
      }
      if (url.endsWith("/api/aillium/desktop/invoke-action")) {
        return jsonResponse({ ok: true, observation: "done" });
      }
      return notFound();
    });

    await expect(client.invokeAction(governedAction())).resolves.toMatchObject({
      ok: true,
    });
    const actionCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("invoke-action"));
    expect(actionCalls).toEqual([
      "http://localhost:18789/api/aillium/desktop/invoke-action",
    ]);
  });

  it("never replays an action after a non-404 failure", async () => {
    const { client, fetchMock } = clientWith((url) =>
      url.includes("capabilities")
        ? jsonResponse(capabilityPayload())
        : new Response("{}", { status: 500 }),
    );

    await expect(client.invokeAction(governedAction())).rejects.toThrow();
    expect(
      fetchMock.mock.calls.map(([url]) => String(url)).filter((u) => u.includes("invoke-action")),
    ).toHaveLength(1);
  });

  it("does not mistake a bad token for the wrong path", async () => {
    // 401 on the first prefix means this is the right gateway and the token is
    // wrong. Trying the other prefix would report "unconfigured" for what is
    // actually an authentication problem.
    const { client, fetchMock } = clientWith(() => new Response("{}", { status: 401 }));

    await expect(client.capabilities()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("honours a pinned dialect without probing for it", async () => {
    const { client, fetchMock } = clientWith(
      () => jsonResponse(capabilityPayload()),
      "aillium",
    );

    await client.capabilities();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:18789/api/aillium/desktop/capabilities",
    ]);
  });

  it("reads the dialect hint from the environment, and ignores a typo", () => {
    const base = {
      OPENCLAW_BRIDGE_URL: "http://127.0.0.1:18789",
      OPENCLAW_BRIDGE_RUNTIME_TOKEN: "t",
    };
    expect(
      openClawConfigFromEnv({ ...base, OPENCLAW_BRIDGE_DIALECT: "aillium" })?.dialect,
    ).toBe("aillium");
    expect(
      openClawConfigFromEnv({ ...base, OPENCLAW_BRIDGE_DIALECT: "AIT" })?.dialect,
    ).toBe("ait");
    expect(
      openClawConfigFromEnv({ ...base, OPENCLAW_BRIDGE_DIALECT: "nonsense" })?.dialect,
    ).toBeUndefined();
  });
});

describe("reading a capabilities payload the bridge itself produced", () => {
  it("accepts the desktop bridge's own shape, not just the gateway's", async () => {
    // What `buildCapabilitiesPayload()` in the UI-TARS desktop bridge returns:
    // one `activeOperator` rather than a list, and no `surfaces` or `note`.
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        available: true,
        rpcReady: true,
        provider: "ui-tars-desktop",
        launchUrl: null,
        activeOperator: "nutjs",
        capabilities: [
          {
            action: "computer.execute_instruction",
            surface: "local_computer",
            category: "computer",
            description: "Run a natural-language instruction on the desktop.",
          },
        ],
      }),
    );
    const client = new OpenClawDesktopClient(
      { baseUrl: "http://localhost:47891", runtimeToken: "t", dialect: "ait" },
      { fetchImpl: fetchMock },
    );

    const capabilities = await client.capabilities();
    expect(capabilities.operators).toEqual(["nutjs"]);
    // Surfaces are derived from the capabilities rather than reported as none.
    expect(capabilities.surfaces).toEqual(["local_computer"]);
  });
});
