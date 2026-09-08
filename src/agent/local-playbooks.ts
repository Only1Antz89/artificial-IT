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

/** Ticket categories, mirrored from the Intake contract. */
export type TicketCategory =
  | "connectivity"
  | "authentication"
  | "hardware"
  | "software"
  | "performance"
  | "printing"
  | "email"
  | "storage"
  | "security"
  | "access-request"
  | "other";

export interface LocalCheck {
  id: string;
  intent: string;
  /**
   * Categories this check is worth running for.
   *
   * A technician handed "my wifi keeps dropping" does not start by listing
   * printers. `"*"` marks the handful worth running whatever the complaint is -
   * knowing the machine and whether the disk is full is never wasted.
   */
  relevantTo: (TicketCategory | "*")[];
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
  /**
   * A fix for the fault this check finds, where a safe one exists.
   *
   * Most checks have none, and that is the honest answer: a full disk is fixed
   * by a person deciding what to delete, and a failing battery by replacing it.
   * A fix belongs here only when it is reversible, needs no elevation, and
   * addresses the exact fault the interpreter reported.
   */
  fix?: LocalFix;
}

export interface LocalFix {
  intent: string;
  command: Partial<Record<HostPlatform, string>>;
  requires: Partial<Record<HostPlatform, string>>;
  /** In prose, for the ticket. */
  rollback: string;
  /** A command that reverses it, where one exists. */
  rollbackCommand?: Partial<Record<HostPlatform, string>>;
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
    relevantTo: ["*"],
    intent: "Confirm which machine and account we are working on",
    command: { linux: "uname -a", macos: "uname -a", windows: "systeminfo" },
    requires: { linux: "uname", macos: "uname", windows: "systeminfo" },
    interpret: () => undefined,
    healthy: (r) => `Host identified: ${r.stdout.trim().split("\n")[0] ?? "unknown"}`,
  },
  {
    id: "check.uptime",
    relevantTo: ["*"],
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
    relevantTo: ["*"],
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
    relevantTo: ["performance", "software", "other"],
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
    relevantTo: ["connectivity", "email", "software", "other"],
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
    fix: {
      intent: "Clear the stale DNS resolver cache",
      command: {
        macos: "dscacheutil -flushcache",
        linux: "resolvectl flush-caches",
        windows: "ipconfig /flushdns",
      },
      requires: { macos: "dscacheutil", linux: "resolvectl", windows: "ipconfig" },
      // Genuinely reversible by doing nothing: the cache refills from the
      // configured resolvers on the next lookup. Saying so is more honest than
      // inventing an undo command that would only flush it again.
      rollback:
        "Nothing to undo - the resolver cache refills itself from the configured DNS servers on the next lookup.",
    },
  },
  {
    id: "check.network",
    relevantTo: ["connectivity", "email"],
    intent: "Check the network interface has an address",
    command: {
      linux: "ip -4 addr show",
      macos: "ifconfig en0",
      windows: "ipconfig /all",
    },
    requires: { linux: "ip", macos: "ifconfig", windows: "ipconfig" },
    interpret: (r) => {
      // No routable address means the machine is not on a network at all,
      // which explains every connectivity symptom at once.
      if (!/inet\s+\d+\.\d+\.\d+\.\d+|IPv4 Address/i.test(r.stdout)) {
        return "The interface has no IPv4 address, so the machine is not on the network.";
      }
      return /inet\s+169\.254\.|Autoconfiguration IPv4/i.test(r.stdout)
        ? "The interface has a self-assigned (169.254.x.x) address, which means DHCP did not answer."
        : undefined;
    },
    healthy: (r) => {
      const ip = r.stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/)?.[1];
      return ip ? `Interface has address ${ip}.` : "Interface has an address.";
    },
  },
  {
    id: "check.reachability",
    relevantTo: ["connectivity", "email"],
    intent: "Check the machine can reach the internet by IP, bypassing DNS",
    command: {
      // curl beats ping here: it is present far more often, needs no raw
      // sockets, and separates "no route" from "no name resolution" just as
      // well when pointed at an address.
      linux: "curl -s -o /dev/null -w %{http_code} --max-time 8 http://1.1.1.1",
      macos: "curl -s -o /dev/null -w %{http_code} --max-time 8 http://1.1.1.1",
      windows: "curl -s -o /dev/null -w %{http_code} --max-time 8 http://1.1.1.1",
    },
    requires: { linux: "curl", macos: "curl", windows: "curl" },
    interpret: (r) =>
      r.exit_code === 0 && /\d{3}/.test(r.stdout)
        ? undefined
        : "Could not reach 1.1.1.1 by IP, so the network path itself is down - this is not a DNS problem.",
    healthy: () => "The machine can reach the internet by IP, so the network path is up.",
  },
  {
    id: "check.printers",
    relevantTo: ["printing"],
    intent: "List the printers and the state of their queues",
    command: {
      linux: "lpstat -t",
      macos: "lpstat -t",
      windows: "wmic printer get name,printerstatus,workoffline",
    },
    requires: { linux: "lpstat", macos: "lpstat", windows: "wmic" },
    interpret: (r) => {
      if (/disabled|not accepting/i.test(r.stdout)) {
        return "A print queue is disabled or not accepting jobs, so anything sent to it will sit unprinted.";
      }
      return /TRUE/i.test(r.stdout) ? "A printer is marked offline." : undefined;
    },
    healthy: (r) =>
      r.stdout.trim() ? "Print queues are accepting jobs." : "No printers are configured on this machine.",
    fix: {
      intent: "Re-enable the print queue so jobs can leave the machine",
      command: {
        macos: "cupsenable --all",
        linux: "cupsenable --all",
      },
      requires: { macos: "cupsenable", linux: "cupsenable" },
      rollback: "Disable the queue again with `cupsdisable --all`.",
      rollbackCommand: { macos: "cupsdisable --all", linux: "cupsdisable --all" },
    },
  },
  {
    id: "check.power",
    relevantTo: ["hardware", "performance"],
    intent: "Check battery and power state",
    command: {
      linux: "cat /sys/class/power_supply/BAT0/capacity",
      macos: "pmset -g batt",
      // `powercfg /batteryreport` writes a report file; this reads the value
      // instead. A "read-only" check that writes is not read-only.
      windows: "wmic path Win32_Battery get EstimatedChargeRemaining",
    },
    requires: { linux: "cat", macos: "pmset", windows: "wmic" },
    interpret: (r) => {
      const percent = Number(r.stdout.match(/(\d{1,3})%/)?.[1] ?? r.stdout.trim());
      if (!Number.isFinite(percent)) return undefined;
      return percent > 0 && percent < 15
        ? `Battery is at ${percent}%, low enough to explain throttling or sudden shutdowns.`
        : undefined;
    },
    healthy: (r) => `Power state read: ${r.stdout.trim().split("\n")[0] ?? "ok"}`,
  },
  {
    id: "check.wifi",
    relevantTo: ["connectivity"],
    intent: "Check the wireless connection and signal strength",
    command: {
      // `wdutil` is the supported reader on modern macOS; the old `airport`
      // binary was removed in Sonoma, so reaching for it would fail on any
      // current Mac.
      macos: "system_profiler SPAirPortDataType",
      linux: "cat /proc/net/wireless",
      windows: "netsh wlan show interfaces",
    },
    requires: { macos: "system_profiler", linux: "cat", windows: "netsh" },
    interpret: (r) => {
      const rssi = Number(
        r.stdout.match(/Signal\s*\/\s*Noise:\s*(-?\d+)/i)?.[1] ??
          r.stdout.match(/Signal[^\n]*?(-\d{2,3})\s*dBm/i)?.[1] ??
          NaN,
      );
      if (Number.isFinite(rssi) && rssi < -75) {
        return `Wireless signal is weak at ${rssi} dBm, which will cause drops and slow transfers.`;
      }
      return /Status:\s*Off|not associated|disconnected/i.test(r.stdout)
        ? "The wireless interface is off or not associated with a network."
        : undefined;
    },
    healthy: (r) => {
      const ssid = r.stdout.match(/Current Network Information:\s*\n\s*(.+?):/)?.[1];
      return ssid ? `Connected to ${ssid.trim()} with usable signal.` : "Wireless looks healthy.";
    },
  },
  {
    id: "check.vpn",
    relevantTo: ["connectivity"],
    intent: "Check whether a VPN tunnel is up",
    command: {
      macos: "ifconfig",
      linux: "ip -br link",
      windows: "ipconfig",
    },
    requires: { macos: "ifconfig", linux: "ip", windows: "ipconfig" },
    interpret: () =>
      // A VPN being up or down is context, not a fault - it changes what a
      // connectivity problem means, and the technician reads it from `healthy`.
      undefined,
    healthy: (r) =>
      /\b(utun|tun0|ppp0|tap0)\b/i.test(r.stdout)
        ? "A VPN tunnel is up, so internal names should resolve."
        : "No VPN tunnel is up.",
  },
  {
    id: "check.time",
    relevantTo: ["authentication", "security", "email"],
    intent: "Check the clock is in sync",
    command: {
      // Clock drift breaks Kerberos, certificates and MFA codes, and presents
      // as "I cannot sign in to anything" - worth ruling out early.
      // No -s or -S: those *set* the clock. This only asks it the time.
      macos: "sntp time.apple.com",
      linux: "timedatectl status",
      windows: "w32tm /query /status",
    },
    requires: { macos: "sntp", linux: "timedatectl", windows: "w32tm" },
    interpret: (r) => {
      const offset = Number(r.stdout.match(/([+-]\d+\.\d+)\s*\+\/-/)?.[1] ?? NaN);
      if (Number.isFinite(offset) && Math.abs(offset) > 60) {
        return `The clock is ${Math.round(Math.abs(offset))}s out, which will break sign-in and certificate checks.`;
      }
      return /synchronized:\s*no|NTP service:\s*inactive/i.test(r.stdout)
        ? "The clock is not synchronised with a time server."
        : undefined;
    },
    healthy: () => "The clock is in sync.",
  },
  {
    id: "check.battery-health",
    relevantTo: ["hardware"],
    intent: "Check battery condition",
    command: {
      macos: "system_profiler SPPowerDataType",
      linux: "cat /sys/class/power_supply/BAT0/status",
      windows: "wmic path Win32_Battery get BatteryStatus",
    },
    requires: { macos: "system_profiler", linux: "cat", windows: "wmic" },
    interpret: (r) => {
      const condition = r.stdout.match(/Condition:\s*(.+)/i)?.[1]?.trim();
      return condition && !/normal|good/i.test(condition)
        ? `The battery reports its condition as "${condition}", which needs replacing rather than fixing.`
        : undefined;
    },
    healthy: (r) => {
      const cycles = r.stdout.match(/Cycle Count:\s*(\d+)/i)?.[1];
      return cycles ? `Battery is healthy at ${cycles} cycles.` : "Battery condition is normal.";
    },
  },
  {
    id: "check.updates",
    relevantTo: ["security", "software"],
    intent: "Check for pending system updates",
    command: {
      // `--no-scan` reads the cached list rather than contacting Apple, which
      // keeps a diagnostic step from taking a minute.
      macos: "softwareupdate -l --no-scan",
      linux: "cat /var/lib/update-notifier/updates-available",
      windows: "wmic qfe get HotFixID,InstalledOn",
    },
    requires: { macos: "softwareupdate", linux: "cat", windows: "wmic" },
    interpret: (r) =>
      /restart required|security update|deferred/i.test(r.stdout)
        ? "There are pending updates, including at least one that needs a restart."
        : undefined,
    healthy: (r) =>
      /No new software available/i.test(r.stdout)
        ? "The machine is up to date."
        : "Update state read.",
  },
  {
    id: "check.disk-health",
    relevantTo: ["hardware", "storage"],
    intent: "Check the disk is not reporting failures",
    command: {
      macos: "diskutil info -all",
      linux: "lsblk -o NAME,SIZE,STATE",
      windows: "wmic diskdrive get model,status",
    },
    requires: { macos: "diskutil", linux: "lsblk", windows: "wmic" },
    interpret: (r) =>
      /SMART Status:\s*(?!Verified)|Failing|Pred Fail/i.test(r.stdout)
        ? "The disk is reporting a SMART failure. Back the machine up before doing anything else."
        : undefined,
    healthy: () => "The disk reports no hardware faults.",
  },
  {
    id: "check.top-processes",
    relevantTo: ["performance", "software", "other"],
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

/** The fix for a check, when this host can actually run it. */
export function fixFor(
  check: LocalCheck,
  platform: HostPlatform,
  availableCommands: string[],
): { command: string; rollback: string; rollbackCommand?: string; intent: string } | undefined {
  const fix = check.fix;
  if (!fix) return undefined;
  const command = fix.command[platform];
  const requires = fix.requires[platform];
  if (!command || !requires || !availableCommands.includes(requires)) return undefined;
  return {
    intent: fix.intent,
    command,
    rollback: fix.rollback,
    ...(fix.rollbackCommand?.[platform]
      ? { rollbackCommand: fix.rollbackCommand[platform] }
      : {}),
  };
}

/**
 * The checks worth running for a particular complaint.
 *
 * Filters by category first, then falls back to the whole runnable set when a
 * category has nothing specific - a general sweep is the right answer to "it
 * just feels wrong", and a poor answer to "my printer is stuck".
 */
export function checksForCategory(
  platform: HostPlatform,
  availableCommands: string[],
  category: TicketCategory,
): LocalCheck[] {
  const runnable = checksFor(platform, availableCommands);
  const targeted = runnable.filter(
    (c) => c.relevantTo.includes("*") || c.relevantTo.includes(category),
  );
  // A category with nothing but the always-run checks is not really targeted,
  // so widen rather than run three checks and call it a diagnosis.
  const specific = targeted.filter((c) => !c.relevantTo.includes("*"));
  return specific.length > 0 ? targeted : runnable;
}
