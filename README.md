# Pi Universal Harness

A portable, model-agnostic, task-agnostic **control plane** for the [Pi coding agent](https://github.com/earendil-works/pi).

The model does the work. The harness governs execution.

```
Model    = CPU
Harness  = operating system / control plane
Judge    = narrow decision engine
```

---

## Why this exists

Large and small models can usually perform individual actions correctly. Long-running
agents still fail, and they fail in the same ways: they forget the original goal, lose
constraints, drift from scope, repeat approaches that already failed, confuse
hypotheses with verified facts, overstate weak evidence, declare success early, and
perform irreversible actions without verification.

Those problems are not fixed by better prompts. A prompt is a request; the model
chooses whether to honour it, and after fifty turns and a compaction it usually
doesn't remember it was asked.

This harness moves the guarantees into the runtime:

```
BAD                                    GOOD
───                                    ────
Prompt:                                Model proposes action
"Remember to check before                     ↓
 important actions."                   Pi runtime event
                                              ↓
The model decides whether              Harness intercepts
to comply.                                    ↓
                                       Checkpoint detection
                                              ↓
                                       Evidence collection
                                              ↓
                                       Judge
                                              ↓
                                       Harness allows or blocks
```

The model is never asked to remember any of this.

---

## What it is not

It is **not** a collection of rules about code. There is no "run tests before push"
anywhere in it. The word `git` does not appear in any executable line of the checkpoint
detector, the evidence planner, or the Judge payload builder — there is a test that
enforces this.

The schema is fixed. The content comes from the task in front of it. The same harness
governs software development, git operations, deployment, security audits, dataset
preparation, image generation, data processing, model-training preparation, research
and general agent work.

---

## How it works

### 1. The Task Contract

Every substantive request is compiled into a structured contract. The **schema is
static; the content is dynamic**.

```
TaskContract
├── originalRequest      the user's words, unmodified
├── goal
├── requirements         things that must be ACHIEVED
├── constraints          boundaries on HOW
├── successConditions    what must be demonstrably true, and verifiable
├── forbiddenConditions  outcomes that must never occur
├── criticalActions      actions verified BEFORE they run
├── ambiguities          what the compiler could not resolve
└── assumptions          what it filled in — never presented as user instructions
```

Every item carries `source` (`user` / `compiler` / `runtime` / `system`) and `priority`
(`hard` / `soft`). This separation is load-bearing:

> **An explicit user instruction is authoritative.**
> "Do not touch production" is stored as `{source: "user", priority: "hard"}` with the
> user's exact words quoted. The compiler may add its own best practices, but they are
> marked `source: "compiler"` and can never be presented back to the Judge as something
> the user said.

Three different tasks, one schema:

| | Coding | Dataset | Image |
|---|---|---|---|
| **goal** | Fix the authentication defect | Produce a training-ready dataset | Produce the requested visual |
| **constraint** | The frontend must not be modified | The source dataset must remain unchanged | — |
| **forbidden** | — | A sample appears in both splits | — |
| **success** | Tests pass; defect gone | Splits exist and are disjoint | OCR matches exactly; text is on the left |
| **critical action** | Publish changes to the remote | Finalize the dataset on disk | — |

Same code path. Different strings.

### 2. Contract review

The compiler is one model call, and one model call can quietly drop
"do not touch production" or invent a requirement nobody asked for. An independent
reviewer audits `(original request, proposed contract)` and returns
`PASS` / `REVISE` / `NEEDS_USER_INPUT`, checking specifically for:

- a user requirement the contract missed
- an item marked `source: "user"` that the user never said
- a user prohibition softened to `priority: "soft"`
- contradictions, unrepresented ambiguities, and success conditions too vague to settle

On `REVISE` the contract is recompiled once with the findings attached. If the reviewer
returns `PASS` while listing a high-severity finding — which models do regularly — the
findings win and the verdict is upgraded.

### 3. Locking and versioning

Once reviewed, the contract is **deep-frozen**. The worker cannot mutate it; attempting
to throws. Changing the task produces a new version with a recorded diff, reason,
source and timestamp.

A hard user constraint **cannot be dropped across a revision** unless the user
themselves authorized it. The state manager refuses the revision outright.

### 4. Canonical state

The harness owns the state. The model may read it and reason about it, but never owns it.

```
stateVersion 47
├── contract + contractVersion + revision history
├── verifiedFacts      ← requires runtime evidence. Enforced, not requested.
├── hypotheses         ← what the model believes. A structurally different type.
├── evidence           ← with provenance, trust level, and freshness
├── actions            ← with equivalence signatures, for loop detection
├── checkpoints
├── decisions          ← every Judge verdict, including ones not applied
└── counters
```

Backed by an **append-only event log** (NDJSON). The log is the source of truth;
snapshots are an optimization. Any state can be rebuilt by replay, which is what makes
recovery after a crash trivial and the audit trail complete.

**Trust levels are types, not conventions:**

| Level | Source | Example |
|---|---|---|
| 1 | Runtime evidence | exit codes, file hashes, test output, API responses |
| 2 | Explicit user instruction | "don't modify production", "stop after 10 attempts" |
| 3 | Model interpretation | "I think this is safe", inferred root causes |

A Level 3 claim can never become a Level 1 fact:

```ts
// This throws. Not warns — throws.
state.verifyFact({ statement: "SQL injection confirmed", evidenceIds: [] })
```

Because the evidence only ever said *"malformed input produced HTTP 500"*. That is the
fact. "SQL injection" is a hypothesis, and it is stored as one.

### 5. Checkpoint detection

Three tiers, cheapest first:

```
Is the action mutating?  ──no──►  allowed, zero I/O, zero cost
         │ yes
         ▼
Contract signals         ──hit──►  gate   (exact, free, decisive)
         │ none
         ▼
Generic signals          ──strong──►  gate   (documented heuristics)
         │ weak
         ▼
Judge escalation (one noul question, ~70–500ms)
```

Contract signals come from the contract's own `criticalActions`, hard `constraints` and
`forbiddenConditions`. Generic signals describe *effects on the world* — external
mutation, destruction, irreversibility — never tool names. `external_mutation` covers
`git push`, `curl -X POST`, an S3 upload and sending an email equally.

> A gap found during live testing: the contract named "delete the .log files" as
> critical. `find … -delete` was correctly blocked three times, and the model then
> reached the same outcome with `rm -f -- ./*.log`, which matched nothing. A gate
> defeated by rephrasing is a vocabulary filter, not a gate. Removal *programs* are now
> named explicitly, and `isMutating` and `destructiveSignal` share one definition so
> they cannot drift apart again. There is a regression test with six equivalent
> phrasings.

### 6. Evidence planning and collection

Once a checkpoint fires, the planner asks: *what must be proven before this may proceed?*

The answer comes from the contract, not from a checklist:

1. Skip requirements that fresh evidence already covers.
2. Derive a check — from a machine-checkable `check`, from the success condition's own
   `verificationHint`, or from project `preferredCommands`.
3. Anything with no available route is reported as **unverifiable** rather than silently
   dropped. The Judge is told a requirement could not be checked.

Requirements no command can settle — *"the image is thematically about Kubernetes"* —
become reviewer requests, and reviewer output is recorded at trust level
`model_interpretation`, not as runtime evidence.

### 7. The Judge

```
Harness core  ──►  Judge interface  ──►  OpenRouterJevJudge  ──►  OpenRouter
                          │                                      ~typesafe/jev-latest
                          ├──►  ModelJudge        (fallback)
                          └──►  DeterministicJudge (always available)
```

Core logic depends only on `Judge.evaluate()`. It has no idea OpenRouter exists.

**Jev is not a chat model.** Verified against the live API:

```
GET /api/v1/models/~typesafe/jev-latest/endpoints
→ modality "text->decisions", output_modalities ["decisions"], endpoints []
```

It is a **System One model**: it takes application state plus *typed questions* and
returns *typed answers with calibrated probabilities*. It is served from
`POST /api/alpha/decisions`, not `/v1/chat/completions`.

The harness fans out **one** request into a `choice` verdict plus one `noul` per
requirement and per hard constraint:

```json
{
  "model": "~typesafe/jev-latest",
  "state":  { "goal": "...", "evidence": [...], "userInstructions": [...] },
  "questions": {
    "verdict":  { "type": "choice", "criteria": { "PASS": "...", "FAIL": "...",
                                                  "MORE_EVIDENCE": "...", "REVIEW": "..." } },
    "req_s1":   { "type": "noul", "instructions": "Is this requirement sufficiently supported...?" },
    "con_c1":   { "type": "noul", "instructions": "Would the proposed action violate...?" }
  }
}
```

`reasons` and `missingEvidence` are then derived **deterministically in code** from
those probabilities. There is no prose to parse and nothing to hallucinate, and
`confidence` is a real calibrated number rather than a model's opinion of itself.

Three consistency rules are applied, because a raw verdict can contradict the per-item
answers — and when it does, the narrower questions win:

1. A violated hard constraint overrides any verdict → `FAIL`.
2. A `PASS` with unsupported hard requirements → `MORE_EVIDENCE`.
3. A `PASS` below the confidence threshold → `REVIEW`.

### 8. Compact payloads

The full Pi context is never sent. A 262K window costs money, adds latency, and buries
the three facts that matter. The payload carries only what bears on this checkpoint:
relevant requirements, explicit user constraints, current fresh evidence, recent
actions, counters, `stateVersion`.

**The worker cannot write this object.** Its opinion may appear only as:

```
agentAssessment: "[UNTRUSTED — this is the working agent's own claim, not evidence] ..."
```

and every Judge prompt is told to disregard it as a basis for `PASS`. Without this rule
a model could assert *"everything passed and this is safe"* and have the Judge ratify it.

### 9. Stale decisions

Every Judge decision references the `stateVersion` it was computed against. If state
advanced while the Judge was thinking, the verdict describes a world that no longer
exists:

```
Judge evaluated v41 → state is now v43 → decision recorded, NOT applied → re-evaluate
```

### 10. The completion gate

The worker cannot declare "task completed" and bypass verification. The gate runs from
Pi's `agent_settled` event, which fires when Pi will not continue on its own — that is
the moment the worker has effectively declared it finished, whatever words it used.

On rejection the harness pushes structured feedback back with `triggerTurn`, so the
worker resumes with the gaps spelled out instead of the session ending on an unverified
claim:

```
COMPLETION REJECTED — the task is not finished.

Missing:
  - s1: The test suite passes — no runtime evidence has been collected.

Success conditions not yet verified:
  - s1: The test suite passes
      verify by: run `npm test`

Judge: openrouter/~typesafe/jev-latest · MORE_EVIDENCE · confidence 0.94 · state v147

Continue the task: gather the missing evidence, then declare completion again.
```

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

| Command | What it shows |
|---|---|
| `/harness status` | Configuration, current task, contract and state versions |
| `/harness setup` | Store the OpenRouter key locally (mode 0600) and verify connectivity |
| `/harness doctor` | Full diagnostic, with a stated fix for every failure |
| `/harness contract` | The Task Contract, review findings, revision history |
| `/harness state` | Phase, versions, verified facts, hypotheses, counters |
| `/harness events [n]` | The append-only audit log |
| `/harness evidence` | Evidence with provenance, trust level and freshness |
| `/harness decision [id]` | Judge decisions in full, including ones not applied |
| `/harness judge` | Judge configuration and usage accounting |
| `/harness enable` / `disable` | Toggle the harness (persisted) |
| `/harness abandon [reason]` | End the current task without completing it |

No command ever prints a secret. `status` shows a fingerprint: `sk-or-…f4a2`.

---

## When something is blocked

```
BLOCKED — more evidence is required before this action can proceed

Action:      bash: git push origin main
Checkpoint:  contract_critical_action (critical)
Reason:      The Task Contract marks this as a critical action:
             "Publish the repository changes to the shared remote"

Relevant contract items:
  a1 — Publish the repository changes to the shared remote
  s1 — The test suite passes

Evidence collected:
  - command_result via npm test: exit 0 — 3 passed

Missing:
  - s1: No regression verification has been performed.

Judge:       openrouter/~typesafe/jev-latest
Decision:    MORE_EVIDENCE
Confidence:  0.94
State:       v147

Judge reasoning:
  - Requirement "The test suite passes" is supported by the evidence (p=0.96).
  - Overriding the returned verdict "PASS": 1 hard requirement lacks evidence.

Gather the missing evidence listed above, then try the action again.
```

Every block answers: what was attempted, which contract item it touched, what is known,
what is missing, who decided, how confident, and against which state version.

---

## Failure behaviour

**The conservative default.** When no Judge can answer:

| Checkpoint | Policy | Behaviour |
|---|---|---|
| critical | `user_review` | Block and ask the user. **`fail_closed` when there is no UI** (print/JSON mode). |
| noncritical | `fallback` | Try the chain; allow with a warning if it is exhausted. |

`fail_open` exists because it is sometimes genuinely wanted, but it is never a default,
`doctor` warns when it is configured for critical checkpoints, and the router logs an
error every time it is used.

Other guarantees:

- Transient failures (429, 5xx, timeout) retry with exponential backoff; auth and 404
  errors do not, because retrying them is pointless.
- A **user abort is not a Judge failure** and does not cascade through the fallback chain.
- A malformed response is rejected rather than half-interpreted.
- The deterministic Judge **never returns `PASS` on a critical checkpoint** — the best it
  offers is `REVIEW`, which puts a human in the loop.
- A harness bug cannot take Pi down: every hook is wrapped and fails open with a logged
  error. A harness that bricks the agent is a harness people uninstall, and an
  uninstalled harness governs nothing.

---

## Security

- The API key is resolved from **Pi's own credential store** (`/login`, which also covers
  `OPENROUTER_API_KEY`), then from a harness-local store at mode `0600`, then reported as
  unconfigured. Never from tracked config, never from source. Preferring Pi's store means
  there is usually no second copy of the key to protect at all.
