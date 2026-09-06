/**
 * MeshCentral-backed remote support sessions.
 *
 * This is the adapter that would put a real endpoint behind `DeviceSession`.
 * It follows AIT's remote-support contract: a session is *requested* against a
 * device by an operator, moves through a small state machine, and is revocable
 * at any time by the user.
 *
 * It is deliberately not a re-implementation of MeshCentral. Relay transport
 * lives in the MeshCentral repo; this file only owns the boundary - so the
 * agent loop, the tests and the demo all talk to one interface whether the
 * machine behind it is simulated or real.
 */
import type { CommandResult } from "../contracts/index.js";
import type { DeviceInfo } from "../contracts/ticket.js";
import type { DeviceSession, ScreenCapture } from "./device.js";

export type RemoteSessionStatus =
  | "requested"
  | "establishing"
  | "active"
  | "ended"
  | "failed";

export interface RemoteSessionRequest {
  tenant_id: string;
  task_id: string;
  trace_id: string;
  device_id: string;
  operator_id: string;
  requested_at: string;
}

export interface MeshCentralConfig {
  /** e.g. https://mesh.example.internal */
  serverUrl: string;
  /** Login token for the operator account driving the session. */
  operatorToken: string;
  /** Mesh (device group) the device belongs to. */
  meshId: string;
}

export function meshConfigFromEnv(): MeshCentralConfig | undefined {
  const serverUrl = process.env["MESHCENTRAL_URL"];
  const operatorToken = process.env["MESHCENTRAL_TOKEN"];
  const meshId = process.env["MESHCENTRAL_MESH_ID"];
  if (!serverUrl || !operatorToken || !meshId) return undefined;
  return { serverUrl, operatorToken, meshId };
}

/**
 * A session against a real endpoint.
 *
 * Left unimplemented rather than faked: a stub that silently returned empty
 * output would let a run look successful while touching nothing, which is
 * exactly the failure this whole codebase is arranged to prevent. Wire it to
 * MeshCentral's relay (`/meshrelay.ashx`) to bring it up.
 */
export class MeshCentralSession implements DeviceSession {
  readonly device: DeviceInfo;
  readonly sessionId: string;
  status: RemoteSessionStatus = "requested";

  constructor(
    device: DeviceInfo,
    private readonly config: MeshCentralConfig,
    private readonly request: RemoteSessionRequest,
  ) {
    this.device = device;
    this.sessionId = `mesh_${request.device_id}_${request.trace_id}`;
  }

  private notWired(what: string): never {
    this.status = "failed";
    throw new Error(
      `MeshCentral ${what} is not wired up in this build. ` +
        `Connect ${this.config.serverUrl} via meshrelay.ashx for device ${this.request.device_id}, ` +
        `or run the demo against a simulated device.`,
    );
  }

  async exec(_command: string): Promise<CommandResult> {
    this.notWired("terminal relay");
  }

  async capture(): Promise<ScreenCapture> {
    this.notWired("desktop relay");
  }

  async end(): Promise<void> {
    this.status = "ended";
  }
}
