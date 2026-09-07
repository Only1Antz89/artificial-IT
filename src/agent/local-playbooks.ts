/**
 * Playbooks for a real machine.
 *
 * These differ from the simulated ones in three ways that matter:
 *
 *   1. They target things that genuinely exist - `/`, `example.com`, `1.1.1.1` -
 *      rather than a fictional corporate intranet.
 *   2. Each step names the tool it needs, so the brain can skip steps this host
 *      does not have. A container with no `ping` should not have the technician
 *      proposing `ping` and calling it a failure.
 *   3. They interpret output rather than looking for a canned string. Free disk
 *      space is a number to compare, not a marker to grep for - which means the
 *      diagnosis is genuinely derived from the machine's real state.
 *
 * The most important property: on a healthy machine these find nothing, say so,
 * and change nothing. A technician who invents a fault to have something to fix
 * is worse than no technician.
 */
import type { CommandResult } from "../contracts/index.js";

export type HostPlatform = "windows" | "macos" | "linux";

export interface LocalCheck {
  id: string;
  intent: string;
  /** Command per platform. Absent means "not applicable here". */
  command: Partial<Record<HostPlatform, string>>;
  /** Base command that must exist on the host for this check to be proposed. */
  requires: Partial<Record<HostPlatform, string>>;
  /**
   * Decide whether the output shows a fault.
   *
   * Returns the finding when something is wrong, or undefined when it is not.
   * The string is written as a technician's note - it goes into the ticket.
   */
  interpret: (result: CommandResult) => string | undefined;
  /** What "all clear" looks like in words, for the healthy write-up. */
  healthy: (result: CommandResult) => string;
}

/* ------------------------------------------------------------------ *
 * Interpreters
 * ------------------------------------------------------------------ */

/** Parse `df -h /` (or `df -k /`) and return percent used on the root volume. */
export function parseDiskUsage(stdout: string): number | undefined {
  for (const line of stdout.split("\n").slice(1)) {
    const percent = line.match(/(\d{1,3})%/);
    if (percent) return Number(percent[1]);
  }
  return undefined;
}

/** Parse Windows `wmic logicaldisk` output into percent used. */
export function parseWindowsDisk(stdout: string): number | undefined {
  for (const line of stdout.split("\n")) {
    const numbers = line.match(/(\d{6,})\s+(\d{6,})/);
    if (!numbers) continue;
    const free = Number(numbers[1]);
    const size = Number(numbers[2]);
    if (size > 0) return Math.round(((size - free) / size) * 100);
  }
  return undefined;
}

/** Parse `free -m` / `vm_stat` style output into percent of memory in use. */
export function parseMemoryUsage(stdout: string): number | undefined {
  // Linux `free`: "Mem:  total used free ..."
  const mem = stdout.match(/^Mem:\s+(\d+)\s+(\d+)/m);
  if (mem) {
    const total = Number(mem[1]);
    const used = Number(mem[2]);
    if (total > 0) return Math.round((used / total) * 100);
  }
  // macOS `vm_stat`: pages free vs pages active/wired.
  const pageSize = stdout.match(/page size of (\d+) bytes/);
  if (pageSize) {
    const grab = (label: string) => {
      const m = stdout.match(new RegExp(`${label}:\\s+(\\d+)`));
      return m ? Number(m[1]) : 0;
    };
    const free = grab("Pages free") + grab("Pages inactive");
    const used = grab("Pages active") + grab("Pages wired down");
    const total = free + used;
    if (total > 0) return Math.round((used / total) * 100);
  }
  return undefined;
}

const DISK_WARN = 90;
const MEMORY_WARN = 92;

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */

