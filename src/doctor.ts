/**
 * Preflight checks.
 *
 * Everything that could embarrass you five minutes into a live demo, checked in
 * one command before you start. It is deliberately opinionated about what
 * counts as a problem:
 *
 *   - **fail**  the demo will not work until this is fixed.
 *   - **warn**  the demo works, but something will look worse than it should.
 *   - **ok**    nothing to do.
 *
 * The macOS screen-recording check deserves its own note. `screencapture`
 * succeeds whether or not the terminal has been granted Screen Recording
 * permission - without it you get a picture of the desktop wallpaper and
 * nothing else. It fails silently, which is the worst way for anything to fail,
 * so this reports it as something to verify by eye rather than pretending to
 * have detected it.
 */
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, platform, release, totalmem } from "node:os";
import { LocalDeviceSession, screenshotStrategy } from "./execution-plane/device.js";
import { checksFor, type HostPlatform } from "./agent/local-playbooks.js";
import { hostPlatform, localDevice } from "./demo/local.js";
import { selectBrain } from "./agent/select-brain.js";
import { checkClaudeModel, checkOpenAIModel, withTimeout } from "./agent/model-check.js";

export type CheckState = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  state: CheckState;
  detail: string;
  /** What to actually do about it, when there is something to do. */
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
  /** True when at least one check failed outright. */
  blocked: boolean;
}

const MIN_NODE_MAJOR = 22;

export async function runDoctor(port = 3000): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  checks.push(nodeVersion());
  checks.push(platformSupport());

  const host = hostPlatform();
  if (host !== "unknown") {
    checks.push(await diagnosticTools(host));
    checks.push(...(await screenCapture(host)));
  }

  checks.push(await portFree(port));
  checks.push(...(await providers()));
  checks.push(evidenceWritable());

  return {
    checks,
    ok: checks.every((c) => c.state === "ok"),
    blocked: checks.some((c) => c.state === "fail"),
  };
}

/* ------------------------------------------------------------------ *
 * Individual checks
 * ------------------------------------------------------------------ */

function nodeVersion(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= MIN_NODE_MAJOR) {
    return { name: "Node.js", state: "ok", detail: `v${process.versions.node}` };
  }
  return {
    name: "Node.js",
    state: "fail",
    detail: `v${process.versions.node} is too old; AIT needs ${MIN_NODE_MAJOR} or newer.`,
    // Native WebSocket, which the MeshCentral transport relies on, landed in 22.
    fix: "Install Node 22+ — `brew install node` on macOS, or nvm: `nvm install 22 && nvm use 22`.",
  };
}

function platformSupport(): DoctorCheck {
  const host = hostPlatform();
  const detail = `${platform()} ${release()} · ${hostname()} · ${Math.round(totalmem() / 1e9)}GB RAM`;

  if (host === "unknown") {
    return {
      name: "Platform",
      state: "warn",
      detail: `${detail} — no local diagnostic set for "${platform()}".`,
      fix: "The simulated scenarios still work; only `ait local` is unavailable.",
    };
  }
  return { name: "Platform", state: "ok", detail: `${detail} → ${host}` };
}

async function diagnosticTools(host: HostPlatform): Promise<DoctorCheck> {
  const caps = await new LocalDeviceSession(localDevice()).capabilities();
  const usable = checksFor(host, caps.availableCommands);
  const total = checksFor(
    host,
    // Everything a check could possibly need, to compare against.
    [...new Set(caps.availableCommands.concat(ALL_REQUIRED[host]))],
  );

  const missing = total
    .filter((t) => !usable.some((u) => u.id === t.id))
    .map((t) => t.requires[host])
    .filter(Boolean);

  if (usable.length === 0) {
    return {
      name: "Diagnostic tools",
      state: "fail",
      detail: `None of the local checks can run — found ${caps.availableCommands.length} commands but none that a check needs.`,
      fix: "Run the simulated scenarios instead, or install standard diagnostics.",
    };
  }
  if (missing.length > 0) {
    return {
      name: "Diagnostic tools",
      state: "warn",
      detail: `${usable.length} of ${total.length} local checks can run. Missing: ${missing.join(", ")}.`,
      fix: "Those checks are skipped rather than failed — the demo still works.",
    };
  }
  return {
    name: "Diagnostic tools",
    state: "ok",
    detail: `all ${usable.length} local checks can run (${caps.availableCommands.length} commands found)`,
  };
}

