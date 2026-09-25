import { describe, expect, it, vi } from "vitest";
import { makeWindowsDnsDevice } from "../src/demo/devices.js";
import {
  OpenClawControlledSession,
  type DesktopBridgeClient,
} from "../src/integrations/openclaw-session.js";

const DESKTOP_CAPABILITIES = {
  available: true,
  rpcReady: true,
  provider: "ui-tars-desktop",
  launchUrl: null,
  surfaces: ["local_computer" as const],
  operators: ["Local Computer Operator"],
  capabilities: [],
  note: "ready",
};

describe("OpenClaw-controlled device session", () => {
  it("combines endpoint diagnostics with caller-issued desktop authority", async () => {
    const invokeAction = vi.fn(async () => ({
      ok: true,
      action: "computer.execute_instruction",
      result: { runId: "desktop-run-1" },
    }));
    const bridge: DesktopBridgeClient = {
      capabilities: vi.fn(async () => DESKTOP_CAPABILITIES),
      invokeAction,
    };
    const base = makeWindowsDnsDevice();
    const session = new OpenClawControlledSession(base, bridge, async () => ({
      tenantId: "tenant-1",
      sessionId: "desktop-1",
      sessionKey: "session-key-1",
      requestedSurface: "local_computer",
      desktopControlToken: "issued-upstream",
      executionContext: {
        tenantId: "tenant-1",
        authorityType: "user",
        authorityId: "tech-1",
        workOrderId: "ticket-1",
        runId: "run-1",
        runStepId: "step-1",
        desktopSessionId: "desktop-1",
        attempt: 1,
        executorId: "ait",
        fenceToken: "7",
        cancellationGeneration: 0,
      },
    }));

    expect((await session.capabilities()).controlProvider).toBe("ui-tars-desktop");
    expect((await session.exec("ipconfig /all")).exit_code).toBe(0);
    const result = await session.control({
      action: "computer.execute_instruction",
      arguments: { instruction: "Open Settings" },
    });

    expect(result.ok).toBe(true);
    expect(invokeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        desktopControlToken: "issued-upstream",
        action: "computer.execute_instruction",
        executionContext: expect.objectContaining({ fenceToken: "7" }),
      }),
    );
  });

  it("does not claim control when the governed RPC bridge is not ready", async () => {
    const bridge: DesktopBridgeClient = {
      capabilities: vi.fn(async () => ({
        ...DESKTOP_CAPABILITIES,
        available: false,
        rpcReady: false,
        note: "Desktop bridge is not configured.",
      })),
      invokeAction: vi.fn(),
    };
    const session = new OpenClawControlledSession(
      makeWindowsDnsDevice(),
      bridge,
      async () => {
        throw new Error("authority should not be requested");
      },
    );
    const capabilities = await session.capabilities();
    expect(capabilities.canControl).toBe(false);
    expect(capabilities.controlUnavailableReason).toMatch(/not configured/i);
  });
});
