/**
 * Two surfaces, one process.
 *
 * The `userView` allowlist has always been the boundary between what a
 * technician sees and what a user sees. Running each half on its own listener
 * adds a second, structural one: on the port the user's browser is pointed at,
 * the technician API is not a forbidden route, it is not a route at all.
 *
 * Both boundaries are tested here, because either alone is a single point of
 * failure and this is the part of the product where a mistake is a disclosure.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../src/server/index.js";

let stop: () => Promise<void>;
let consoleBase: string;
let portalBase: string;
let workdir: string;

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "ait-surfaces-"));
  const s = await startServer({ port: 0, portalPort: 0, workdir });
  consoleBase = `http://localhost:${s.port}`;
  portalBase = `http://localhost:${s.portalPort}`;
  stop = s.close;
});

afterAll(async () => {
  await stop();
  rmSync(workdir, { recursive: true, force: true });
});

describe("the portal listener", () => {
  it("serves the user's page at its own root", async () => {
    const html = await (await fetch(`${portalBase}/`)).text();
    expect(html).toContain("IT Support");
    expect(html.toLowerCase()).not.toContain("technician console");
  });

  const forbidden = [
    "/api/desk",
    "/api/desk/events",
    "/api/scenarios",
    "/api/knowledge",
    "/api/providers",
    "/api/runs",
    "/api/runs/anything/events",
  ];

  for (const path of forbidden) {
    it(`does not serve ${path}`, async () => {
      const res = await fetch(`${portalBase}${path}`);
      expect(res.status).toBe(404);
    });
  }

  it("refuses to start a run, not just to describe one", async () => {
    const res = await fetch(`${portalBase}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "dns-outage", provider: "offline" }),
    });
    expect(res.status).toBe(404);
  });

  it("serves only the targets a report can be pointed at, not the catalogue", async () => {
    const body = (await (await fetch(`${portalBase}/api/portal/targets`)).json()) as {
      targets: { key: string }[];
      simulated?: unknown;
    };
    expect(body.targets.length).toBeGreaterThan(0);
    expect(body.simulated).toBeUndefined();
  });

  it("still takes a report", async () => {
    const res = await fetch(`${portalBase}/api/portal/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "The intranet page will not load and says the site cannot be reached.",
        reportedBy: "Priya",
        target: "no-device",
        provider: "offline",
      }),
    });
    expect(res.status).toBe(202);
  });
});

describe("the console listener", () => {
  it("serves the technician's page at its own root", async () => {
    const html = await (await fetch(`${consoleBase}/`)).text();
    expect(html.toLowerCase()).toContain("technician console");
  });

  it("points its portal link at the port the portal is actually on", async () => {
    const html = await (await fetch(`${consoleBase}/`)).text();
    expect(html).not.toContain("__PORTAL_URL__");
    expect(html).toContain(`${portalBase}/`);
  });

  it("does not serve the portal's page or API", async () => {
    expect((await fetch(`${consoleBase}/portal`)).status).toBe(404);
    expect((await fetch(`${consoleBase}/api/portal/targets`)).status).toBe(404);
  });

  it("serves the technician API", async () => {
    expect((await fetch(`${consoleBase}/api/scenarios`)).status).toBe(200);
    expect((await fetch(`${consoleBase}/api/desk`)).status).toBe(200);
  });
});

describe("one process, one port", () => {
  it("serves both halves when no portal port is asked for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ait-single-"));
    const s = await startServer({ port: 0, workdir: dir });
    const base = `http://localhost:${s.port}`;
    try {
      expect((await fetch(`${base}/`)).status).toBe(200);
      expect((await fetch(`${base}/portal`)).status).toBe(200);
      expect((await fetch(`${base}/api/desk`)).status).toBe(200);
      expect((await fetch(`${base}/api/portal/targets`)).status).toBe(200);
      // With one port there is nowhere else for the link to point.
      expect(await (await fetch(`${base}/`)).text()).toContain('href="/portal"');
    } finally {
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
