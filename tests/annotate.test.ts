/**
 * Annotation and evidence tests.
 *
 * The failure mode being guarded against is a silent one: an SVG containing an
 * unescaped `&` is rejected by the browser's parser and renders as nothing, so
 * a ticket ends up with an attachment that shows a blank box and no error.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { annotate, type Annotation } from "../src/execution-plane/annotate.js";
import type { ScreenCapture } from "../src/execution-plane/device.js";
import { EvidenceStore } from "../src/execution-plane/evidence-store.js";
import { browserScreen, printQueueScreen } from "../src/demo/screen.js";

/**
 * A deliberately strict well-formedness check.
 *
 * Node has no DOM parser built in, so this checks the properties that actually
 * break SVG rendering: balanced tags, and no bare `&` outside an entity.
 */
function assertWellFormed(svg: string): void {
  const bareAmp = svg.match(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi);
  expect(bareAmp, `unescaped & found: ${bareAmp?.slice(0, 3)}`).toBeNull();

  const opens = [...svg.matchAll(/<([a-z][a-z0-9]*)(\s[^>]*?)?(\/?)>/gi)];
  const stack: string[] = [];
  for (const match of opens) {
    const [, tag, , selfClosing] = match;
    if (selfClosing) continue;
    stack.push(tag!);
  }
  const closes = [...svg.matchAll(/<\/([a-z][a-z0-9]*)>/gi)].map((m) => m[1]!);
  expect(stack.length).toBe(closes.length);
}

const ANNOTATIONS: Annotation[] = [
  {
    style: "problem",
    box: { x: 240, y: 228, width: 430, height: 96 },
    label: "Name lookup is failing, not the connection itself",
  },
  {
    style: "action",
    box: { x: 56, y: 88, width: 792, height: 42 },
    label: "Address is correct & the request never left the machine",
    arrowFrom: { x: 700, y: 200 },
  },
];

describe("annotated captures", () => {
  it("produces a well-formed document from the browser screen", () => {
    const capture = browserScreen({ dns_cache_stale: true });
    assertWellFormed(capture.svg!);
    assertWellFormed(annotate(capture, ANNOTATIONS, "Browser error"));
  });

  it("escapes ampersands in the window title", () => {
    // "Printers & scanners" is exactly the case that broke this before.
    const capture = printQueueScreen({ spooler_running: false, queued_jobs: 4 });
    expect(capture.svg!).toContain("Printers &amp; scanners");
    assertWellFormed(capture.svg!);
    assertWellFormed(annotate(capture, ANNOTATIONS, "Print queue & jobs"));
  });

  it("escapes ampersands in annotation labels and captions", () => {
    const capture = browserScreen({ dns_cache_stale: true });
    const svg = annotate(capture, ANNOTATIONS, "Before & after");
    expect(svg).toContain("&amp;");
    assertWellFormed(svg);
  });

  it("grows the canvas for the caption bar rather than covering the screen", () => {
    const capture = browserScreen({ dns_cache_stale: true });
    const svg = annotate(capture, ANNOTATIONS, "A caption");
    expect(svg).toContain(`height="${capture.height + 44}"`);
  });

  it("keeps every annotation label inside the frame", () => {
    const capture = browserScreen({ dns_cache_stale: true });
    // A box near the bottom would push its label off the canvas if unhandled.
    const svg = annotate(capture, [
      {
        style: "problem",
        box: { x: 800, y: capture.height - 30, width: 90, height: 20 },
        label: "A label long enough to need wrapping onto several lines here",
      },
    ]);
    const xs = [...svg.matchAll(/<rect x="(-?[\d.]+)"[^>]*fill="#ffffff"/g)].map((m) =>
      Number(m[1]),
    );
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(0);
    assertWellFormed(svg);
  });

  it("reflects the device's real state, not a fixed picture", () => {
    const broken = printQueueScreen({ spooler_running: false, queued_jobs: 4 });
    const fixed = printQueueScreen({ spooler_running: true, queued_jobs: 0 });
    expect(broken.description).toMatch(/stuck/);
    expect(fixed.description).toMatch(/normally/);
    expect(broken.svg).not.toBe(fixed.svg);
  });
});

describe("evidence store", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "ait-ev-"));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("content-addresses what it stores", () => {
    const store = new EvidenceStore(workdir, "run-1");
    const a = store.put("a.txt", "hello", "text/plain", "greeting");
    const b = store.put("b.txt", "hello", "text/plain");
    // Same bytes, same hash - so a ticket attachment can be checked against the
    // audit entry that claims to have produced it.
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(a.size_bytes).toBe(5);
    expect(a.caption).toBe("greeting");
  });
});

describe("placing labels so they can be read", () => {
  const frame: ScreenCapture = {
    source: "rendered",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560"></svg>',
    width: 900,
    height: 560,
    description: "test frame",
  };

  /** Every label rectangle the renderer drew, in document order. */
  function labelBoxes(svg: string): { x: number; y: number; w: number; h: number }[] {
    // The label plate is the white rect inside each annotation group.
    return [...svg.matchAll(
      /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="#ffffff"/g,
    )].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
      w: Number(m[3]),
      h: Number(m[4]),
    }));
  }

  const overlaps = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  it("does not stack two labels on the same spot", () => {
    // Two regions 20px apart: their labels would land on each other unless
    // something moves them.
    const svg = annotate(frame, [
      { style: "problem", box: { x: 90, y: 120, width: 500, height: 40 }, label: "The first thing that is wrong here" },
      { style: "info", box: { x: 90, y: 180, width: 500, height: 40 }, label: "The second thing that is wrong here" },
    ]);
    const boxes = labelBoxes(svg);
    expect(boxes).toHaveLength(2);
    expect(overlaps(boxes[0]!, boxes[1]!)).toBe(false);
  });

  it("keeps a label off another annotation's region", () => {
    const regionB = { x: 90, y: 190, width: 500, height: 120 };
    const svg = annotate(frame, [
      { style: "problem", box: { x: 90, y: 120, width: 500, height: 40 }, label: "Points at the top band" },
      { style: "info", box: regionB, label: "Points at the block below it" },
    ]);
    const first = labelBoxes(svg)[0]!;
    expect(
      overlaps(first, { x: regionB.x, y: regionB.y, w: regionB.width, h: regionB.height }),
    ).toBe(false);
  });

  it("keeps every label inside the frame", () => {
    const svg = annotate(frame, [
      { style: "problem", box: { x: 40, y: 480, width: 800, height: 60 }, label: "Right at the bottom edge of the capture" },
      { style: "info", box: { x: 40, y: 500, width: 800, height: 40 }, label: "And another one just below it" },
      { style: "action", box: { x: 40, y: 520, width: 800, height: 30 }, label: "And a third, with nowhere obvious to go" },
    ]);
    for (const b of labelBoxes(svg)) {
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.h).toBeLessThanOrEqual(560);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(900);
    }
  });
});
