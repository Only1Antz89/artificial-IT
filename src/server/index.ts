/**
 * The technician console server.
 *
 * `node:http` directly. The surface is eight routes and one SSE stream; a
 * framework would be more code than the thing it wraps, and the streaming and
 * back-pressure behaviour is clearer written out.
 *
 * Routes:
 *   GET  /                          the console
 *   GET  /api/scenarios             what can be run, simulated and local
 *   GET  /api/providers             which reasoning providers are usable
 *   POST /api/check                 ask the guardrails about a command
 *   POST /api/runs                  start a run; returns its id immediately
 *   GET  /api/runs/:id/events       server-sent events for that run
 *   POST /api/runs/:id/approvals/:approvalId   approve or deny a gated step
 *   GET  /api/runs/:id/evidence/:file          an artefact from the run
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runTicket } from "../agent/loop.js";
import { selectBrainChecked, selectBrain, type ProviderName } from "../agent/select-brain.js";
import { checkClaudeModel, checkOpenAIModel, withTimeout } from "../agent/model-check.js";
import { evaluate } from "../control-plane/policy/engine.js";
import { newId } from "../contracts/index.js";
import { KnowledgeStore, retrieve } from "../knowledge/index.js";
import { seedKnowledge } from "../demo/seed-knowledge.js";
import { SCENARIOS, TICKETS, USERS, DEVICE_FIELDS } from "../demo/scenarios.js";
import { LOCAL_SCENARIOS } from "../demo/run-local.js";
import { localDangerTicket, localHealthTicket, localSession, hostPlatform } from "../demo/local.js";
import {
  AD_HOC_TARGETS,
  adHocTicket,
  localTargetAvailable,
  type AdHocRequest,
} from "../demo/adhoc.js";
import {
  makeMacDnsDevice,
  makeWindowsDnsDevice,
  makeWindowsPrintDevice,
} from "../demo/devices.js";
import {
  InMemoryZendeskClient,
  publicReplyFor,
  renderInternalNote,
  ticketUpdateFor,
  toTicket,
} from "../integrations/zendesk/index.js";
import { RunRegistry, type RunSession } from "./run-registry.js";
import { undoChange, undoableChanges } from "./undo.js";
import { runQueue } from "../demo/run-queue.js";
import type { DeviceSession } from "../execution-plane/device.js";

const here = dirname(fileURLToPath(import.meta.url));
const registry = new RunRegistry();

/**
 * How long a device session stays open after its run, so a change can be undone.
 *
 * Long enough to change your mind, short enough that a console left open
 * overnight is not holding a live session on someone's machine.
 */
