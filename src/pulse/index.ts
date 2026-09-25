export * from "./types.js";
export * from "./monitor.js";
export * from "./demo-fleet.js";

import { join } from "node:path";
import { demoPulseTargets } from "./demo-fleet.js";
import { PulseMonitor, type PulseMonitorOptions } from "./monitor.js";

/** Ready-to-wire monitor used by the demo server without owning any UI state. */
export function createDemoPulseMonitor(
  options: Omit<PulseMonitorOptions, "targets"> = {},
): PulseMonitor {
  return new PulseMonitor({
    ...options,
    targets: demoPulseTargets(),
    evidenceRoot: options.evidenceRoot ?? join("run-artifacts", "pulse"),
  });
}

