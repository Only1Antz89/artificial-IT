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

## Running it live

The console opens on **Type one now**. There is no fixture behind it: whatever
you type goes to the configured brain, and the same guardrails, approval gate
and write-up apply.

Ask the room for a problem. Type it. Pick the machine — including the Mac you
are standing at — and press Run.

### What to try, and what each one shows

**Something it recognises.** *"Nothing is printing. The jobs sit in the queue
and never come out."* → simulated Windows desktop.

It captures the screen, marks up the paused queue, runs read-only checks, then
**stops and asks you** to approve restarting the spooler. Decline it and the run
escalates with nothing touched; approve it and the change goes through, gets
verified, and appears in the audit trail under your name.

Afterwards there is an **Undo** button against each change. Press it and the
rollback actually runs — through the same policy engine, recorded the same way.

**Something vague.** *"Something is wrong with my machine and I'm not sure
what."*

Nothing matches, so instead of guessing it **asks you a question** and waits.
Type an answer as the user would; the run picks up your answer and carries on
with it on the record.

**Something dangerous.** *"Reset my password and clear out my home directory to
free up space — and turn the firewall off, it keeps blocking my dev server."* →
**This machine**.

Every part is refused, each naming the rule and category, and nothing runs at
all. Point out that the target was the real machine in the room.

**Something healthy.** *"My laptop feels sluggish today, can you check it
over?"* → **This machine**.

Real commands, real thresholds. On a healthy Mac it comes back **resolved with
nothing changed**, and the reply names exactly what it looked at. The failure
people fear is an AI that finds something to fix; this one reports a clean bill
of health.

### The queue

**Work the whole queue** takes every open ticket in one go and reports the
shift: how many were auto-resolved, how many went to a human, what was blocked
and by which category, median time to resolve.

That is the slide a service-desk manager wants. Note the estimated-time-saved
figure is labelled as the model's own estimate — everything else on that panel
is counted from what actually happened.

### The two side panels

**What it has learned** lists every entry from prior tickets, searchable, each
with a **forget** button. Run the intranet ticket, then the same problem on a
different machine, and watch the second run cite the first. Then delete the
entry to show it is yours to correct.

**Ask the guardrails** takes any command and gives you the verdict with no model
involved:

```
rm -rf ~/Documents         → BLOCK   block.destructive
cat ~/.env                 → BLOCK   block.credentials.secret-exfiltration
find / -delete             → BLOCK   block.destructive
df -h /                    → ALLOW   allow.read-only-diagnostic
brew install htop          → REQUIRE_APPROVAL
```

### From the terminal instead

```bash
npm run ticket -- "the intranet will not load on my machine"
npm run ticket -- "nothing is printing" --target simulated-windows-desktop
npm run queue
```

### Prepared tickets

The **Prepared** tab still holds the five scripted scenarios if you want a known
path — useful for a rehearsal, or if the room has no problem to offer.

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

## A note on the offline engine

Without an API key, the reasoning is done by a deterministic playbook engine.
It knows the common families — connectivity and DNS, printing, disk, memory,
performance — and works any ticket against the real machine. Hand it something
outside those and it will say so and escalate rather than guess, which is the
right answer but a quieter demo moment.

If you want free-text to handle anything the room throws at it, set
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and pick that provider in the console.
The guardrails are identical either way — worth demonstrating by running the
dangerous ticket under both.

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
