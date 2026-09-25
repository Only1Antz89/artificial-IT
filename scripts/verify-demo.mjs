import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.AIT_DEMO_URL ?? "http://127.0.0.1:3110";
const screenshotPath = resolve(
  process.env.AIT_DEMO_SCREENSHOT ?? "run-artifacts/stakeholder-demo.png",
);
/**
 * Find a browser to render the demo in.
 *
 * In order: an explicit override, then the usual install locations for this
 * platform, then whatever Playwright itself has downloaded. The last one
 * matters - it is the only branch that works in CI or on a machine with no
 * desktop browser installed, and this script is the gate the stakeholder demo
 * is signed off against, so it has to run somewhere other than one laptop.
 */
const browsersByPlatform = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/opt/pw-browsers/chromium",
  ],
};

function findBrowser() {
  const override = process.env.AIT_DEMO_BROWSER;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`AIT_DEMO_BROWSER points at ${override}, which does not exist.`);
    }
    return override;
  }

  const installed = (browsersByPlatform[process.platform] ?? []).find(existsSync);
  if (installed) return installed;

  // Playwright's own download, wherever PLAYWRIGHT_BROWSERS_PATH puts it.
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // playwright-core resolves no path when no browser has been downloaded.
  }

  throw new Error(
    "No browser found for rendered demo verification. Install Chrome, Edge or " +
      "Chromium, run `npx playwright install chromium`, or set AIT_DEMO_BROWSER " +
      "to a browser executable.",
  );
}

const executablePath = findBrowser();

mkdirSync(dirname(screenshotPath), { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
const page = await context.newPage();
const browserErrors = [];
page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
});

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#integrationList .ops-row").first().waitFor({ timeout: 10_000 });
  assert.equal(await page.locator("#integrationList .ops-row").count(), 5);
  assert.match(await page.locator("#integrationList").innerText(), /UI-TARS Desktop/i);

  await page.locator("#runPulse").click();
  await page.waitForFunction(() =>
    document.querySelectorAll("#pulseTargets .pulse-target").length === 3,
  );
  assert.match(await page.locator("#pulseSummary").innerText(), /healthy|degraded|critical/i);
  const mobileTicket = page.locator('[data-pulse-ticket="mobile-ios-0441"]');
  await mobileTicket.click();
  await page.waitForFunction(() =>
    /Opened|Already/.test(
      document.querySelector('[data-pulse-ticket="mobile-ios-0441"]')?.textContent ?? "",
    ),
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#inbox .tk")].some((ticket) =>
      /IOS-0441/i.test(ticket.textContent ?? "") && /escalated/i.test(ticket.textContent ?? ""),
    ),
  );

  await page.locator("#tabFixture").click();
  await page.locator("#scenario").selectOption("wifi-disabled");
  await page.locator("#provider").selectOption("offline");
  await page.locator("#run").click();
  const approval = page.locator(".approval:not(.settled)");
  await approval.waitFor({ timeout: 15_000 });
  assert.match(await approval.innerText(), /UI · computer\.execute_instruction/);
  await approval.locator("button.yes").click();
  await page.waitForFunction(() =>
    document.querySelector("#statusPill")?.textContent?.trim() === "resolved",
    undefined,
    { timeout: 20_000 },
  );

  const feed = await page.locator("#feed").innerText();
  assert.match(feed, /UI · computer\.execute_instruction/);
  assert.match(feed, /Connected/);
  assert.doesNotMatch(feed.split("Connected").at(-1) ?? "", /Disabled/);
  assert.match(await page.locator("#panels").innerText(), /changes made/i);

  await page.screenshot({ path: screenshotPath, fullPage: true });

  const portal = await context.newPage();
  portal.on("pageerror", (error) => browserErrors.push(`portal page: ${error.message}`));
  await portal.goto(`${baseUrl}/portal`, { waitUntil: "domcontentloaded" });
  assert.match(await portal.locator("body").innerText(), /Tell us what happened/i);
  assert.equal(await portal.locator("text=Guardrail").count(), 0);
  await portal.close();

  assert.deepEqual(browserErrors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        integrations: 5,
        pulseTargets: 3,
        desktopAction: "approved-and-verified",
        portalBoundary: "rendered",
        screenshotPath,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