- Redaction runs at the **boundary** — every log write and every rendered command output
  — rather than trusting each call site to remember. Registered key values, common
  credential formats (OpenRouter, Anthropic, OpenAI, GitHub, AWS, Slack, JWT, Google) and
  `KEY=value` assignments are all masked.
- `doctor` fails if the secret store is group- or world-readable, if a secret file is
  tracked in git, or if the state directory sits inside a repository.
- Evidence commands are barred from containing shell metacharacters, run with a timeout,
  and have their output truncated. The planner will not extract a chained command from a
  verification hint.
- All external, model and tool output is treated as untrusted input.

---

## Configuration

Global config lives outside the repository and contains **no secrets**:

```jsonc
{
  "enabled": true,
  "compiler":        { "provider": "current-pi-model" },
  "contractReviewer": { "provider": "current-pi-model", "enabled": true },
  "judge": {
    "enabled": true,
    "provider": "openrouter",
    "baseUrl": "https://openrouter.ai/api",
    "decisionsPath": "/alpha/decisions",
    "model": "~typesafe/jev-latest",
    "timeoutMs": 30000,
    "fallbackChain": ["model", "deterministic"],
    "failurePolicy": { "critical": "user_review", "noncritical": "fallback" },
    "thresholds": {
      "requirementSupported": 0.75,
      "constraintViolated": 0.5,
      "minPassConfidence": 0.6
    }
  },
  "contract": { "autoCompile": "substantive" },
  "state":    { "persist": true },
  "logging":  { "level": "info" }
}
```

