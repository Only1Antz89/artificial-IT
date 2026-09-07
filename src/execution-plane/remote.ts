/**
 * MeshCentral-backed remote support sessions.
 *
 * This is the adapter that puts a real endpoint behind `DeviceSession`. It
 * follows AIT's remote-support contract: a session is *requested* against a
 * device by an operator, moves through a small state machine, and is revocable
 * at any time by the user.
 *
 * ## The protocol
 *
 * MeshCentral does not expose a request/response API for running a command. It
 * gives you an interactive relay, and you drive it the way a person would:
 *
 *   1. Open the control channel, `wss://server/control.ashx?auth=<login cookie>`.
 *   2. Ask for auth cookies: `{action:'authcookie'}` comes back with `cookie`
 *      (for the browser side of a relay) and `rcookie` (for the agent side).
 *   3. Ask the agent to dial in, by sending it a `tunnel` message naming a
 *      relay URL and a tunnel id you invent.
 *   4. Connect your own side of the same relay. When both ends are present the
 *      server sends `c` (or `cr`, if the session is being recorded).
 *   5. Select protocol 1 (terminal) and you have a shell.
 *
 * From there it is a terminal, not an API - so a command's output has no
 * natural end. `exec` appends a sentinel echo and reads until it appears, which
 * is what any automation over an interactive shell has to do.
 *
 * ## TLS
 *
 * Certificate verification is never disabled here. MeshCentral installations
 * commonly use a private CA; point `NODE_EXTRA_CA_CERTS` at it. An adapter that
 * quietly accepted any certificate would undermine the remote-support channel
 * it exists to secure.
 */
import { randomBytes } from "node:crypto";
import type { CommandResult } from "../contracts/index.js";
import type { DeviceInfo } from "../contracts/ticket.js";
import type { DeviceSession, ScreenCapture, SessionCapabilities } from "./device.js";
import { pngDimensions } from "./device.js";

export type RemoteSessionStatus =
  | "requested"
  | "establishing"
  | "active"
  | "ended"
  | "failed";

export interface RemoteSessionRequest {
  tenant_id: string;
  task_id: string;
  trace_id: string;
  device_id: string;
  operator_id: string;
  requested_at: string;
}

export interface MeshCentralConfig {
  /** e.g. https://mesh.example.internal */
  serverUrl: string;
  /**
   * Server login cookie or login key, as `meshctrl --loginkey` takes.
   * Appended to the control URL as `?auth=`.
   */
  operatorToken: string;
  /** Mesh (device group) the device belongs to. */
  meshId: string;
  /** Milliseconds to wait for the agent to answer a tunnel request. */
  connectTimeoutMs?: number;
}

export function meshConfigFromEnv(): MeshCentralConfig | undefined {
  const serverUrl = process.env["MESHCENTRAL_URL"];
  const operatorToken = process.env["MESHCENTRAL_TOKEN"];
  const meshId = process.env["MESHCENTRAL_MESH_ID"];
  if (!serverUrl || !operatorToken || !meshId) return undefined;
  return { serverUrl, operatorToken, meshId };
}

/** MeshCentral's relay protocol numbers. */
const PROTOCOL_TERMINAL = 1;

/** The channel MeshCentral uses for in-band control frames on a relay. */
const CTRL_CHANNEL = "102938";

/** Marks the end of one command's output on an interactive shell. */
const SENTINEL = "__AIT_DONE__";

/**
 * The sentinel *followed by digits* - i.e. the shell's expansion of it, not the
 * echo of the line that was typed.
 *
 * A terminal echoes what you send, so the literal text `echo __AIT_DONE__$?`
 * comes back before the command has run at all. Matching the bare sentinel
 * would end every command the instant it started and return the echo as its
 * output. The digits are what separate the expansion from the echo.
 */
const SENTINEL_RESULT = new RegExp(`${SENTINEL}(\\d+)`);

/** Matches ANSI escape sequences a terminal emits and a ticket does not want. */
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g");

