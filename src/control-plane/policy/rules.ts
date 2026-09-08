/**
 * The guardrail ruleset.
 *
 * These are the "stop, this is out of limits" boundaries from the brief. The
 * ruleset is data rather than code so it can be reviewed by someone who is a
 * service-desk manager rather than a TypeScript programmer, and so the audit
 * log can name the exact rule that fired.
 *
 * Two design decisions worth stating plainly:
 *
 * 1. `block` rules are absolute. There is no confidence threshold, no "unless
 *    the model is sure", and no override flag reachable from the agent loop.
 *    A human technician takes over instead. This is the whole point.
 *
 * 2. Matching is deliberately broad. A false positive costs one escalation; a
 *    false negative costs a reset password or a deleted disk. When a pattern is
 *    ambiguous we route to `require_approval` rather than widening `allow`.
 */
import type { PolicyDecision, RiskCategory } from "../../contracts/index.js";

export interface GuardrailRule {
  id: string;
  category: RiskCategory;
  decision: PolicyDecision;
  /** Patterns matched against the normalised action surface. */
  patterns: RegExp[];
  /** Shown to the user and written into the ticket - keep it human. */
  reason: string;
  /** Whether firing this rule should hand the whole ticket to a human. */
  escalate?: boolean;
}

/**
 * Hard stops. Any match ends the action immediately.
 *
 * Ordering matters only for reporting: `evaluate()` collects every match, but
 * reports the first blocking rule as the headline reason.
 */