Optional project config at `<project>/.pi/harness.json` *helps* the Evidence Planner but
never replaces contract logic. **The harness works with no project config at all.**

```json
{
  "projectType": "backend",
  "preferredCommands": { "test": "npm test", "lint": "npm run lint" },
  "protectedPaths": ["infra/production/**"]
}
```

Project config is honoured only for trusted projects, and anything derived from it is
`source: "compiler"` — never `source: "user"`.

---

## Model-agnostic by construction

The compiler, reviewer and fallback Judge all speak one interface:

```ts
interface ModelAdapter {
  id: string
  available: boolean
  complete(request: ModelRequest): Promise<ModelResponse>
}
```

Nothing above it knows whether the active model is a local Qwen, a llama.cpp build,
Kimi, Claude, GPT, Codex, Gemini or something that does not exist yet. Changing Pi's
model rebinds the adapter at runtime via `model_select`.

Structured output is obtained by **prompt-constrained JSON → extract → validate →
bounded repair**, deliberately *not* provider-native JSON-schema mode, which is not
uniformly available across those models. The repair prompt restates the original task,
because sending only the error makes weaker models "fix" their JSON by inventing
content — which, for a Task Contract, means fabricating user requirements.

---

## Development

```bash
npm test          # 74 tests
npm run typecheck
```

