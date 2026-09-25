/**
 * Opening a session against whichever machine a ticket names.
 *
 * One place, so the console, the CLI and the queue all resolve a target the
 * same way. Before this, each caller had its own switch and the remote target
 * was reachable from none of them.
 */
import { randomUUID } from "node:crypto";
import type { DeviceSession } from "../execution-plane/device.js";
import { MeshCentralSession, meshConfigFromEnv } from "../execution-plane/remote.js";
import { localSession } from "./local.js";
import {
  OpenClawDesktopClient,
  openClawConfigFromEnv,
} from "../integrations/openclaw.js";
import { OpenClawControlledSession } from "../integrations/openclaw-session.js";
import { resolveDesktopAuthority } from "./desktop-authority.js";
import { BridgeDeviceSession, bridgeConfigFromEnv } from "./bridge-device.js";
import { remoteDevice, type AdHocTarget } from "./adhoc.js";
import {
  makeMacDnsDevice,
  makeMacFullDiskDevice,
  makeWindowsDnsDevice,
  makeWindowsPrintDevice,
  makeWindowsWifiDevice,
  makeWindowsVpnDevice,
} from "./devices.js";

/**
 * Put a governed desktop bridge behind a session, when one is available.
 *
 * Only for sessions that were going to be driven anyway. A device whose own
 * capabilities say it cannot be controlled is left alone: wrapping it would
 * advertise desktop control on a machine the demo has no business clicking on,
 * and the brain reads `canControl` when it decides what to propose.
 *
 * When the bridge is configured the real one replaces the in-process
 * simulation for those devices - same scenario, real sockets - and when it is
 * not, everything behaves exactly as it did before.
 */
async function withGovernedDesktop(
  session: DeviceSession | undefined,
  env: NodeJS.ProcessEnv,
): Promise<DeviceSession | undefined> {
  if (!session) return session;

  const config = openClawConfigFromEnv(env);
  if (!config) return session;

  const authority = resolveDesktopAuthority(env);
  if (!authority.provider) return session;

  const base = await session.capabilities();
  // The over-the-wire host is the exception: its terminal session reports no
  // control precisely because control belongs to the wrapper, so requiring
  // `canControl` here would mean it never got one.
  const wantsWrapping =
    base.canControl || session instanceof BridgeDeviceSession;
  if (!wantsWrapping) return session;

  return new OpenClawControlledSession(
    session,
    new OpenClawDesktopClient(config),
    authority.provider,
  );
}

export function sessionForTarget(
  target: AdHocTarget | undefined,
  context: { tenantId?: string; traceId?: string; operatorId?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): DeviceSession | undefined {
  switch (target) {
    case "no-device":
      return undefined;

    case "simulated-windows-laptop":
      return makeWindowsDnsDevice();
    case "simulated-windows-desktop":
      return makeWindowsPrintDevice();
    case "simulated-mac-laptop":
      return makeMacDnsDevice();
    case "simulated-mac-designer":
      return makeMacFullDiskDevice();
    case "simulated-windows-field-laptop":
      return makeWindowsVpnDevice();
    case "simulated-windows-wifi-disabled":
      return makeWindowsWifiDevice();

    case "simulated-host-over-the-wire": {
      const config = bridgeConfigFromEnv(env);
      if (!config) {
        throw new Error(
          "The demo stack is not configured. Set AILLIUM_DESKTOP_BRIDGE_URL and AILLIUM_DESKTOP_BRIDGE_TOKEN, or start it with `npm run demo:stack`.",
        );
      }
      return new BridgeDeviceSession(config);
    }

    case "remote-device": {
      const config = meshConfigFromEnv();
      const device = remoteDevice();
      if (!config || !device) {
        throw new Error(
          "No remote device is configured. Set the MeshCentral URL, operator authentication, mesh id and device id.",
        );
      }
      return new MeshCentralSession(device, config, {
        tenant_id: context.tenantId ?? "demo-tenant",
        task_id: randomUUID(),
        trace_id: context.traceId ?? randomUUID(),
        device_id: device.device_id,
        operator_id: context.operatorId ?? "ait",
        requested_at: new Date().toISOString(),
      });
    }

    default:
      return localSession();
  }
}

/**
 * The same resolution, with a governed desktop bridge attached where one
 * applies. Async because deciding needs the session's own capabilities.
 */
export async function governedSessionForTarget(
  target: AdHocTarget | undefined,
  context: { tenantId?: string; traceId?: string; operatorId?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeviceSession | undefined> {
  return withGovernedDesktop(sessionForTarget(target, context, env), env);
}
