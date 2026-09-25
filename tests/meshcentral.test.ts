/**
 * MeshCentral transport tests.
 *
 * A stub server speaks the real protocol - authcookie, tunnel request, the `c`
 * handshake, protocol selection, and a shell that echoes and prints a prompt -
 * so the client is exercised against the message flow it will meet in
 * production rather than against a mock of itself.
 *
 * `ws` is also used by the client when MeshCentral password authentication
 * requires an x-meshauth upgrade header.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import {
  MeshCentralSession,
  meshConfigFromEnv,
  parseShellOutput,
  qualifyNodeId,
  remoteCaptureScript,
} from "../src/execution-plane/remote.js";
import type { DeviceInfo } from "../src/contracts/ticket.js";

const DEVICE: DeviceInfo = {
  device_id: "abc123",
  hostname: "REMOTE-01",
  platform: "linux",
  consent_granted: true,
  managed: true,
};

function request(deviceId = DEVICE.device_id) {
  return {
    tenant_id: "t",
    task_id: "k",
    trace_id: "tr",
    device_id: deviceId,
    operator_id: "op",
    requested_at: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * A stub that speaks MeshCentral's actual message flow
 * ------------------------------------------------------------------ */

interface Stub {
  port: number;
  close: () => Promise<void>;
  /** Tunnel requests the control channel received. */
  tunnelRequests: Record<string, unknown>[];
  /** Set false to simulate an agent that never joins the relay. */
  agentJoins: boolean;
  /** Set true to simulate a recorded session. */
  recorded: boolean;
  /** Set true to have the control channel reject the supplied credential. */
  rejectLogin: boolean;
  /** Raw command frames received by the terminal relay. */
  terminalInput: string[];
  /** Password-auth upgrade header received by the control channel. */
  lastMeshAuth?: string;
}

