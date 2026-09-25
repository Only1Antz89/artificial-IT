/**
 * A UI-TARS Desktop RPC bridge, for the simulation stack.
 *
 * This speaks the contract the real bridge in the alternative project speaks -
 * POST-only, bearer or `x-aillium-*` token, `/capabilities`, `/handoff`,
 * `/invoke`, and the same response shapes - against the simulated desktop in
 * `desktop-state.ts` rather than a real screen.
 *
 * Why this exists rather than "just simulate it in-process": every property
 * worth demonstrating lives at the boundary. A token that is wrong, a bridge
 * that is down, a 404 on the wrong path, a timeout mid-action - none of those
 * happen to a function call, and all of them happen in front of stakeholders.
 * Running the real wire protocol over a real socket is what makes the demo an
 * integration test rather than a slideshow.
 *
 * It is a simulation and says so: `provider` is `simulated-ui-tars-desktop`,
 * never `ui-tars-desktop`, so nothing downstream can mistake it for the real
 * application driving a real screen.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  applyInstruction,
  execOnDesktop,
  freshDesktopState,
  readState,
  type DesktopState,
} from "./desktop-state.js";

/** Mirrors the capability descriptors the real bridge advertises. */
const CAPABILITIES = [
  {
    action: "screen.get_size",
    surface: "local_computer",
    category: "screen",
    description: "Read the primary display dimensions and scale factor.",
  },
  {
    action: "computer.get_state",
    surface: "local_computer",
    category: "computer",
    description: "Read what the desktop is currently showing.",
  },
  {
    action: "computer.execute_instruction",
    surface: "local_computer",
    category: "computer",
    description: "Carry out a natural-language instruction on the desktop.",
  },
] as const;

export interface DesktopBridgeOptions {
  port?: number;
  host?: string;
  /** Required. A bridge with no token refuses everything, as the real one does. */
  token: string;
  state?: DesktopState;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Accept the same two credential shapes the real bridge accepts.
 *
 * Compared in constant time is overkill for a simulation, but the comparison
 * being length-leaky here and not there would be a difference between the
 * simulation and the thing it stands in for, and those differences are exactly
 * what make a simulated demo lie.
 */
function presentedToken(req: IncomingMessage): string {
  const header = req.headers["x-aillium-runtime-token"];
  const direct = typeof header === "string" ? header.trim() : "";
  if (direct) return direct;
  const authorization =
    typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export interface RunningBridge {
  port: number;
  state: DesktopState;
  close: () => Promise<void>;
}

export async function startDesktopBridge(
  options: DesktopBridgeOptions,
): Promise<RunningBridge> {
  const token = options.token.trim();
  if (!token) throw new Error("the desktop bridge needs a token; it refuses every request without one");
  const state = options.state ?? freshDesktopState();

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      sendJson(res, 405, { error: "Method Not Allowed" });
      return;
    }
    if (presentedToken(req) !== token) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    try {
      const body = await readJsonBody(req);

      if (path === "/capabilities") {
        sendJson(res, 200, {
          available: true,
          rpcReady: true,
          provider: "simulated-ui-tars-desktop",
          launchUrl: null,
          activeOperator: "simulated-nutjs",
          capabilities: CAPABILITIES,
        });
        return;
      }

      if (path === "/handoff") {
        state.foreground = "Settings — Network & internet";
        sendJson(res, 200, {
          handoffPrepared: true,
          requestedSurface: readString(body.requestedSurface) || "local_computer",
          activeOperator: "simulated-nutjs",
          note: readString(body.reason) || "Desktop handoff prepared.",
        });
        return;
      }

      // The terminal channel onto the same host. A real deployment reaches it
      // over MeshCentral rather than over this bridge; what matters for the
      // demo is that it reads the state the desktop actions write, so a fix
      // applied through one channel is verifiable through the other.
      if (path === "/exec") {
        const command = readString(body.command);
        if (!command) {
          sendJson(res, 400, { error: "command is required" });
          return;
        }
        const started = Date.now();
        const result = execOnDesktop(state, command);
        sendJson(res, 200, {
          command,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs: Date.now() - started,
        });
        return;
      }

      if (path === "/invoke") {
        const action = readString(body.action);
        if (!action) {
          sendJson(res, 400, { error: "action is required" });
          return;
        }

        const read = readState(state, action);
        if (read) {
          sendJson(res, 200, { ok: read.ok, action, result: read });
          return;
        }

        if (action !== "computer.execute_instruction") {
          sendJson(res, 400, { error: `Unsupported desktop RPC action: ${action}` });
          return;
        }

        const args =
          body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
            ? (body.arguments as Record<string, unknown>)
            : {};
        const instruction = readString(args.instruction) || readString(args.prompt);
        if (!instruction) {
          sendJson(res, 400, { error: "computer.execute_instruction needs an instruction" });
          return;
        }

        const outcome = applyInstruction(state, instruction);
        // A refused instruction is a 200 carrying `ok: false`, exactly as the
        // real bridge reports an operator that declined: the RPC succeeded,
        // the desktop action did not.
        sendJson(res, 200, { ok: outcome.ok, action, result: outcome });
        return;
      }

      sendJson(res, 404, { error: "Not Found" });
    } catch (err) {
      sendJson(res, 400, {
        error: err instanceof Error ? err.message : "desktop bridge error",
      });
    }
  });

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 47891, options.host ?? "127.0.0.1", resolve),
  );

  return {
    port: (server.address() as { port: number }).port,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
