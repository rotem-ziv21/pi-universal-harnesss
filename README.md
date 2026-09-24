# Pi Universal Harness

A model-agnostic control layer for the [Pi coding agent](https://github.com/earendil-works/pi).
The worker model does the work. The harness checks two things, and the worker cannot
skip either check:

1. **Before every tool call:** is this action safe to run?
2. **When the worker stops:** did it change code and then claim success with no passing check?

Both answers come from code and from [Jev](https://typesafe.ai), TypeSafe's decision model.
Jev gets fixed questions about facts the runtime observed. **The harness makes no
language-model calls of its own.** Changing the worker model (GLM, DeepSeek, Qwen, Claude,
a local 7B) changes the work, not the harness.

```
Worker model   = does the work (any model)
Harness code   = observes, applies thresholds, caps retries
Jev            = answers fixed, typed questions over observed facts
```

---

## Why it is built this way

An earlier version compiled every request into a task contract with a language model,
had a second model review it, and used the reviewer's verdicts to decide completion.
Each of those steps depended on a model's output, so each model swap changed how the
harness behaved. Tasks looped, and every new task exposed a new bug.
`docs/מחקר-השוואתי-jev.md` compares that design with 18 projects built on Jev.
The working ones share these rules, and this harness follows them:

- **The goal is the user's own words.** Nothing rewrites them into requirements.
- **Jev sees facts, never a model's prose**: the command, a script's contents, which files
  changed, which checks ran and whether they passed.
- **The questions are fixed.** They live in `src/decide/questions.ts`, and a test pins their
  hash, so they are the same for every task and every model.
- **Code decides from probabilities.** Thresholds are config values, not wording.
- **Deterministic evidence comes first.** Most actions and most stops never reach Jev.
- **Every retry is capped.** The worker is sent back at most once per user prompt. After
  that the run ends and is reported as verified or not verified. The harness never loops.
- **Every decision is logged**, so thresholds can be tuned against real traffic.

---

## How it works

### The action gate (`tool_call`)

```
tool call
   │
   ├─ deny list? ───────────────► blocked (rm -rf ~, mkfs, dd to a device, fork bomb …)
   ├─ needs the user? ──────────► confirm (git push, reset --hard, clean -f, npm publish, sudo, curl | sh,
   │                                         writes to protected paths)
   ├─ routine? ─────────────────► runs, no Judge call (reads, searches, tests/builds/lint,
   │                                         edits inside the project, local git, deleting build output)
   └─ anything else ────────────► one Jev request, four fixed questions:
                                     destructive · exfiltration · outward · off_request
                                  → policy thresholds → run / confirm / block
```

The fast layer in `src/decide/hazards.ts` is deliberately small. It does not try to
understand every command. When it doesn't recognise a command, it asks Jev, which costs
one call of a few hundred milliseconds. It also passes Jev what it noticed as `hints`
(for example "touches a path outside the workspace"), and the contents of any local
script or here-document the command runs, so Jev judges what the script does rather
than its name.

With a UI, a held action goes to you: approve it once, and an identical retry passes.
Without a UI, the block reason becomes the tool result the worker reads. It tells the
worker not to retry the same action, and to either find a recoverable alternative or
stop and explain to you.

If Jev cannot answer (no key, timeout, outage), routine work still runs, and anything
the fast layer flagged is held for you.

### The done gate (`agent_settled`)

```
worker stops
   │
   ├─ stopped on an error, abort or length limit? ─► not a completion claim; nothing to check
   ├─ no files changed? ───────────────────────────► done (nothing to verify)
   ├─ a check passed after the last change? ───────► done, verified (no Judge call)
   └─ otherwise: one Jev request over {task, final message, files changed, checks run}
         claims_done · claims_verified · verification_applies · outcome
         │
         ├─ asking you a question, blocked, or a test can't check this work ─► done, not verified
         └─ claims done with no passing check ─► sent back ONCE with the facts;
                                                 the next stop ends the run, reported as not verified
```

A check is a test, build, typecheck or lint command. Whether it passed is read from its
exit status and from the runner's own summary line. Changes are write and edit calls,
plus any files the before/after snapshot shows a shell command created, modified or
deleted.

### Repeat failures

When the same call fails the same way three times, a one-line note is appended to the
result the worker reads. There is no block and no extra turn.

---

## Installation

**One line, on any machine that already has Pi:**

```bash
curl -fsSL https://raw.githubusercontent.com/rotem-ziv21/pi-universal-harnesss/main/scripts/bootstrap.sh | bash
```

That clones (or updates) the harness and installs it. It is idempotent — re-run it to
update. On a container it prefers a mounted volume over the root filesystem, so the
install survives a restart, and warns when it cannot find one.

Or manually:

```bash
git clone https://github.com/rotem-ziv21/pi-universal-harnesss.git
cd pi-universal-harnesss
./scripts/install.sh
```

The installer discovers everything at runtime. It reads the config directory name from
the **installed Pi package's** `piConfig.configDir` rather than assuming `.pi`, resolves
`$PI_HARNESS_CONFIG_DIR` → `$PI_CONFIG_DIR` → `$XDG_CONFIG_HOME` → `$HOME`, verifies the
Pi version, and symlinks the checkout into the global extension directory.

It never overwrites an existing config, never touches unrelated extensions, and is
idempotent. `--dry-run` shows exactly what it would do; `--copy` installs without a
symlink.

Then give the Judge a key. **Pi already has a place for this**, and the harness reads
it rather than keeping its own copy:

```
pi
/login              # choose OpenRouter, paste your key
/harness doctor     # confirm
```

That is the whole configuration. One place to log in, one place to rotate, nothing to
carry between machines.

The key is resolved fresh on every use, so a `/login` performed mid-session takes
effect on the very next gate — no reload.

Two alternatives remain for anyone who would rather not log in to OpenRouter inside Pi:
`export OPENROUTER_API_KEY=...`, or `/harness setup` to store it locally at mode 0600.

### Portability

```
                    GitHub
                (source code only)
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
     RunPod           macOS         Linux VM
        +               +               +
   local key       local key       local key
```

Code moves through git. Secrets do not. Nothing hardcodes `/root`, `/workspace`,
`/Users/<name>`, a GPU, an endpoint or a project.

### Updating

```bash
git pull      # then /reload inside Pi
```

Pi loads TypeScript directly through jiti, so there is no build step and no compiled
artifact to keep in sync.

---

## Commands

| Command | What it does |
|---|---|
| `/harness status` | Mode, Judge key and usage, what this run changed and checked |
| `/harness why` | The last decision in full: the state Jev saw, its answers, the verdict |
| `/harness log [n]` | The last n decisions |
| `/harness evidence` | Changes and checks the harness observed in this run |
| `/harness mode enforce\|observe` | Switch modes (then `/reload`) |
| `/harness setup` | Store an OpenRouter key locally (prefer `/login` → OpenRouter) |
| `/harness doctor` | Environment and Judge connectivity checks |
| `/harness enable\|disable` | Turn the harness on or off (then `/reload`) |

---

## Modes

- **`enforce`** (default): risky actions are held, and an unverified "done" is sent back once.
- **`observe`**: nothing is held and nothing is sent back. Every decision the harness
  *would* have made is written to the log. Use it to check the thresholds on your own
  work before you enforce them. The deny list still applies in this mode.

---

## Configuration

`<agent dir>/harness/config.json`. Every field is optional. These are the defaults:

```json
{
  "enabled": true,
  "mode": "enforce",
  "judge": {
    "baseUrl": "https://openrouter.ai/api",
    "decisionsPath": "/alpha/decisions",
    "model": "~typesafe/jev-latest",
    "timeoutMs": 8000
  },
  "action": { "destructiveConfirm": 0.8, "exfiltrationBlock": 0.8, "outwardConfirm": 0.85, "offRequestConfirm": 0.9 },
  "done": { "enabled": true, "claimsDone": 0.7, "applies": 0.5, "maxNudgesPerPrompt": 1, "maxNudgesPerSession": 3 },
  "stuck": { "repeatThreshold": 3 }
}
```

Settings from the previous, contract-based harness (`compiler`, `contractReviewer`,
`contract`, `progress`, …) are ignored, and the harness warns about them.

For a trusted project, `.pi/harness.json` can add the following:

```json
{
  "protectedPaths": ["config/production.yml", "migrations/"],
  "preferredCommands": { "verify": "./scripts/verify.sh" }
}
```

Protected paths always need your approval before they are written. Running a preferred
command counts as a check.

**Tuning:** every decision is appended to `<agent dir>/harness/decisions.jsonl`. Each line
holds the state, the question-pack version, the raw answers, the verdict and the model
that answered. Change a threshold only after reading what it would have changed there.
Thresholds are tuned to a Jev version, so pin a versioned model id in `judge.model` once
you have confirmed one on OpenRouter.

---

## Security

- The API key is resolved from **Pi's own credential store** (`/login`, which also covers
  `OPENROUTER_API_KEY`), then from a harness-local store at mode `0600`. It is never read
  from tracked config or from source.
- Redaction runs on every log line and every decision record. Registered key values,
  common credential formats and `KEY=value` assignments are all masked.
- Jev's state never includes the worker's reasoning or plans. Only the user's messages
  define the request, so a worker cannot argue its own action into being approved.
- The harness is a guard, not a sandbox. A determined process can do things no tool call
  reveals. Run untrusted work in a container.

---

## Development

```bash
npm install
npm run check      # typecheck + tests
```

The tests run offline against a fake decisions endpoint. They cover:

- the fast layer, including a corpus of real commands from live runs (`tests/corpus/commands.json`)
- the evidence tracker and runner-summary parsing
- both gates and their caps
- the Pi wiring end to end, against a fake Pi (`tests/extension.test.ts`)

When a live run surfaces a command the fast layer handles badly, add it to the corpus.

### Repository layout

```
index.ts                 Pi entry point
src/decide/
  questions.ts           the fixed question packs (hash-pinned)
  hazards.ts             the deterministic fast layer
  evidence.ts            changes and checks, as observed
  policy.ts              thresholds → verdicts, and every message the worker sees
  gates.ts               the action gate and the done gate
  jev.ts                 decisions-endpoint client (never throws)
  stuck.ts               repeat-failure notes
  decision-log.ts        decisions.jsonl
src/pi/                  Pi wiring, commands, doctor
src/config/ src/security/ src/resources/snapshot.ts src/util/
```

---

## Known limitations

- **It does not make a weak model write better code.** It stops false "done" claims and
  holds dangerous actions. It does not add capability.
- **Some work cannot be verified by running a command**, such as prose, a clear comment
  or a design. For that kind of work the done gate reports "not verified" and stops. It
  does not keep sending the worker back.
- **The thresholds are starting points** taken from projects that measured their own
  traffic. Run in `observe` mode for a while and read the log before relying on them.
- **Jev reads English best.** Hebrew requests work, but the goal text Jev sees is your
  own words, so its judgments about off-request actions are weaker in other languages.

---

## Credits

Built against Pi 0.85.1. Judge: [Jev](https://typesafe.ai) by TypeSafe, via
[OpenRouter](https://openrouter.ai/typesafe). The design follows the comparative study in
`docs/מחקר-השוואתי-jev.md`.

MIT.
