/**
 * Adds governed UI-TARS control to an existing command/screen session.
 *
 * MeshCentral and UI-TARS do different jobs: the wrapped session supplies the
 * endpoint terminal and screen, while OpenClaw supplies fenced desktop input.
 * The authority callback is intentionally external. AIT may consume a
 * short-lived token issued by the curated runtime; it never invents one.
 */
import type {
  DeviceSession,
  ScreenCapture,
  SessionCapabilities,
  UIActionRequest,
  UIActionResult,
} from "../execution-plane/device.js";
import type { CommandResult } from "../contracts/index.js";
import type {
  DesktopCapabilities,
  InvokeDesktopActionInput,
} from "./openclaw.js";

export type DesktopActionAuthority = Omit<
  InvokeDesktopActionInput,
  "action" | "arguments"
>;

export type DesktopAuthorityProvider = (
  request: UIActionRequest,
  session: DeviceSession,
) => DesktopActionAuthority | Promise<DesktopActionAuthority>;

export interface DesktopBridgeClient {
  capabilities(includeRuntimeHints?: boolean): Promise<DesktopCapabilities>;
  invokeAction(input: InvokeDesktopActionInput): Promise<Record<string, unknown>>;
}

export class OpenClawControlledSession implements DeviceSession {
  readonly device;
  readonly sessionId;
  #capabilities?: SessionCapabilities;

  constructor(
    private readonly base: DeviceSession,
    private readonly bridge: DesktopBridgeClient,
    private readonly authority: DesktopAuthorityProvider,
  ) {
    this.device = base.device;
    this.sessionId = base.sessionId;
  }

  exec(command: string, timeoutMs?: number): Promise<CommandResult> {
    return this.base.exec(command, timeoutMs);
  }

  capture(): Promise<ScreenCapture> {
    return this.base.capture();
  }

  async capabilities(): Promise<SessionCapabilities> {
    if (this.#capabilities) return this.#capabilities;
    const base = await this.base.capabilities();
    try {
      const desktop = await this.bridge.capabilities();
      const ready = desktop.available && desktop.rpcReady;
      this.#capabilities = {
        ...base,
        canControl: ready,
        ...(ready
          ? { controlProvider: "ui-tars-desktop" as const, controlUnavailableReason: undefined }
          : {
              controlProvider: undefined,
              controlUnavailableReason:
                desktop.note || "OpenClaw answered, but UI-TARS Desktop RPC is not ready",
            }),
      };
    } catch (error) {
      this.#capabilities = {
        ...base,
        canControl: false,
        controlProvider: undefined,
        controlUnavailableReason:
          error instanceof Error
            ? error.message
            : "the governed desktop bridge could not be reached",
      };
    }
    return this.#capabilities;
  }

  async control(request: UIActionRequest): Promise<UIActionResult> {
    const scoped = await this.authority(request, this.base);
    const response = await this.bridge.invokeAction({
      ...scoped,
      action: request.action,
      ...(request.arguments ? { arguments: request.arguments } : {}),
    });
    const ok = response["ok"] === true;
    const returnedAction =
      typeof response["action"] === "string" ? response["action"] : request.action;
    return {
      ok,
      action: returnedAction,
      provider: "ui-tars-desktop",
      observation: ok
        ? `UI-TARS Desktop completed ${returnedAction}; the ticket workflow must still verify the device state.`
        : `UI-TARS Desktop did not confirm ${returnedAction}.`,
      detail: response,
    };
  }

  end(): Promise<void> {
    return this.base.end();
  }
}
