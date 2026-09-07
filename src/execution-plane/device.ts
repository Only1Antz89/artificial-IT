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
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../contracts/index.js";
import type { DeviceInfo } from "../contracts/ticket.js";

/**
 * A frame from the device's screen.
 *
 * Two kinds, and the difference is recorded rather than smoothed over:
 *
 *   - `screen-capture` - genuine pixels grabbed from a real display, carried as
 *     base64 PNG. This is what a remote-support session produces.
 *   - `rendered`       - a frame drawn from known device state, carried as SVG.
 *     The simulated devices produce these.
 *
 * `source` is not cosmetic. A technician reading a ticket needs to know whether
 * they are looking at the user's actual screen or at a diagram of it, and the
 * annotation layer stamps the distinction onto the image itself.
 */
export interface ScreenCapture {
  source: "screen-capture" | "rendered";
  /** Base64 PNG, for a real capture. */
  png?: string;
  /** SVG markup, for a rendered frame. */
  svg?: string;
  width: number;
  height: number;
  /** What was on screen, in words - used when writing up the ticket. */
  description: string;
}

/**
 * What a session can actually do.
 *
 * Reported rather than assumed, because it varies more than you would like:
 * a stripped container has no `ping`, a headless host has no display, and a
 * technician who proposes `dig` on a machine without it has wasted a step.
 */
export interface SessionCapabilities {
  platform: DeviceInfo["platform"];
  /** Base commands confirmed present on this machine. */
  availableCommands: string[];
  /** Whether `capture()` can return a real frame. */
  canCapture: boolean;
  /** Why capture is unavailable, when it is. */
  captureUnavailableReason?: string;
}

export interface DeviceSession {
  readonly device: DeviceInfo;
  readonly sessionId: string;
  exec(command: string, timeoutMs?: number): Promise<CommandResult>;
  capture(): Promise<ScreenCapture>;
  /** Probed once and cached; safe to call repeatedly. */
  capabilities(): Promise<SessionCapabilities>;
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

