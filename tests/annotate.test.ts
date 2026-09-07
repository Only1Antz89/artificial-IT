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
