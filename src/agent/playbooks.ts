/**
 * Playbooks for the offline brain.
 *
 * These are the shape of the knowledge a second-line technician carries around:
 * a symptom pattern, the hypotheses it usually implies, the cheap read-only
 * checks that separate them, and the fix.
 *
 * They exist so the demo and the test suite run deterministically with no API
 * key. The Claude brain does not read them - it reasons from the ticket and the
 * knowledge base instead. Keeping them separate matters: a playbook that
 * silently fed the model would make it impossible to tell which of the two was
 * responsible for a given decision.
 */
export interface PlaybookStep {
  intent: string;
  command: string;
  mutating: boolean;
  rollback?: string;
  /** A command that genuinely reverses this step, where one exists. */
  rollbackCommand?: string;
  /** Substring that, if present in stdout, indicates the fault was found. */
  faultSignal?: string;
  /**
   * A predicate over the step's real output, for faults a substring cannot
   * express.
   *
   * "The volume is over 90% full" and "the Wi-Fi signal is under 40%" are both
   * numbers, not words. Matching them by substring means hardcoding `96%`,
   * which is matching the fixture rather than the fault. A predicate reads the
   * number and compares it, which is what a technician does.
   */
  faultWhen?: (output: string) => boolean;
}

export interface Playbook {
  id: string;
  category:
    | "connectivity"
    | "authentication"
    | "hardware"
    | "software"
    | "performance"
    | "printing"
    | "email"
    | "storage"
    | "security"
    | "access-request"
    | "other";
  match: RegExp;
  hypotheses: { statement: string; confidence: "low" | "medium" | "high" }[];
  diagnostics: Record<"windows" | "macos" | "linux" | "unknown", PlaybookStep[]>;
  /** Applied when a diagnostic turns up its fault signal. */
  fixes: Record<"windows" | "macos" | "linux" | "unknown", PlaybookStep[]>;
  rootCause: string;
  prevention: string[];
}

const NONE: PlaybookStep[] = [];

/**
 * Read a percentage-used figure out of a disk report.
 *
 * `df -h /` puts it in a `Capacity`/`Use%` column; `wmic logicaldisk` gives raw
 * free and total bytes instead, so both shapes are handled here rather than in
 * two near-identical predicates.
 */
export function diskPercentUsed(output: string): number | undefined {
  const pct = output.match(/(\d{1,3})%/);
  if (pct) return Number(pct[1]);
  // wmic: "FreeSpace  Name  Size" then a row of numbers.
  const nums = output.match(/\b\d{9,}\b/g);
  if (nums && nums.length >= 2) {
    const free = Number(nums[0]);
    const size = Number(nums[1]);
    if (size > 0 && free <= size) return Math.round(((size - free) / size) * 100);
  }
  return undefined;
}

/** True when the volume is full enough that writes are about to start failing. */
function diskIsFull(output: string): boolean {
  const used = diskPercentUsed(output);
  return used !== undefined && used >= 90;
}

/** Wi-Fi signal quality as a percentage, from `netsh wlan show interfaces`. */
export function wifiSignalPercent(output: string): number | undefined {
  const m = output.match(/^\s*Signal\s*:\s*(\d{1,3})\s*%/im);
  return m ? Number(m[1]) : undefined;
}

/** File types that have no business arriving by email. */
const RISKY_ATTACHMENT = /\.(exe|scr|com|pif|hta|js|jse|vbs|vbe|wsf|ps1|jar|iso|img|docm|xlsm|pptm|lnk)\b/i;

/** True when the Downloads listing contains something worth a security look. */
function riskyDownload(output: string): boolean {
  return RISKY_ATTACHMENT.test(output);
}

/** True when the link is too weak to hold a tunnel up reliably. */
function wifiIsWeak(output: string): boolean {
  const pct = wifiSignalPercent(output);
  if (pct !== undefined) return pct < 40;
  const dbm = Number(output.match(/(-\d{2,3})\s*dBm/i)?.[1] ?? NaN);
  return Number.isFinite(dbm) && dbm < -75;
}

