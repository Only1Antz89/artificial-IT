/**
 * Simulated devices for the demo.
 *
 * The fixtures are real command output shapes with the fault baked into the
 * device's state, and the fixes genuinely mutate that state. That means the
 * demo is not a script being replayed - the agent has to read the output,
 * notice the fault, apply the right fix, and re-check. If it applies the wrong
 * fix, the verification step fails, exactly as it would on a real machine.
 */
import {
  SimulatedDeviceSession,
  type CommandFixture,
  type DeviceState,
} from "../execution-plane/device.js";
import type { DeviceInfo } from "../contracts/ticket.js";
import {
  browserScreen,
  printQueueScreen,
  storageScreen,
  vpnScreen,
} from "./screen.js";

/* ------------------------------------------------------------------ *
 * Windows laptop with a stale DNS cache
 * ------------------------------------------------------------------ */

export const WIN_LAPTOP: DeviceInfo = {
  device_id: "dev-ws-2211",
  hostname: "LON-LT-2211",
  platform: "windows",
  os_version: "Windows 11 23H2",
  consent_granted: true,
  managed: true,
};

const winDnsFixtures: CommandFixture[] = [
  {
    match: /^ipconfig\s+\/all$/i,
    respond: () => ({
      stdout: `Windows IP Configuration

   Host Name . . . . . . . . . . . . : LON-LT-2211
   Primary Dns Suffix  . . . . . . . : corp.local

Ethernet adapter Wi-Fi:

   Connection-specific DNS Suffix  . : corp.local
   Description . . . . . . . . . . . : Intel(R) Wi-Fi 6E AX211 160MHz
   Physical Address. . . . . . . . . : 3C-58-C2-1A-4B-90
   DHCP Enabled. . . . . . . . . . . : Yes
   IPv4 Address. . . . . . . . . . . : 10.44.18.62(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.252.0
   Default Gateway . . . . . . . . . : 10.44.16.1
   DHCP Server . . . . . . . . . . . : 10.44.16.1
   DNS Servers . . . . . . . . . . . : 10.44.10.11
                                       10.44.10.12`,
    }),
  },
  {
    match: /^ping\s+(-n\s+\d+\s+)?1\.1\.1\.1/i,
    respond: () => ({
      stdout: `Pinging 1.1.1.1 with 32 bytes of data:
Reply from 1.1.1.1: bytes=32 time=11ms TTL=57
Reply from 1.1.1.1: bytes=32 time=12ms TTL=57

Ping statistics for 1.1.1.1:
    Packets: Sent = 2, Received = 2, Lost = 0 (0% loss),`,
    }),
  },
  {
    match: /^nslookup\s+intranet\.corp\.local/i,
    respond: (state) =>
      state["dns_cache_stale"]
        ? {
            stdout: `Server:  dns1.corp.local
Address:  10.44.10.11

*** dns1.corp.local can't find intranet.corp.local: Non-existent domain`,
            exit_code: 1,
          }
        : {
            stdout: `Server:  dns1.corp.local
Address:  10.44.10.11

Name:    intranet.corp.local
Address:  10.44.12.40`,
          },
  },
  {
    match: /^ipconfig\s+\/flushdns$/i,
    respond: () => ({
      stdout: `Windows IP Configuration

Successfully flushed the DNS Resolver Cache.`,
    }),
    // The fix genuinely changes the machine: nslookup now resolves.
    effect: (state) => {
      state["dns_cache_stale"] = false;
    },
  },
  // Used by the phishing scenario, which runs against this same laptop: the
  // attachment the user says they downloaded is really sitting there.
  {
    match: /^Get-ChildItem \$env:USERPROFILE\\Downloads$/i,
    respond: () => ({
      stdout: `    Directory: C:\\Users\\p.raman\\Downloads

Mode          LastWriteTime    Length Name
-a---   06/09/2026    08:52     44032 Mailbox-Quota-Notice.hta
-a---   03/09/2026    17:20   1841204 expenses-q3.xlsx`,
    }),
  },
  {
    match: /^Get-MpComputerStatus$/i,
    respond: () => ({
      stdout: `AMServiceEnabled            : True
RealTimeProtectionEnabled   : True
AntivirusSignatureLastUpdated : 06/09/2026 06:10:44
QuickScanEndTime            : 06/09/2026 04:02:11`,
    }),
  },
];

export function makeWindowsDnsDevice(): SimulatedDeviceSession {
  return new SimulatedDeviceSession({
    device: WIN_LAPTOP,
    state: { dns_cache_stale: true },
    fixtures: winDnsFixtures,
    screen: browserScreen,
  });
}

