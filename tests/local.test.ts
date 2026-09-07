/**
 * Tests for running against a real machine.
 *
 * These execute genuine commands on whatever host runs the suite, so they are
 * written to assert on properties that hold anywhere rather than on this
 * machine's particular numbers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLocal } from "../src/demo/run-local.js";
import { hostPlatform, localDangerTicket, localDevice } from "../src/demo/local.js";
import {
  checksFor,
  parseDiskUsage,
  parseMemoryUsage,
  parseWindowsDisk,
} from "../src/agent/local-playbooks.js";
import { pngDimensions, splitArgv } from "../src/execution-plane/device.js";

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "ait-local-"));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("output interpreters", () => {
  it("reads percent used from df", () => {
    const df = `Filesystem      Size  Used Avail Use% Mounted on
/dev/vda        252G  8.3G   29G  23% /`;
    expect(parseDiskUsage(df)).toBe(23);
  });

  it("reads percent used from wmic", () => {
    const wmic = `Name  FreeSpace     Size
C:    10000000000   100000000000`;
    expect(parseWindowsDisk(wmic)).toBe(90);
  });

  it("reads memory pressure from free", () => {
    const free = `               total        used        free      shared  buff/cache   available
Mem:           16075         899       13704          12        1775       15175`;
    expect(parseMemoryUsage(free)).toBe(6);
  });

  it("reads memory pressure from vm_stat", () => {
    const vmstat = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                          100000.
Pages active:                         50000.
Pages inactive:                       50000.
Pages wired down:                     50000.`;
    // 100k used of 250k total.
    expect(parseMemoryUsage(vmstat)).toBe(40);
  });

  // Real macOS output, since the macOS path cannot be exercised on CI Linux.
  // Apple Silicon uses 16K pages, `df` labels the column "Capacity" and carries
  // a second percentage (%iused) that must not be mistaken for it, and every
  // vm_stat value ends with a period.
  describe("macOS output shapes", () => {
    const dfApple = `Filesystem       Size   Used  Avail Capacity iused      ifree %iused  Mounted on
/dev/disk3s1s1  926Gi  9.6Gi  111Gi     8%  404163 1163983797    0%   /`;

    const dfFull = `Filesystem       Size   Used  Avail Capacity iused      ifree %iused  Mounted on
/dev/disk3s1s1  494Gi  466Gi   23Gi    96%  512000  999999999    1%   /`;

    const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               47230.
Pages active:                            803416.
Pages inactive:                          792628.
Pages speculative:                        12442.
Pages wired down:                        246971.`;

    const vmStatPressed = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                1200.
Pages active:                           1900000.
Pages inactive:                            8000.
Pages wired down:                        400000.`;

    it("reads the Capacity column, not %iused", () => {
      expect(parseDiskUsage(dfApple)).toBe(8);
      expect(parseDiskUsage(dfFull)).toBe(96);
    });

    it("reads Apple Silicon vm_stat, periods and all", () => {
      const healthy = parseMemoryUsage(vmStat);
      expect(healthy).toBeGreaterThan(0);
      expect(healthy).toBeLessThan(92); // a normal Mac must not trip the alert
      expect(parseMemoryUsage(vmStatPressed)).toBeGreaterThanOrEqual(92);
    });

    it("reads load average from macOS uptime, which pluralises it", () => {
      const mac = "20:15  up 3 days, 10:22, 2 users, load averages: 1.53 1.72 1.86";
      expect(mac.match(/load average[s]?:\s*([\d.]+)/i)?.[1]).toBe("1.53");
    });

    it("reads %MEM from macOS ps column order", () => {
      const ps = `  PID %MEM %CPU COMM
  482 61.9  3.1 /Applications/Leaky.app/Contents/MacOS/leaky`;
      const cols = ps.trim().split("\n")[1]!.trim().split(/\s+/);
      expect(Number(cols[1])).toBe(61.9);
      expect(cols[3]).toContain("leaky");
    });
  });

  it("returns undefined rather than guessing on output it cannot parse", () => {
    expect(parseDiskUsage("not a df table")).toBeUndefined();
    expect(parseMemoryUsage("not memory output")).toBeUndefined();
  });
});

describe("checks are filtered by what the host actually has", () => {
  it("proposes nothing that needs a missing tool", () => {
    const checks = checksFor("linux", ["df", "uname"]);
    const ids = checks.map((c) => c.id);
    expect(ids).toContain("check.disk");
    expect(ids).toContain("check.identity");
    // No `free`, no `ps`, no `getent` - so none of those checks are offered.
    expect(ids).not.toContain("check.memory");
    expect(ids).not.toContain("check.dns");
    expect(ids).not.toContain("check.top-processes");
  });

  it("offers nothing at all when the host has nothing", () => {
    expect(checksFor("linux", [])).toHaveLength(0);
  });
});

describe("argv splitting", () => {
  it("keeps quoted arguments whole", () => {
    expect(splitArgv('grep -n "hello world" file.txt')).toEqual([
      "grep",
      "-n",
      "hello world",
      "file.txt",
    ]);
  });

  it("collapses repeated whitespace", () => {
    expect(splitArgv("  ps   aux  ")).toEqual(["ps", "aux"]);
  });
});

describe("PNG header parsing", () => {
  it("reads dimensions from a real PNG header", () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]),
      Buffer.from("IHDR", "ascii"),
      (() => {
        const b = Buffer.alloc(8);
        b.writeUInt32BE(1920, 0);
        b.writeUInt32BE(1080, 4);
        return b;
      })(),
    ]);
    expect(pngDimensions(png)).toEqual({ width: 1920, height: 1080 });
  });

  it("returns undefined for something that is not a PNG", () => {
    expect(pngDimensions(Buffer.from("definitely not a png"))).toBeUndefined();
  });
});

// The runs below execute real commands. Skipped on a platform AIT has no
// diagnostic set for, rather than asserting something meaningless.
const platform = hostPlatform();
const describeIfSupported = platform === "unknown" ? describe.skip : describe;

describeIfSupported("running against this machine", () => {
  it("describes the host it is actually on", () => {
    const device = localDevice();
    expect(device.platform).toBe(platform);
    expect(device.hostname.length).toBeGreaterThan(0);
    // Consent is a real decision here: you started the process on your own box.
    expect(device.consent_granted).toBe(true);
  });

  it("runs real read-only checks and changes nothing", async () => {
    const { run, capabilities } = await runLocal({
      scenario: "local-health",
      provider: "offline",
      workdir,
    });

    expect(capabilities.availableCommands.length).toBeGreaterThan(0);

    const executed = run.results.filter((r) => r.outcome === "success");
    expect(executed.length).toBeGreaterThan(0);

    // The defining property: a health check never mutates.
    expect(run.results.every((r) => !r.step.mutating)).toBe(true);

    // And the output is real - a genuine command with a genuine exit code.
    const withOutput = executed.find((r) => r.command);
    expect(withOutput?.command?.exit_code).toBe(0);
    expect(withOutput?.command?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("does not invent a fault on a machine that has none", async () => {
    const { run } = await runLocal({
      scenario: "local-health",
      provider: "offline",
      workdir,
    });

    // Either it found something genuinely wrong and escalated, or it found
    // nothing and said so. What it must never do is claim a fix.
    const changed = run.results.filter((r) => r.outcome === "success" && r.step.mutating);
    expect(changed).toHaveLength(0);

    if (run.status === "resolved") {
      expect(run.documentation!.root_cause).toMatch(/no fault found/i);
      expect(run.documentation!.user_reply).toMatch(/haven't changed anything/i);
      expect(run.documentation!.resolution).toMatch(/no change was needed/i);
    }
  });

  it("refuses every dangerous request aimed at this machine", async () => {
    const { run } = await runLocal({
      scenario: "local-danger",
      provider: "offline",
      workdir,
    });

    const blocked = run.results.filter((r) => r.outcome === "blocked");
    expect(blocked.length).toBeGreaterThanOrEqual(3);

    const categories = new Set(blocked.flatMap((b) => b.verdict.categories));
    expect(categories.has("credentials")).toBe(true);
    expect(categories.has("destructive")).toBe(true);
    expect(categories.has("security-controls")).toBe(true);

    // Nothing ran at all: no command result exists on any step.
    expect(run.results.every((r) => r.command === undefined)).toBe(true);
    expect(run.status).toBe("escalated");
  });

  it("puts the real platform's command in the refused step", async () => {
    const ticket = localDangerTicket();
    expect(ticket.device?.platform).toBe(platform);

    const { run } = await runLocal({
      scenario: "local-danger",
      provider: "offline",
      workdir,
    });

    const commands = run.results.map((r) => String(r.step.payload["command"]));
    // A technician reading the ticket sees what was actually asked for on this
    // OS, not a Windows command on a Mac.
    if (platform === "windows") {
      expect(commands.some((c) => /net user|Remove-Item/i.test(c))).toBe(true);
    } else {
      expect(commands.some((c) => /passwd|rm -rf/i.test(c))).toBe(true);
    }
  });
});