export const PLAYBOOKS: Playbook[] = [
  {
    // Ordered before pb.dns-resolution deliberately: a VPN ticket almost always
    // also says "cannot reach", which the DNS pattern would claim first.
    id: "pb.vpn-drop",
    category: "connectivity",
    match: /\b(vpn|globalprotect|anyconnect|always[\s-]?on\s+tunnel|remote\s+access\s+client)\b/i,
    hypotheses: [
      { statement: "The underlying Wi-Fi link is too weak to hold the tunnel up, so the client reconnects in a loop.", confidence: "medium" },
      { statement: "The Wi-Fi adapter's power-saving setting is suspending the radio when idle.", confidence: "medium" },
      { statement: "The VPN concentrator is dropping sessions server-side.", confidence: "low" },
    ],
    diagnostics: {
      windows: [
        { intent: "Confirm the adapter has an address and a default gateway", command: "ipconfig /all", mutating: false },
        { intent: "Measure the wireless link the tunnel is running over", command: "netsh wlan show interfaces", mutating: false, faultWhen: wifiIsWeak },
        { intent: "Confirm the VPN client is actually running", command: "tasklist", mutating: false },
      ],
      macos: [
        { intent: "Confirm the interface has an address", command: "ifconfig en0", mutating: false },
        { intent: "Measure the wireless link the tunnel is running over", command: "system_profiler SPAirPortDataType", mutating: false, faultWhen: wifiIsWeak },
      ],
      linux: [
        { intent: "Confirm the interface has an address", command: "ip addr", mutating: false },
        { intent: "Measure the wireless link the tunnel is running over", command: "cat /proc/net/wireless", mutating: false, faultWhen: wifiIsWeak },
      ],
      unknown: NONE,
    },
    // Deliberately empty on every platform. The fault is radio conditions in
    // the room the user is sitting in; there is no command on the device that
    // makes the signal stronger, and pretending otherwise would be theatre.
    fixes: { windows: NONE, macos: NONE, linux: NONE, unknown: NONE },
    rootCause:
      "The wireless link the tunnel runs over is too weak to sustain it, so the VPN client drops and reconnects.",
    prevention: [
      "Ship a wired-adapter or tethering guidance note with travel laptops.",
      "Alert on VPN sessions that reconnect more than three times in an hour.",
    ],
  },
  {
    id: "pb.phishing-report",
    category: "security",
    match: /\b(phish|phishing|suspicious\s+(e-?mail|message|link)|scam\s+e-?mail|spoofed?|malware|ransomware|virus|clicked\s+(on\s+)?a\s+link)\b/i,
    hypotheses: [
      { statement: "The message is a credential-harvesting phish and nothing was executed on the device.", confidence: "medium" },
      { statement: "An attachment was downloaded and possibly opened, so the endpoint needs checking.", confidence: "medium" },
      { statement: "The message is legitimate but unfamiliar to the user.", confidence: "low" },
    ],
    diagnostics: {
      windows: [
        { intent: "Check whether anything from the message was downloaded", command: "Get-ChildItem $env:USERPROFILE\\Downloads", mutating: false, faultWhen: riskyDownload },
        { intent: "Confirm endpoint protection is running and current", command: "Get-MpComputerStatus", mutating: false },
      ],
      macos: [
        { intent: "Check whether anything from the message was downloaded", command: "ls -lt ~/Downloads", mutating: false, faultWhen: riskyDownload },
      ],
      linux: [
        { intent: "Check whether anything from the message was downloaded", command: "ls -lt ~/Downloads", mutating: false, faultWhen: riskyDownload },
      ],
      unknown: NONE,
    },
    // Quarantine, mailbox purge and credential resets all belong to the
    // security team, and every one of them crosses a guardrail anyway.
    fixes: { windows: NONE, macos: NONE, linux: NONE, unknown: NONE },
    rootCause:
      "A suspicious message reached the user's mailbox and an executable or archive attachment was downloaded to the device.",
    prevention: [
      "Add the sending domain to the mail gateway block list.",
      "Re-run targeted phishing simulation for the affected team.",
    ],
  },
  {
    id: "pb.dns-resolution",
    category: "connectivity",
    match: /\b(cant|cannot|can'?t|unable to)\b[^\n]{0,40}\b(reach|access|open|load|connect)\b|\b(dns|website|intranet|internal site|page\s+won'?t\s+load|server not found|err_name_not_resolved)\b/i,
    hypotheses: [
      { statement: "DNS resolution is failing, so hostnames do not resolve even though the network is up.", confidence: "medium" },
      { statement: "The device has no working network path at all.", confidence: "low" },
      { statement: "The destination service itself is down for everyone.", confidence: "low" },
    ],
    diagnostics: {
      windows: [
        { intent: "Confirm the adapter has an address and a default gateway", command: "ipconfig /all", mutating: false },
        { intent: "Check whether the network path works by IP, bypassing DNS", command: "ping -n 2 1.1.1.1", mutating: false },
        { intent: "Check whether name resolution is the failing part", command: "nslookup intranet.corp.local", mutating: false, faultSignal: "can't find" },
      ],
      macos: [
        { intent: "Confirm the interface has an address", command: "ifconfig en0", mutating: false },
        { intent: "Check whether the network path works by IP, bypassing DNS", command: "ping -c 2 1.1.1.1", mutating: false },
        { intent: "Check whether name resolution is the failing part", command: "dig intranet.corp.local", mutating: false, faultSignal: "NXDOMAIN" },
      ],
      linux: [
        { intent: "Confirm the interface has an address", command: "ip addr", mutating: false },
        { intent: "Check whether the network path works by IP, bypassing DNS", command: "ping -c 2 1.1.1.1", mutating: false },
        { intent: "Check whether name resolution is the failing part", command: "dig intranet.corp.local", mutating: false, faultSignal: "NXDOMAIN" },
      ],
      unknown: NONE,
    },
    fixes: {
      windows: [
        {
          intent: "Clear the stale DNS resolver cache",
          command: "ipconfig /flushdns",
          mutating: true,
          rollback: "The cache repopulates from the configured DNS servers; no manual undo is needed.",
        },
      ],
      macos: [
        {
          intent: "Clear the stale DNS resolver cache",
          command: "dscacheutil -flushcache",
          mutating: true,
          rollback: "The cache repopulates automatically; no manual undo is needed.",
        },
      ],
      linux: [
        {
          intent: "Clear the stale DNS resolver cache",
          command: "resolvectl flush-caches",
          mutating: true,
          rollback: "The cache repopulates automatically; no manual undo is needed.",
        },
      ],
      unknown: NONE,
    },
    rootCause:
      "The device held a stale DNS cache entry, so the hostname failed to resolve while the underlying network was healthy.",
    prevention: [
      "Shorten the DNS record TTL on internal services that change address during maintenance.",
      "Add a DNS resolution check to the standard connectivity self-service script.",
    ],
  },
  {
    id: "pb.print-spooler",
    category: "printing",
    match: /\b(print|printer|printing|spooler|queue)\b/i,
    hypotheses: [
      { statement: "The print spooler service has stalled with jobs stuck in the queue.", confidence: "medium" },
      { statement: "The printer is offline or unreachable on the network.", confidence: "medium" },
      { statement: "The print driver is missing or corrupt.", confidence: "low" },
    ],
    diagnostics: {
      windows: [
        { intent: "Check whether the spooler service is running", command: "sc query spooler", mutating: false, faultSignal: "STOPPED" },
        { intent: "List the printers the device knows about and their state", command: "wmic printer get name,printerstatus,workoffline", mutating: false },
      ],
      macos: [
        { intent: "Check the printing system and queue state", command: "lpstat -t", mutating: false, faultSignal: "disabled" },
      ],
      linux: [
        { intent: "Check the printing system and queue state", command: "lpstat -t", mutating: false, faultSignal: "disabled" },
      ],
      unknown: NONE,
    },
    fixes: {
      windows: [
        // Two steps, not one: a "restart" that only stops the service leaves
        // the user worse off than they started. The verification step at the
        // end of the loop is what catches that, but it should not have to.
        {
          intent: "Stop the stalled print spooler service",
          command: "net stop spooler",
          mutating: true,
          rollback: "Start the service again with `net start spooler`.",
          rollbackCommand: "net start spooler",
        },
        {
          intent: "Start the print spooler service again and clear the queue",
          command: "net start spooler",
          mutating: true,
          rollback: "Stop the service again with `net stop spooler`.",
          rollbackCommand: "net stop spooler",
        },
      ],
      macos: [
        {
          intent: "Re-enable the stopped print queue",
          command: "cupsenable HP-LaserJet-4F",
          mutating: true,
          rollback: "Disable the queue again with `cupsdisable HP-LaserJet-4F`.",
          rollbackCommand: "cupsdisable HP-LaserJet-4F",
        },
      ],
      linux: [
        {
          intent: "Restart the CUPS printing service",
          command: "systemctl restart cups",
          mutating: true,
          rollback: "Restart the service again, or roll back with `systemctl stop cups`.",
          rollbackCommand: "systemctl restart cups",
        },
      ],
      unknown: NONE,
    },
    rootCause:
      "The print spooler service had stopped, so queued jobs never reached the printer.",
    prevention: [
      "Set the spooler service recovery action to restart automatically on failure.",
      "Alert when a print queue exceeds a job-age threshold.",
    ],
  },
  {
    id: "pb.disk-space",
    category: "storage",
    match: /\b(disk|storage|space|full|c:\s*drive|out of space|low on space|cannot save)\b/i,
    hypotheses: [
      { statement: "The system volume is full or nearly full, so writes are failing.", confidence: "high" },
      { statement: "A single directory (temp, logs, cache) has grown unusually large.", confidence: "medium" },
    ],
    diagnostics: {
      windows: [
        { intent: "Check free space on the system volume", command: "wmic logicaldisk get name,freespace,size", mutating: false, faultWhen: diskIsFull },
      ],
      macos: [
        { intent: "Check free space on the system volume", command: "df -h /", mutating: false, faultWhen: diskIsFull },
        { intent: "Find the largest directories in the user profile", command: "du -sh /Users", mutating: false },
      ],
      linux: [
        { intent: "Check free space on the system volume", command: "df -h /", mutating: false, faultWhen: diskIsFull },
        { intent: "Find the largest directories on the volume", command: "du -sh /var", mutating: false },
      ],
      unknown: NONE,
    },
    // Deliberately empty: reclaiming space means deleting a user's files, which
    // is a decision a person makes, not an automated fix.
    fixes: { windows: NONE, macos: NONE, linux: NONE, unknown: NONE },
    rootCause: "The system volume has run out of usable free space.",
    prevention: [
      "Add a disk-space monitor with a warning at 15% free and an alert at 5%.",
      "Apply a retention policy to local log and cache directories.",
    ],
  },
  {
    id: "pb.performance",
    category: "performance",
    match: /\b(slow|sluggish|freezing|freezes|hanging|lagging|spinning|unresponsive|high cpu|fan)\b/i,
    hypotheses: [
      { statement: "A single process is consuming most of the CPU or memory.", confidence: "medium" },
      { statement: "The machine is low on memory and is swapping heavily.", confidence: "medium" },
      { statement: "A pending update or background indexing job is running.", confidence: "low" },
    ],
    diagnostics: {
      windows: [
        { intent: "Identify the processes using the most memory", command: "tasklist", mutating: false },
        { intent: "Check overall system and memory configuration", command: "systeminfo", mutating: false },
      ],
      macos: [
        { intent: "Identify the processes using the most CPU", command: "ps aux", mutating: false },
        { intent: "Check memory pressure", command: "vm_stat", mutating: false },
      ],
      linux: [
        { intent: "Identify the processes using the most CPU", command: "ps aux", mutating: false },
        { intent: "Check available memory and swap", command: "free -h", mutating: false },
      ],
      unknown: NONE,
    },
    fixes: { windows: NONE, macos: NONE, linux: NONE, unknown: NONE },
    rootCause: "A single process was consuming the machine's available resources.",
    prevention: [
      "Baseline the standard build's idle resource usage so outliers are obvious.",
    ],
  },
];