/** Tools each platform's full check set wants, for the "missing" comparison. */
const ALL_REQUIRED: Record<HostPlatform, string[]> = {
  macos: ["uname", "uptime", "df", "vm_stat", "dscacheutil", "ps", "ifconfig", "curl", "lpstat", "pmset"],
  linux: ["uname", "uptime", "df", "free", "getent", "ps", "ip", "curl", "lpstat", "cat"],
  windows: ["systeminfo", "powershell", "wmic", "nslookup", "tasklist", "ipconfig", "curl", "powercfg"],
};

async function screenCapture(host: HostPlatform): Promise<DoctorCheck[]> {
  const strategy = await screenshotStrategy();
  const out: DoctorCheck[] = [];

  if (!strategy.available) {
    const reason = strategy.reason ?? "unavailable";
    // Tell them the fix for the problem actually found. "Install scrot" is
    // useless advice on a machine that has no display for scrot to photograph.
    const noDisplay = /no display server/i.test(reason);
    out.push({
      name: "Screen capture",
      state: "warn",
      detail: reason,
      fix: noDisplay
        ? "Expected on a headless host. Screenshot steps are skipped; everything else works."
        : host === "linux"
          ? "Install one: `sudo apt install scrot`. Screenshot steps are skipped without it."
          : "Screenshot steps are skipped; the rest of the demo is unaffected.",
    });
    return out;
  }

  out.push({
    name: "Screen capture",
    state: "ok",
    detail: `available via \`${strategy.tool?.[0]}\``,
  });

  if (host === "macos") {
    // Not detectable without native APIs, and silent when wrong - so it is
    // raised as something to confirm by eye rather than asserted either way.
    out.push({
      name: "Screen Recording permission",
      state: "warn",
      detail:
        "macOS requires Screen Recording permission, and screencapture succeeds without it — you just get the wallpaper and nothing else.",
      fix: "System Settings → Privacy & Security → Screen Recording → enable your terminal, then restart the terminal. Verify with: screencapture -x /tmp/t.png && open /tmp/t.png",
    });
  }
  return out;
}

async function portFree(port: number): Promise<DoctorCheck> {
  const free = await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });

  if (free) {
    return { name: `Port ${port}`, state: "ok", detail: "free for the console" };
  }
  return {
    name: `Port ${port}`,
    state: "warn",
    detail: `something is already listening on ${port}.`,
    fix: `Start the console on another port: PORT=3100 npm run serve`,
  };
}

async function providers(): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];

  for (const provider of ["claude", "openai"] as const) {
    let selection;
    try {
      selection = selectBrain(provider);
    } catch {
      out.push({
        name: `Provider: ${provider}`,
        state: "ok",
        detail: "not configured — not needed for the offline demo",
      });
      continue;
    }

    const check = await withTimeout(
      provider === "claude"
        ? checkClaudeModel(selection.model)
        : checkOpenAIModel(selection.model),
      { ok: true, model: selection.model, skipped: "timed out", message: "Verification timed out." },
      10_000,
    );

    out.push({
      name: `Provider: ${provider}`,
      state: check.ok ? (check.skipped ? "warn" : "ok") : "fail",
      detail: check.message,
      ...(check.ok
        ? {}
        : {
            fix: `Set ${provider === "claude" ? "ANTHROPIC_MODEL" : "OPENAI_MODEL"} to one of the ids listed above.`,
          }),
    });
  }

  const active = selectBrain();
  out.push({
    name: "Active provider",
    state: "ok",
    detail: `${active.provider} (${active.model}) — ${active.note}`,
  });
  return out;
}

function evidenceWritable(): DoctorCheck {
  try {
    mkdirSync("run-artifacts", { recursive: true });
    writeFileSync("run-artifacts/.doctor", "ok");
    rmSync("run-artifacts/.doctor");
    return { name: "Evidence directory", state: "ok", detail: "./run-artifacts is writable" };
  } catch (err) {
    return {
      name: "Evidence directory",
      state: "fail",
      detail: `cannot write to ./run-artifacts: ${err instanceof Error ? err.message : err}`,
      fix: "Run AIT from a directory you can write to.",
    };
  }
}
