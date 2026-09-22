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

It is **not** a collection of task-domain rules. Core policy never asks whether the
task is "code", "data", or "image" work. It evaluates typed capabilities, resource
operations, provenance, scope, reversibility, and external visibility.

Concrete tool and command knowledge is isolated in semantic adapters. The shell
adapter may know how a program expresses deletion or publication; the detector,
evidence planner, completion evaluator, and Judge payload consume only the normalized
result. Adding a new tool means adding an adapter or supplying a structured
`harnessSemantics` declaration, not adding a branch to policy.

---

## How it works

### 1. The Task Contract

Every substantive request is compiled into a structured contract. The **schema is
static; the content is dynamic**.

```
TaskContract
├── originalRequest      the user's words, unmodified
├── goal
├── workspace            allowed scopes and protected resources
├── requirements         things that must be ACHIEVED
├── constraints          boundaries on HOW, optionally with typed action policy
├── successConditions    what must be demonstrably true
├── forbiddenConditions  outcomes that must never occur
├── criticalActions      typed action selectors verified BEFORE they run
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
├── workspace
│   └── resource registry ← URI, kind, provenance, scope, status, creating action
├── verifiedFacts        ← requires runtime evidence. Enforced, not requested.
├── hypotheses           ← what the model believes. A structurally different type.
├── evidence             ← expected, observed, provenance, trust, freshness
├── actions              ← normalized resource effects and loop signatures
├── checkpoints
├── decisions            ← every Judge verdict, including ones not applied
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

Every tool call is normalized into active semantics:

```
actionType · classification · mutationType · reversibility
externalSideEffect · capabilities
resource effects[] = URI · kind · operation · provenance · scope
```

Only operation fields are classified. File content, patches, replacement text and
request bodies are data; words inside those payloads cannot become capabilities.
Built-in file tools, shell syntax, and known commands are adapters. Unknown custom
tools are reviewed conservatively unless they provide structured semantics.

Checkpoint policy then runs cheapest-first:

```
Read/query only?                   ──yes──► allow
Protected/out-of-scope mutation?  ──yes──► block without a Judge
Typed forbidden policy match?     ──yes──► block without a Judge
Typed review/critical match?       ──yes──► evidence gate
Reversible local PLAN/EXECUTE?     ──yes──► allow construction
Generic high-risk side effect?     ──yes──► evidence gate
Unknown classification?           ──yes──► conservative review
```

Policy selectors use task-independent dimensions: capability, operation, resource
kind, provenance, scope, external visibility, and optional URI prefix. Descriptions
remain authoritative human intent, but are never regex-dispatched into policy.

### 6. Evidence planning and collection

Once a checkpoint fires, the planner asks: *what must be proven before this may proceed?*
Planning happens before the final gate decision so the harness can detect typed circular
dependencies: reversible construction that creates a resource named by a verification
strategy is allowed before that resource can be inspected.

The answer is a typed strategy from the contract:

- `command_execution` carries a program and argument vector separately, plus typed
  exit/output expectations. No shell string is extracted from prose.
- `resource_state` checks existence, absence, or an exact hash.
- `event_log_assertion` evaluates normalized successful actions.
- `semantic_evaluation` and `visual_evaluation` remain model interpretation and cannot
  masquerade as runtime evidence.
- `user_confirmation` records an explicit user response.

Fresh, requirement-linked evidence is reused. Failed checks are contradictory evidence.
Items with no typed route are reported as **unverifiable**. Arbitrary successful tool
calls, filenames, and words in descriptions never satisfy a condition implicitly.

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
the facts that matter. The payload carries the current phase, normalized action
semantics, only the requirements and constraints relevant to this checkpoint, and a
requirement-specific evidence bundle. Source bodies, patches and request payloads are
replaced with size-only omission markers.

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

### 10. Phase-aware completion

Task execution advances through `PLAN → EXECUTE → VERIFY → FINALIZE`. These phases
describe lifecycle state, not a software workflow: a research query, a rendered
document, a local program, and a generated image use the same transitions. Reversible
allowed-scope work can proceed during PLAN, EXECUTE, and VERIFY; irreversible,
protected-scope, and external actions remain gated. Adding evidence moves the task to
VERIFY. A rejected completion returns there.

The worker cannot declare "task completed" and bypass verification. The gate runs from
Pi's `agent_settled` event, which fires when Pi will not continue on its own.

At FINALIZE every hard requirement, success condition, constraint and forbidden
condition receives its own `SATISFIED`, `UNSATISFIED` or `UNKNOWN` result. Deterministic
results come only from fresh, explicitly linked typed evidence or structured event-log
policy. `UNSATISFIED` blocks directly; only `UNKNOWN` conditions reach the Judge.

On rejection the harness pushes structured feedback back with `triggerTurn`, so the
worker resumes with the exact remaining conditions instead of repeating the same
action. The feedback tells the worker what actually counts: the Judge sees what its
tools returned (exit codes, output, listings, diffs), so it must *demonstrate* a
condition with a tool result rather than restate that the work is done.

### 11. The loop guard

A harness that sends the worker back "for more evidence" has to know when more
evidence cannot exist. Otherwise it produces the failure it was built to prevent: a
model circling until its context is full, and finally claiming success to escape.

Four rules keep that from happening:

- **An action gate asks only about the action.** A `rm *.log` the user asked for is
  judged on the constraints it might violate, never on whether an unrelated
  requirement has been proven yet.
- **Unverifiable is not "more evidence".** A hard requirement with no typed
  verification route can never acquire linked runtime evidence. The deterministic
  Judge sends it to a human (`REVIEW`) instead of demanding the impossible, and the
  Judge payload flags it so a model Judge weighs the tool observations instead.
- **A repeated block goes to the user.** Retrying an equivalent blocked checkpoint
  with no new evidence asks the user to decide when there is a UI, and otherwise
  returns `NO_PROGRESS` with a message that says retrying cannot work.
- **Completion rejections are finite.** If the worker declares completion again
  without recording a single new action, or after `progress.maxCompletionRejections`
  rejections, the harness stops restarting it. The task moves to `awaiting_user`, the
  last rejection is shown, and the user is asked whether to accept the result, continue
  with a new instruction, or `/harness abandon`. The harness never marks an unverified
  task complete on its own.

A `FAIL` on an action gate no longer ends the agent run. Ending it only bounced the
worker through the completion gate and back into the same `FAIL`; the block message
already tells it not to retry.

### 12. Follow-ups revise the contract

A new substantive prompt while a task is active is not ignored and does not start an
unrelated task. The compiler is given the previous contract and the new message and
produces the updated contract for the whole conversation; it is recorded as a contract
revision of the same task, so the event log, evidence and action history survive. A
short reply ("yes", "go on") continues under the existing contract. An unfinished task
is resumed on session start only if it was touched within `state.resumeWithinHours`.

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
| `/harness judge-debug [id] [full]` | Requirement ids, evidence ids, payload/semantic hashes, normalized decision; `full` prints redacted request/response |
| `/harness checkpoint-debug [id]` | Normalized action, matched capabilities/constraints, phase, dependency analysis and final policy |
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
  "compiler":        { "provider": "current-pi-model", "reasoning": "minimal", "maxOutputTokens": 8000 },
  "contractReviewer": { "provider": "current-pi-model", "enabled": true, "reasoning": "minimal" },
  "judge": {
    "enabled": true,
    "provider": "openrouter",
    "baseUrl": "https://openrouter.ai/api",
    "decisionsPath": "/alpha/decisions",
    "model": "~typesafe/jev-latest",
    "timeoutMs": 30000,
    "modelFallbackTimeoutMs": 90000,     // budget per attempt for the chat-model fallback Judge
    "modelFallbackRepairAttempts": 1,
    "fallbackChain": ["model", "deterministic"],
    "failurePolicy": { "critical": "user_review", "noncritical": "fallback" },
    "thresholds": {
      "requirementSupported": 0.75,
      "constraintViolated": 0.5,
      "minPassConfidence": 0.6
    }
  },
  "contract": { "autoCompile": "substantive" },
  "progress": { "maxCompletionRejections": 2 },  // then the user decides, not the loop
  "state":    { "persist": true, "resumeWithinHours": 12 },
  "logging":  { "level": "info" }
}
```