async function startStub(): Promise<Stub> {
  const stub: Partial<Stub> & { tunnelRequests: Record<string, unknown>[] } = {
    tunnelRequests: [],
    agentJoins: true,
    recorded: false,
    rejectLogin: false,
    terminalInput: [],
  };

  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/control.ashx") {
        const meshAuth = req.headers["x-meshauth"];
        stub.lastMeshAuth = Array.isArray(meshAuth) ? meshAuth[0] : meshAuth;
        ws.on("message", (raw) => {
          const msg = JSON.parse(String(raw));
          if (msg.action === "authcookie") {
            if (stub.rejectLogin) {
              ws.send(JSON.stringify({ action: "close", cause: "noauth" }));
            } else {
              ws.send(JSON.stringify({ action: "authcookie", cookie: "C1", rcookie: "R1" }));
            }
          } else if (msg.type === "tunnel") {
            stub.tunnelRequests.push(msg);
          }
        });
        return;
      }

      if (url.pathname === "/meshrelay.ashx") {
        if (!stub.agentJoins) return; // open, but the agent never arrives
        // The agent joined: announce it, then behave like a shell.
        setTimeout(() => ws.send(stub.recorded ? "cr" : "c"), 5);
        attachShell(ws, stub.terminalInput!);
        return;
      }

      ws.close();
    });
  });

  // Bind only loopback. Apart from matching the URL below, this keeps the test
  // runnable in sandboxes that correctly forbid listeners on all interfaces.
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;

  return {
    port,
    tunnelRequests: stub.tunnelRequests,
    get agentJoins() {
      return stub.agentJoins!;
    },
    set agentJoins(v: boolean) {
      stub.agentJoins = v;
    },
    get recorded() {
      return stub.recorded!;
    },
    set recorded(v: boolean) {
      stub.recorded = v;
    },
    get rejectLogin() {
      return stub.rejectLogin!;
    },
    set rejectLogin(v: boolean) {
      stub.rejectLogin = v;
    },
    terminalInput: stub.terminalInput,
    get lastMeshAuth() {
      return stub.lastMeshAuth;
    },
    close: () =>
      new Promise<void>((resolve) => {
        // Open WebSockets keep `http.close()` waiting forever, so drop them
        // first. Without this the suite hangs in teardown, not in the client.
        for (const client of wss.clients) client.terminate();
        wss.close();
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  } as Stub;
}

/** Behaves like an interactive shell: echoes the line, answers, prints a prompt. */
function attachShell(ws: WsSocket, terminalInput: string[]): void {
  ws.on("message", (raw) => {
    const text = String(raw);
    if (text === "1" || text.startsWith('{"ctrlChannel"')) return; // protocol select / options
    terminalInput.push(text);

    const command = text.trim().split(";")[0]!.trim();
    // The echo of what was typed, as a real terminal produces.
    ws.send(`${text.trim()}\r\n`);

    if (command.startsWith("which ")) {
      // `which` prints a full path per tool it finds, and nothing for the rest.
      const requested = command
        .slice("which ".length)
        .split(/\s+/);
      const found = requested.filter((t) =>
        ["df", "ps", "uptime", "uname", "getent", "curl"].includes(t),
      );
      ws.send(`${found.map((t) => `/usr/bin/${t}`).join("\r\n")}\r\n`);
      // Real `which` is non-zero when even one requested command is missing,
      // despite printing paths for every command it did find.
      ws.send(`__AIT_DONE__${found.length === requested.length ? 0 : 1}\r\n`);
    } else if (command.startsWith("false")) {
      ws.send("something went wrong\r\n");
      ws.send("__AIT_DONE__1\r\n");
    } else {
      ws.send("ok\r\n");
      ws.send("__AIT_DONE__0\r\n");
    }
  });
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

let stub: Stub;
beforeEach(async () => {
  stub = await startStub();
});
afterEach(async () => {
  await stub.close();
});

function session(overrides: Partial<{ connectTimeoutMs: number }> = {}) {
  return new MeshCentralSession(
    DEVICE,
    {
      serverUrl: `http://127.0.0.1:${stub.port}`,
      operatorToken: "token",
      meshId: "mesh//x",
      connectTimeoutMs: 4_000,
      ...overrides,
    },
    request(),
  );
}

describe("the tunnel handshake", () => {
  it("authenticates, asks the agent to dial in, and reaches an active session", async () => {
    const s = session();
    const result = await s.exec("uptime");

    expect(s.status).toBe("active");
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("ok");

    // The agent was sent a relay URL carrying the agent-side cookie.
    expect(stub.tunnelRequests).toHaveLength(1);
    const tunnel = stub.tunnelRequests[0]!;
    expect(String(tunnel["value"])).toContain("meshrelay.ashx");
    expect(String(tunnel["value"])).toContain("rauth=R1");
    expect(String(tunnel["value"])).toContain("p=1");
    expect(tunnel["nodeid"]).toBe("node//abc123");

    await s.end();
    expect(s.status).toBe("ended");
  });

  it("supports MeshCentral login-token username/password authentication", async () => {
    const s = new MeshCentralSession(
      DEVICE,
      {
        serverUrl: `http://127.0.0.1:${stub.port}`,
        operatorUsername: "~t:ait-lab",
        operatorPassword: "token-password",
        meshId: "mesh//x",
      },
      request(),
    );
    await s.exec("uptime");
    expect(stub.lastMeshAuth).toBe(
      `${Buffer.from("~t:ait-lab").toString("base64")},${Buffer.from("token-password").toString("base64")}`,
    );
    await s.end();
  });

  it("reuses one tunnel across commands rather than redialling each time", async () => {
    const s = session();
    await s.exec("uptime");
    await s.exec("df -h /");
    expect(stub.tunnelRequests).toHaveLength(1);
    await s.end();
  });

  it("notices when the session is being recorded", async () => {
    stub.recorded = true;
    const s = session();
    await s.exec("uptime");
    expect(s.recorded).toBe(true);
    await s.end();
  });

  it("says the agent is offline rather than hanging", async () => {
    stub.agentJoins = false;
    const s = session({ connectTimeoutMs: 300 });
    await expect(s.exec("uptime")).rejects.toThrow(/did not join the session/i);
    expect(s.status).toBe("failed");
    await s.end();
  });

  it("reports rejected credentials immediately", async () => {
    stub.rejectLogin = true;
    const s = session({ connectTimeoutMs: 4_000 });
    const started = Date.now();
    await expect(s.exec("uptime")).rejects.toThrow(/rejected.*login|token/i);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(s.status).toBe("failed");
    await s.end();
  });

  it("uses the mesh domain when a configured device id is only a hash", async () => {
    const s = new MeshCentralSession(
      DEVICE,
      {
        serverUrl: `http://127.0.0.1:${stub.port}`,
        operatorToken: "token",
        meshId: "mesh/corp/group123",
        connectTimeoutMs: 4_000,
      },
      request(),
    );
    await s.exec("uptime");
    expect(stub.tunnelRequests[0]?.["nodeid"]).toBe("node/corp/abc123");
    await s.end();
  });

  it("names the likely causes when the server is unreachable", async () => {
    const s = new MeshCentralSession(
      DEVICE,
      {
        serverUrl: "http://127.0.0.1:1",
        operatorToken: "t",
        meshId: "m",
        connectTimeoutMs: 1_000,
      },
      request(),
    );
    await expect(s.exec("uptime")).rejects.toThrow(/reachable|token|CA/i);
  });
});

describe("running commands over the relay", () => {
  it("serialises commands so their output cannot interleave", async () => {
    const s = session();
    const [a, b, c] = await Promise.all([
      s.exec("which df"),
      s.exec("uptime"),
      s.exec("which df"),
    ]);
    expect(a.stdout).toBe("/usr/bin/df");
    expect(b.stdout).toBe("ok");
    expect(c.stdout).toBe("/usr/bin/df");
    await s.end();
  });

  it("reports a non-zero exit as a failure with the output on stderr", async () => {
    const s = session();
    const result = await s.exec("false");
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("something went wrong");
    expect(result.stdout).toBe("");
    await s.end();
  });

  it("probes the remote host's real tool list", async () => {
    const s = session();
    const caps = await s.capabilities();
    expect(caps.platform).toBe("linux");
    expect(caps.availableCommands).toContain("df");
    expect(caps.availableCommands).not.toContain("something went wrong");
    expect(caps.canCapture).toBe(true);
    await s.end();
  });

  it("puts the Windows exit-code sentinel on a later cmd input line", async () => {
    const windows: DeviceInfo = { ...DEVICE, platform: "windows" };
    const s = new MeshCentralSession(
      windows,
      {
        serverUrl: `http://127.0.0.1:${stub.port}`,
        operatorToken: "token",
        meshId: "mesh//x",
        connectTimeoutMs: 4_000,
      },
      request(),
    );
    await s.exec("false");
    expect(stub.terminalInput.at(-1)).toBe(
      "false\r\necho __AIT_DONE__%errorlevel%\r\n",
    );
    await s.end();
  });
});

describe("transcript parsing", () => {
  it("strips the echoed command and the sentinel", () => {
    const result = parseShellOutput(
      "df -h /",
      "df -h /; echo __AIT_DONE__$?\r\nFilesystem Size\r\n/dev/vda 252G\r\n__AIT_DONE__0\r\n",
      12,
    );
    expect(result.stdout).toBe("Filesystem Size\r\n/dev/vda 252G");
    expect(result.exit_code).toBe(0);
  });

  it("strips ANSI escapes a terminal emits", () => {
    const esc = String.fromCharCode(27);
    const result = parseShellOutput(
      "ls",
      `ls; echo __AIT_DONE__$?\r\n${esc}[0;34mfolder${esc}[0m\r\n__AIT_DONE__0\r\n`,
      1,
    );
    expect(result.stdout).toBe("folder");
  });

  it("carries the remote exit code through", () => {
    const result = parseShellOutput("badcmd", "badcmd\r\nnot found\r\n__AIT_DONE__127\r\n", 1);
    expect(result.exit_code).toBe(127);
    expect(result.stderr).toContain("not found");
  });

  it("strips the separately echoed Windows sentinel helper", () => {
    const result = parseShellOutput(
      "dir missing",
      "dir missing\r\necho __AIT_DONE__%errorlevel%\r\nFile Not Found\r\n__AIT_DONE__1\r\n",
      1,
    );
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toBe("File Not Found");
  });
});

describe("configuration and addressing", () => {
  it("qualifies a bare device id and leaves a full one alone", () => {
    expect(qualifyNodeId("abc")).toBe("node//abc");
    expect(qualifyNodeId("abc", "corp")).toBe("node/corp/abc");
    expect(qualifyNodeId("node/corp/abc")).toBe("node/corp/abc");
  });

  it("needs all three settings before it will claim to be configured", () => {
    const saved = { ...process.env };
    delete process.env["MESHCENTRAL_URL"];
    delete process.env["MESHCENTRAL_TOKEN"];
    delete process.env["MESHCENTRAL_MESH_ID"];
    expect(meshConfigFromEnv()).toBeUndefined();

    process.env["MESHCENTRAL_URL"] = "https://mesh.test";
    expect(meshConfigFromEnv()).toBeUndefined();

    process.env["MESHCENTRAL_TOKEN"] = "t";
    process.env["MESHCENTRAL_MESH_ID"] = "m";
    expect(meshConfigFromEnv()?.serverUrl).toBe("https://mesh.test");

    delete process.env["MESHCENTRAL_TOKEN"];
    process.env["MESHCENTRAL_USER"] = "~t:ait-lab";
    process.env["MESHCENTRAL_PASSWORD"] = "token-password";
    expect(meshConfigFromEnv()?.operatorUsername).toBe("~t:ait-lab");

    process.env = saved;
  });

  it("has a capture method for each supported platform and none for unknown", () => {
    expect(remoteCaptureScript("windows")).toContain("CopyFromScreen");
    expect(remoteCaptureScript("macos")).toContain("screencapture");
    expect(remoteCaptureScript("linux")).toContain("scrot");
    expect(remoteCaptureScript("unknown")).toBeUndefined();
  });
});
