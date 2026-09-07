# Running AIT on your Mac

Setup is three commands. The fourth tells you whether the demo will actually
work before you stand up in front of anyone.

## 1. Prerequisites

Node 22 or newer. Check what you have:

```bash
node --version
```

If it is missing or older:

```bash
brew install node          # or: nvm install 22 && nvm use 22
```

Node 22 matters specifically — the MeshCentral transport uses the built-in
`WebSocket`, which arrived in 22.

## 2. Get the code

```bash
git clone -b claude/aillium-it-assistant-demo-8hjdus \
  https://github.com/Only1Antz89/artificial-IT.git
cd artificial-IT
npm install
```

## 3. Preflight

```bash
npm run doctor
```

This is the one to run before a live demo. It checks Node, your platform, which
diagnostic tools your Mac actually has, whether screen capture will work, whether
port 3000 is free, and which reasoning provider is active. Anything marked `✗`
will stop the demo; `!` will not, but you should know about it.

Expected on a healthy Mac:

```
  ✓ Node.js                    v22.x.x
  ✓ Platform                   darwin 24.x.x · your-mac · 16GB RAM → macos
  ✓ Diagnostic tools           all 6 local checks can run
  ✓ Screen capture             available via `screencapture`
  ! Screen Recording permission macOS requires Screen Recording permission…
  ✓ Port 3000                  free for the console
  ✓ Active provider            offline (playbooks)
```

That `!` is expected and worth reading — see [Screen recording](#screen-recording)
below.

## 4. Run it

```bash
npm run serve
```

Open **http://localhost:3000**.

---

## A running order for the demo

Five minutes, building from "it does useful work" to "and it knows when not to".

### 1. It does the boring work properly — 60s

Pick **Intranet unreachable (Windows)** and hit Run.

Watch the steps arrive: it reads the ticket, recalls prior tickets, forms a
diagnosis, then runs read-only checks *before* changing anything. It confirms the
adapter has an address, proves the network works by IP, and only then discovers
that name resolution is what's broken. It applies the fix and **re-runs the
failing check to confirm** before calling it resolved.

> The point: it verifies rather than assumes. A fix that was applied is not the
> same as a fix that worked.

### 2. It stops and asks you — 90s

Pick **Print jobs stuck in the queue (Windows)** and hit Run.

An annotated screenshot lands on the ticket, then the run **stops** and asks you
to approve restarting the print spooler. The card shows which rule fired, why AIT
wants it, and the rollback.

It asks **twice** — once to stop the service, once to start it again — because
each is a separate change to the machine and is judged on its own.

Decline both. The run escalates, the spooler is never touched, and your
decision is in the audit trail with your name on it.

Run it again and approve both. Same ticket, different outcome: two changes
applied, verified, resolved — and the audit records who authorised each one.

> The point: a person is in the loop for anything that changes a machine, and
> the record says who decided what.

### 3. It refuses, on your actual machine — 90s

Pick **Dangerous requests against this machine** and hit Run.

This one is aimed at the Mac you are standing in front of. The ticket asks to
reset your password, delete your home directory and turn off your firewall. All
three are refused, each naming the rule and the category, and **nothing runs at
all** — no command result exists on any step.

The handover pack below shows what a human would need to pick it up.

> The point: the guardrails are not a prompt asking nicely. Nothing reached the
> machine.

Then, in the sidebar, type a command into **Ask the guardrails** — no model
involved, just the policy engine:

```
rm -rf ~/Documents         → BLOCK   block.destructive
sudo dscl . -passwd ...    → BLOCK   block.credentials.password-change
df -h /                    → ALLOW   allow.read-only-diagnostic
brew install htop          → REQUIRE_APPROVAL
```

### 4. It won't invent a problem — 45s

Pick **Check over this machine** and hit Run.

Real commands against your real Mac: disk, memory, running processes, DNS. On a
healthy machine it comes back **resolved with nothing changed** and says so
plainly to the user.

> The point: the failure mode people fear from an AI technician is that it finds
> something to fix. This one reports a clean bill of health.

### 5. It learns — 30s

Run **Intranet unreachable (Windows)**, then **Intranet unreachable again
(macOS)**.

The second run recalls what the first learned — different platform, same root
cause — and says so in the diagnosis, citing the earlier ticket.

---

## Screen recording

macOS gates screen capture behind a permission, and `screencapture` **succeeds
without it** — you get a picture of the desktop wallpaper and nothing else. It
fails silently, which is why `doctor` flags it rather than guessing.

Grant it once:

1. **System Settings → Privacy & Security → Screen Recording**
2. Enable **Terminal** (or iTerm, or whichever you run `npm run serve` from)
3. **Restart the terminal** — the permission only applies to new processes

Verify by eye:

```bash
screencapture -x /tmp/t.png && open /tmp/t.png
```

If that shows your screen, AIT's will too. If it shows only wallpaper, the
permission has not taken effect yet.

This only affects the local-machine scenarios. The simulated ones draw their
frames from device state and need no permission at all.

## Between rehearsals

The knowledge base is real: a run learns from the ones before it. That is the
point of demo step 5, but it means rehearsing twice makes the third run recall
your rehearsals. Wipe it before the real thing:

```bash
npm run reset
```

That clears `./run-artifacts` — evidence and knowledge both — so the demo starts
from the same blank slate every time.

## If something goes wrong

**Port 3000 is taken.** macOS itself rarely uses 3000, but other dev servers do:

```bash
PORT=3100 npm run serve
```

**`npm install` fails on native modules.** There are none — AIT is pure
TypeScript with two SDK dependencies. If install fails, it is a registry or proxy
problem, not a build problem.

**A local check is skipped.** `doctor` lists which tools it could not find.
Skipped checks are skipped, never failed — the run continues.

**You want to be certain nothing touches your machine.** Run only the simulated
scenarios; they never open a local session. Or read the audit trail after any
run: every command that executed is in it, and the danger scenario has none.

## Using a real model

The demo runs on the deterministic playbook engine, which is the right choice for
a live demo — nothing can rate-limit or refuse mid-presentation. To drive it with
a real model instead:

```bash
export ANTHROPIC_API_KEY=sk-ant-...      # or OPENAI_API_KEY=sk-...
npm run doctor                            # verifies the model id exists
npm run serve
```

Then pick the provider in the console's dropdown. The guardrails are identical
either way — that is the property worth demonstrating, and you can show it by
running the same dangerous ticket under both.
