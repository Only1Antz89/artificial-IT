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

/** The macOS storage pane on a volume that has almost nothing left. */
export function storageScreen(state: DeviceState): ScreenCapture {
  const used = Number(state["disk_percent"] ?? 0);
  const free = Math.max(0, 100 - used);
  const barW = W - 200;
  const usedW = Math.round((barW * used) / 100);

  // The four largest categories, sized so they add up to the used portion.
  const segments: [string, number, string][] = [
    ["Documents", 0.42, "#175cd3"],
    ["Photos", 0.24, "#2e90fa"],
    ["Applications", 0.19, "#84caff"],
    ["System Data", 0.15, "#b2ddff"],
  ];
  let x = 100;
  const bars = segments
    .map(([, share, fill]) => {
      const w = Math.round(usedW * share);
      const rect = `<rect x="${x}" y="150" width="${w}" height="34" fill="${fill}"/>`;
      x += w;
      return rect;
    })
    .join("\n  ");

  const legend = segments
    .map(([label, share, fill], i) => {
      const y = 232 + i * 30;
      return `<rect x="100" y="${y - 11}" width="12" height="12" rx="3" fill="${fill}"/>
  <text x="122" y="${y}" font-family="system-ui, sans-serif" font-size="13" fill="#101828">${esc(label)}</text>
  <text x="${W - 100}" y="${y}" font-family="system-ui, sans-serif" font-size="13" fill="#475467" text-anchor="end">${Math.round(468 * share)} GB</text>`;
    })
    .join("\n  ");

  const body = `<rect x="40" y="70" width="${W - 80}" height="${H - 120}" fill="#ffffff" stroke="#d0d5dd" rx="8"/>
  <text x="100" y="120" font-family="system-ui, sans-serif" font-size="18" font-weight="700" fill="#101828">Macintosh HD</text>
  <rect x="100" y="150" width="${barW}" height="34" rx="4" fill="#eaecf0"/>
  ${bars}
  <text x="100" y="208" font-family="system-ui, sans-serif" font-size="13.5" fill="${free < 10 ? "#b42318" : "#475467"}">${free < 10 ? `Your disk is almost full — only ${free}% (21 GB) available of 494 GB` : `${free}% available of 494 GB`}</text>
  ${legend}`;

  return {
    source: "rendered",
    svg: chrome("Storage — Macintosh HD", body),
    width: W,
    height: H,
    description: `Storage pane showing the volume ${used}% full with ${free}% free.`,
  };
}

/** A VPN client that keeps losing its tunnel over a weak wireless link. */
export function vpnScreen(state: DeviceState): ScreenCapture {
  const signal = Number(state["wifi_signal"] ?? 100);
  const weak = signal < 40;
  const bars = Array.from({ length: 5 }, (_, i) => {
    const lit = signal >= (i + 1) * 20;
    const h = 8 + i * 7;
    return `<rect x="${104 + i * 14}" y="${168 - h}" width="9" height="${h}" rx="2" fill="${lit ? (weak ? "#f79009" : "#12b76a") : "#eaecf0"}"/>`;
  }).join("\n  ");

  const log = [
    "09:41:02  Tunnel established (gw-lon-01)",
    "09:43:18  Keepalive missed (3 of 3)",
    "09:43:19  Tunnel down — reconnecting",
    "09:43:44  Tunnel established (gw-lon-01)",
    "09:45:57  Tunnel down — reconnecting",
  ]
    .map(
      (line, i) =>
        `<text x="100" y="${300 + i * 26}" font-family="ui-monospace, monospace" font-size="12.5" fill="${line.includes("down") ? "#b42318" : "#475467"}">${esc(line)}</text>`,
    )
    .join("\n  ");

  const body = `<rect x="40" y="70" width="${W - 80}" height="${H - 120}" fill="#ffffff" stroke="#d0d5dd" rx="8"/>
  <text x="100" y="118" font-family="system-ui, sans-serif" font-size="18" font-weight="700" fill="#101828">GlobalProtect</text>
  <text x="100" y="144" font-family="system-ui, sans-serif" font-size="13.5" fill="${weak ? "#b42318" : "#027a48"}">${weak ? "Disconnected — reconnecting" : "Connected"}</text>
  ${bars}
  <text x="184" y="168" font-family="system-ui, sans-serif" font-size="13" fill="#475467">Travelodge_Guest — signal ${signal}%</text>
  <text x="100" y="268" font-family="system-ui, sans-serif" font-size="11.5" font-weight="700" fill="#475467">CONNECTION LOG</text>
  ${log}`;

  return {
    source: "rendered",
    svg: chrome("GlobalProtect — Connection", body),
    width: W,
    height: H,
    description: weak
      ? `VPN client reconnecting in a loop on a ${signal}% wireless signal.`
      : `VPN client connected on a ${signal}% wireless signal.`,
  };
}