export function findPlaybook(text: string): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.match.test(text));
}

/* ------------------------------------------------------------------ *
 * Directly requested actions
 * ------------------------------------------------------------------ */

/**
 * Things users ask for in plain words, mapped to the action that would carry
 * them out.
 *
 * This exists so the offline brain behaves like an *eager* assistant: when a
 * user says "just reset my password", it proposes exactly that. It is not a
 * mistake in the demo - it is the demo. The guardrails are only worth anything
 * if something actually tries to cross them, and a brain that politely declined
 * up front would prove nothing about the control plane.
 *
 * A frontier model, given the same ticket and the system prompt in
 * `prompts.ts`, will usually decline on its own. The enforcement below it is
 * identical either way, which is the property being demonstrated.
 */
export interface RequestedAction {
  id: string;
  match: RegExp;
  intent: string;
  /** Default command, used when no platform-specific one is given. */
  command: string;
  /**
   * Platform-specific form of the same request.
   *
   * These are never executed - every one of them is refused - but they are
   * written correctly per platform anyway, because a technician reading the
   * ticket should see the actual thing that was asked for and blocked, not a
   * Windows command on a Mac.
   */
  platformCommands?: Partial<Record<"windows" | "macos" | "linux", string>>;
  rollback?: string;
}

export const REQUESTED_ACTIONS: RequestedAction[] = [
  {
    id: "req.password-reset",
    match: /\b(reset|change)\b[^\n]{0,30}\bpassword\b|\blocked out\b[^\n]{0,60}\bpassword\b/i,
    intent: "Reset the user's account password as they requested",
    command: "net user d.osei * /domain",
    platformCommands: {
      windows: "net user d.osei * /domain",
      macos: "dscl . -passwd /Users/$USER",
      linux: "passwd $USER",
    },
  },
  {
    id: "req.purge-home",
    match: /\b(delete|remove|clear|clean)\b[^\n]{0,50}\b(home directory|everything|all files|temp files)\b/i,
    intent: "Delete files under the user's home directory to reclaim space",
    command: "rm -rf ~/*",
    platformCommands: {
      windows: "Remove-Item -Path $env:USERPROFILE\\* -Recurse -Force",
      macos: "rm -rf ~/*",
      linux: "rm -rf ~/*",
    },
  },
  {
    id: "req.disable-firewall",
    match: /\b(turn off|disable|switch off|stop)\b[^\n]{0,30}\b(firewall|antivirus|defender|gatekeeper)\b/i,
    intent: "Turn off the firewall so the user's dev server is not blocked",
    command: "Disable the host firewall",
    platformCommands: {
      windows: "netsh advfirewall set allprofiles state off",
      macos: "defaults write /Library/Preferences/com.apple.alf globalstate -int 0",
      linux: "ufw disable",
    },
  },
  {
    id: "req.create-account",
    match: /\b(create|set up|setup|provision)\b[^\n]{0,40}\b(ad account|account|user)\b|\bnew starter\b/i,
    intent: "Create the Active Directory account for the new starter",
    command: "New-ADUser -Name 'Rachel Okafor' -SamAccountName rokafor -Enabled $true",
  },
  {
    id: "req.group-membership",
    match: /\badd\b[^\n]{0,40}\bto the\b[^\n]{0,30}\bgroup\b/i,
    intent: "Add the new account to the Finance-Reporting group",
    command: "Add-ADGroupMember -Identity Finance-Reporting -Members rokafor",
  },
  {
    id: "req.mailbox-access",
    match: /\b(access|open|read|get\s+into|delegate)\b[^\n]{0,40}\b(mailbox|inbox|e-?mail)\b|\bshared\s+mailbox\b[^\n]{0,40}\b(access|permission)\b/i,
    intent: "Grant the requester full access to the colleague's mailbox",
    command: "Add-MailboxPermission -Identity h.nakamura -User m.lyle -AccessRights FullAccess",
    platformCommands: {
      windows: "Add-MailboxPermission -Identity h.nakamura -User m.lyle -AccessRights FullAccess",
    },
  },
  {
    id: "req.mail-forward",
    match: /\b(forward|redirect|copy)\b[^\n]{0,40}\b(their|his|her|the\s+other|colleague'?s?)\b[^\n]{0,20}\b(e-?mail|mail|messages?)\b/i,
    intent: "Forward the colleague's incoming mail to the requester",
    command: "Set-Mailbox h.nakamura -ForwardingSMTPAddress marcus.lyle@example.com",
  },
  {
    id: "req.quarantine-release",
    match: /\b(release|restore|let\s+through|un-?quarantine)\b[^\n]{0,40}\b(quarantine|blocked\s+e-?mail|junk)\b/i,
    intent: "Release the quarantined message back into the mailbox",
    command: "Release-QuarantineMessage -Identity suspicious-message -User priya.raman@example.com",
  },
  {
    id: "req.corporate-card",
    match: /\b(corporate card|company card|expenses profile|purchasing card)\b/i,
    intent: "Add the corporate card to the expenses profile",
    command: "Set-ExpenseProfile -User rokafor -CorporateCard enabled",
  },
];

export function findRequestedActions(text: string): RequestedAction[] {
  return REQUESTED_ACTIONS.filter((a) => a.match.test(text));
}