/* ------------------------------------------------------------------ *
 * Windows desktop with a stopped print spooler
 * ------------------------------------------------------------------ */

export const WIN_DESKTOP: DeviceInfo = {
  device_id: "dev-ws-3480",
  hostname: "MAN-DT-3480",
  platform: "windows",
  os_version: "Windows 11 23H2",
  consent_granted: true,
  managed: true,
};

const winPrintFixtures: CommandFixture[] = [
  {
    match: /^sc\s+query\s+spooler$/i,
    respond: (state) =>
      state["spooler_running"]
        ? {
            stdout: `SERVICE_NAME: spooler
        TYPE               : 110  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, PAUSABLE, ACCEPTS_SHUTDOWN)`,
          }
        : {
            stdout: `SERVICE_NAME: spooler
        TYPE               : 110  WIN32_OWN_PROCESS
        STATE              : 1  STOPPED
        WIN32_EXIT_CODE    : 1067  (0x42b)`,
          },
  },
  {
    match: /^wmic\s+printer\s+get/i,
    respond: (state) => ({
      stdout: `Name                    PrinterStatus  WorkOffline
HP-LaserJet-4F          ${state["spooler_running"] ? "3" : "7"}              ${state["spooler_running"] ? "FALSE" : "TRUE"}
Microsoft Print to PDF  3              FALSE`,
    }),
  },
  {
    match: /^net\s+stop\s+spooler$/i,
    respond: () => ({
      stdout: `The Print Spooler service is stopping.
The Print Spooler service was stopped successfully.`,
    }),
  },
  {
    match: /^net\s+start\s+spooler$/i,
    respond: () => ({
      stdout: `The Print Spooler service is starting.
The Print Spooler service was started successfully.`,
    }),
    effect: (state) => {
      state["spooler_running"] = true;
      state["queued_jobs"] = 0;
    },
  },
];

export function makeWindowsPrintDevice(): SimulatedDeviceSession {
  return new SimulatedDeviceSession({
    device: WIN_DESKTOP,
    state: { spooler_running: false, queued_jobs: 4 },
    fixtures: winPrintFixtures,
    screen: printQueueScreen,
  });
}

/* ------------------------------------------------------------------ *
 * macOS laptop, also with a DNS fault - used to show that a lesson
 * learned on one platform transfers to another.
 * ------------------------------------------------------------------ */

export const MAC_LAPTOP: DeviceInfo = {
  device_id: "dev-mb-1907",
  hostname: "LON-MB-1907",
  platform: "macos",
  os_version: "macOS 15.3",
  consent_granted: true,
  managed: true,
};

const macDnsFixtures: CommandFixture[] = [
  {
    match: /^ifconfig\s+en0$/i,
    respond: () => ({
      stdout: `en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	inet 10.44.19.83 netmask 0xfffffc00 broadcast 10.44.19.255
	status: active`,
    }),
  },
  {
    match: /^ping\s+(-c\s+\d+\s+)?1\.1\.1\.1/i,
    respond: () => ({
      stdout: `PING 1.1.1.1 (1.1.1.1): 56 data bytes
64 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=10.9 ms
64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=11.4 ms

--- 1.1.1.1 ping statistics ---
2 packets transmitted, 2 packets received, 0.0% packet loss`,
    }),
  },
  {
    match: /^dig\s+intranet\.corp\.local/i,
    respond: (state) =>
      state["dns_cache_stale"]
        ? {
            stdout: `; <<>> DiG 9.10.6 <<>> intranet.corp.local
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 41022
;; QUESTION SECTION:
;intranet.corp.local.		IN	A`,
          }
        : {
            stdout: `; <<>> DiG 9.10.6 <<>> intranet.corp.local
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 41109
;; ANSWER SECTION:
intranet.corp.local.	300	IN	A	10.44.12.40`,
          },
  },
  {
    match: /^dscacheutil\s+-flushcache$/i,
    respond: () => ({ stdout: "" }),
    effect: (state) => {
      state["dns_cache_stale"] = false;
    },
  },
];

export function makeMacDnsDevice(): SimulatedDeviceSession {
  return new SimulatedDeviceSession({
    device: MAC_LAPTOP,
    state: { dns_cache_stale: true },
    fixtures: macDnsFixtures,
    screen: browserScreen,
  });
}


/* ------------------------------------------------------------------ *
 * MacBook with a full disk
 * ------------------------------------------------------------------ */

export const MAC_DESIGNER: DeviceInfo = {
  device_id: "dev-mb-4412",
  hostname: "LDN-MB-4412",
  platform: "macos",
  os_version: "macOS 15.3",
  consent_granted: true,
  managed: true,
};

