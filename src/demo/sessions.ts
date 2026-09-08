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
import { remoteDevice, type AdHocTarget } from "./adhoc.js";
import {
  makeMacDnsDevice,
  makeMacFullDiskDevice,
  makeWindowsDnsDevice,
  makeWindowsPrintDevice,
  makeWindowsVpnDevice,
} from "./devices.js";

export function sessionForTarget(
  target: AdHocTarget | undefined,
  context: { tenantId?: string; traceId?: string; operatorId?: string } = {},
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

    case "remote-device": {
      const config = meshConfigFromEnv();
      const device = remoteDevice();
      if (!config || !device) {
        throw new Error(
          "No remote device is configured. Set MESHCENTRAL_URL, MESHCENTRAL_TOKEN, MESHCENTRAL_MESH_ID and MESHCENTRAL_DEVICE_ID.",
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
