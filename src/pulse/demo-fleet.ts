/**
 * Repeatable fleet for the stakeholder demo.
 *
 * Every result below comes from a stateful simulated session and is labelled
 * `source: "simulated"` in the public snapshot. Nothing here pretends to be a
 * live MeshCentral or MDM response. Production adapters only need to supply a
 * DeviceSession and the same read-only probes.
 */
import type { CommandResult } from "../contracts/index.js";
import type { DeviceInfo } from "../contracts/ticket.js";
import {
  SimulatedDeviceSession,
  type DeviceState,
  type ScreenCapture,
} from "../execution-plane/device.js";
import {
  makeWindowsDnsDevice,
  makeWindowsPrintDevice,
  WIN_DESKTOP,
  WIN_LAPTOP,
} from "../demo/devices.js";
import type { PulseFinding, PulseTarget } from "./types.js";

function commandFailed(result: CommandResult): boolean {
  return result.exit_code !== 0;
}

function interpretReachability(result: CommandResult): PulseFinding {
  if (commandFailed(result)) {
    return { health: "critical", summary: "The endpoint could not reach the internet by IP." };
  }
  const loss = Number(result.stdout.match(/(\d+)%\s*loss/i)?.[1] ?? 0);
  if (loss > 5) {
    return {
      health: "warning",
      summary: `Internet reachability is intermittent (${loss}% packet loss).`,
      metric: `${loss}% loss`,
    };
  }
  return {
    health: "healthy",
    summary: "Internet reachability is healthy.",
    metric: `${loss}% loss`,
  };
}

function interpretDns(result: CommandResult): PulseFinding {
  if (commandFailed(result) || /can't find|non-existent domain|nxdomain/i.test(result.stdout)) {
    return {
      health: "critical",
      summary: "Corporate DNS lookup is failing although the endpoint still has IP connectivity.",
      metric: "NXDOMAIN",
    };
  }
  return { health: "healthy", summary: "Corporate DNS lookup succeeded.", metric: "resolved" };
}

function interpretSpooler(result: CommandResult): PulseFinding {
  if (commandFailed(result)) {
    return { health: "unavailable", summary: "The print-spooler state could not be read." };
  }
  const running = /STATE\s*:\s*4\s+RUNNING/i.test(result.stdout);
  return running
    ? { health: "healthy", summary: "The print spooler is running.", metric: "running" }
    : {
        health: "critical",
        summary: "The print spooler is stopped and print jobs cannot be processed.",
        metric: "stopped",
      };
}

function interpretPrinter(result: CommandResult): PulseFinding {
  if (commandFailed(result)) {
    return { health: "unavailable", summary: "Printer state could not be read." };
  }
  return /TRUE/i.test(result.stdout)
    ? {
        health: "warning",
        summary: "One managed printer is reporting offline.",
        metric: "1 offline",
      }
    : { health: "healthy", summary: "Managed printers report online.", metric: "online" };
}

interface DemoMdmResponse {
  enrolled: boolean;
  compliant: boolean;
  last_seen_minutes: number;
  battery_percent: number;
  os_version: string;
  update_available?: string;
}

function interpretMdm(result: CommandResult): PulseFinding {
  if (commandFailed(result)) {
    return { health: "unavailable", summary: "The MDM provider did not return device health." };
  }
  const data = JSON.parse(result.stdout) as DemoMdmResponse;
  if (!data.enrolled) {
    return { health: "critical", summary: "The mobile device is no longer enrolled in MDM." };
  }
  if (!data.compliant) {
    return { health: "critical", summary: "The mobile device is enrolled but non-compliant." };
  }
  if (data.last_seen_minutes > 60) {
    return {
      health: "warning",
      summary: `The mobile device has not checked in for ${data.last_seen_minutes} minutes.`,
      metric: `${data.last_seen_minutes}m ago`,
    };
  }
  if (data.battery_percent < 15) {
    return {
      health: "warning",
      summary: `The mobile device is compliant but its battery is at ${data.battery_percent}%.`,
      metric: `${data.battery_percent}% battery`,
    };
  }
  if (data.update_available) {
    return {
      health: "warning",
      summary: `The mobile device is compliant; OS ${data.update_available} is available.`,
      metric: `${data.os_version} → ${data.update_available}`,
    };
  }
  return {
    health: "healthy",
    summary: "The mobile device is enrolled, compliant and checking in.",
    metric: `${data.last_seen_minutes}m ago`,
  };
}