Tests cover three unrelated workflows (coding, dataset, image) through identical harness
code, plus the §61 failure modes: compiler misses a requirement, reviewer catches it,
compiler invents a user constraint, stale `stateVersion`, OpenRouter unavailable, key
missing, invalid Judge response, contradicting evidence, repeated strategies, completion
without evidence, mid-task requirement change, hard-constraint violation,
`MORE_EVIDENCE`, and restart recovery.

One test reads the source of the detector, signals, planner and payload builder and
fails if any executable line mentions git, npm, a specific tool name or a task domain.
Comments are stripped first — several of those files *discuss* git precisely to explain
why they do not branch on it, and a test that failed on the explanation would push us to
delete the explanation rather than keep the property.

### Repository layout

```
├── index.ts                  extension entry (symlink target)
├── src/
│   ├── pi/          extension · commands · doctor · harness (the gate) · pi-adapter
│   │                render · runtime
│   ├── contract/    schema · compiler · reviewer · revisions
│   ├── state/       types · event-store · reducer · state-manager · freshness
│   ├── checkpoints/ types · detector · signals
│   ├── evidence/    types · planner · collector
│   ├── judges/      judge · payload · normalize · openrouter-jev
│   │                model-judge · deterministic · router
│   ├── progress/    monitor
│   ├── models/      model-adapter · structured
│   ├── config/      schema · loader · paths
│   ├── security/    secrets · redact
│   └── util/        ids · json · logger · errors · validate
├── scripts/         install.sh · uninstall.sh · doctor.sh
└── tests/
```

