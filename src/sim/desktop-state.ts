/**
 * The desktop the simulated bridge drives.
 *
 * Small and stateful on purpose. The point of the simulation stack is that
 * every *boundary* is real - real HTTP, real auth, real error shapes - so the
 * thing behind the last boundary can be modest. What it must do is change when
 * it is told to, because the scenario's verification step re-reads the state
 * through a different channel (the terminal) and would otherwise be theatre.
 */

export interface DesktopState {
  /** Whether the Wi-Fi radio is switched on in Settings. */
  wifiEnabled: boolean;
  /** Which app the desktop is showing. */
  foreground: string;
  /** Every action that has been carried out, oldest first. */
  history: { at: string; action: string; note: string }[];
}

export function freshDesktopState(): DesktopState {
  return { wifiEnabled: false, foreground: "Settings", history: [] };
}

export interface DesktopActionOutcome {
  ok: boolean;
  observation: string;
  /** Anything the caller should see back, such as a screen size. */
  detail?: Record<string, unknown>;
}

/**
 * Natural-language instructions this desktop understands.
 *
 * Deliberately a small table rather than a model call: the simulation must be
 * deterministic, and an instruction it does not recognise has to fail honestly
 * rather than claim success. A real UI-TARS Desktop would interpret far more,
 * and would also sometimes fail - which is why the unrecognised branch exists
 * rather than being smoothed away.
 */
const INSTRUCTIONS: {
  match: RegExp;
  apply: (state: DesktopState) => DesktopActionOutcome;
}[] = [
  {
    match: /\b(turn|switch|toggle)\b[^\n]{0,20}\bwi-?fi\b[^\n]{0,20}\b(on|back on|enabled?)\b|\benable\b[^\n]{0,15}\bwi-?fi\b/i,
    apply: (state) => {
      if (state.wifiEnabled) {
        return { ok: true, observation: "Wi-Fi was already on; nothing to change." };
      }
      state.wifiEnabled = true;
      return {
        ok: true,
        observation: "Opened Network & internet settings and switched Wi-Fi on.",
      };
    },
  },
  {
    match: /\b(turn|switch|toggle)\b[^\n]{0,20}\bwi-?fi\b[^\n]{0,20}\b(off|disabled?)\b|\bdisable\b[^\n]{0,15}\bwi-?fi\b/i,
    apply: (state) => {
      state.wifiEnabled = false;
      return {
        ok: true,
        observation: "Opened Network & internet settings and switched Wi-Fi off.",
      };
    },
  },
  {
    match: /\bopen\b[^\n]{0,25}\b(network|internet|wi-?fi)\b[^\n]{0,20}\bsettings\b/i,
    apply: (state) => {
      state.foreground = "Settings — Network & internet";
      return { ok: true, observation: "Network & internet settings are in the foreground." };
    },
  },
];

export function applyInstruction(
  state: DesktopState,
  instruction: string,
): DesktopActionOutcome {
  const entry = INSTRUCTIONS.find((item) => item.match.test(instruction));
  if (!entry) {
    return {
      ok: false,
      observation:
        "The simulated desktop does not know how to carry out that instruction.",
    };
  }
  const outcome = entry.apply(state);
  state.history.push({
    at: new Date().toISOString(),
    action: "computer.execute_instruction",
    note: outcome.observation,
  });
  return outcome;
}

/** The read-only actions the bridge advertises alongside instruction execution. */
export function readState(
  state: DesktopState,
  action: string,
): DesktopActionOutcome | undefined {
  switch (action) {
    case "screen.get_size":
      return {
        ok: true,
        observation: "Read the primary display dimensions.",
        detail: { width: 1920, height: 1080, scaleFactor: 1 },
      };
    case "computer.get_state":
      return {
        ok: true,
        observation: `Wi-Fi is ${state.wifiEnabled ? "on" : "off"}; ${state.foreground} is in the foreground.`,
        detail: {
          wifiEnabled: state.wifiEnabled,
          foreground: state.foreground,
          actionsPerformed: state.history.length,
        },
      };
    default:
      return undefined;
  }
}

/**
 * The same machine, seen from its terminal.
 *
 * In a real deployment MeshCentral's shell and UI-TARS' input are two channels
 * onto *one* host, which is why the scenario can verify a desktop action by
 * re-reading the terminal. A simulation that kept those two channels in
 * separate worlds would break that link silently: the action would succeed,
 * the re-check would fail, and the run would look like a bug in the fix rather
 * than a bug in the simulation. So the commands below read the same state the
 * desktop actions write.
 */
export interface SimulatedCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const NOT_FOUND: SimulatedCommandResult = {
  stdout: "",
  stderr: "The simulated host does not provide that command.",
  exitCode: 127,
};

export function execOnDesktop(
  state: DesktopState,
  command: string,
): SimulatedCommandResult {
  const normalised = command.trim().replace(/\s+/g, " ").toLowerCase();

  if (normalised === "netsh interface show interface") {
    const wifi = state.wifiEnabled
      ? "Enabled         Connected      Dedicated        Wi-Fi"
      : "Disabled        Disconnected   Dedicated        Wi-Fi";
    return {
      stdout: [
        "Admin State    State          Type             Interface Name",
        "-------------------------------------------------------------------------",
        wifi,
        "Enabled         Connected      Dedicated        Ethernet",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    };
  }

  if (normalised === "hostname") {
    return { stdout: "SIM-DESK-0001", stderr: "", exitCode: 0 };
  }

  if (normalised === "ipconfig" || normalised === "ipconfig /all") {
    return {
      stdout: state.wifiEnabled
        ? "Wireless LAN adapter Wi-Fi:\n   IPv4 Address. . . . . . . . . . . : 10.44.18.62(Preferred)"
        : "Wireless LAN adapter Wi-Fi:\n   Media State . . . . . . . . . . . : Media disconnected",
      stderr: "",
      exitCode: 0,
    };
  }

  if (normalised.startsWith("netsh wlan show interfaces")) {
    return {
      stdout: state.wifiEnabled
        ? "    Name                   : Wi-Fi\n    State                  : connected\n    SSID                   : Momentum-Corp\n    Signal                 : 84%"
        : "    There is no wireless interface on the system.",
      stderr: "",
      exitCode: state.wifiEnabled ? 0 : 1,
    };
  }

  return NOT_FOUND;
}