const MOBILE_DEVICE: DeviceInfo = {
  device_id: "mob-ios-0441",
  hostname: "IOS-0441",
  // The shared device contract intentionally does not invent an iOS command
  // shell. This target is observed through its MDM connector, so its endpoint
  // platform remains unknown.
  platform: "unknown",
  os_version: "iOS 18.6",
  // Standing read-only MDM enrolment authorises this health query; it is not a
  // claim that an interactive remote-control session is open.
  consent_granted: true,
  managed: true,
};

const MDM_COMMAND = "curl -s https://mdm.demo.local/v1/devices/mob-ios-0441/health";

function mobileScreen(_state: DeviceState): ScreenCapture {
  return {
    source: "rendered",
    width: 390,
    height: 844,
    description: "Rendered placeholder for the simulated MDM-enrolled mobile device.",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844"><rect width="390" height="844" fill="#101b2b"/></svg>',
  };
}

function makeMobileMdmSession(): SimulatedDeviceSession {
  return new SimulatedDeviceSession({
    device: MOBILE_DEVICE,
    state: {},
    fixtures: [
      {
        match: /^curl -s https:\/\/mdm\.demo\.local\/v1\/devices\/mob-ios-0441\/health$/,
        respond: () => ({
          stdout: JSON.stringify({
            source: "simulated-mdm",
            enrolled: true,
            compliant: true,
            last_seen_minutes: 7,
            battery_percent: 81,
            os_version: "18.6",
            update_available: "18.7",
          }),
        }),
      },
    ],
    screen: mobileScreen,
  });
}

export function demoPulseTargets(): PulseTarget[] {
  return [
    {
      id: "endpoint-lon-lt-2211",
      name: WIN_LAPTOP.hostname,
      kind: "endpoint",
      source: "simulated",
      connector: "endpoint-agent",
      device: WIN_LAPTOP,
      openSession: makeWindowsDnsDevice,
      probes: [
        {
          id: "internet-reachability",
          name: "Internet reachability",
          command: "ping -n 2 1.1.1.1",
          interpret: interpretReachability,
        },
        {
          id: "corporate-dns",
          name: "Corporate DNS",
          command: "nslookup intranet.corp.local",
          interpret: interpretDns,
        },
      ],
    },
    {
      id: "service-print-man-dt-3480",
      name: `${WIN_DESKTOP.hostname} · Print service`,
      kind: "service",
      source: "simulated",
      connector: "endpoint-agent",
      device: WIN_DESKTOP,
      openSession: makeWindowsPrintDevice,
      probes: [
        {
          id: "print-spooler",
          name: "Print spooler",
          command: "sc query spooler",
          interpret: interpretSpooler,
        },
        {
          id: "printer-status",
          name: "Managed printer status",
          command: "wmic printer get name,printerstatus,workoffline",
          interpret: interpretPrinter,
        },
      ],
    },
    {
      id: "mobile-ios-0441",
      name: MOBILE_DEVICE.hostname,
      kind: "mobile",
      source: "simulated",
      connector: "mdm",
      device: MOBILE_DEVICE,
      openSession: makeMobileMdmSession,
      probes: [
        {
          id: "mdm-posture",
          name: "MDM posture and check-in",
          command: MDM_COMMAND,
          interpret: interpretMdm,
        },
      ],
    },
  ];
}

