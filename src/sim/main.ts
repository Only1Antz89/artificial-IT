/**
 * Entrypoint for the simulation services.
 *
 * `node dist/src/sim/main.js bridge` and `... gateway` are what the container
 * images run. Kept in one file so the two services share their configuration
 * conventions and their "what this is not" banner.
 */
import { startDesktopBridge } from "./desktop-bridge.js";
import { startOpenClawGateway } from "./openclaw-gateway.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`\n  ${name} is required. Refusing to start without it.\n`);
    process.exit(1);
  }
  return value;
}

function port(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    console.error(`\n  ${name} must be a port number.\n`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const role = process.argv[2];
  // Containers bind all interfaces; a bare `npm run sim:*` stays on loopback.
  const host = process.env["SIM_BIND_HOST"]?.trim() || "127.0.0.1";

  if (role === "bridge") {
    const running = await startDesktopBridge({
      token: required("AILLIUM_DESKTOP_BRIDGE_TOKEN"),
      port: port("AILLIUM_DESKTOP_BRIDGE_PORT", 47891),
      host,
    });
    console.log(
      `\n  Simulated UI-TARS desktop bridge → http://${host}:${running.port}` +
        `\n  Simulated: no real screen is driven. Wi-Fi starts switched off.\n`,
    );
    return;
  }

  if (role === "gateway") {
    const running = await startOpenClawGateway({
      token: required("OPENCLAW_BRIDGE_RUNTIME_TOKEN"),
      bridgeUrl: required("AILLIUM_DESKTOP_BRIDGE_URL"),
      bridgeToken: required("AILLIUM_DESKTOP_BRIDGE_TOKEN"),
      port: port("OPENCLAW_GATEWAY_PORT", 18789),
      host,
    });
    console.log(
      `\n  Simulated OpenClaw desktop gateway → http://${host}:${running.port}` +
        `\n  Serves both /api/desktop/* and /api/aillium/desktop/*.` +
        `\n  Simulated: authority is shape-checked, not signature-verified.\n`,
    );
    return;
  }

  console.error("\n  Usage: sim <bridge|gateway>\n");
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
