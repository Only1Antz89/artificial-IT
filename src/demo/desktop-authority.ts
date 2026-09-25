/**
 * Where a desktop action's authority comes from.
 *
 * AIT does not mint desktop authority. That is the whole point of the
 * boundary: the token is short-lived, run-scoped, and issued by something that
 * knows whether this run is still the current one - which AIT, being the thing
 * asking, cannot know about itself.
 *
 * So there are exactly three states, and the third is not an error:
 *
 *   issuer configured    ask it, per action, and pass on what it returns
 *   simulation opted in  mint an obviously-labelled simulation authority
 *   neither              no desktop control; the session says why
 *
 * The middle one exists so the demo stack runs with no issuer deployed, and it
 * is deliberately awkward to reach: an explicit environment variable, a token
 * that announces itself as simulated, and a fence that is a counter rather
 * than a lease. Nothing here will ever be mistaken for the real thing by a
 * gateway that checks signatures, because it carries no signature at all.
 */
import { randomUUID } from "node:crypto";
import type {
  DesktopActionAuthority,
  DesktopAuthorityProvider,
} from "../integrations/openclaw-session.js";

export const DESKTOP_AUTHORITY_ENV = {
  /** A real issuer's endpoint. Takes precedence over the simulation. */
  issuerUrl: "AIT_DESKTOP_AUTHORITY_URL",
  issuerToken: "AIT_DESKTOP_AUTHORITY_TOKEN",
  /** Opt in to simulated authority: only ever for a simulated bridge. */
  simulate: "AIT_SIMULATED_DESKTOP_AUTHORITY",
  tenantId: "AIT_TENANT_ID",
} as const;

export type DesktopAuthorityKind = "issuer" | "simulated" | "none";

export interface DesktopAuthorityResolution {
  kind: DesktopAuthorityKind;
  /** Undefined when no authority is available, which means no desktop control. */
  provider?: DesktopAuthorityProvider;
  /** Shown in the Operations card, verbatim. */
  note: string;
}

function isTruthy(value: string | undefined): boolean {
  const normalised = value?.trim().toLowerCase();
  return normalised === "1" || normalised === "true" || normalised === "yes";
}

/**
 * Mint a simulation authority.
 *
 * Every field the governed boundary requires is present and well-formed -
 * that is what makes the demo exercise the real validation path - but the
 * token says `simulated` in plain text, so a receipt on a ticket cannot be
 * read as evidence that a real authority issued it.
 */
function simulatedAuthority(tenantId: string): DesktopAuthorityProvider {
  const workOrderId = `wo-sim-${randomUUID().slice(0, 8)}`;
  // A monotonic counter, not a lease. A real fence is issued by whoever owns
  // the desktop session and is what makes a stale executor's action fail; this
  // one only proves the field survived the hop.
  let fence = 0;

  return (_request, session): DesktopActionAuthority => {
    fence += 1;
    const desktopSessionId = session.sessionId;
    return {
      tenantId,
      sessionId: desktopSessionId,
      sessionKey: `sim-session-key-${desktopSessionId}`,
      desktopControlToken: `simulated-desktop-control-token.${randomUUID()}`,
      executionContext: {
        tenantId,
        authorityType: "agent",
        authorityId: "ait-simulated-authority",
        workOrderId,
        runId: `run-${desktopSessionId}`,
        runStepId: `step-${fence}`,
        desktopSessionId,
        attempt: 1,
        executorId: "ait-demo-executor",
        fenceToken: String(fence),
        cancellationGeneration: 0,
      },
    };
  };
}

/**
 * Ask a real issuer for authority, once per action.
 *
 * Per action rather than per run on purpose: a token that outlives the step it
 * was issued for is a token that can be replayed against the next one.
 */
function issuerAuthority(
  url: string,
  token: string | undefined,
  tenantId: string,
): DesktopAuthorityProvider {
  return async (request, session): Promise<DesktopActionAuthority> => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        tenantId,
        desktopSessionId: session.sessionId,
        deviceId: session.device.device_id,
        action: request.action,
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      // No body in the message: an issuer's error can echo the request, and
      // the request is where the credentials are.
      throw new Error(
        `The desktop authority issuer refused this action (HTTP ${response.status}).`,
      );
    }

    const authority = (await response.json()) as DesktopActionAuthority;
    if (!authority?.desktopControlToken || !authority?.executionContext) {
      throw new Error("The desktop authority issuer returned an incomplete grant.");
    }
    return authority;
  };
}

export function resolveDesktopAuthority(
  env: NodeJS.ProcessEnv = process.env,
): DesktopAuthorityResolution {
  const tenantId = env[DESKTOP_AUTHORITY_ENV.tenantId]?.trim() || "ait-demo-tenant";
  const issuerUrl = env[DESKTOP_AUTHORITY_ENV.issuerUrl]?.trim();

  if (issuerUrl) {
    return {
      kind: "issuer",
      provider: issuerAuthority(
        issuerUrl,
        env[DESKTOP_AUTHORITY_ENV.issuerToken]?.trim(),
        tenantId,
      ),
      note: "Desktop authority is issued upstream, per action.",
    };
  }

  if (isTruthy(env[DESKTOP_AUTHORITY_ENV.simulate])) {
    return {
      kind: "simulated",
      provider: simulatedAuthority(tenantId),
      note:
        "Desktop authority is simulated: every governed field is present and checked for shape, but nothing signs it.",
    };
  }

  return {
    kind: "none",
    note:
      `No desktop authority issuer is configured. Set ${DESKTOP_AUTHORITY_ENV.issuerUrl} for a real one, ` +
      `or ${DESKTOP_AUTHORITY_ENV.simulate}=1 to drive a simulated bridge.`,
  };
}
