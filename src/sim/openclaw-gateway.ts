/**
 * An OpenClaw desktop gateway, for the simulation stack.
 *
 * This is the middle hop: AIT calls it, it validates the governed request and
 * forwards to the UI-TARS Desktop bridge. It exists so the demo exercises the
 * shape the real deployment has - two network hops, two credentials, and a
 * gateway that can refuse a request the bridge would happily have run.
 *
 * It serves both path dialects, because the two deployments genuinely differ
 * and the client's discovery logic should be exercised rather than assumed.
 *
 * What it does NOT do is mint authority. AIT supplies `desktopControlToken`
 * and a complete execution context; this gateway checks they are present and
 * well-formed and passes them on. It cannot verify a signature, because the
 * key that would sign one is not part of this simulation - so it says so in
 * every response rather than implying a verification it did not perform.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface GatewayOptions {
  port?: number;
  host?: string;
  /** The token AIT must present to this gateway. */
  token: string;
  /** Where the UI-TARS Desktop bridge is listening. */
  bridgeUrl: string;
  /** The token this gateway presents to that bridge. Separate on purpose. */
  bridgeToken: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

/** Fields the real gateway's schema requires on an invoke. */
const REQUIRED_INVOKE_FIELDS = ["tenantId", "sessionId", "sessionKey", "action"] as const;

/** Fields AIT's governed boundary adds on top, which must survive the hop. */
const REQUIRED_CONTEXT_FIELDS = [
  "tenantId",
  "authorityType",
  "authorityId",
  "workOrderId",
  "runId",
  "runStepId",
  "desktopSessionId",
  "attempt",
  "executorId",
  "fenceToken",
  "cancellationGeneration",
] as const;

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

function nonBlank(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : typeof value === "number";
}

/** Which route a path is, across both dialects. */
function classify(path: string): "capabilities" | "handoff" | "invoke" | undefined {
  const tail = path.replace(/^\/api(\/aillium)?\/desktop/, "");
  if (path === tail) return undefined;
  if (tail === "/capabilities") return "capabilities";
  if (tail === "/request-handoff") return "handoff";
  if (tail === "/invoke-action") return "invoke";
  return undefined;
}

export interface RunningGateway {
  port: number;
  close: () => Promise<void>;
}

export async function startOpenClawGateway(
  options: GatewayOptions,
): Promise<RunningGateway> {
  const token = options.token.trim();
  if (!token) throw new Error("the gateway needs a token; it refuses every request without one");
  const bridgeUrl = options.bridgeUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? 10_000;

  const callBridge = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; payload: unknown }> => {
    const response = await doFetch(`${bridgeUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.bridgeToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let payload: unknown = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    return { status: response.status, payload };
  };

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      sendJson(res, 405, { error: "Method Not Allowed" });
      return;
    }

    const route = classify(path);
    if (!route) {
      sendJson(res, 404, { error: "Not Found" });
      return;
    }
    if (presentedToken(req) !== token) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    try {
      const body = await readJsonBody(req);

      if (route === "capabilities") {
        // A bridge that is down refuses the connection rather than answering,
        // so the throw has to be caught here. Letting it reach the catch-all
        // turns "the gateway is up, its bridge is not" into a flat 502, and
        // that is precisely the distinction the Operations card exists to draw.
        const probe = await callBridge("/capabilities", {}).catch(() => undefined);
        const { status, payload } = probe ?? { status: 0, payload: {} };
        if (status !== 200) {
          // The gateway is up and the bridge is not. Saying so is the whole
          // point of the Operations card's CONFIGURED-but-not-LIVE state.
          sendJson(res, 200, {
            available: false,
            rpcReady: false,
            provider: "simulated-openclaw-gateway",
            launchUrl: null,
            surfaces: [],
            operators: [],
            capabilities: [],
            note: "The gateway is reachable but its desktop bridge is not answering.",
          });
          return;
        }
        const record = (payload ?? {}) as Record<string, unknown>;
        sendJson(res, 200, {
          ...record,
          note:
            "Simulated gateway: authority fields are carried and checked for shape, not cryptographically verified.",
        });
        return;
      }

      if (route === "handoff") {
        const { status, payload } = await callBridge("/handoff", body);
        sendJson(res, status, payload);
        return;
      }

      // An action. Refuse anything missing the governed fields *before* it
      // reaches the bridge: the gateway is where authority is supposed to be
      // checked, and a simulation that forwarded an unauthorised action would
      // be teaching the wrong lesson.
      const missing = REQUIRED_INVOKE_FIELDS.filter((field) => !nonBlank(body[field]));
      if (!nonBlank(body.desktopControlToken)) missing.push("desktopControlToken" as never);

      const context =
        body.executionContext && typeof body.executionContext === "object"
          ? (body.executionContext as Record<string, unknown>)
          : undefined;
      if (!context) {
        missing.push("executionContext" as never);
      } else {
        for (const field of REQUIRED_CONTEXT_FIELDS) {
          if (!nonBlank(context[field])) missing.push(`executionContext.${field}` as never);
        }
      }

      if (missing.length > 0) {
        sendJson(res, 403, {
          error: "desktop authority is incomplete",
          missing,
        });
        return;
      }

      const { status, payload } = await callBridge("/invoke", {
        action: body.action,
        arguments: body.arguments ?? {},
        requestedSurface: body.requestedSurface,
      });
      if (status !== 200) {
        sendJson(res, 502, { error: "the desktop bridge rejected the action" });
        return;
      }

      const record = (payload ?? {}) as Record<string, unknown>;
      const result = (record.result ?? {}) as Record<string, unknown>;
      sendJson(res, 200, {
        ok: record.ok === true,
        action: body.action,
        provider: "simulated-openclaw-gateway",
        observation:
          typeof result.observation === "string"
            ? result.observation
            : "The desktop bridge returned no observation.",
        ...(result.detail ? { detail: result.detail } : {}),
        // Echoed so the receipt on the ticket shows which fence and which
        // cancellation generation the action ran under.
        fenceToken: context!.fenceToken,
        cancellationGeneration: context!.cancellationGeneration,
        runStepId: context!.runStepId,
        note: "Simulated gateway: authority carried and shape-checked, not signature-verified.",
      });
    } catch (err) {
      sendJson(res, 502, {
        error: err instanceof Error ? err.message : "gateway error",
      });
    }
  });

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 18789, options.host ?? "127.0.0.1", resolve),
  );

  return {
    port: (server.address() as { port: number }).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
