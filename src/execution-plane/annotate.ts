/**
 * Screenshot annotation.
 *
 * A screenshot on a ticket is evidence; an *annotated* screenshot is an
 * explanation. This renders the marks a technician would draw by hand - a box
 * round the thing that is wrong, an arrow to the button the user needs, a
 * caption saying what they are looking at - as SVG layered over the capture.
 *
 * SVG rather than raster on purpose: it composes without an image library, it
 * stays legible when Zendesk scales it, and the annotation text stays
 * selectable and searchable inside the ticket.
 */
import type { ScreenCapture } from "./device.js";

export type AnnotationStyle = "problem" | "action" | "info";

export interface Annotation {
  style: AnnotationStyle;
  /** Region of interest, in capture coordinates. */
  box: { x: number; y: number; width: number; height: number };
  label: string;
  /** Optional arrow drawn from this point to the box. */
  arrowFrom?: { x: number; y: number };
}

const PALETTE: Record<AnnotationStyle, { stroke: string; fill: string; text: string }> = {
  problem: { stroke: "#d92d20", fill: "#d92d2018", text: "#7a271a" },
  action: { stroke: "#175cd3", fill: "#175cd318", text: "#194185" },
  info: { stroke: "#667085", fill: "#66708514", text: "#344054" },
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wrap a caption so long labels do not run off the edge of the frame. */
function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + word.length + 1 <= maxChars) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Draw annotations over a capture and return a standalone SVG document.
 *
 * The original capture is embedded as a group rather than re-rendered, so what
 * the ticket shows is provably the frame that was captured.
 */
export function annotate(
  capture: ScreenCapture,
  annotations: Annotation[],
  caption?: string,
): string {
  const { width, height } = capture;
  const captionHeight = caption ? 44 : 0;

  // A real capture is embedded as an image; a rendered frame is inlined so its
  // vectors stay crisp. Either way the original is carried through untouched,
  // so what the ticket shows is provably the frame that was captured.
  const inner =
    capture.source === "screen-capture" && capture.png
      ? `<image x="0" y="0" width="${width}" height="${height}" href="data:image/png;base64,${capture.png}" preserveAspectRatio="none"/>`
      : (capture.svg ?? "")
          .replace(/^[\s\S]*?<svg[^>]*>/i, "")
          .replace(/<\/svg>\s*$/i, "");

  // Provenance stamp. A technician must be able to tell at a glance whether
  // they are looking at the user's actual screen or a drawing of it.
  const provenance =
    capture.source === "screen-capture"
      ? "Live screen capture"
      : "Rendered from device state (not a photograph of the screen)";

  const marks = annotations
    .map((a, index) => {
      const colors = PALETTE[a.style];
      const { x, y, width: w, height: h } = a.box;
      const lines = wrap(a.label, 34);
      const labelWidth = Math.max(...lines.map((l) => l.length)) * 7.1 + 34;
      const labelHeight = lines.length * 16 + 14;
      // Keep the label inside the frame: flip above the box when it would
      // otherwise fall off the bottom.
      const labelY = y + h + 8 + labelHeight > height ? y - labelHeight - 8 : y + h + 8;
      const labelX = Math.min(Math.max(x, 8), Math.max(8, width - labelWidth - 8));

      const arrow = a.arrowFrom
        ? `<line x1="${a.arrowFrom.x}" y1="${a.arrowFrom.y}" x2="${x + w / 2}" y2="${y + h / 2}" stroke="${colors.stroke}" stroke-width="2.5" marker-end="url(#arrow-${a.style})" opacity="0.9"/>`
        : "";

      return `
  <g class="annotation annotation-${a.style}">
    ${arrow}
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="3" rx="6"/>
    <g>
      <rect x="${labelX}" y="${labelY}" width="${labelWidth}" height="${labelHeight}" fill="#ffffff" stroke="${colors.stroke}" stroke-width="1.5" rx="6" opacity="0.97"/>
      <circle cx="${labelX + 16}" cy="${labelY + labelHeight / 2}" r="10" fill="${colors.stroke}"/>
      <text x="${labelX + 16}" y="${labelY + labelHeight / 2 + 4}" font-family="system-ui, sans-serif" font-size="11" font-weight="700" fill="#ffffff" text-anchor="middle">${index + 1}</text>
${lines
  .map(
    (l, i) =>
      `      <text x="${labelX + 32}" y="${labelY + 19 + i * 16}" font-family="system-ui, sans-serif" font-size="12.5" fill="${colors.text}">${escapeXml(l)}</text>`,
  )
  .join("\n")}
    </g>
  </g>`;
    })
    .join("\n");

  const captionBar = caption
    ? `
  <g class="caption">
    <rect x="0" y="${height}" width="${width}" height="${captionHeight}" fill="#101828"/>
    <text x="16" y="${height + 27}" font-family="system-ui, sans-serif" font-size="14" fill="#ffffff">${escapeXml(caption)}</text>
    <text x="${width - 16}" y="${height + 27}" font-family="system-ui, sans-serif" font-size="11" fill="#98a2b3" text-anchor="end">${escapeXml(provenance)}</text>
  </g>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + captionHeight}" viewBox="0 0 ${width} ${height + captionHeight}" role="img" aria-label="${escapeXml(caption ?? capture.description)}">
  <defs>
${(["problem", "action", "info"] as AnnotationStyle[])
  .map(
    (style) =>
      `    <marker id="arrow-${style}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${PALETTE[style].stroke}"/></marker>`,
  )
  .join("\n")}
  </defs>
  <g class="capture">${inner}</g>
${marks}
${captionBar}
</svg>`;
}