function wsUrl(serverUrl: string, path: string): string {
  const base = serverUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}${path}`;
}

/** MeshCentral node ids are `node/<domain>/<hash>`; accept either form. */
export function qualifyNodeId(deviceId: string, domain = ""): string {
  return deviceId.startsWith("node/") ? deviceId : `node/${domain}/${deviceId}`;
}

export class MeshCentralSession implements DeviceSession {
  readonly device: DeviceInfo;
  readonly sessionId: string;
  status: RemoteSessionStatus = "requested";
  /** True when MeshCentral told us this session is being recorded. */
  recorded = false;

  #control?: WebSocket;
  #relay?: WebSocket;
  #cookies?: { cookie: string; rcookie: string };
  /** Commands are serialised: one interactive shell, one command at a time. */
  #queue: Promise<unknown> = Promise.resolve();
  #capabilities?: SessionCapabilities;

  constructor(
    device: DeviceInfo,
    private readonly config: MeshCentralConfig,
    private readonly request: RemoteSessionRequest,
  ) {
    this.device = device;
    this.sessionId = `mesh_${request.device_id}_${request.trace_id}`;
  }

  private get timeout(): number {
    return this.config.connectTimeoutMs ?? 30_000;
  }

  /* ---------------- control channel ---------------- */

  async #openControl(): Promise<void> {
    if (this.#cookies) return;
    this.status = "establishing";

    const url = `${wsUrl(this.config.serverUrl, "/control.ashx")}?auth=${encodeURIComponent(this.config.operatorToken)}`;
    const ws = await openSocket(url, this.timeout, "MeshCentral control channel");
    this.#control = ws;

    // The cookies are short-lived and scoped to this operator; both sides of the
    // relay need one each.
    this.#cookies = await new Promise<{ cookie: string; rcookie: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("MeshCentral did not return auth cookies in time")),
          this.timeout,
        );
        ws.addEventListener("message", (event) => {
          let payload: { action?: string; cookie?: string; rcookie?: string };
          try {
            payload = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (payload.action === "authcookie" && payload.cookie && payload.rcookie) {
            clearTimeout(timer);
            resolve({ cookie: payload.cookie, rcookie: payload.rcookie });
          }
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("MeshCentral control channel errored during login"));
        });
        ws.send(JSON.stringify({ action: "authcookie" }));
      },
    );
  }

  /* ---------------- relay ---------------- */

  async #openTerminal(): Promise<WebSocket> {
    if (this.#relay && this.#relay.readyState === 1) return this.#relay;
    await this.#openControl();

    const nodeId = qualifyNodeId(this.request.device_id);
    const tunnelId = randomBytes(6).toString("hex");
    const { cookie, rcookie } = this.#cookies!;

    // Tell the agent to dial into a relay we are about to join.
    this.#control!.send(
      JSON.stringify({
        action: "msg",
        nodeid: nodeId,
        type: "tunnel",
        usage: 1,
        value: `*/meshrelay.ashx?p=${PROTOCOL_TERMINAL}&nodeid=${nodeId}&id=${tunnelId}&rauth=${rcookie}`,
        responseid: "ait",
      }),
    );

    const relayUrl =
      `${wsUrl(this.config.serverUrl, "/meshrelay.ashx")}?browser=1` +
      `&p=${PROTOCOL_TERMINAL}&nodeid=${encodeURIComponent(nodeId)}` +
      `&id=${tunnelId}&auth=${encodeURIComponent(cookie)}`;

    const relay = await openSocket(relayUrl, this.timeout, "MeshCentral relay");
    relay.binaryType = "arraybuffer";

    // The relay is open, but the *agent* may not have arrived yet. `c` (or `cr`
    // when the session is recorded) is the server saying both ends are present.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `The MeshCentral agent on ${this.device.hostname} did not join the session within ${this.timeout}ms. It may be offline.`,
          ),
        );
      }, this.timeout);

      const onMessage = (event: MessageEvent) => {
        const text = frameToText(event.data);
        if (text === "c" || text === "cr") {
          clearTimeout(timer);
          relay.removeEventListener("message", onMessage);
          // Worth surfacing on the ticket: the user's session is being recorded.
          if (text === "cr") this.recorded = true;
          // A sane default size, then select the terminal protocol.
          relay.send(
            JSON.stringify({ ctrlChannel: CTRL_CHANNEL, type: "options", cols: 200, rows: 50 }),
          );
          relay.send(String(PROTOCOL_TERMINAL));
          resolve();
        }
      };
      relay.addEventListener("message", onMessage);
    });

    this.#relay = relay;
    this.status = "active";
    return relay;
  }

  /* ---------------- DeviceSession ---------------- */

  /**
   * Run one command on the remote host.
   *
   * Serialised through `#queue`, because a terminal has one cursor: two
   * concurrent commands would interleave their output and neither result would
   * be trustworthy.
   */
  async exec(command: string, timeoutMs = 60_000): Promise<CommandResult> {
    const run = this.#queue.then(() => this.#execNow(command, timeoutMs));
    // Keep the chain alive even when one command rejects.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #execNow(command: string, timeoutMs: number): Promise<CommandResult> {
    const started = Date.now();
    const relay = await this.#openTerminal();

    const windows = this.device.platform === "windows";
    const line = windows
      ? `${command} & echo ${SENTINEL}%errorlevel%\r\n`
      : `${command}; echo ${SENTINEL}$?\n`;

    const output = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => {
        relay.removeEventListener("message", onMessage);
        reject(new Error(`Remote command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onMessage = (event: MessageEvent) => {
        const text = frameToText(event.data);
        // In-band control frames (ping/pong, resize) are not command output.
        if (text.startsWith(`{"ctrlChannel":"${CTRL_CHANNEL}"`)) return;
        buffer += text;
        if (SENTINEL_RESULT.test(buffer)) {
          clearTimeout(timer);
          relay.removeEventListener("message", onMessage);
          resolve(buffer);
        }
      };

      relay.addEventListener("message", onMessage);
      relay.send(line);
    });

    return parseShellOutput(command, output, Date.now() - started);
  }

  /**
   * Photograph the remote screen.
   *
   * Taken through the terminal rather than MeshCentral's desktop relay: that
   * relay speaks a tiled JPEG protocol meant for a live viewer, and decoding it
   * to a still is a great deal of machinery for a worse picture. Running the
   * platform's own screenshot tool and reading the PNG back gives an exact
   * frame, and reuses the capture logic already proven locally.
   */
  async capture(): Promise<ScreenCapture> {
    const script = remoteCaptureScript(this.device.platform);
    if (!script) {
      throw new Error(
        `AIT has no remote screen-capture method for platform "${this.device.platform}".`,
      );
    }

    const result = await this.exec(script, 90_000);
    const base64 = result.stdout.replace(/\s+/g, "");
    if (result.exit_code !== 0 || base64.length < 100) {
      throw new Error(
        `Remote screen capture failed on ${this.device.hostname}: ${result.stderr.trim() || "no image data returned"}`,
      );
    }

    const png = Buffer.from(base64, "base64");
    const size = pngDimensions(png);
    if (!size) {
      throw new Error(
        `Remote screen capture on ${this.device.hostname} returned data that is not a PNG.`,
      );
    }

    return {
      source: "screen-capture",
      png: base64,
      width: size.width,
      height: size.height,
      description: `Live screen capture of ${this.device.hostname} via MeshCentral (${size.width}x${size.height}).`,
    };
  }

  async capabilities(): Promise<SessionCapabilities> {
    if (this.#capabilities) return this.#capabilities;

    const probe =
      this.device.platform === "windows"
        ? "where ipconfig systeminfo tasklist sc wmic powershell nslookup getmac"
        : "which df du free ps top uptime hostname uname getent ping dig nslookup ip ifconfig netstat curl vm_stat sw_vers systemctl journalctl lscpu";

    const result = await this.exec(probe, 30_000);
    const available = [
      ...new Set(
        result.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => (l.split(/[\\/]/).pop() ?? l).replace(/\.exe$/i, "").toLowerCase()),
      ),
    ].sort();

    const canCapture = Boolean(remoteCaptureScript(this.device.platform));
    this.#capabilities = {
      platform: this.device.platform,
      availableCommands: available,
      canCapture,
      ...(canCapture
        ? {}
        : { captureUnavailableReason: `no capture method for ${this.device.platform}` }),
    };
    return this.#capabilities;
  }

  async end(): Promise<void> {
    this.#relay?.close();
    this.#control?.close();
    this.#relay = undefined;
    this.#control = undefined;
    this.#cookies = undefined;
    this.status = "ended";
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function frameToText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return String(data);
}

function openSocket(url: string, timeoutMs: number, what: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(new Error(`Could not open ${what}: ${err instanceof Error ? err.message : err}`));
      return;
    }
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`${what} did not connect within ${timeoutMs}ms`));
    }, timeoutMs);

    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      // The WebSocket error event carries no detail by design; the likely
      // causes are worth naming so an operator is not left guessing.
      reject(
        new Error(
          `${what} failed to connect to ${url.split("?")[0]}. Check the server URL is reachable, the token is valid, and that the server's CA is trusted (NODE_EXTRA_CA_CERTS).`,
        ),
      );
    });
  });
}

