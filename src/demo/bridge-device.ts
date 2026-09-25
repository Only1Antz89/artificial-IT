/**
 * One simulated host, reached over the wire.
 *
 * The demo stack's "machine" is the desktop-bridge container. This session is
 * its terminal channel: commands go over HTTP to the same process that the
 * approved desktop action goes to through OpenClaw, so a fix applied through
 * one channel is genuinely verifiable through the other.
 *
 * That mirrors the deployment it stands in for, where MeshCentral's shell and
 * UI-TARS' input are two channels onto one physical host. It is the part a
 * two-world simulation gets wrong: the action succeeds, the re-check fails,
 * and the run looks like a broken fix rather than a broken simulation.
 *
 * Desktop control is deliberately absent here. It is added by wrapping this
 * session in `OpenClawControlledSession`, so input still travels the governed
 * path through the gateway rather than shortcutting straight to the bridge.
 */
import { randomUUID } from "node:crypto";
import type { CommandResult } from "../contracts/index.js";
import type { DeviceInfo } from "../contracts/ticket.js";
import type {
  DeviceSession,
  ScreenCapture,
  SessionCapabilities,
} from "../execution-plane/device.js";
import { wifiSettingsScreen } from "./screen.js";

export const BRIDGE_ENV = {
  /** Where the desktop bridge's terminal channel is. */
  url: "AILLIUM_DESKTOP_BRIDGE_URL",
  token: "AILLIUM_DESKTOP_BRIDGE_TOKEN",
} as const;

export const BRIDGE_DEVICE: DeviceInfo = {
  device_id: "dev-sim-0001",
  hostname: "SIM-DESK-0001",
  platform: "windows",
  os_version: "Windows 11 24H2",
  consent_granted: true,
  managed: true,
};

export interface BridgeSessionConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export function bridgeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BridgeSessionConfig | undefined {
  const baseUrl = env[BRIDGE_ENV.url]?.trim();
  const token = env[BRIDGE_ENV.token]?.trim();
  if (!baseUrl || !token) return undefined;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

/** True when a simulated host is reachable as a target on this deployment. */
export function bridgeTargetAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return bridgeConfigFromEnv(env) !== undefined;
}

interface ExecResponse {
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: unknown;
  durationMs?: unknown;
}

export class BridgeDeviceSession implements DeviceSession {
  readonly device = BRIDGE_DEVICE;
  readonly sessionId = `bridge-${randomUUID()}`;
  readonly #config: BridgeSessionConfig;
  readonly #fetch: typeof fetch;

  constructor(config: BridgeSessionConfig, fetchImpl: typeof fetch = fetch) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  async exec(command: string, timeoutMs?: number): Promise<CommandResult> {
    const started = Date.now();
    const response = await this.#fetch(`${this.#config.baseUrl}/exec`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#config.token}`,
      },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(timeoutMs ?? this.#config.timeoutMs ?? 10_000),
    });

    if (!response.ok) {
      return {
        command,
        stdout: "",
        stderr: `The simulated host's terminal refused the command (HTTP ${response.status}).`,
        exit_code: 1,
        duration_ms: Date.now() - started,
        truncated: false,
      };
    }

    const body = (await response.json()) as ExecResponse;
    return {
      command,
      stdout: typeof body.stdout === "string" ? body.stdout : "",
      stderr: typeof body.stderr === "string" ? body.stderr : "",
      exit_code: typeof body.exitCode === "number" ? body.exitCode : 0,
      duration_ms:
        typeof body.durationMs === "number" ? body.durationMs : Date.now() - started,
      truncated: false,
    };
  }

  /**
   * The screen, drawn from the host's own state.
   *
   * Read back over the terminal rather than assumed, so the frame on the
   * ticket shows what the machine actually reports rather than what AIT last
   * asked for.
   */
  async capture(): Promise<ScreenCapture> {
    const result = await this.exec("netsh interface show interface");
    const wifiEnabled = /^Enabled\s+Connected\s+Dedicated\s+Wi-Fi/im.test(result.stdout);
    return wifiSettingsScreen({ wifi_enabled: wifiEnabled });
  }

  async capabilities(): Promise<SessionCapabilities> {
    return {
      platform: "windows",
      availableCommands: [
        "netsh",
        "ipconfig",
        "hostname",
      ],
      canCapture: true,
      // Set by the OpenClawControlledSession wrapper, which is where desktop
      // input actually lives. A bare terminal session cannot click anything.
      canControl: false,
      controlUnavailableReason:
        "this session is the host's terminal; desktop input goes through the governed gateway",
    };
  }

  async end(): Promise<void> {
    // Stateless over HTTP: nothing to tear down.
  }
}
