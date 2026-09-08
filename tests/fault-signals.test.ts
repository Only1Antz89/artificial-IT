/**
 * Fault predicates over real command output.
 *
 * A substring match can say "this output contains NXDOMAIN". It cannot say
 * "this volume is over 90% full", and hardcoding `96%` would test the fixture
 * rather than the fault. These parse the number.
 */
import { describe, expect, it } from "vitest";
import { diskPercentUsed, wifiSignalPercent } from "../src/agent/playbooks.js";

describe("reading disk usage out of a report", () => {
  it("reads the Capacity column from Apple Silicon df output", () => {
    const out = `Filesystem       Size   Used  Avail Capacity iused      ifree %iused  Mounted on
/dev/disk3s1s1  494Gi  468Gi   21Gi    96%  512003 1163983797    0%   /`;
    // The second percentage in that line is %iused, which is 0 - taking the
    // wrong one would report a healthy disk on a full machine.
    expect(diskPercentUsed(out)).toBe(96);
  });

  it("reads the Use% column from Linux df output", () => {
    const out = `Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        40G   12G   27G  32% /`;
    expect(diskPercentUsed(out)).toBe(32);
  });

  it("computes a percentage from wmic's raw byte counts", () => {
    const out = `FreeSpace     Name  Size
10737418240   C:    536870912000`;
    expect(diskPercentUsed(out)).toBe(98);
  });

  it("returns undefined rather than guessing on output it cannot parse", () => {
    expect(diskPercentUsed("command not found")).toBeUndefined();
  });
});

describe("reading wireless signal strength", () => {
  it("reads the percentage netsh reports", () => {
    const out = `    Name                   : Wi-Fi
    State                  : connected
    SSID                   : Travelodge_Guest
    Signal                 : 28%`;
    expect(wifiSignalPercent(out)).toBe(28);
  });

  it("does not mistake another percentage on the line for the signal", () => {
    expect(wifiSignalPercent("    Receive rate (Mbps)    : 6.5\n    Signal : 71%")).toBe(71);
  });

  it("returns undefined when there is no signal line", () => {
    expect(wifiSignalPercent("Name : Ethernet\nState : connected")).toBeUndefined();
  });
});
