/**
 * Seed knowledge base.
 *
 * A brand-new service desk has no history, which makes the "learn from previous
 * tickets" behaviour invisible in a demo. These are entries a real desk would
 * have accumulated in its first month or two.
 *
 * Two rules held while writing them, and both matter for the demo to prove
 * anything:
 *
 *  1. None of them gives away the answer to a scenario the agent is supposed to
 *     work out for itself. The DNS fault is not in here; the agent finds it by
 *     running the checks and reading the output.
 *  2. Several of them are *near misses* - a printing entry that is not the
 *     spooler fault, a storage entry about a different volume, an entry whose
 *     root cause was never established. A knowledge base where every hit is the
 *     right hit tells you nothing about the retrieval, and the near misses are
 *     what the coverage gates in `retrieve.ts` exist to reject.
 */
import type { KnowledgeStore } from "../knowledge/index.js";

export function seedKnowledge(store: KnowledgeStore): void {
  if (store.size() > 0) return;

  store.add({
    id: "kb_seed_vpn",
    source_ticket_id: "zd-4390",
    title: "VPN disconnects every few minutes on Wi-Fi",
    category: "connectivity",
    platform: "windows",
    symptoms: [
      "VPN keeps dropping",
      "disconnects every few minutes",
      "reconnects on its own then drops again",
    ],
    root_cause:
      "The Wi-Fi adapter's power-saving setting was suspending the radio during idle periods, dropping the tunnel.",
    diagnostic_steps: ["ipconfig /all", "netsh wlan show interfaces"],
    resolution_steps: [
      "Disable power management on the Wi-Fi adapter via the managed device policy",
    ],
    cautions: [],
    times_applied: 3,
    outcome: "resolved",
  });

  store.add({
    id: "kb_seed_mailbox",
    source_ticket_id: "zd-4402",
    title: "Request for access to a colleague's mailbox",
    category: "access-request",
    platform: "any",
    symptoms: [
      "need access to someone else's mailbox",
      "colleague is on leave and I need their email",
    ],
    root_cause:
      "Not a fault. Delegated mailbox access is an authorisation decision, not a technical one.",
    diagnostic_steps: [],
    resolution_steps: [],
    cautions: [
      'Tickets like this tend to run into the "compliance" guardrail.',
      "Previously escalated to service-desk-tier-2 (policy-block, out-of-scope).",
    ],
    times_applied: 2,
    outcome: "escalated",
  });

  store.add({
    id: "kb_seed_teams_audio",
    source_ticket_id: "zd-4415",
    title: "No sound in Teams calls after joining",
    category: "software",
    platform: "windows",
    symptoms: [
      "cannot hear anyone in Teams",
      "no audio on calls but sound works elsewhere",
      "headset works in Spotify but not Teams",
    ],
    root_cause:
      "Teams held a stale device selection pointing at a headset that was no longer connected, so audio was routed to a device that did not exist.",
    diagnostic_steps: ["Get-PnpDevice -Class AudioEndpoint", "Check Teams device settings"],
    resolution_steps: [
      "Re-select the active output device in Teams settings",
      "Sign out of Teams and back in to clear the cached device list",
    ],
    cautions: ["Do not reinstall Teams first; it rarely helps and loses local cache."],
    times_applied: 6,
    outcome: "resolved",
  });

  store.add({
    id: "kb_seed_onedrive_full",
    source_ticket_id: "zd-4431",
    title: "OneDrive stopped syncing with a full local disk",
    category: "storage",
    platform: "windows",
    symptoms: [
      "OneDrive says sync is paused",
      "files not uploading",
      "red cross on the OneDrive icon",
    ],
    root_cause:
      "The local volume was full, so OneDrive could not stage files for upload. Freeing space restarted the sync without any change to OneDrive itself.",
    diagnostic_steps: ["wmic logicaldisk get name,freespace,size"],
    resolution_steps: [
      "User cleared their own Downloads folder after being shown the figures",
      "Enabled Files On-Demand so cloud-only files stop occupying local space",
    ],
    cautions: [
      "Space is reclaimed by the user, not by the assistant - deletion is their decision.",
    ],
    times_applied: 4,
    outcome: "resolved",
  });

  store.add({
    id: "kb_seed_printer_driver",
    source_ticket_id: "zd-4448",
    title: "Printing comes out garbled on the finance printer",
    category: "printing",
    platform: "windows",
    symptoms: [
      "pages print as random characters",
      "output is garbage text",
      "prints fine from other machines",
    ],
    root_cause:
      "The workstation had a PCL driver installed against a queue configured for PostScript, so the page description was misinterpreted.",
    diagnostic_steps: ["wmic printer get name,drivername"],
    resolution_steps: ["Reinstalled the queue with the matching PostScript driver"],
    cautions: [
      "Not the same as jobs stuck in the queue - here the spooler is healthy and pages do come out.",
    ],
    times_applied: 2,
    outcome: "resolved",
  });

  store.add({
    id: "kb_seed_phishing",
    source_ticket_id: "zd-4462",
    title: "Reported phishing email impersonating the IT service desk",
    category: "security",
    platform: "any",
    symptoms: [
      "email says my mailbox is over quota",
      "link asking me to re-verify my password",
      "sender address looks wrong",
      "downloaded the attachment",
    ],
    root_cause:
      "A credential-harvesting campaign spoofing the internal service desk. The link pointed at a lookalike domain registered the same week.",
    diagnostic_steps: [
      "Listed the user's Downloads folder for anything from the message",
      "Confirmed endpoint protection was enabled and current",
    ],
    resolution_steps: [
      "Security operations blocked the sending domain at the mail gateway",
      "Message purged from all mailboxes by the security team",
    ],
    cautions: [
      "Nothing is remediated on the device by the assistant: quarantine, mailbox purge and credential resets are all security-team actions.",
      "If the user typed credentials into the page, treat it as a confirmed compromise and escalate immediately.",
    ],
    times_applied: 5,
    outcome: "escalated",
  });

  store.add({
    id: "kb_seed_slow_startup",
    source_ticket_id: "zd-4470",
    title: "MacBook very slow for the first ten minutes after login",
    category: "performance",
    platform: "macos",
    symptoms: [
      "machine crawls after logging in",
      "fans spin up straight away",
      "settles down after ten minutes",
    ],
    // Deliberately unresolved. The retrieval layer filters entries whose cause
    // was never established out of the hypothesis list, and that filter needs
    // something to filter.
    root_cause: "Not established. The user stopped reporting it after a macOS update.",
    diagnostic_steps: ["ps -Ao pid,pmem,pcpu,comm -m", "vm_stat"],
    resolution_steps: [],
    cautions: ["Spotlight re-indexing was suspected but never confirmed."],
    times_applied: 1,
    outcome: "unresolved",
  });

  store.add({
    id: "kb_seed_certificate_clock",
    source_ticket_id: "zd-4488",
    title: "Certificate errors on every internal site after a laptop came back from repair",
    category: "connectivity",
    platform: "windows",
    symptoms: [
      "every site says the certificate is not valid yet",
      "cannot sign in to anything",
      "worked fine before it went for repair",
    ],
    root_cause:
      "The CMOS battery had been replaced and the system clock was two years behind, so every certificate looked as though it had not started yet.",
    diagnostic_steps: ["w32tm /query /status"],
    resolution_steps: ["Resynchronised the clock against the domain time source"],
    cautions: [
      "Clock drift presents as authentication and certificate failures, not as a clock problem - the user never mentions the time.",
    ],
    times_applied: 3,
    outcome: "resolved",
  });
}
