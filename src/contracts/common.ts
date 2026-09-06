/**
 * Primitives shared by every AIT contract.
 *
 * Every object that crosses a plane boundary carries tenancy, trace and
 * schema-version identity, so the control plane can audit it without guessing
 * where it came from.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;

export const IsoDateTime = z.string().datetime({ offset: true });

/** Identity carried by every cross-boundary envelope. */
export const Envelope = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  tenant_id: z.string().min(1),
  trace_id: z.string().min(1),
  created_at: IsoDateTime,
});
export type Envelope = z.infer<typeof Envelope>;

/**
 * Confidence is deliberately coarse. A technician who says "70.4% sure" is
 * inventing precision; the escalation rules only ever need these three bands.
 */
export const Confidence = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof Confidence>;

export const Severity = z.enum(["low", "normal", "high", "urgent"]);
export type Severity = z.infer<typeof Severity>;

/** A stored file (screenshot, log capture, annotated image) referenced by URI. */
export const ArtifactRef = z.object({
  uri: z.string().min(1),
  content_type: z.string().optional(),
  sha256: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
  size_bytes: z.number().int().min(0).optional(),
  caption: z.string().optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export function nowIso(): string {
  return new Date().toISOString();
}

let counter = 0;
/** Deterministic-ish id generator; readable in transcripts and audit logs. */
export function newId(prefix: string): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}