`src/pi/harness.ts` is the gate. `src/judges/openrouter-jev.ts` is the only file that
knows OpenRouter exists.

---

## Universal invariants

Permanently in core, regardless of task:

1. Explicit hard user constraints cannot be silently removed.
2. Hypotheses do not automatically become verified facts.
3. Stale Judge decisions are not applied.
4. Runtime evidence outranks model claims.
5. Judge decisions carry provenance.
6. Contract revisions are versioned and diffed.
7. Important decisions are auditable.
8. Completion requires contract evaluation.

Everything else is dynamic.

---

## Known limitations

1. **`/api/alpha/decisions` is alpha.** Configurable via `judge.decisionsPath`; `doctor`
   reports a clear diagnostic if it moves.
2. **Jev returns no prose.** `reasons` are synthesized from calibrated probabilities —
   accurate and reproducible, but template-shaped rather than free-form.
3. **Checkpoint detection on novel actions is heuristic.** Contract-derived signals are
   exact; the generic classifier is documented and biased toward over-gating.
4. **The compiler is one model call.** A bad contract produces bad gating for the whole
   task. Review mitigates but does not eliminate this.
5. **Structured output is prompt-constrained, not schema-enforced**, for portability.
   Small local models fail validation more often; after two repair attempts the harness
   degrades to a minimal contract built from the raw request and says so, rather than
   fabricating one.
6. **Sibling tool results are not visible at gate time** in Pi's parallel tool mode — a
   documented Pi constraint.
7. **No cost data from the decisions endpoint.** Calls, retries, failures, latency and
   tokens are tracked; cost is estimated from a configurable rate.
8. **Extensions run with full user permissions.** Pi has no sandbox for them. The harness
   only ever writes inside its own state directory.

---

## Credits

Built against Pi 0.85.1. Judge: [Jev](https://typesafe.ai) by TypeSafe, via
[OpenRouter](https://openrouter.ai/typesafe).

`docs/PHASE0.md` records the environment inspection this design was built from,
including the API findings that changed it.

MIT.
