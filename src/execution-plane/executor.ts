/**
 * The executor.
 *
 * It performs one cleared step and returns one StepResult. Two properties are
 * load-bearing:
 *
 *   - It refuses any step whose verdict is not `allow`. The approval gate turns
 *     a `require_approval` into an `allow` before the step reaches here; a
 *     `block` never reaches here at all. This is belt-and-braces against a
 *     future caller that forgets to check.
 *   - It records what actually happened, including failures. Nothing here
 *     smooths over a non-zero exit code - the write-up depends on the results
 *     being true.
 */
import type {
  ArtifactRef,
  PlanStep,
  PolicyVerdict,
  StepResult,
} from "../contracts/index.js";
import { nowIso } from "../contracts/index.js";
import type { DeviceSession } from "./device.js";
import { annotate, type Annotation } from "./annotate.js";
import type { EvidenceStore } from "./evidence-store.js";

export interface ExecutionContext {
  session?: DeviceSession;
  evidence: EvidenceStore;
  /** Answers the agent may consult for `ask_user` steps in an unattended run. */
  userAnswers?: Record<string, string>;
}

export async function executeStep(
  step: PlanStep,
  verdict: PolicyVerdict,
  ctx: ExecutionContext,
): Promise<StepResult> {
  const started_at = nowIso();

  const base = {
    step,
    verdict,
    started_at,
    artifacts: [] as ArtifactRef[],
  };

  if (verdict.decision !== "allow") {
    return {
      ...base,
      outcome: verdict.decision === "block" ? "blocked" : "awaiting_approval",
      finished_at: nowIso(),
      observation: verdict.reason,
    };
  }

  try {
    switch (step.kind) {
      case "command":
        return await runCommand(step, verdict, ctx, started_at);
      case "screenshot":
        return await runScreenshot(step, verdict, ctx, started_at);
      case "read_file":
        return await runReadFile(step, verdict, ctx, started_at);
      case "ask_user":
        return runAskUser(step, verdict, ctx, started_at);
      case "ui_action":
        // Driving a desktop needs a GUI automation backend, and there is not
        // one wired up. Failing honestly beats reporting "skipped", which reads
        // like a decision rather than a missing capability - and a run that
        // appears to have clicked something it never clicked is the worst of
        // both.
        return {
          ...base,
          outcome: "failed",
          finished_at: nowIso(),
          observation:
            "AIT has no UI automation backend, so it cannot drive the desktop directly.",
          error: "no UI automation backend is configured",
        };

      default:
        // `ticket_comment` and `knowledge_lookup` are the agent loop's own
        // business - it owns the ticket and the knowledge base - so a step of
        // that kind reaching the executor means something upstream is confused.
        return {
          ...base,
          outcome: "skipped",
          finished_at: nowIso(),
          observation: `"${step.kind}" is handled by the agent loop, not the device.`,
        };
    }
  } catch (err) {
    return {
      ...base,
      outcome: "failed",
      finished_at: nowIso(),
      observation: "The step could not be carried out.",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runCommand(
  step: PlanStep,
  verdict: PolicyVerdict,
  ctx: ExecutionContext,
  started_at: string,
): Promise<StepResult> {
  if (!ctx.session) throw new Error("no device session is open");
  const command = String(step.payload["command"] ?? "");
  const result = await ctx.session.exec(command);

  // Keep the raw output as evidence - the write-up quotes from it later, and a
  // reviewer can check the quote against the capture.
  const artifact = ctx.evidence.put(
    `${step.id}-command.txt`,
    `$ ${result.command}\n\n--- stdout ---\n${result.stdout}\n\n--- stderr ---\n${result.stderr}\n\nexit=${result.exit_code} duration=${result.duration_ms}ms`,
    "text/plain",
    `Output of \`${command}\``,
  );

  const ok = result.exit_code === 0;
  return {
    step,
    verdict,
    outcome: ok ? "success" : "failed",
    started_at,
    finished_at: nowIso(),
    observation: ok
      ? summariseOutput(result.stdout)
      : `Command exited ${result.exit_code}: ${summariseOutput(result.stderr || result.stdout)}`,
    command: result,
    artifacts: [artifact],
    ...(ok ? {} : { error: result.stderr.trim() || `exit ${result.exit_code}` }),
  };
}

async function runScreenshot(
  step: PlanStep,
  verdict: PolicyVerdict,
  ctx: ExecutionContext,
  started_at: string,
): Promise<StepResult> {
  if (!ctx.session) throw new Error("no device session is open");
  const capture = await ctx.session.capture();

  const annotations = (step.payload["annotations"] as Annotation[] | undefined) ?? [];
  const caption = String(step.payload["caption"] ?? step.intent);

  // The raw frame is kept in whatever form it arrived in: PNG bytes for a real
  // capture, SVG markup for a rendered one. Converting either way would mean
  // the ticket no longer carries what the device actually produced.
  const artifacts =
    capture.source === "screen-capture" && capture.png
      ? [
          ctx.evidence.putBinary(
            `${step.id}-screen.png`,
            Buffer.from(capture.png, "base64"),
            "image/png",
            capture.description,
          ),
        ]
      : [
          ctx.evidence.put(
            `${step.id}-screen.svg`,
            capture.svg ?? "",
            "image/svg+xml",
            capture.description,
          ),
        ];

  if (annotations.length > 0) {
    const annotated = annotate(capture, annotations, caption);
    artifacts.push(
      ctx.evidence.put(
        `${step.id}-screen-annotated.svg`,
        annotated,
        "image/svg+xml",
        caption,
      ),
    );
  }

  return {
    step,
    verdict,
    outcome: "success",
    started_at,
    finished_at: nowIso(),
    observation: capture.description,
    artifacts,
  };
}

async function runReadFile(
  step: PlanStep,
  verdict: PolicyVerdict,
  ctx: ExecutionContext,
  started_at: string,
): Promise<StepResult> {
  if (!ctx.session) throw new Error("no device session is open");
  const path = String(step.payload["path"] ?? "");
  const result = await ctx.session.exec(`cat ${path}`);
  const artifact = ctx.evidence.put(
    `${step.id}-file.txt`,
    result.stdout,
    "text/plain",
    `Contents of ${path}`,
  );
  return {
    step,
    verdict,
    outcome: result.exit_code === 0 ? "success" : "failed",
    started_at,
    finished_at: nowIso(),
    observation:
      result.exit_code === 0
        ? summariseOutput(result.stdout)
        : `Could not read ${path}: ${result.stderr}`,
    command: result,
    artifacts: [artifact],
  };
}

function runAskUser(
  step: PlanStep,
  verdict: PolicyVerdict,
  ctx: ExecutionContext,
  started_at: string,
): StepResult {
  const question = String(step.payload["question"] ?? step.intent);
  const answer = ctx.userAnswers?.[question];

  // No answer available is not a failure - it is the run pausing on the user.
  if (answer === undefined) {
    return {
      step,
      verdict,
      outcome: "awaiting_user",
      started_at,
      finished_at: nowIso(),
      observation: `Waiting on the user: ${question}`,
      artifacts: [],
    };
  }

  return {
    step,
    verdict,
    outcome: "success",
    started_at,
    finished_at: nowIso(),
    observation: `User answered: ${answer}`,
    artifacts: [],
  };
}

/** First few meaningful lines - enough for a technician's note, not a dump. */
function summariseOutput(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "No output.";
  const head = lines.slice(0, 4).join(" | ");
  return lines.length > 4 ? `${head} … (+${lines.length - 4} more lines)` : head;
}
