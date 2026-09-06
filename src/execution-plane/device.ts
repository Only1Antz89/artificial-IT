/**
 * Device sessions - the "hands" of the technician.
 *
 * The abstraction follows the split remote-support tooling draws: a session is
 * requested, consented to, used, and ended, and everything that happens inside
 * it is attributable. What sits behind the interface varies:
 *
 *   - `SimulatedDeviceSession` - a scripted machine used by the demo and the
 *     tests. It has real mutable state, so a fix genuinely changes what the
 *     next diagnostic command reports.
 *   - `LocalDeviceSession`     - runs against the machine this process is on.
 *   - A MeshCentral-backed session would implement the same interface; see
 *     `remote.ts`.
 *
 * Nothing in here enforces policy. Sessions are dumb on purpose - the control
 * plane decides, the session performs.
 */
import { spawn } from "node:child_process";
import type { CommandResult } from "../contracts/index.js";
import type { DeviceInfo } from "../contracts/ticket.js";

export interface ScreenCapture {
  /** SVG markup of the captured screen. */
  svg: string;
  width: number;
  height: number;
  /** What was on screen, in words - used when writing up the ticket. */
  description: string;
}

export interface DeviceSession {
  readonly device: DeviceInfo;
  readonly sessionId: string;
  exec(command: string, timeoutMs?: number): Promise<CommandResult>;
  capture(): Promise<ScreenCapture>;
  end(): Promise<void>;
}

const MAX_OUTPUT = 8_000;

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_OUTPUT)}\n… [truncated ${text.length - MAX_OUTPUT} characters]`,
    truncated: true,
  };
}

/* ------------------------------------------------------------------ *
 * Simulated device
 * ------------------------------------------------------------------ */

/** Mutable facts about the simulated machine that commands can read and change. */
export type DeviceState = Record<string, string | number | boolean>;

export interface CommandFixture {
  match: RegExp;
  /** Produce the output for this command from the current device state. */
  respond: (state: DeviceState, command: string) => {
    stdout?: string;
    stderr?: string;
    exit_code?: number;
  };
  /** Applied after `respond`, so a fix changes what later commands report. */
  effect?: (state: DeviceState) => void;
}

export interface SimulatedDeviceOptions {
  device: DeviceInfo;
  state: DeviceState;
  fixtures: CommandFixture[];
  /** Renders the screen from the current state. */
  screen: (state: DeviceState) => ScreenCapture;
}

export class SimulatedDeviceSession implements DeviceSession {
  readonly device: DeviceInfo;
  readonly sessionId: string;
  readonly state: DeviceState;

  #fixtures: CommandFixture[];
  #screen: (state: DeviceState) => ScreenCapture;
  #ended = false;

  constructor(opts: SimulatedDeviceOptions) {
    this.device = opts.device;
    this.state = { ...opts.state };
    this.#fixtures = opts.fixtures;
    this.#screen = opts.screen;
    this.sessionId = `sim_${opts.device.device_id}_${Date.now().toString(36)}`;
  }

  async exec(command: string): Promise<CommandResult> {
    if (this.#ended) throw new Error("session has ended");
    const started = Date.now();

    const fixture = this.#fixtures.find((f) => f.match.test(command));
    if (!fixture) {
      // An honest "I don't know that" beats inventing plausible output.
      return {
        command,
        exit_code: 127,
        stdout: "",
        stderr: `${command.split(/\s+/)[0]}: command not found on simulated device`,
        duration_ms: Date.now() - started,
        truncated: false,
      };
    }

    const out = fixture.respond(this.state, command);
    fixture.effect?.(this.state);

    const stdout = truncate(out.stdout ?? "");
    const stderr = truncate(out.stderr ?? "");
    return {
      command,
      exit_code: out.exit_code ?? 0,
      stdout: stdout.text,
      stderr: stderr.text,
      duration_ms: Date.now() - started + 40,
      truncated: stdout.truncated || stderr.truncated,
    };
  }

  async capture(): Promise<ScreenCapture> {
    if (this.#ended) throw new Error("session has ended");
    return this.#screen(this.state);
  }

  async end(): Promise<void> {
    this.#ended = true;
  }
}

/* ------------------------------------------------------------------ *
 * Local device
 * ------------------------------------------------------------------ */

/**
 * Runs commands on the host this process is running on.
 *
 * Note the shape: arguments are passed as an argv array to `spawn` with no
 * shell, so the command cannot grow a second command through `;` or `&&`. The
 * policy engine already splits and checks pipelines, but a runner that cannot
 * express a pipeline at all is a better second line of defence than one that
 * can and promises not to.
 */
export class LocalDeviceSession implements DeviceSession {
  readonly device: DeviceInfo;
  readonly sessionId: string;

  constructor(device: DeviceInfo) {
    this.device = device;
    this.sessionId = `local_${device.device_id}_${Date.now().toString(36)}`;
  }

  async exec(command: string, timeoutMs = 20_000): Promise<CommandResult> {
    const started = Date.now();
    const argv = command.trim().split(/\s+/).filter(Boolean);
    const bin = argv[0];
    if (!bin) {
      return {
        command,
        exit_code: 1,
        stdout: "",
        stderr: "empty command",
        duration_ms: 0,
        truncated: false,
      };
    }

    return new Promise<CommandResult>((resolve) => {
      const child = spawn(bin, argv.slice(1), { shell: false });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        stderr += `\n[timed out after ${timeoutMs}ms]`;
      }, timeoutMs);

      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          command,
          exit_code: 127,
          stdout: "",
          stderr: String(err instanceof Error ? err.message : err),
          duration_ms: Date.now() - started,
          truncated: false,
        });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const o = truncate(stdout);
        const e = truncate(stderr);
        resolve({
          command,
          exit_code: code ?? 0,
          stdout: o.text,
          stderr: e.text,
          duration_ms: Date.now() - started,
          truncated: o.truncated || e.truncated,
        });
      });
    });
  }

  async capture(): Promise<ScreenCapture> {
    // Screen capture on a real endpoint goes through the remote-support agent
    // (MeshCentral), not this process. Rather than return a fake frame, say so.
    throw new Error(
      "screen capture is not available on a local session; use a remote-support session",
    );
  }

  async end(): Promise<void> {
    /* nothing to tear down */
  }
}
