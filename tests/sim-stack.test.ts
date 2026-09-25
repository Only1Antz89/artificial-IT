/**
 * The simulation stack, over real sockets.
 *
 * These start the two services on real ports and drive them with AIT's own
 * client, so what is tested is the wire: paths, credentials, status codes and
 * the governed body shape. An in-process fake would pass all of this and prove
 * none of it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDesktopBridge, type RunningBridge } from "../src/sim/desktop-bridge.js";
import { startOpenClawGateway, type RunningGateway } from "../src/sim/openclaw-gateway.js";
import { OpenClawDesktopClient } from "../src/integrations/openclaw.js";
import type { InvokeDesktopActionInput } from "../src/integrations/openclaw.js";

const BRIDGE_TOKEN = "bridge-secret";
const GATEWAY_TOKEN = "gateway-secret";

let bridge: RunningBridge;
let gateway: RunningGateway;
let gatewayUrl: string;

beforeAll(async () => {
  bridge = await startDesktopBridge({ token: BRIDGE_TOKEN, port: 0 });
  gateway = await startOpenClawGateway({
    token: GATEWAY_TOKEN,
    bridgeUrl: `http://127.0.0.1:${bridge.port}`,
    bridgeToken: BRIDGE_TOKEN,
    port: 0,
  });
  gatewayUrl = `http://127.0.0.1:${gateway.port}`;
});

afterAll(async () => {
  await gateway.close();
  await bridge.close();
});

function governedAction(
  action: string,
  args: Record<string, unknown>,
): InvokeDesktopActionInput {
  return {
    tenantId: "tenant-demo",
    sessionId: "desk-1",
    sessionKey: "session-key-1",
    action,
    arguments: args,
    desktopControlToken: "short-lived-token",
    executionContext: {
      tenantId: "tenant-demo",
      authorityType: "user",
      authorityId: "tech-1",
      workOrderId: "wo-1",
      runId: "run-1",
      runStepId: "step-1",
      desktopSessionId: "desk-1",
      attempt: 1,
      executorId: "executor-1",
      fenceToken: "42",
      cancellationGeneration: 0,
    },
  };
}

function client(dialect?: "ait" | "aillium"): OpenClawDesktopClient {
  return new OpenClawDesktopClient({
    baseUrl: gatewayUrl,
    runtimeToken: GATEWAY_TOKEN,
    ...(dialect ? { dialect } : {}),
  });
}

describe("the gateway hop", () => {
  it("reports the bridge's capabilities through to AIT's client", async () => {
    const capabilities = await client().capabilities();
    expect(capabilities.available).toBe(true);
    expect(capabilities.rpcReady).toBe(true);
    // Never claims to be the real application.
    expect(capabilities.provider).toBe("simulated-ui-tars-desktop");
    expect(capabilities.capabilities.map((c) => c.action)).toContain(
      "computer.execute_instruction",
    );
    expect(capabilities.note).toMatch(/not cryptographically verified/i);
  });

  it("serves both path dialects", async () => {
    for (const dialect of ["ait", "aillium"] as const) {
      await expect(client(dialect).capabilities()).resolves.toMatchObject({
        rpcReady: true,
      });
    }
  });

  it("rejects a caller with the wrong token", async () => {
    const wrong = new OpenClawDesktopClient({
      baseUrl: gatewayUrl,
      runtimeToken: "not-the-token",
      dialect: "ait",
    });
    await expect(wrong.capabilities()).rejects.toMatchObject({ status: 401 });
  });

  it("does not accept the bridge's own token at the gateway", async () => {
    // Two hops, two credentials. Holding one must not get you the other.
    const wrong = new OpenClawDesktopClient({
      baseUrl: gatewayUrl,
      runtimeToken: BRIDGE_TOKEN,
      dialect: "ait",
    });
    await expect(wrong.capabilities()).rejects.toMatchObject({ status: 401 });
  });
});

describe("driving the desktop across both hops", () => {
  it("changes the desktop and says what it did", async () => {
    expect(bridge.state.wifiEnabled).toBe(false);

    const result = await client().invokeAction(
      governedAction("computer.execute_instruction", {
        instruction: "Open Windows Settings and turn Wi-Fi on",
      }),
    );

    expect(result.ok).toBe(true);
    expect(String(result.observation)).toMatch(/switched Wi-Fi on/i);
    // The state actually moved, which is what the scenario's terminal re-check
    // is later going to read back through an entirely different channel.
    expect(bridge.state.wifiEnabled).toBe(true);
  });

  it("carries the fence and cancellation generation through to the receipt", async () => {
    const result = await client().invokeAction(
      governedAction("computer.get_state", {}),
    );
    expect(result.fenceToken).toBe("42");
    expect(result.cancellationGeneration).toBe(0);
    expect(result.runStepId).toBe("step-1");
  });

  it("refuses an action whose authority is incomplete, before the bridge sees it", async () => {
    const before = bridge.state.history.length;
    const response = await fetch(`${gatewayUrl}/api/desktop/invoke-action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        tenantId: "tenant-demo",
        sessionId: "s",
        sessionKey: "k",
        action: "computer.execute_instruction",
        arguments: { instruction: "Open Windows Settings and turn Wi-Fi off" },
        // No desktopControlToken and no executionContext.
      }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { missing: string[] };
    expect(body.missing).toContain("desktopControlToken");
    expect(body.missing).toContain("executionContext");
    // And nothing reached the desktop.
    expect(bridge.state.history).toHaveLength(before);
  });

  it("refuses an action missing one execution-context field", async () => {
    const input = governedAction("computer.execute_instruction", {
      instruction: "Open Windows Settings and turn Wi-Fi off",
    });
    const response = await fetch(`${gatewayUrl}/api/desktop/invoke-action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        ...input,
        executionContext: { ...input.executionContext, fenceToken: "" },
      }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { missing: string[] };
    expect(body.missing).toContain("executionContext.fenceToken");
  });

  it("reports an instruction it cannot carry out rather than claiming success", async () => {
    const result = await client().invokeAction(
      governedAction("computer.execute_instruction", {
        instruction: "Reorganise the user's entire filing system by vibe",
      }),
    );
    expect(result.ok).toBe(false);
    expect(String(result.observation)).toMatch(/does not know how/i);
  });
});

describe("when the bridge is not there", () => {
  it("says the gateway is up but not ready, rather than pretending", async () => {
    const orphan = await startOpenClawGateway({
      token: GATEWAY_TOKEN,
      // A port nothing is listening on.
      bridgeUrl: "http://127.0.0.1:1",
      bridgeToken: BRIDGE_TOKEN,
      port: 0,
      requestTimeoutMs: 500,
    });
    try {
      const capabilities = await new OpenClawDesktopClient({
        baseUrl: `http://127.0.0.1:${orphan.port}`,
        runtimeToken: GATEWAY_TOKEN,
        dialect: "ait",
      }).capabilities();
      expect(capabilities.available).toBe(false);
      expect(capabilities.rpcReady).toBe(false);
      expect(capabilities.note).toMatch(/not answering/i);
    } finally {
      await orphan.close();
    }
  });
});