  /**
   * A simulated machine knows exactly what it can do: whatever its fixtures
   * cover. Deriving this from the fixtures rather than hardcoding a list keeps
   * the two from drifting apart.
   */
  async capabilities(): Promise<SessionCapabilities> {
    const commands = [
      ...new Set(
        this.#fixtures
          .map((f) => f.match.source.replace(/^\^/, "").match(/^[a-z_][a-z0-9_-]*/i)?.[0])
          .filter((c): c is string => Boolean(c)),
      ),
    ].sort();
    return {
      platform: this.device.platform,
      availableCommands: commands,
      canCapture: true,
    };
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
  #capabilities?: SessionCapabilities;

  constructor(device: DeviceInfo) {
    this.device = device;
    this.sessionId = `local_${device.device_id}_${Date.now().toString(36)}`;
  }

  async exec(command: string, timeoutMs = 20_000): Promise<CommandResult> {
    const started = Date.now();
    const argv = splitArgv(command);
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
    return runProcess(command, bin, argv.slice(1), timeoutMs, started);
  }

  /**
   * Probe what this machine actually has.
   *
   * Done once and cached. The probe list is the union of what the playbooks and
   * the prompts might reach for - probing everything on PATH would be slower and
   * no more useful.
   */
  async capabilities(): Promise<SessionCapabilities> {
    if (this.#capabilities) return this.#capabilities;

    const available: string[] = [];
    await Promise.all(
      PROBE_COMMANDS.map(async (name) => {
        if (await commandExists(name)) available.push(name);
      }),
    );
    available.sort();

    const capture = await screenshotStrategy();
    this.#capabilities = {
      platform: this.device.platform,
      availableCommands: available,
      canCapture: capture.available,
      ...(capture.available ? {} : { captureUnavailableReason: capture.reason }),
    };
    return this.#capabilities;
  }

  /**
   * Grab the actual screen.
   *
   * Every platform has its own tool and none of them are guaranteed present, so
   * this reports honestly rather than returning an empty frame: a blank
   * screenshot on a ticket is worse than a stated "no display available".
   */
  async capture(): Promise<ScreenCapture> {
    const strategy = await screenshotStrategy();
    if (!strategy.available) {
      throw new Error(`Cannot capture the screen: ${strategy.reason}`);
    }

    const file = join(tmpdir(), `ait-capture-${Date.now()}.png`);
    try {
      const result = await runProcess(
        strategy.tool!.join(" "),
        strategy.tool![0]!,
        strategy.tool!.slice(1).map((a) => (a === "%OUT%" ? file : a)),
        20_000,
        Date.now(),
      );
      if (result.exit_code !== 0 || !existsSync(file)) {
        throw new Error(
          `${strategy.tool![0]} exited ${result.exit_code}: ${result.stderr.trim() || "no image produced"}`,
        );
      }

      const png = readFileSync(file);
      const { width, height } = pngDimensions(png) ?? { width: 0, height: 0 };
      return {
        source: "screen-capture",
        png: png.toString("base64"),
        width,
        height,
        description: `Live screen capture of ${this.device.hostname} (${png.length} bytes, ${width}x${height}).`,
      };
    } finally {
      rmSync(file, { force: true });
    }
  }

  async end(): Promise<void> {
    /* nothing to tear down */
  }
}

/* ------------------------------------------------------------------ *
 * Host helpers
 * ------------------------------------------------------------------ */

/** Commands worth probing for; the union of what playbooks and prompts use. */
const PROBE_COMMANDS = [
  // portable
  "df", "du", "free", "ps", "top", "uptime", "hostname", "uname", "whoami",
  "cat", "grep", "ls", "curl", "wget", "getent", "env", "date", "id",
  // networking
  "ping", "dig", "nslookup", "host", "ip", "ifconfig", "netstat", "ss",
  "traceroute", "route", "arp", "resolvectl", "networksetup", "scutil",
  // linux
  "lscpu", "lsblk", "lsusb", "journalctl", "systemctl", "vmstat", "dmesg",
  "hostnamectl", "timedatectl", "lpstat",
  // macos
  "sw_vers", "system_profiler", "diskutil", "pmset", "vm_stat", "dscacheutil",
  "launchctl", "sysctl",
  // windows
  "ipconfig", "systeminfo", "tasklist", "sc", "wmic", "powercfg", "driverquery",
  "getmac", "powershell",
];

/** Split a command string into argv, honouring simple double quoting. */
export function splitArgv(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

function runProcess(
  command: string,
  bin: string,
  args: string[],
  timeoutMs: number,
  started: number,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(bin, args, { shell: false });
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

async function commandExists(name: string): Promise<boolean> {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = await runProcess(`${probe} ${name}`, probe, [name], 4_000, Date.now());
  return result.exit_code === 0 && result.stdout.trim().length > 0;
}

interface ScreenshotStrategy {
  available: boolean;
  /** argv with `%OUT%` standing in for the output path. */
  tool?: string[];
  reason?: string;
}

let cachedStrategy: ScreenshotStrategy | undefined;

/**
 * Work out how, if at all, this machine can be photographed.
 *
 * Each platform gets its usual tools in order of preference. A headless host
 * gets a clear "no display" rather than a tool that would produce a black
 * rectangle.
 */
export async function screenshotStrategy(): Promise<ScreenshotStrategy> {
  if (cachedStrategy) return cachedStrategy;

  if (process.platform === "darwin") {
    cachedStrategy = (await commandExists("screencapture"))
      ? { available: true, tool: ["screencapture", "-x", "-t", "png", "%OUT%"] }
      : { available: false, reason: "screencapture is not available on this Mac" };
    return cachedStrategy;
  }

  if (process.platform === "win32") {
    // PowerShell with System.Drawing is present on any supported Windows.
    cachedStrategy = {
      available: true,
      tool: ["powershell", "-NoProfile", "-Command", WINDOWS_CAPTURE_SCRIPT],
    };
    return cachedStrategy;
  }

  // Linux and friends: needs a display server before any tool can help.
  const wayland = Boolean(process.env["WAYLAND_DISPLAY"]);
  const x11 = Boolean(process.env["DISPLAY"]);
  if (!wayland && !x11) {
    cachedStrategy = {
      available: false,
      reason:
        "no display server is attached (neither DISPLAY nor WAYLAND_DISPLAY is set), so there is no screen to capture",
    };
    return cachedStrategy;
  }

  const candidates: string[][] = wayland
    ? [["grim", "%OUT%"], ["spectacle", "-b", "-n", "-o", "%OUT%"]]
    : [
        ["scrot", "-o", "%OUT%"],
        ["maim", "%OUT%"],
        ["import", "-window", "root", "%OUT%"],
        ["gnome-screenshot", "-f", "%OUT%"],
      ];

  for (const candidate of candidates) {
    if (await commandExists(candidate[0]!)) {
      cachedStrategy = { available: true, tool: candidate };
      return cachedStrategy;
    }
  }

  cachedStrategy = {
    available: false,
    reason: `a display is present but no screenshot tool was found (looked for ${candidates.map((c) => c[0]).join(", ")})`,
  };
  return cachedStrategy;
}

/** Reset the probe cache. Tests change the environment between cases. */
export function resetCapabilityCache(): void {
  cachedStrategy = undefined;
}

const WINDOWS_CAPTURE_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
  "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;",
  "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;",
  "$g=[System.Drawing.Graphics]::FromImage($bmp);",
  "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
  "$bmp.Save('%OUT%',[System.Drawing.Imaging.ImageFormat]::Png);",
].join(" ");

/**
 * Read width and height from a PNG header.
 *
 * Sixteen bytes of parsing, versus an image library dependency used for exactly
 * this. The IHDR chunk is always first and always at this offset.
 */
export function pngDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(SIGNATURE)) return undefined;
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return undefined;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