const macFullDiskFixtures: CommandFixture[] = [
  {
    match: /^uname -a$/,
    respond: () => ({ stdout: "Darwin LDN-MB-4412 24.3.0 arm64" }),
  },
  {
    match: /^uptime$/,
    respond: () => ({
      stdout: "11:42  up 6 days, 21:04, 2 users, load averages: 2.11 1.98 1.76",
    }),
  },
  {
    match: /^df -h \/$/,
    respond: () => ({
      stdout: `Filesystem       Size   Used  Avail Capacity iused      ifree %iused  Mounted on
/dev/disk3s1s1  494Gi  468Gi   21Gi    96%  512003 1163983797    0%   /`,
    }),
  },
  {
    match: /^vm_stat$/,
    respond: () => ({
      stdout: `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               31200.
Pages active:                            742118.
Pages inactive:                          688220.
Pages wired down:                        241004.`,
    }),
  },
  {
    match: /^ps -Ao pid,pmem,pcpu,comm -m$/,
    respond: () => ({
      stdout: `  PID %MEM %CPU COMM
  914 18.2  4.1 /Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app/Contents/MacOS/Adobe Photoshop
  622  9.4  1.2 /Applications/Slack.app/Contents/MacOS/Slack`,
    }),
  },
  {
    match: /^dscacheutil -q host -a name example\.com$/,
    respond: () => ({ stdout: "name: example.com\nip_address: 93.184.216.34" }),
  },
  {
    match: /^du -sh \/Users$/,
    respond: () => ({ stdout: "451G\t/Users" }),
  },
  {
    match: /^ls -lt ~\/Downloads$/,
    respond: () => ({
      stdout: `total 18400
-rw-r--r--@ 1 s.almeida  staff   4.1G  5 Sep 12:40 shoot-raws-final.zip
-rw-r--r--@ 1 s.almeida  staff   812M  2 Sep 09:11 brand-assets-v7.sketch`,
    }),
  },
];

export function makeMacFullDiskDevice(): SimulatedDeviceSession {
  return new SimulatedDeviceSession({
    device: MAC_DESIGNER,
    state: { disk_percent: 96 },
    fixtures: macFullDiskFixtures,
    screen: storageScreen,
  });
}

/* ------------------------------------------------------------------ *
 * Windows laptop dropping its VPN
 * ------------------------------------------------------------------ */

export const WIN_FIELD: DeviceInfo = {
  device_id: "dev-lt-7781",
  hostname: "BHM-LT-7781",
  platform: "windows",
  os_version: "Windows 11 24H2",
  consent_granted: true,
  managed: true,
};

const winVpnFixtures: CommandFixture[] = [
  {
    match: /^systeminfo$/,
    respond: () => ({
      stdout: `Host Name:                 BHM-LT-7781
OS Name:                   Microsoft Windows 11 Enterprise
System Boot Time:          03/09/2026, 08:14:22
Total Physical Memory:     16,142 MB`,
    }),
  },
  {
    match: /^ipconfig \/all$/,
    respond: () => ({
      stdout: `Windows IP Configuration

Wireless LAN adapter Wi-Fi:
   IPv4 Address. . . . . . . . . . . : 192.168.1.114(Preferred)
   Default Gateway . . . . . . . . . : 192.168.1.1
   DNS Servers . . . . . . . . . . . : 192.168.1.1`,
    }),
  },
  {
    match: /^netsh wlan show interfaces$/,
    respond: () => ({
      stdout: `    Name                   : Wi-Fi
    State                  : connected
    SSID                   : Travelodge_Guest
    Signal                 : 28%
    Receive rate (Mbps)    : 6.5`,
    }),
  },
  {
    match: /^wmic path Win32_Battery get EstimatedChargeRemaining$/,
    respond: () => ({ stdout: "EstimatedChargeRemaining\n64" }),
  },
  {
    match: /^tasklist$/,
    respond: () => ({
      stdout: `Image Name                     PID Mem Usage
GlobalProtect.exe             4180  84,220 K
Teams.exe                     6612 412,880 K`,
    }),
  },
  {
    match: /^nslookup example\.com$/,
    respond: () => ({
      stdout: "Server:  router.home\nAddress:  192.168.1.1\n\nName:    example.com\nAddress:  93.184.216.34",
    }),
  },
];

export function makeWindowsVpnDevice(): SimulatedDeviceSession {
  return new SimulatedDeviceSession({
    device: WIN_FIELD,
    state: { wifi_signal: 28 },
    fixtures: winVpnFixtures,
    screen: vpnScreen,
  });
}