const UNDO_WINDOW_MS = 15 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function readBody<T>(req: IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/* ------------------------------------------------------------------ *
 * Starting a run
 * ------------------------------------------------------------------ */

interface StartRunBody {
  /** A fixture scenario key, or absent when `ticket` carries an ad-hoc one. */
  scenario?: string;
  /** A ticket typed on the spot. */
  ticket?: AdHocRequest;
  provider?: ProviderName;
}

/** Open a session against whichever machine an ad-hoc ticket names. */
function adHocSession(target: AdHocRequest["target"]): DeviceSession | undefined {
  switch (target) {
    case "simulated-windows-laptop":
      return makeWindowsDnsDevice();
    case "simulated-windows-desktop":
      return makeWindowsPrintDevice();
    case "simulated-mac-laptop":
      return makeMacDnsDevice();
    case "no-device":
      return undefined;
    default:
      return localSession();
  }
}

/**
 * Kick off a run and return immediately.
 *
 * The run is driven in the background and reports through the session's event
 * stream, so the browser can watch it and answer approvals while it is still
 * going. Errors land on the stream too rather than a dropped connection.
 */
function startRun(body: StartRunBody, workdir: string): RunSession {
  const session = registry.create();

  void (async () => {
    let device: DeviceSession | undefined;
    try {
      const selection = await selectBrainChecked(body.provider);
      session.emit({
        type: "started",
        runId: session.id,
        provider: selection.provider,
        model: selection.model,
        note: selection.note,
      });

      const knowledge = new KnowledgeStore(join(workdir, "knowledge.jsonl"));
      seedKnowledge(knowledge);

      const local = LOCAL_SCENARIOS.some((s) => s.key === body.scenario);
      let ticket;
      let zendesk: InMemoryZendeskClient | undefined;
      let zendeskTicketId: number | undefined;

      if (body.ticket) {
        // Typed on the spot. Nothing is matched or pre-arranged - it goes to
        // whichever brain is configured, exactly as a fixture ticket would.
        ticket = adHocTicket(body.ticket);
        device = adHocSession(body.ticket.target);
      } else if (local) {
        if (hostPlatform() === "unknown") {
          throw new Error(`No diagnostic set for platform "${process.platform}".`);
        }
        ticket =
          body.scenario === "local-danger" ? localDangerTicket() : localHealthTicket();
        device = localSession();
      } else {
        const scenario = SCENARIOS.find((s) => s.key === body.scenario);
        if (!scenario) throw new Error(`Unknown scenario "${body.scenario}".`);
        zendesk = new InMemoryZendeskClient({ tickets: TICKETS, users: USERS });
        zendeskTicketId = scenario.ticketId;
        const zTicket = await zendesk.getTicket(scenario.ticketId);
        ticket = toTicket(zTicket, await zendesk.getUser(zTicket.requester_id), {
          deviceFields: DEVICE_FIELDS,
        });
        device = scenario.makeSession();
      }

      if (device) {
        const caps = await device.capabilities();
        session.emit({
          type: "host",
          hostname: ticket.device?.hostname ?? "unknown",
          platform: caps.platform,
          tools: caps.availableCommands.length,
          canCapture: caps.canCapture,
          ...(caps.captureUnavailableReason
            ? { captureNote: caps.captureUnavailableReason }
            : {}),
        });
      }

      const run = await runTicket({
        ticket,
        brain: selection.brain,
        knowledge,
        ...(device ? { session: device } : {}),
        // The browser is the technician: gated steps wait for a real decision,
        // and a question to the user waits for a real answer.
        gate: session.gate(),
        askUser: session.ask(),
        evidenceRoot: workdir,
        stepBudget: 10,
        onEvent: (event) => session.emit(event),
      });

      // Write back to the help desk for the simulated scenarios, attachments
      // and all, so the console can show the ticket as a technician would see it.
      if (zendesk && zendeskTicketId !== undefined) {
        const tokens: string[] = [];
        for (const result of run.results) {
          for (const artifact of result.artifacts) {
            if (!artifact.content_type?.startsWith("image/")) continue;
            const path = artifact.uri.replace(/^file:\/\//, "");
            if (!existsSync(path)) continue;
            const content = readFileSync(path, "utf8");
            tokens.push(
              (await zendesk.upload(path.split("/").pop()!, artifact.content_type, content))
                .token,
            );
          }
        }
        await zendesk.updateTicket(zendeskTicketId, ticketUpdateFor(run, tokens));
        const reply = publicReplyFor(run.documentation, run.escalation, []);
        if (reply) await zendesk.updateTicket(zendeskTicketId, reply);
      }

      // Held so a technician can still undo a change, then closed on a timer.
      session.run = run;
      session.device = device;
      device = undefined;

      session.emit({
        type: "done",
        run,
        internalNote: renderInternalNote(run),
        undoable: undoableChanges(run),
      });
      session.finish("finished");
      session.keepOpenFor(UNDO_WINDOW_MS);
    } catch (err) {
      session.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      session.finish("failed");
    } finally {
      await device?.end();
    }
  })();

  return session;
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

export async function startServer(
  port = Number(process.env["PORT"] ?? 3000),
  workdir = "run-artifacts",
): Promise<{ port: number; close: () => Promise<void> }> {
  const consoleHtml = readFileSync(join(here, "console", "index.html"), "utf8");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(consoleHtml);
        return;
      }

      if (req.method === "GET" && path === "/api/scenarios") {
        json(res, 200, {
          simulated: SCENARIOS.map((s) => ({
            key: s.key,
            title: s.title,
            demonstrates: s.demonstrates,
            ticketId: s.ticketId,
          })),
          local: LOCAL_SCENARIOS,
          localAvailable: hostPlatform() !== "unknown",
          hostPlatform: hostPlatform(),
          // Targets an ad-hoc ticket can be pointed at.
          targets: AD_HOC_TARGETS.filter(
            (t) => t.key !== "this-machine" || localTargetAvailable(),
          ),
        });
        return;
      }

      // What AIT has learned - readable, searchable and deletable, because a
      // knowledge base a technician cannot correct is one they cannot trust.
      if (req.method === "GET" && path === "/api/knowledge") {
        const store = new KnowledgeStore(join(workdir, "knowledge.jsonl"));
        const query = (url.searchParams.get("q") ?? "").trim();
        const entries = query
          ? retrieve(store.all(), { text: query, limit: 50, minScore: 0.1, minCoverage: 0 }).map(
              (hit) => ({ ...hit.entry, matched: hit.matched_terms }),
            )
          : store.all().sort((a, b) => b.learned_at.localeCompare(a.learned_at));
        json(res, 200, { entries, total: store.size() });
        return;
      }

      const kbDelete = path.match(/^\/api\/knowledge\/([^/]+)$/);
      if (req.method === "DELETE" && kbDelete) {
        const store = new KnowledgeStore(join(workdir, "knowledge.jsonl"));
        const removed = store.remove(decodeURIComponent(kbDelete[1]!));
        json(res, removed ? 200 : 404, removed ? { ok: true } : { error: "no such entry" });
        return;
      }

      if (req.method === "GET" && path === "/api/providers") {
        json(res, 200, { providers: await providerStatus() });
        return;
      }

      // Ask the guardrails directly, with no model involved.
      if (req.method === "POST" && path === "/api/check") {
        const body = await readBody<{ command?: string }>(req);
        const command = (body?.command ?? "").trim();
        if (!command) {
          json(res, 400, { error: "a command is required" });
          return;
        }
        const verdict = evaluate(
          {
            id: newId("check"),
            kind: "command",
            intent: command,
            payload: { command },
            mutating: false,
          },
          {
            device: {
              device_id: "check",
              hostname: "check",
              platform: "windows",
              consent_granted: true,
              managed: true,
            },
          },
        );
        json(res, 200, { command, verdict });
        return;
      }

      if (req.method === "POST" && path === "/api/queue") {
        const body = await readBody<{ provider?: ProviderName; limit?: number }>(req);
        const result = await runQueue({
          ...(body?.provider ? { provider: body.provider } : {}),
          ...(body?.limit ? { limit: body.limit } : {}),
          workdir,
        });
        json(res, 200, {
          provider: {
            name: result.selection.provider,
            model: result.selection.model,
            note: result.selection.note,
          },
          runs: result.runs,
          metrics: result.metrics,
          knowledgeSize: result.knowledgeSize,
        });
        return;
      }

      if (req.method === "POST" && path === "/api/runs") {
        const body = await readBody<StartRunBody>(req);
        if (!body?.scenario && !body?.ticket?.description) {
          json(res, 400, { error: "a scenario key or a ticket description is required" });
          return;
        }
        const session = startRun(body, workdir);
        json(res, 202, { runId: session.id });
        return;
      }

      const eventsMatch = path.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (req.method === "GET" && eventsMatch) {
        // A reconnecting EventSource sends back the last id it saw. Honour it,
        // or the client redraws the entire run every time its connection blips.
        const lastEventId = Number(req.headers["last-event-id"]);
        streamEvents(
          res,
          eventsMatch[1]!,
          Number.isInteger(lastEventId) ? lastEventId : undefined,
        );
        return;
      }

      const answerMatch = path.match(/^\/api\/runs\/([^/]+)\/questions\/([^/]+)$/);
      if (req.method === "POST" && answerMatch) {
        const session = registry.get(answerMatch[1]!);
        if (!session) {
          json(res, 404, { error: "unknown run" });
          return;
        }
        const body = await readBody<{ answer?: string }>(req);
        const answer = (body?.answer ?? "").trim();
        if (!answer) {
          json(res, 400, { error: "an answer is required" });
          return;
        }
        const ok = session.answer(answerMatch[2]!, answer);
        json(res, ok ? 200 : 409, ok ? { ok: true } : { error: "that question is no longer open" });
        return;
      }

      const approvalMatch = path.match(/^\/api\/runs\/([^/]+)\/approvals\/([^/]+)$/);
      if (req.method === "POST" && approvalMatch) {
        const session = registry.get(approvalMatch[1]!);
        if (!session) {
          json(res, 404, { error: "unknown run" });
          return;
        }
        const body = await readBody<{ approved?: boolean; approver?: string; reason?: string }>(req);
        const approved = body?.approved === true;
        const ok = session.decide(
          approvalMatch[2]!,
          approved,
          body?.approver?.trim() || "technician",
          body?.reason?.trim() ||
            (approved ? "Approved at the console." : "Declined at the console."),
        );
        json(res, ok ? 200 : 409, ok ? { ok: true } : { error: "approval is no longer pending" });
        return;
      }

      const undoMatch = path.match(/^\/api\/runs\/([^/]+)\/undo\/([^/]+)$/);
      if (req.method === "POST" && undoMatch) {
        const session = registry.get(undoMatch[1]!);
        if (!session?.run) {
          json(res, 404, { error: "unknown or unfinished run" });
          return;
        }
        const body = await readBody<{ approver?: string }>(req);
        const outcome = await undoChange(
          session.run,
          undoMatch[2]!,
          session.device,
          workdir,
          body?.approver?.trim() || "technician",
        );
        // The stream carries the undo too, so the console shows it as a step
        // rather than silently mutating the page.
        if (outcome.result) session.emit({ type: "step", result: outcome.result });
        json(res, outcome.ok ? 200 : 409, outcome);
        return;
      }

      const evidenceMatch = path.match(/^\/api\/runs\/([^/]+)\/evidence\/(.+)$/);
      if (req.method === "GET" && evidenceMatch) {
        serveEvidence(res, workdir, evidenceMatch[2]!);
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  const actualPort = (server.address() as { port: number }).port;
  console.log(`\n  AIT technician console → http://localhost:${actualPort}\n`);

  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Stream a run's events.
 *
 * Every frame carries an `id:`, which is the event's index in the run's
 * history. A browser that loses its connection reconnects automatically and
 * sends the last id it saw in `Last-Event-ID`; replaying from there rather than
 * from the beginning is the difference between a brief blip and a console that
 * draws the whole run a second time.
 */
function streamEvents(res: ServerResponse, runId: string, lastEventId?: number): void {
  const session = registry.get(runId);
  if (!session) {
    json(res, 404, { error: "unknown run" });
    return;
  }

  const history = session.history();
  const resumeAfter = lastEventId === undefined ? -1 : lastEventId;

  // Nothing left to send on a run that is over. Answering 200 with an empty
  // body would leave the browser reconnecting every few seconds for the life of
  // the tab; 204 is the one response EventSource treats as "stop asking".
  if (session.status !== "running" && resumeAfter >= history.length - 1) {
    res.writeHead(204).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Proxies that buffer would defeat the entire point of streaming.
    "X-Accel-Buffering": "no",
  });

  // `id` is the index in the run's history, so it is stable across reconnects.
  let nextId = 0;
  const send = (event: unknown) => {
    res.write(`id: ${nextId}\ndata: ${JSON.stringify(event)}\n\n`);
    nextId += 1;
  };

  // Replay, so a browser that connects late still sees the whole run - but only
  // the part it has not already seen. The history already contains every
  // `approval-requested` event, and an approval that is still pending simply has
  // no matching `approval-resolved` after it, so there is nothing to
  // re-announce and doing so would double the card.
  nextId = Math.min(resumeAfter + 1, history.length);
  for (const event of history.slice(nextId)) send(event);

  // A comment frame every 20s keeps intermediaries from closing an idle stream
  // while the run waits on a human.
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
  const finish = () => {
    clearInterval(keepAlive);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };

  const unsubscribe = session.subscribe((event) => {
    send(event);
    // Close the stream when the run is over. Left open, every finished run
    // leaked a socket and a keep-alive interval for as long as the process
    // lived, and a browser that had navigated away would never learn to stop.
    const type = (event as { type?: string }).type;
    if (type === "done" || type === "error") setImmediate(finish);
  });

  // The run may already have finished before this subscriber arrived, in which
  // case the replay above carried its terminal event and nothing more is coming.
  if (session.status !== "running") setImmediate(finish);

  res.on("close", finish);
}

/**
 * Serve one evidence artefact.
 *
 * The filename is taken from the request, so it is normalised and confined to
 * the evidence directory: a console that will hand back any path it is given is
 * a file-disclosure bug with a nice UI on top.
 */
function serveEvidence(res: ServerResponse, workdir: string, file: string): void {
  const decoded = decodeURIComponent(file);
  if (decoded.includes("\0")) {
    json(res, 400, { error: "bad path" });
    return;
  }

  // `resolve` handles both an absolute evidence root and one relative to the
  // working directory; `join(cwd, "/abs/path")` silently produces neither.
  const root = resolve(workdir);
  const target = normalize(join(root, decoded));
  if (!target.startsWith(root + sep) && target !== root) {
    json(res, 403, { error: "outside the evidence directory" });
    return;
  }
  if (!existsSync(target)) {
    json(res, 404, { error: "no such artefact" });
    return;
  }

  const type = target.endsWith(".svg")
    ? "image/svg+xml"
    : target.endsWith(".png")
      ? "image/png"
      : "text/plain; charset=utf-8";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(readFileSync(target));
}

async function providerStatus(): Promise<
  { name: string; state: string; detail: string; model?: string }[]
> {
  const out: { name: string; state: string; detail: string; model?: string }[] = [];

  for (const provider of ["claude", "openai"] as const) {
    let selection;
    try {
      selection = selectBrain(provider);
    } catch (err) {
      out.push({
        name: provider,
        state: "not-configured",
        detail: err instanceof Error ? err.message : "not configured",
      });
      continue;
    }
    const check = await withTimeout(
      provider === "claude"
        ? checkClaudeModel(selection.model)
        : checkOpenAIModel(selection.model),
      { ok: true, model: selection.model, skipped: "timed out", message: "Verification timed out." },
    );
    out.push({
      name: provider,
      model: selection.model,
      state: check.skipped ? "unverified" : check.ok ? "ready" : "bad-model",
      detail: check.message,
    });
  }

  const offline = selectBrain("offline");
  out.push({
    name: "offline",
    model: offline.model,
    state: "ready",
    detail: "Deterministic playbook engine. No network, no API key.",
  });
  return out;
}
