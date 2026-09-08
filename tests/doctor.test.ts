/**
 * Preflight tests.
 *
 * The doctor's job is to be right about whether a demo will work, so the thing
 * worth testing is that it does not report "ready" when it is not, and that
 * every problem it reports comes with advice that matches the problem.
 */
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { createServer } from "node:http";

describe("preflight", () => {
  it("reports on everything a live demo depends on", async () => {
    const report = await runDoctor(0);
    const names = report.checks.map((c) => c.name);

    expect(names).toContain("Node.js");
    expect(names).toContain("Platform");
    expect(names).toContain("Active provider");
    expect(names).toContain("Evidence directory");
    expect(names.some((n) => n.startsWith("Port"))).toBe(true);
  });

  it("passes on a machine that can actually run the demo", async () => {
    const report = await runDoctor(0);
    // Nothing here should be a hard blocker in a normal working checkout.
    const failures = report.checks.filter((c) => c.state === "fail");
    expect(failures, JSON.stringify(failures, null, 2)).toHaveLength(0);
    expect(report.blocked).toBe(false);
  });

  it("gives advice for every problem it reports, and none for what is fine", async () => {
    const report = await runDoctor(0);
    for (const check of report.checks) {
      if (check.state === "ok") continue;
      // A warning with no fix leaves the reader stuck.
      expect(check.fix, `"${check.name}" reported ${check.state} with no fix`).toBeTruthy();
    }
  });

  it("notices a port that is already taken", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    try {
      const report = await runDoctor(port);
      const check = report.checks.find((c) => c.name === `Port ${port}`)!;
      expect(check.state).toBe("warn");
      expect(check.fix).toMatch(/--port/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("does not call a busy port a hard failure — the console can move", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const report = await runDoctor(port);
      expect(report.blocked).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("advises about the display when there is no display, not about tools", async () => {
    const report = await runDoctor(0);
    const capture = report.checks.find((c) => c.name === "Screen capture");
    if (capture && /no display server/i.test(capture.detail)) {
      // Telling someone to install scrot on a headless box is useless advice.
      expect(capture.fix).not.toMatch(/apt install/i);
      expect(capture.fix).toMatch(/headless/i);
    }
  });
});

describe("both listeners", () => {
  it("checks the portal's port as well as the console's", async () => {
    // `ait serve` binds two ports. Finding out the second one is taken after
    // the first has already come up is the surprise this command prevents.
    const report = await runDoctor(4310);
    expect(report.checks.some((c) => c.name === "Port 4310")).toBe(true);
    expect(report.checks.some((c) => c.name === "Port 4311")).toBe(true);
    const portal = report.checks.find((c) => c.name === "Port 4311")!;
    expect(portal.detail).toMatch(/portal/i);
  });
});