export const BLOCKING_RULES: GuardrailRule[] = [
  {
    id: "block.credentials.password-change",
    category: "credentials",
    decision: "block",
    patterns: [
      /\b(net\s+user)\b[^\n]*\s\*/i,
      /\bpasswd\b/i,
      /\bchpasswd\b/i,
      /\bset-adaccountpassword\b/i,
      /\b(reset|change|set|rotate|update)\b[^\n]{0,40}\b(password|passphrase|pin|credential)s?\b/i,
      /\bdsmod\s+user\b[^\n]*-pwd/i,
    ],
    reason:
      "Changing or resetting credentials is outside what an automated technician may do. A human technician must verify the person's identity first.",
    escalate: true,
  },
  {
    id: "block.credentials.secret-exfiltration",
    category: "credentials",
    decision: "block",
    patterns: [
      // Two alternations on purpose. A dot-prefixed name cannot carry a
      // leading `\b`: after a path separator both `/` and `.` are non-word
      // characters, so there is no boundary between them and `\b\.env` never
      // matches `/home/user/.env`. That gap let a file full of API keys and
      // database passwords read straight through.
      /\b(cat|type|get-content|less|more|head|tail|strings|xxd|od|nl)\b[^\n]*(\b(id_rsa|id_ed25519|id_ecdsa|shadow|sam|ntds\.dit|credentials|secrets?\.(json|ya?ml))\b|\.(pem|ppk|env|key|p12|pfx|jks|keystore)\b)/i,
      /\bsecurity\s+find-(generic|internet)-password\b/i,
      /\bcmdkey\s+\/list\b/i,
      /\bvaultcmd\b/i,
      /\bmimikatz\b/i,
      /\bkeychain[_-]?dump\b/i,
      /\bgpg\s+--export-secret-keys\b/i,
      // Searching a credential store is reading it. `grep` is allowlisted for
      // ordinary log triage; pointing it at these paths is not that.
      /\b(grep|egrep|rg|ag|ack|findstr|select-string)\b[^\n]*(\b(id_rsa|id_ed25519|shadow|sudoers|credentials|keychain)\b|\.(ssh|env|pem|key)\b)/i,
    ],
    reason:
      "Reading stored passwords, keys or credential vaults is never part of a support fix, so this action is blocked.",
    escalate: true,
  },
  {
    id: "block.identity.account-lifecycle",
    category: "identity",
    decision: "block",
    patterns: [
      /\bnet\s+user\b[^\n]*\s\/(add|delete)\b/i,
      /\b(useradd|userdel|adduser|deluser|dscl\s+\.\s+-create)\b/i,
      /\bnew-(aduser|localuser|msoluser|mguser)\b/i,
      /\bremove-(aduser|localuser|msoluser|mguser)\b/i,
      // Tight gap on purpose. With a wide one, "delete files under the user's
      // home directory" reads as an account deletion and gets headlined under
      // the wrong category - it is destructive, not identity.
      // Allows a determiner and any number of qualifiers ("the AD account",
      // "a new local user account") while still refusing to span an unrelated
      // noun phrase like "files under the user's home directory".
      /\b(create|delete|remove|provision|deprovision|disable|enable)\s+(a|an|the|this|these|their|her|his|its)?\s*((new|ad|azure|entra|local|domain|admin|administrator|service|email|guest|test|starter|staff)\s+)*(user|account|mailbox|tenant)s?\b/i,
      /\b(user|mailbox|tenant)\s+account\b[^\n]{0,20}\b(create|delete|remove|disable)/i,
    ],
    reason:
      "Creating, deleting or disabling user accounts is an identity-management change that requires a human technician with the right authority.",
    escalate: true,
  },
  {
    id: "block.identity.privilege-escalation",
    category: "identity",
    decision: "block",
    patterns: [
      /\bnet\s+localgroup\b[^\n]*\/(add|delete)\b/i,
      /\badd-(adgroupmember|localgroupmember)\b/i,
      /\busermod\b[^\n]*-a?G\b/i,
      /\bdscl\b[^\n]*\bappend\b[^\n]*\badmin\b/i,
      /\b(grant|give|add)\b[^\n]{0,30}\b(admin|administrator|root|sudo|domain\s+admin|global\s+admin)\b[^\n]{0,20}\b(rights?|access|privileges?|permissions?)?\b/i,
      /\bvisudo\b/i,
      /\/etc\/sudoers/i,
    ],
    reason:
      "Granting administrator or elevated group membership is a privilege change that must be authorised by a human.",
    escalate: true,
  },
  {
    id: "block.finance",
    category: "finance",
    decision: "block",
    patterns: [
      /\b(payment|invoice|refund|purchase|purchasing|billing|payroll|bank(ing)?|iban|sort\s?code)\b/i,
      // "corporate card", "expenses profile", "expense claim", "p-card".
      /\b(corporate|company|purchasing|credit|debit|p-)\s?card\b|\bcard\s+details?\b/i,
      /\bexpenses?\b/i,
      /\b(buy|order|renew|cancel)\b[^\n]{0,30}\b(licence|license|subscription|seat)s?\b/i,
      /\b(approve|authorise|authorize|release)\b[^\n]{0,20}\b(payment|funds|transfer)\b/i,
    ],
    reason:
      "Anything touching payments, purchasing, billing or payroll is out of scope for IT support automation.",
    escalate: true,
  },
  {
    id: "block.destructive",
    category: "destructive",
    decision: "block",
    patterns: [
      /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME|\*)/i,
      /\brm\s+-rf\s+\//i,
      /\b(format|diskpart|mkfs(\.\w+)?|fdisk|gparted)\b/i,
      /\bdd\s+[^\n]*of=\/dev\/(sd|nvme|disk)/i,
      /\bremove-item\b[^\n]*-recurse[^\n]*-force/i,
      /\bcipher\s+\/w\b/i,
      /\bshred\b/i,
      /\breg\s+delete\b[^\n]*\/f/i,
      /\bdel\s+\/[sq]\b[^\n]*[\\\/]\*/i,
      /\b(wipe|erase|factory\s+reset|nuke)\b[^\n]{0,30}\b(disk|drive|device|machine|profile|data)\b/i,
      /\bDrop\s+(Database|Table)\b/i,
      // `find` is on the read-only allowlist because searching a filesystem is
      // ordinary triage - but these flags turn the same command into a
      // recursive delete. The allowlist trusts a base command; this does not.
      /\bfind\b[^\n]*\s-delete\b/i,
      /\bfind\b[^\n]*\s-exec(dir)?\s+(rm|mv|shred|dd|truncate)\b/i,
      /\bxargs\b[^\n]*\b(rm|shred)\b/i,
    ],
    reason:
      "This would destroy data or a filesystem irreversibly. Automated remediation never performs unrecoverable deletions.",
    escalate: true,
  },
  {
    id: "block.security-controls",
    category: "security-controls",
    decision: "block",
    patterns: [
      /\b(disable|turn\s+off|stop|uninstall|bypass|exclude|whitelist|allowlist)\b[^\n]{0,40}\b(antivirus|defender|firewall|edr|xdr|mfa|2fa|bitlocker|filevault|gatekeeper|sip|secure\s?boot|smartscreen)\b/i,
      /\bset-mppreference\b[^\n]*-disable/i,
      /\bnetsh\s+advfirewall\s+set\b[^\n]*\boff\b/i,
      /\bcsrutil\s+disable\b/i,
      /\bspctl\s+--master-disable\b/i,
      /\bmanage-bde\b[^\n]*-off\b/i,
      /\bSet-ExecutionPolicy\b[^\n]*\bUnrestricted\b/i,
      /\bsetenforce\s+0\b/i,
      // Firewall tools by name: their own names never contain "firewall", so
      // the generic pattern above misses them entirely.
      /\bufw\s+(disable|reset|--force\s+reset)\b/i,
      /\bfirewall-cmd\b[^\n]*--(permanent\s+)?(remove|set-default-zone=trusted)/i,
      /\biptables\s+(-F|--flush|-P\s+\w+\s+ACCEPT)\b/i,
      /\bpfctl\s+-d\b/i,
      /\bcom\.apple\.alf\b[^\n]*globalstate[^\n]*(-int\s+)?0\b/i,
      /\bsystemctl\s+(stop|disable|mask)\s+(ufw|firewalld|clamav|apparmor)\b/i,
    ],
    reason:
      "Weakening or disabling a security control (antivirus, firewall, disk encryption, MFA) is never an acceptable automated fix.",
    escalate: true,
  },
  {
    id: "block.data-exfiltration",
    category: "data-exfiltration",
    decision: "block",
    patterns: [
      /\b(scp|rsync|sftp|curl\s+-T|robocopy|xcopy)\b[^\n]*\b(@|https?:\/\/|\\\\)/i,
      /\b(upload|exfil|send|copy|sync)\b[^\n]{0,40}\b(all|entire|everything|whole)\b[^\n]{0,20}\b(documents?|files?|mailbox|drive|profile|database)\b/i,
      /\bCompress-Archive\b[^\n]*\b(Users|Documents)\b[^\n]*\b(temp|tmp|public)\b/i,
      // `curl` and `wget` are allowlisted for fetching, which is read-only.
      // These flags make them send instead, which is the opposite.
      /\bcurl\b[^\n]*\s(-T|--upload-file|-F|--form|--data-binary\s+@|-d\s+@)/i,
      /\bwget\b[^\n]*\s--(post-file|body-file)\b/i,
      /\bInvoke-(RestMethod|WebRequest)\b[^\n]*-InFile\b/i,
    ],
    reason:
      "Bulk-copying user data off the device is blocked, regardless of the destination.",
    escalate: true,
  },
  {
    id: "block.major-system-change",
    category: "major-system-change",
    decision: "block",
    patterns: [
      /\b(reinstall|reimage|re-image|rebuild|wipe\s+and\s+reload)\b[^\n]{0,20}\b(os|windows|macos|operating\s+system|machine)\b/i,
      /\b(add-computer|remove-computer|djoin|dsregcmd\s+\/leave|realm\s+(join|leave))\b/i,
      /\bbcdedit\b/i,
      /\bbootrec\b/i,
      /\b(bios|uefi|firmware)\b[^\n]{0,20}\b(update|flash|reset|change)\b/i,
      /\b(domain\s+(join|leave)|unjoin)\b/i,
      /\bsysprep\b/i,
    ],
    reason:
      "OS reinstalls, domain membership changes and firmware work are major system changes that need a human technician and a change record.",
    escalate: true,
  },
  {
    id: "block.network-infrastructure",
    category: "network-infrastructure",
    decision: "block",
    patterns: [
      /\b(configure|reconfigure|change|update|reboot|restart|reset)\b[^\n]{0,30}\b(router|switch|firewall\s+appliance|access\s+point|vpn\s+concentrator|dhcp\s+server|dns\s+server|domain\s+controller)\b/i,
      /\benable\s+secret\b/i,
      /\bconfig\s+t(erminal)?\b/i,
      /\bSet-DnsServer\w*\b/i,
      /\bSet-DhcpServer\w*\b/i,
    ],
    reason:
      "Shared network infrastructure affects every user, so changes there are outside the scope of a single-ticket automated fix.",
    escalate: true,
  },
  {
    id: "block.compliance",
    category: "compliance",
    decision: "block",
    patterns: [
      /\b(gdpr|hipaa|pci[\s-]?dss|sox)\b[^\n]{0,30}\b(delete|erase|export|request)\b/i,
      /\b(legal\s+hold|litigation\s+hold|subject\s+access\s+request|data\s+retention\s+policy)\b/i,
      // Both word orders: "open another user's mailbox" and "open the mailbox
      // of another user". Ticket prose uses whichever it feels like.
      /\b(read|open|search|access|get\s+into)\b[^\n]{0,30}\b(another|other|someone\s+else'?s?|colleague'?s?|somebody\s+else'?s?)\b[^\n]{0,30}\b(mailbox|email|inbox|files?|messages?|account|drive)\b/i,
      /\b(read|open|search|access|get\s+into)\b[^\n]{0,30}\b(mailbox|inbox|email|files?|messages?|drive)\b[^\n]{0,30}\b(another|other|someone\s+else'?s?|colleague'?s?|somebody\s+else'?s?)\b/i,
      // Redirecting someone else's mail is the same decision as reading it,
      // reached by a different route. Users offer it as the "easier" option
      // when the first request is refused, so it needs its own pattern.
      /\b(forward|redirect|auto-?forward|divert)\b[^\n]{0,40}\b(another|other|someone\s+else'?s?|colleague'?s?|their|his|her)\b[^\n]{0,20}\b(mail|e-?mail|messages?|inbox)\b/i,
      // The cmdlets that carry those decisions out, matched directly so the
      // block does not depend on how the intent happened to be worded.
      /\b(add-mailboxpermission|add-recipientpermission|grant-mailboxaccess)\b/i,
      /\bset-mailbox\b[^\n]*-(forwarding(smtp)?address|deliverandforward)\b/i,
      /\b(new-compliancesearch|search-mailbox|new-mailboxexportrequest)\b/i,
    ],
    reason:
      "This touches regulated or legally sensitive material and must be handled by a human through the proper process.",
    escalate: true,
  },
];

/**
 * Actions that are allowed but must be signed off by a human technician first.
 * These are real fixes - they just change state on someone's machine.
 */
export const APPROVAL_RULES: GuardrailRule[] = [
  {
    id: "approve.service-restart",
    category: "routine",
    decision: "require_approval",
    patterns: [
      /\b(restart|stop|start)-service\b/i,
      /\bnet\s+(start|stop)\b/i,
      /\bsystemctl\s+(restart|stop|start|disable|enable)\b/i,
      /\bsc\s+(config|stop|start)\b/i,
      /\bbrew\s+services\s+(restart|stop)\b/i,
      /\blaunchctl\s+(unload|load|bootout)\b/i,
      /\bcups(enable|disable)\b/i,
    ],
    reason:
      "Restarting a service interrupts whatever is using it, so a technician confirms the timing.",
  },
  {
    id: "approve.reboot",
    category: "routine",
    decision: "require_approval",
    patterns: [
      /\b(shutdown|reboot|restart-computer)\b/i,
      /\bshutdown\s+\/r\b/i,
    ],
    reason: "Rebooting the device will close the user's open work.",
  },
  {
    id: "approve.software-change",
    category: "routine",
    decision: "require_approval",
    patterns: [
      /\b(apt|apt-get|yum|dnf|winget|choco|brew|npm|pip|pip3)\s+(install|remove|uninstall|upgrade|update)\b/i,
      /\bmsiexec\b/i,
      /\bInstall-Module\b/i,
      /\b(install|uninstall|reinstall|update)\b[^\n]{0,20}\b(driver|application|software|package|agent)\b/i,
    ],
    reason:
      "Installing, removing or updating software changes the build of the machine.",
  },
  {
    id: "approve.registry-and-config-write",
    category: "routine",
    decision: "require_approval",
    patterns: [
      /\breg\s+add\b/i,
      /\bSet-ItemProperty\b[^\n]*HKLM/i,
      /\bdefaults\s+write\b/i,
      /\b(edit|modify|write|append)\b[^\n]{0,20}\b(registry|hosts\s+file|config(uration)?\s+file|plist)\b/i,
      /\bnetsh\s+(int|interface|winsock)\b[^\n]*\breset\b/i,
      /\bipconfig\s+\/(release|renew|flushdns)\b/i,
      /\bdscacheutil\s+-flushcache\b/i,
      // The same reversible cache flush on the other platforms. Without these
      // the fix fell through to "declared mutating", which standing policy does
      // not pre-authorise - so a tier-1 fix that is safe by construction sat
      // waiting for a person.
      /\bresolvectl\s+flush-caches\b/i,
      /\bsystemd-resolve\s+--flush-caches\b/i,
    ],
    reason:
      "Writing to system configuration is reversible but not invisible, so a technician signs it off.",
  },
  {
    id: "approve.secret-search",
    category: "credentials",
    decision: "require_approval",
    patterns: [
      /\b(grep|egrep|rg|ag|ack|findstr|select-string)\b[^\n]*\b(password|passwd|secret|api[_-]?key|apikey|token|credential)s?\b/i,
    ],
    reason:
      "Searching for credentials can be legitimate triage or can be harvesting, so a technician decides which this is.",
  },
  {
    id: "approve.clock-and-update-changes",
    category: "routine",
    decision: "require_approval",
    patterns: [
      // `sntp -s` sets the system clock; `sntp` alone only asks the time.
      /\bsntp\b[^\n]*\s-[sS]\b/i,
      /\bsystemsetup\s+-set/i,
      /\bsoftwareupdate\b[^\n]*\s(-i|--install|--schedule)\b/i,
      /\bw32tm\s+\/(resync|config)\b/i,
      /\bnetsh\b[^\n]*\bset\b/i,
    ],
    reason:
      "Changing the clock or installing updates alters the machine, so a technician signs it off.",
  },
  {
    id: "approve.process-termination",
    category: "routine",
    decision: "require_approval",
    patterns: [
      /\b(kill|pkill|killall|taskkill|stop-process)\b/i,
    ],
    reason: "Force-closing a process can lose the user's unsaved work.",
  },
  {
    id: "approve.file-mutation",
    category: "routine",
    decision: "require_approval",
    patterns: [
      /\b(mv|move|rename|cp|copy|chmod|chown|icacls|takeown|attrib)\b/i,
      /\bRemove-Item\b/i,
      /\b(rm|del|rmdir)\b/i,
      /\bNew-Item\b/i,
      /\bmkdir\b/i,
    ],
    reason:
      "Moving, copying or deleting files on a user's device needs technician sign-off.",
  },
];

/**
 * Read-only diagnostics. These run without asking, which is what makes the
 * agent quick: the overwhelming majority of triage is pure observation.
 *
 * The list is an allowlist of *base commands*. Anything not on it that also
 * fails to match an approval rule is still held for approval - see
 * `engine.ts`, `unknown command` handling. Deny-by-default, not allow-by-default.
 */
export const READ_ONLY_COMMANDS = new Set([
  // cross-platform / shell
  "echo", "date", "uptime", "whoami", "hostname", "env", "printenv", "which",
  "where", "pwd", "id", "uname", "df", "du", "free", "top", "ps", "vmstat",
  "iostat", "lsof", "cat", "head", "tail", "less", "wc", "grep", "find", "ls",
  "dir", "stat", "file", "tree", "sort", "uniq", "diff",
  // networking (read-only)
  "ping", "traceroute", "tracert", "nslookup", "dig", "host", "ipconfig",
  "ifconfig", "ip", "netstat", "ss", "arp", "route", "curl", "wget", "nc",
  "networksetup", "scutil", "resolvectl", "speedtest", "mtr", "getent", "netsh",
  "sntp", "sw_vers", "softwareupdate", "w32tm",
  // windows diagnostics
  // `sc` is read-only here only because `sc config|stop|start` is caught by
  // `approve.service-restart`, which is evaluated before this allowlist.
  "sc", "systeminfo", "tasklist", "driverquery", "wmic", "dxdiag", "powercfg",
  "getmac", "klist", "w32tm",
  "sfc", "dism", "chkdsk", "gpresult", "whoami.exe", "qwinsta", "eventvwr",
  "get-service", "get-process", "get-eventlog", "get-winevent", "get-hotfix",
  "get-computerinfo", "get-netadapter", "get-netipconfiguration", "test-netconnection",
  "get-childitem", "get-content", "get-itemproperty", "get-psdrive", "get-volume",
  "get-printer", "get-printjob", "resolve-dnsname", "get-nettcpconnection",
  // Reading Defender's state is read-only. The mutating `Set-MpPreference
  // -Disable...` form is a hard block in `block.security-controls`, which is
  // evaluated long before this allowlist.
  "get-mpcomputerstatus", "get-mpthreatdetection",
  // macos / linux diagnostics
  "system_profiler", "sw_vers", "diskutil", "pmset", "log", "sysctl", "vm_stat",
  "hostnamectl", "timedatectl",
  // `dscacheutil -q ...` is a read-only lookup. The mutating `-flushcache`
  // form is caught by `approve.registry-and-config-write`, which is evaluated
  // before this allowlist, so allowing the base command here is safe.
  "dscacheutil",
  "launchctl", "brew", "softwareupdate", "lscpu", "lsblk", "lspci", "lsusb",
  "journalctl", "dmesg", "systemctl",
  // printing
  "lpstat", "lpq", "cupsctl",
]);

export const ALL_RULES: GuardrailRule[] = [...BLOCKING_RULES, ...APPROVAL_RULES];
