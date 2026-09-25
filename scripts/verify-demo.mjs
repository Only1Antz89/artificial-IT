import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.AIT_DEMO_URL ?? "http://127.0.0.1:3110";
const portalUrl = process.env.AIT_DEMO_PORTAL_URL ?? "http://127.0.0.1:3111";
const screenshotPath = resolve(
  process.env.AIT_DEMO_SCREENSHOT ?? "run-artifacts/stakeholder-demo.png",
);
const settingsScreenshotPath = resolve(
  process.env.AIT_DEMO_SETTINGS_SCREENSHOT ?? "run-artifacts/settings-page.png",
);
const narrowSettingsScreenshotPath = settingsScreenshotPath.replace(
  /(\.[^.]+)$/,
  "-mobile$1",
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
  await page.locator("#demoQueue .tk").first().waitFor({ timeout: 10_000 });
  assert.equal(await page.locator("#demoQueue .tk").count(), 10);
  assert.equal(await page.locator("#operationsCard").count(), 0);
  await page.locator('#demoQueue [data-demo-ticket="printer-stuck"]').click();
  assert.equal(await page.locator("#scenario").inputValue(), "printer-stuck");
  assert.match(await page.locator("#stage").innerText(), /Ready to demonstrate/i);

  const settings = await context.newPage();
  settings.on("pageerror", (error) => browserErrors.push(`settings page: ${error.message}`));
  await settings.goto(`${baseUrl}/settings`, { waitUntil: "domcontentloaded" });
  assert.match(await settings.locator("h1").innerText(), /Options & settings/i);
  await settings.locator("#integrationList .ops-row").first().waitFor({ timeout: 10_000 });
  assert.equal(await settings.locator("#integrationList .ops-row").count(), 5);
  assert.match(await settings.locator("#integrationList").innerText(), /UI-TARS Desktop/i);
  assert.equal(await settings.locator('input[type="password"]').count(), 3);
  assert.equal(await settings.locator("select#geminiModel").count(), 1);
  assert.ok(await settings.locator("select#geminiModel option").count() >= 5);
  assert.equal(await settings.locator("select#claudeModel").count(), 1);
  assert.equal(await settings.locator("select#openaiModel").count(), 1);
  assert.match(await settings.locator("body").innerText(), /runtime|running AIT process/i);

  await settings.locator("#runPulse").click();
  await settings.waitForFunction(() =>
    document.querySelectorAll("#pulseTargets .pulse-target").length === 3,
  );
  assert.match(await settings.locator("#pulseSummary").innerText(), /healthy|degraded|critical/i);
  const mobileTicket = settings.locator('[data-pulse-ticket="mobile-ios-0441"]');
  await mobileTicket.click();
  await settings.waitForFunction(() =>
    /Opened|Already/.test(
      document.querySelector('[data-pulse-ticket="mobile-ios-0441"]')?.textContent ?? "",
    ),
  );
  await settings.screenshot({ path: settingsScreenshotPath, fullPage: true });
  await settings.close();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#inbox .tk")].some((ticket) =>
      /IOS-0441/i.test(ticket.textContent ?? "") && /escalated/i.test(ticket.textContent ?? ""),
    ),
  );

  await page.locator("#tabLive").click();
  await page.locator("#freeText").fill("Wi-Fi is switched off and I cannot turn it back on");
  await page.locator("#target").selectOption("simulated-host-over-the-wire");
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
  const internalNote = page.locator(".note-markdown");
  assert.equal(await internalNote.count(), 1);
  assert.match(await internalNote.locator("h1").textContent(), /AIT — automated triage/i);
  assert.equal(await internalNote.locator(".md-orange").count() > 0, true);
  assert.equal(await internalNote.locator("u").count() > 0, true);
  assert.doesNotMatch(await internalNote.textContent(), /\*\*|^#{1,3}\s/m);
  await page.locator("details summary").filter({ hasText: "Internal note" }).click();

  await page.screenshot({ path: screenshotPath, fullPage: true });

  const portal = await context.newPage();
  portal.on("pageerror", (error) => browserErrors.push(`portal page: ${error.message}`));
  await portal.goto(portalUrl, { waitUntil: "domcontentloaded" });
  assert.match(await portal.locator("body").innerText(), /Tell us what happened/i);
  assert.equal(await portal.locator("text=Guardrail").count(), 0);
  await portal.close();

  const narrowContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const narrow = await narrowContext.newPage();
  narrow.on("pageerror", (error) => browserErrors.push(`narrow settings page: ${error.message}`));
  await narrow.goto(`${baseUrl}/settings`, { waitUntil: "domcontentloaded" });
  const narrowLayout = await narrow.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    fieldColumns: getComputedStyle(document.querySelector(".fields")).gridTemplateColumns,
  }));
  assert.equal(narrowLayout.innerWidth, 390);
  assert.ok(narrowLayout.scrollWidth <= narrowLayout.innerWidth);
  assert.doesNotMatch(narrowLayout.fieldColumns, /\s/);
  await narrow.screenshot({ path: narrowSettingsScreenshotPath, fullPage: true });
  await narrowContext.close();

  assert.deepEqual(browserErrors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        demoTickets: 10,
        integrations: 5,
        pulseTargets: 3,
        desktopAction: "approved-and-verified",
        optionsPage: "model-dropdowns-rendered",
        internalNote: "safe-branded-markdown-rendered",
        portalBoundary: "rendered",
        screenshotPath,
        settingsScreenshotPath,
        narrowSettingsScreenshotPath,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
