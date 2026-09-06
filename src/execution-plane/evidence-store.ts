/**
 * Evidence storage.
 *
 * Artefacts are content-addressed: the sha256 goes into the ArtifactRef and the
 * file is written under the run's directory. That means the annotated
 * screenshot attached to a Zendesk ticket can be checked against the audit log
 * entry that claims to have produced it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef } from "../contracts/index.js";

export class EvidenceStore {
  readonly dir: string;

  constructor(rootDir: string, runId: string) {
    this.dir = join(rootDir, runId);
    mkdirSync(this.dir, { recursive: true });
  }

  /** Persist a text artefact (SVG, log capture, transcript) and describe it. */
  put(
    filename: string,
    content: string,
    contentType: string,
    caption?: string,
  ): ArtifactRef {
    const path = join(this.dir, filename);
    writeFileSync(path, content, "utf8");
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    return {
      uri: `file://${path}`,
      content_type: contentType,
      sha256,
      size_bytes: Buffer.byteLength(content, "utf8"),
      ...(caption ? { caption } : {}),
    };
  }
}