Optional project config at `<project>/.pi/harness.json` gives the Task Compiler trusted
project context and adds protected resources to workspace policy. It never replaces
contract logic. **The harness works with no project config at all.**

```json
{
  "projectType": "backend",
  "preferredCommands": { "verification": "npm test" },
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
npm test
npm run typecheck
```

Tests exercise the same core across local code/file work, protected-source
transformation, non-code artifact generation, externally visible publication, and the
CSV reproduction. Regression coverage also pairs each reproduction with an unrelated
domain: rendered artifacts for provenance and shell semantics, qualitative document
checks for non-executable prose, and generic reports for evidence linkage.

Additional suites cover compiler/reviewer failures, stale state, unavailable Judges,
credential resolution, contradictory evidence, repeated strategies, completion without
evidence, contract revision, hard-policy violations, `MORE_EVIDENCE`, and restart
recovery.

### Repository layout

```
├── index.ts                  extension entry (symlink target)
├── src/
│   ├── pi/          extension · commands · doctor · harness (the gate) · pi-adapter
│   │                render · runtime
│   ├── contract/    schema · compiler · reviewer · revisions
│   ├── state/       types · event-store · reducer · state-manager · freshness
│   ├── checkpoints/ types · action-semantics · detector · signals
│   ├── evidence/    types · planner · collector · dependency · completion
│   ├── resources/    types · registry
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
3. Natural-language descriptions are never executed or regex-dispatched into policy.
4. Resource provenance is recorded from successful normalized effects, including
   task-created single files and non-filesystem resources.
5. Protected and outside-allowed resource mutations are blocked deterministically.
6. Stale Judge decisions are not applied.
7. Runtime evidence outranks model claims.
8. Evidence satisfies only the contract item ids explicitly linked to it.
9. Contract revisions are versioned and diffed.
10. Completion requires per-condition contract evaluation.

Everything else is dynamic.

---

## Known limitations

1. **`/api/alpha/decisions` is alpha.** Configurable via `judge.decisionsPath`; `doctor`
   reports a clear diagnostic if it moves.
2. **Jev returns no prose.** `reasons` are synthesized from calibrated probabilities —
   accurate and reproducible, but template-shaped rather than free-form.
3. **Adapters define observable semantics.** Built-in file tools and common shell
   programs have adapters; custom tools must supply `harnessSemantics`. Unknown tools
   are conservatively reviewed. The shell adapter models common sequencing,
   redirection, descriptor duplication, and `cd`, but is not a complete POSIX shell.
4. **The registry sees harness-routed effects.** Successful tool results update exact
   resource URIs. Mutations performed out of band, or by a tool that declares incomplete
   effects, are not observable until a later direct check.
5. **Qualitative verification remains interpretation.** Semantic and visual reviewers
   are labelled `model_interpretation`; they do not become deterministic completion
   proof without a Judge or explicit user confirmation.
6. **The compiler is one model call.** A bad contract can omit a typed selector or
   verification route. Review mitigates but does not eliminate this.
7. **Structured output is prompt-constrained, not provider-schema-enforced**, for
   portability. After bounded repair failures the harness degrades to a minimal
   contract and relies on generic gating.
8. **Sibling tool results are not visible at gate time** in Pi's parallel tool mode —
   a documented Pi constraint.
9. **No cost data from the decisions endpoint.** Calls, retries, failures, latency and
   tokens are tracked; cost is estimated from a configurable rate.
10. **Extensions run with full user permissions.** Pi has no sandbox for them. The
   harness only writes its own persistent state; governing agent tool effects remains
   policy enforcement, not OS isolation.

---

## Credits

Built against Pi 0.85.1. Judge: [Jev](https://typesafe.ai) by TypeSafe, via
[OpenRouter](https://openrouter.ai/typesafe).

`docs/PHASE0.md` records the environment inspection this design was built from,
including the API findings that changed it.

MIT.
