import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.AIT_DEMO_URL ?? "http://127.0.0.1:3110";
const screenshotPath = resolve(
  process.env.AIT_DEMO_SCREENSHOT ?? "run-artifacts/stakeholder-demo.png",
);
const chromeCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const executablePath = chromeCandidates.find(existsSync);
if (!executablePath) throw new Error("Chrome or Edge is required for rendered demo verification.");

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
