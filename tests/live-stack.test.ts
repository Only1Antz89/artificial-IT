/**
 * One host, two channels.
 *
 * The demo stack's machine is the desktop-bridge process: its terminal and its
 * desktop input are two ways into one state. That is what makes the scenario's
 * verification meaningful - the fix goes in through the governed desktop path
 * and is read back through the shell, exactly as it would be on a real
 * endpoint carrying both a MeshCentral agent and UI-TARS Desktop.
 *
 * A simulation that kept those two channels in separate worlds would fail this
 * file, and would have failed it quietly in front of an audience instead.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDesktopBridge, type RunningBridge } from "../src/sim/desktop-bridge.js";
import { startOpenClawGateway, type RunningGateway } from "../src/sim/openclaw-gateway.js";
import { BridgeDeviceSession, bridgeConfigFromEnv, bridgeTargetAvailable } from "../src/demo/bridge-device.js";
import { governedSessionForTarget } from "../src/demo/sessions.js";
import { resolveDesktopAuthority } from "../src/demo/desktop-authority.js";
import { evaluate } from "../src/control-plane/policy/engine.js";

const BRIDGE_TOKEN = "bridge-secret";
const GATEWAY_TOKEN = "gateway-secret";

let bridge: RunningBridge;
let gateway: RunningGateway;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  bridge = await startDesktopBridge({ token: BRIDGE_TOKEN, port: 0 });
  gateway = await startOpenClawGateway({
    token: GATEWAY_TOKEN,
    bridgeUrl: `http://127.0.0.1:${bridge.port}`,
    bridgeToken: BRIDGE_TOKEN,
    port: 0,
  });
  env = {
    AILLIUM_DESKTOP_BRIDGE_URL: `http://127.0.0.1:${bridge.port}`,
    AILLIUM_DESKTOP_BRIDGE_TOKEN: BRIDGE_TOKEN,
    OPENCLAW_BRIDGE_URL: `http://127.0.0.1:${gateway.port}`,
    OPENCLAW_BRIDGE_RUNTIME_TOKEN: GATEWAY_TOKEN,
    AIT_SIMULATED_DESKTOP_AUTHORITY: "1",
  };
});

afterAll(async () => {
  await gateway.close();
  await bridge.close();
});

describe("the terminal channel", () => {
  it("reads the host's real state rather than a canned answer", async () => {
    const session = new BridgeDeviceSession(bridgeConfigFromEnv(env)!);
    const before = await session.exec("netsh interface show interface");
    expect(before.stdout).toMatch(/Disabled\s+Disconnected\s+Dedicated\s+Wi-Fi/);
    expect(before.exit_code).toBe(0);

    bridge.state.wifiEnabled = true;
    const after = await session.exec("netsh interface show interface");
    expect(after.stdout).toMatch(/Enabled\s+Connected\s+Dedicated\s+Wi-Fi/);
    bridge.state.wifiEnabled = false;
  });

  it("fails honestly on a command the host does not have", async () => {
    const session = new BridgeDeviceSession(bridgeConfigFromEnv(env)!);
    const result = await session.exec("kubectl get pods");
    expect(result.exit_code).toBe(127);
    expect(result.stderr).toMatch(/does not provide that command/i);
  });

  it("draws the screen from what the terminal reports, not from what was asked for", async () => {
    const session = new BridgeDeviceSession(bridgeConfigFromEnv(env)!);
    expect((await session.capture()).description).toMatch(/switched off/i);
    bridge.state.wifiEnabled = true;
    expect((await session.capture()).description).not.toMatch(/switched off/i);
    bridge.state.wifiEnabled = false;
  });

  it("is only offered as a target when the stack is configured", () => {
    expect(bridgeTargetAvailable(env)).toBe(true);
    expect(bridgeTargetAvailable({})).toBe(false);
  });
});

describe("where desktop authority comes from", () => {
  it("declines to invent any when nothing is configured", () => {
    const resolution = resolveDesktopAuthority({});
    expect(resolution.kind).toBe("none");
    expect(resolution.provider).toBeUndefined();
  });

  it("only simulates authority when explicitly asked to", () => {
    expect(resolveDesktopAuthority({ AIT_SIMULATED_DESKTOP_AUTHORITY: "1" }).kind).toBe(
      "simulated",
    );
    expect(resolveDesktopAuthority({ AIT_SIMULATED_DESKTOP_AUTHORITY: "0" }).kind).toBe(
      "none",
    );
  });

  it("labels a simulated token as simulated, so a receipt cannot be misread", async () => {
    const resolution = resolveDesktopAuthority({ AIT_SIMULATED_DESKTOP_AUTHORITY: "1" });
    const session = new BridgeDeviceSession(bridgeConfigFromEnv(env)!);
    const granted = await resolution.provider!(
      { action: "computer.execute_instruction" },
      session,
    );
    expect(granted.desktopControlToken).toMatch(/^simulated-/);
    expect(granted.executionContext.authorityId).toMatch(/simulated/);
    // Every governed field is present: the point is to exercise the real
    // validation path, not to skip it.
    expect(granted.executionContext.fenceToken).toMatch(/^\d+$/);
    expect(granted.sessionId).toBe(granted.executionContext.desktopSessionId);
  });

  it("prefers a configured issuer over the simulation", () => {
    expect(
      resolveDesktopAuthority({
        AIT_DESKTOP_AUTHORITY_URL: "https://issuer.example/token",
        AIT_SIMULATED_DESKTOP_AUTHORITY: "1",
      }).kind,
    ).toBe("issuer");
  });
});

describe("the governed session, end to end", () => {
  it("gains desktop control only once a bridge and an authority both exist", async () => {
    const withoutAuthority = await governedSessionForTarget(
      "simulated-host-over-the-wire",
      {},
      { ...env, AIT_SIMULATED_DESKTOP_AUTHORITY: "0" },
    );
    expect((await withoutAuthority!.capabilities()).canControl).toBe(false);

    const governed = await governedSessionForTarget("simulated-host-over-the-wire", {}, env);
    expect((await governed!.capabilities()).canControl).toBe(true);
  });

  it("fixes the host through the gateway and proves it through the shell", async () => {
    expect(bridge.state.wifiEnabled).toBe(false);
    const session = (await governedSessionForTarget(
      "simulated-host-over-the-wire",
      {},
      env,
    ))!;

    // The diagnosis, through the terminal.
    expect((await session.exec("netsh interface show interface")).stdout).toMatch(
      /Disabled/,
    );

    // The fix, through the governed desktop path. Still gated: the policy
    // engine holds a UI action for a technician whatever is behind it.
    const verdict = evaluate(
      {
        id: "step-1",
        kind: "ui_action",
        intent: "Open Windows Settings and turn Wi-Fi on",
        payload: { action: "computer.execute_instruction" },
        mutating: true,
      } as never,
      { device: session.device },
    );
    expect(verdict.decision).toBe("require_approval");

    const result = await session.control!({
      action: "computer.execute_instruction",
      arguments: { instruction: "Open Windows Settings and turn Wi-Fi on" },
    });
    expect(result.ok).toBe(true);

    // The verification, back through the terminal - a different channel onto
    // the same host, which is the only reason it is worth anything.
    expect((await session.exec("netsh interface show interface")).stdout).toMatch(
      /Enabled\s+Connected\s+Dedicated\s+Wi-Fi/,
    );
    bridge.state.wifiEnabled = false;
  });
});
