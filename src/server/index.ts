/**
 * The technician console server.
 *
 * A small HTTP surface over the demo, so the run can be watched rather than
 * read from a terminal. Uses `node:http` directly - the API is four routes, and
 * a framework would be more code than the thing it wraps.
 *
 * Routes:
 *   GET  /                    the console
 *   GET  /api/scenarios       what can be run
 *   POST /api/run             run scenarios, return the full result set
 *   GET  /api/knowledge       what has been learned so far
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDemo } from "../demo/run-demo.js";
import { SCENARIOS } from "../demo/scenarios.js";
import { renderInternalNote } from "../integrations/zendesk/index.js";
import type { ProviderName } from "../agent/select-brain.js";

const here = dirname(fileURLToPath(import.meta.url));

interface RunRequestBody {
  provider?: ProviderName;
  scenarios?: string[];
}

async function readBody(
  stream: NodeJS.ReadableStream,
): Promise<RunRequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as RunRequestBody;
  } catch {
    return {};
  }
}

export async function startServer(port = Number(process.env["PORT"] ?? 3000)): Promise<void> {
  const console_html = readFileSync(join(here, "console", "index.html"), "utf8");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(console_html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/scenarios") {
        json(200, {
          scenarios: SCENARIOS.map((s) => ({
            key: s.key,
            title: s.title,
            demonstrates: s.demonstrates,
            ticket_id: s.ticketId,
          })),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/run") {
        const body = await readBody(req);
        const session = await runDemo({
          ...(body.provider ? { provider: body.provider } : {}),
          ...(body.scenarios?.length ? { scenarios: body.scenarios } : {}),
        });

        json(200, {
          provider: {
            name: session.selection.provider,
            model: session.selection.model,
            note: session.selection.note,
          },
          knowledge_size: session.knowledge.size(),
          results: session.results.map((r) => ({
            scenario: {
              key: r.scenario.key,
              title: r.scenario.title,
              demonstrates: r.scenario.demonstrates,
            },
            run: r.run,
            internal_note: renderInternalNote(r.run),
            ticket_after: r.ticketAfter,
            attachments: r.attachments,
          })),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/knowledge") {
        // The knowledge base only exists inside a run session, so a bare GET
        // runs nothing and says so rather than inventing an empty answer.
        json(200, {
          note: "Run a scenario first; the knowledge base is built during a run.",
        });
        return;
      }

      json(404, { error: "not found" });
    } catch (err) {
      json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`\n  AIT technician console → http://localhost:${port}\n`);
}
