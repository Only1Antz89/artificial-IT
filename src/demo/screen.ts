/**
 * Screen rendering for simulated devices.
 *
 * The demo has no display attached, so the "screenshot" is drawn from the
 * device's own state. This keeps the annotation pipeline honest: the frame the
 * agent marks up is generated from the same state its commands read, so a box
 * drawn round an error is drawn round an error that is genuinely there.
 */
import type { DeviceState } from "../execution-plane/device.js";
import type { ScreenCapture } from "../execution-plane/device.js";

const W = 900;
const H = 560;

/**
 * Escape text destined for an SVG text node.
 *
 * Not optional: a window title like "Printers & scanners" produces a document
 * that no SVG parser will accept, and the failure is silent - the browser just
 * renders nothing where the screenshot should be.
 */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function chrome(title: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#f2f4f7"/>
  <rect x="0" y="0" width="${W}" height="34" fill="#1d2939"/>
  <circle cx="18" cy="17" r="5" fill="#f04438"/><circle cx="36" cy="17" r="5" fill="#f79009"/><circle cx="54" cy="17" r="5" fill="#12b76a"/>
  <text x="76" y="22" font-family="system-ui, sans-serif" font-size="12.5" fill="#eaecf0">${esc(title)}</text>
  ${body}
</svg>`;
}

/** A browser window failing to load an internal site. */
export function browserScreen(state: DeviceState): ScreenCapture {
  const resolves = state["dns_cache_stale"] === false;
  const body = resolves
    ? `<rect x="40" y="70" width="${W - 80}" height="${H - 120}" fill="#ffffff" stroke="#d0d5dd" rx="8"/>
  <rect x="60" y="92" width="${W - 120}" height="34" fill="#f9fafb" stroke="#d0d5dd" rx="6"/>
  <text x="74" y="114" font-family="system-ui, sans-serif" font-size="13" fill="#101828">https://intranet.corp.local</text>
  <text x="72" y="180" font-family="system-ui, sans-serif" font-size="22" font-weight="700" fill="#101828">Corp Intranet</text>
  <text x="72" y="212" font-family="system-ui, sans-serif" font-size="14" fill="#475467">Welcome back. Today's notices are below.</text>
  <rect x="72" y="236" width="360" height="90" fill="#f2f4f7" rx="6"/>
  <rect x="452" y="236" width="360" height="90" fill="#f2f4f7" rx="6"/>`
    : `<rect x="40" y="70" width="${W - 80}" height="${H - 120}" fill="#ffffff" stroke="#d0d5dd" rx="8"/>
  <rect x="60" y="92" width="${W - 120}" height="34" fill="#f9fafb" stroke="#d0d5dd" rx="6"/>
  <text x="74" y="114" font-family="system-ui, sans-serif" font-size="13" fill="#101828">https://intranet.corp.local</text>
  <text x="300" y="250" font-family="system-ui, sans-serif" font-size="20" font-weight="700" fill="#344054">This site can't be reached</text>
  <text x="248" y="282" font-family="system-ui, sans-serif" font-size="14" fill="#667085">intranet.corp.local's server IP address could not be found.</text>
  <text x="372" y="312" font-family="ui-monospace, monospace" font-size="13" fill="#b42318">ERR_NAME_NOT_RESOLVED</text>
  <rect x="392" y="344" width="116" height="34" fill="#175cd3" rx="6"/>
  <text x="450" y="366" font-family="system-ui, sans-serif" font-size="13" fill="#ffffff" text-anchor="middle">Reload</text>`;

  return {
    source: "rendered",
    svg: chrome("Corp Intranet — Browser", body),
    width: W,
    height: H,
    description: resolves
      ? "Browser showing the intranet home page loading normally."
      : "Browser showing ERR_NAME_NOT_RESOLVED for intranet.corp.local.",
  };
}

/** A print queue with jobs stuck because the spooler has stopped. */
export function printQueueScreen(state: DeviceState): ScreenCapture {
  const stopped = state["spooler_running"] === false;
  const jobs = Number(state["queued_jobs"] ?? 0);

  const rows = Array.from({ length: Math.min(jobs, 4) }, (_, i) => {
    const y = 210 + i * 42;
    return `<rect x="60" y="${y}" width="${W - 120}" height="36" fill="${i % 2 ? "#f9fafb" : "#ffffff"}" stroke="#eaecf0"/>
  <text x="76" y="${y + 23}" font-family="system-ui, sans-serif" font-size="13" fill="#101828">Q4-report-v${i + 1}.pdf</text>
  <text x="470" y="${y + 23}" font-family="system-ui, sans-serif" font-size="13" fill="#101828">3 pages</text>
  <text x="640" y="${y + 23}" font-family="system-ui, sans-serif" font-size="13" fill="${stopped ? "#b42318" : "#027a48"}">${stopped ? "Error - Printing" : "Printing"}</text>`;
  }).join("\n  ");

  const body = `<rect x="40" y="70" width="${W - 80}" height="${H - 120}" fill="#ffffff" stroke="#d0d5dd" rx="8"/>
  <text x="60" y="112" font-family="system-ui, sans-serif" font-size="18" font-weight="700" fill="#101828">HP-LaserJet-4F (Floor 3)</text>
  <text x="60" y="140" font-family="system-ui, sans-serif" font-size="13.5" fill="${stopped ? "#b42318" : "#027a48"}">Status: ${stopped ? "Paused — print spooler not running" : "Ready"}</text>
  <text x="60" y="164" font-family="system-ui, sans-serif" font-size="13.5" fill="#475467">${jobs} document(s) in queue</text>
  <rect x="60" y="186" width="${W - 120}" height="24" fill="#f2f4f7"/>
  <text x="76" y="203" font-family="system-ui, sans-serif" font-size="11.5" font-weight="700" fill="#475467">DOCUMENT</text>
  <text x="470" y="203" font-family="system-ui, sans-serif" font-size="11.5" font-weight="700" fill="#475467">SIZE</text>
  <text x="640" y="203" font-family="system-ui, sans-serif" font-size="11.5" font-weight="700" fill="#475467">STATUS</text>
  ${rows}`;

  return {
    source: "rendered",
    svg: chrome("Printers & scanners — HP-LaserJet-4F", body),
    width: W,
    height: H,
    description: stopped
      ? `Print queue showing ${jobs} job(s) stuck with the spooler paused.`
      : `Print queue showing ${jobs} job(s) printing normally.`,
  };
}