/**
 * Turn a shell transcript into a command result.
 *
 * Interactive shells echo what you typed and print a prompt afterwards, so the
 * transcript contains more than the output. The sentinel line bounds the real
 * output and carries the exit code.
 */
export function parseShellOutput(
  command: string,
  transcript: string,
  durationMs: number,
): CommandResult {
  const sentinelMatch = transcript.match(SENTINEL_RESULT);
  const exitCode = sentinelMatch ? Number(sentinelMatch[1]) : 0;

  // Cut at the *expanded* sentinel, not the echoed one.
  const sentinelAt = sentinelMatch?.index ?? -1;
  let body = sentinelAt === -1 ? transcript : transcript.slice(0, sentinelAt);

  // Drop the echoed command line, which appears first on an interactive shell.
  const firstNewline = body.indexOf("\n");
  if (firstNewline !== -1 && body.slice(0, firstNewline).includes(command.slice(0, 20))) {
    body = body.slice(firstNewline + 1);
  }
  const clean = body.replace(ANSI, "").trim();

  return {
    command,
    exit_code: exitCode,
    stdout: exitCode === 0 ? clean : "",
    stderr: exitCode === 0 ? "" : clean,
    duration_ms: durationMs,
    truncated: false,
  };
}

/** A one-liner that prints a base64 PNG of the screen on stdout. */
export function remoteCaptureScript(platform: DeviceInfo["platform"]): string | undefined {
  switch (platform) {
    case "windows":
      return [
        "powershell -NoProfile -Command",
        '"Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
        "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;",
        "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;",
        "$g=[System.Drawing.Graphics]::FromImage($bmp);",
        "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
        "$ms=New-Object System.IO.MemoryStream;",
        "$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png);",
        '[Convert]::ToBase64String($ms.ToArray())"',
      ].join(" ");
    case "macos":
      return "screencapture -x -t png /tmp/ait.png && base64 -i /tmp/ait.png && rm -f /tmp/ait.png";
    case "linux":
      // Whichever tool is installed; `command -v` keeps it to one round trip.
      return (
        "(command -v scrot >/dev/null && scrot -o /tmp/ait.png) || " +
        "(command -v maim >/dev/null && maim /tmp/ait.png) || " +
        "(command -v grim >/dev/null && grim /tmp/ait.png) || " +
        "(command -v import >/dev/null && import -window root /tmp/ait.png); " +
        "base64 -w0 /tmp/ait.png && rm -f /tmp/ait.png"
      );
    default:
      return undefined;
  }
}