export const LOCAL_CHECKS: LocalCheck[] = [
  {
    id: "check.identity",
    intent: "Confirm which machine and account we are working on",
    command: { linux: "uname -a", macos: "uname -a", windows: "systeminfo" },
    requires: { linux: "uname", macos: "uname", windows: "systeminfo" },
    interpret: () => undefined,
    healthy: (r) => `Host identified: ${r.stdout.trim().split("\n")[0] ?? "unknown"}`,
  },
  {
    id: "check.uptime",
    intent: "Check how long the machine has been up",
    command: { linux: "uptime", macos: "uptime", windows: "powershell -NoProfile -Command Get-Uptime" },
    requires: { linux: "uptime", macos: "uptime", windows: "powershell" },
    interpret: (r) => {
      // A load average well above the core count is worth reporting.
      const load = r.stdout.match(/load average[s]?:\s*([\d.]+)/i);
      if (!load) return undefined;
      const one = Number(load[1]);
      return one > 8 ? `Load average is high at ${one.toFixed(2)}.` : undefined;
    },
    healthy: (r) => `Uptime and load look normal: ${r.stdout.trim()}`,
  },
  {
    id: "check.disk",
    intent: "Check free space on the system volume",
    command: {
      linux: "df -h /",
      macos: "df -h /",
      windows: "wmic logicaldisk get name,freespace,size",
    },
    requires: { linux: "df", macos: "df", windows: "wmic" },
    interpret: (r) => {
      const used =
        parseDiskUsage(r.stdout) ?? parseWindowsDisk(r.stdout);
      if (used === undefined) return undefined;
      return used >= DISK_WARN
        ? `System volume is ${used}% full, which is above the ${DISK_WARN}% threshold and will cause write failures.`
        : undefined;
    },
    healthy: (r) => {
      const used = parseDiskUsage(r.stdout) ?? parseWindowsDisk(r.stdout);
      return used === undefined
        ? "Disk usage read, no threshold breach detected."
        : `System volume is ${used}% full, comfortably under the ${DISK_WARN}% threshold.`;
    },
  },
  {
    id: "check.memory",
    intent: "Check memory pressure",
    command: { linux: "free -m", macos: "vm_stat", windows: "systeminfo" },
    requires: { linux: "free", macos: "vm_stat", windows: "systeminfo" },
    interpret: (r) => {
      const used = parseMemoryUsage(r.stdout);
      if (used === undefined) return undefined;
      return used >= MEMORY_WARN
        ? `Memory is ${used}% used, high enough that the machine is likely swapping.`
        : undefined;
    },
    healthy: (r) => {
      const used = parseMemoryUsage(r.stdout);
      return used === undefined
        ? "Memory read, no threshold breach detected."
        : `Memory is ${used}% used, within normal range.`;
    },
  },
  {
    id: "check.dns",
    intent: "Check that name resolution is working",
    command: {
      linux: "getent hosts example.com",
      macos: "dscacheutil -q host -a name example.com",
      windows: "nslookup example.com",
    },
    requires: { linux: "getent", macos: "dscacheutil", windows: "nslookup" },
    interpret: (r) => {
      if (r.exit_code !== 0 || r.stdout.trim() === "") {
        return "Name resolution for example.com failed, so DNS is not working from this machine.";
      }
      return /can't find|NXDOMAIN|Non-existent/i.test(r.stdout)
        ? "The resolver responded but could not resolve example.com."
        : undefined;
    },
    healthy: (r) =>
      `Name resolution is working: ${r.stdout.trim().split("\n")[0] ?? "resolved"}`,
  },
  {
    id: "check.top-processes",
    intent: "Identify the processes using the most memory",
    command: {
      linux: "ps -eo pid,pmem,pcpu,comm --sort=-pmem",
      // `-m` sorts by memory. `-r` sorts by CPU and would not match the intent.
      macos: "ps -Ao pid,pmem,pcpu,comm -m",
      windows: "tasklist",
    },
    requires: { linux: "ps", macos: "ps", windows: "tasklist" },
    interpret: (r) => {
      // Second column is %MEM on the unix variants.
      const rows = r.stdout.trim().split("\n").slice(1, 4);
      for (const row of rows) {
        const cols = row.trim().split(/\s+/);
        const pmem = Number(cols[1]);
        if (Number.isFinite(pmem) && pmem > 40) {
          return `Process ${cols[3] ?? cols[0]} is using ${pmem}% of system memory on its own.`;
        }
      }
      return undefined;
    },
    healthy: (r) => {
      const top = r.stdout.trim().split("\n")[1]?.trim();
      return top ? `No single process is dominating; heaviest is: ${top}` : "Process list read.";
    },
  },
];

/** Checks this host can actually run, given what the session probed. */
export function checksFor(
  platform: HostPlatform,
  availableCommands: string[],
): LocalCheck[] {
  const available = new Set(availableCommands);
  return LOCAL_CHECKS.filter((check) => {
    const command = check.command[platform];
    const requires = check.requires[platform];
    return Boolean(command) && Boolean(requires) && available.has(requires!);
  });
}
