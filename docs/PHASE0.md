# Phase 0 — Environment Inspection Report

Produced before implementation, as required by §66–§67 of the mission brief.
Everything below was verified against the machine, not assumed.

---

## 1. What was discovered

| Item | Value |
|---|---|
| OS | macOS 26.5.2 (Darwin 25.5.0), arm64 |
| Node | v24.12.0 |
| npm | 11.6.2 |
| Pi package | `@earendil-works/pi-coding-agent` |
| **Pi version** | **0.85.1** |
| Pi binary | `~/.npm-global/bin/pi` |
| Pi install path | `~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent` |
| Config dir name | `.pi` (from `package.json` → `piConfig.configDir`) |
| Global config | `~/.pi/agent/` |
| Global extensions | `~/.pi/agent/extensions/` |
| Sessions | `~/.pi/agent/sessions/` |
| Active default model | `openai-codex/gpt-5.5` |
| Pre-existing extensions | 4 Orca extensions — **must not be touched** |

Extensions are loaded through [jiti](https://github.com/unjs/jiti), so **TypeScript
runs directly with no build step**. That removes an entire class of portability
problems: there is no compiled artifact to keep in sync across machines.

### Global extension mechanism (verified)

| Location | Scope |
|---|---|
| `~/.pi/agent/extensions/*.ts` | Global, all projects |
| `~/.pi/agent/extensions/*/index.ts` | Global, subdirectory |
| `.pi/extensions/*.ts` | Project-local (only after project trust) |
| `settings.json` → `extensions: [...]` | Explicit paths |

We use the **subdirectory form** (`~/.pi/agent/extensions/pi-universal-harness/index.ts`)
as a **symlink** to the git checkout. `git pull` + `/reload` then updates the harness,
which is exactly the workflow §50/§64 asks for.

---

## 2. Pi 0.85.1 extension API — the capabilities that matter

Verified from `dist/core/extensions/types.d.ts` and `docs/extensions.md`.

### Runtime enforcement is genuinely available

```
tool_call  →  { block: true, reason: string, terminate?: boolean }
```

This is the load-bearing hook for the whole design. It fires **after**
`tool_execution_start` and **before** the tool runs, `event.input` is mutable, and
returning `block` prevents execution. Handlers are `async`, so the harness can run
evidence collection and a Judge call inside the gate. Session state is synchronized
through the current assistant message before handlers run.

This means §45 ("mandatory gates are runtime behavior, not suggestions") is
implementable as specified — not approximated.

### Full hook inventory used by the harness

| Hook | Harness use |
|---|---|
| `session_start` | Rehydrate canonical state from disk |
| `before_agent_start` | Compile / review / lock the Task Contract; inject contract digest |
| `tool_call` | **The gate.** Detect → plan → collect → judge → allow/block |
| `tool_result` | Ingest runtime evidence (Level 1 trust) |
| `turn_end` | Progress / loop monitoring |
| `agent_settled` | **Completion gate.** Pi will not continue on its own here |
| `session_shutdown` | Flush event log, release locks |
| `input` | Intercept `/harness …` sub-commands not covered by `registerCommand` |
| `session_before_compact` / `session_compact` | Survive compaction — state lives outside the context window |

### Model invocation (model-agnostic, verified)

```ts
ctx.modelRegistry.complete(model, { systemPrompt, messages }, { signal, ... })
  → Promise<AssistantMessage>
```

`ctx.model` is the **currently active** model. The Task Compiler and Contract
Reviewer call this and never name a provider — swapping Pi's model swaps theirs
with zero harness changes (§6).

Structured output is obtained by prompt-constrained JSON + extraction +
typebox validation + a bounded repair retry — deliberately **not** provider-native
JSON-schema mode, because that is not uniformly available across
Qwen / Kimi / llama.cpp / Claude / GPT / Gemini.

### Other relevant APIs

- `pi.registerCommand(name, {description, handler, getArgumentCompletions})`
- `pi.registerTool({name, parameters: TSchema, execute})` — typebox schemas
- `pi.sendMessage(msg, {triggerTurn, deliverAs})` — how the completion gate pushes
  structured feedback back to the worker and forces it to continue
- `pi.appendEntry(customType, data)` — session-scoped persistence that survives forks
- `ctx.ui.{notify,confirm,input,select,setStatus,setWidget}` — guarded by `ctx.hasUI`
- `ctx.signal` — abort signal, propagated into every Judge/compiler fetch
- `CONFIG_DIR_NAME` exported constant — **never hardcode `.pi`**

---

## 3. The OpenRouter / Jev finding that changes the design

The brief assumed Jev is reachable as an ordinary chat model. **It is not**, and
building it that way would have produced a harness that fails on first contact.

Verified directly against the live API:

```
$ curl https://openrouter.ai/api/v1/models/~typesafe/jev-latest/endpoints
{"data":{"id":"~typesafe/jev-latest","name":"TypeSafe: Jev Latest",
  "architecture":{"modality":"text->decisions",
                  "output_modalities":["decisions"]},
  "endpoints":[]}}
```

- Modality is **`text->decisions`**, not `text->text`.
- `endpoints: []` — it is **not** served over `/v1/chat/completions`.
- It does not appear in the public `/v1/models` listing (445 models, zero matches);
  the `~` prefix marks a separate model class.

Jev is a **System One model**. It takes application state plus *typed questions* and
returns *typed answers with calibrated probabilities*. There is no prose, no JSON to
parse, nothing to validate.

**Correct wire format** (confirmed against TypeSafe's HTTP reference and OpenRouter):

```http
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer $OPENROUTER_API_KEY
Content-Type: application/json

{
  "model": "~typesafe/jev-latest",
  "state":  <string | object | array>,
  "questions": {
    "<your id>": { "type": "noul" | "choice" | "score",
                   "instructions": "...",
                   "criteria": ... }
  }
}
```

```json
{ "model": "...",
  "answers": { "<your id>": { "type": "choice", "choice": "PASS",
                              "probabilities": {...}, "confidence": 0.82 } },
  "usage": { "input_tokens": 312, "output_tokens": 48 } }
```

Question primitives:

| Type | `criteria` | Answer |
|---|---|---|
| `noul` | `{true, false}` descriptions (optional) | `noul: 0..1` — probability of yes |
| `choice` | `map<option, description>` (required) | `choice`, `probabilities`, `confidence` |
| `score` | ordered `string[]`, ≥2 levels (required) | `score`, `legend`, `probabilities`, `confidence` |

OpenRouter-specific constraints, encoded in the adapter:
- `instructions` and `criteria` values must be **strings** — structured values are JSON-encoded.
- A `null` choice criterion is **rejected**; send `""` instead.
- The path is still `/api/alpha/` and may move, so it is configurable.

### Why this is better than the original plan

§39 asked for `{decision, confidence, reasons, missingEvidence, stateVersion}`
normalized from Jev's output. With the real API we get something stronger: the
harness **fans out one call** into a `choice` verdict plus one `noul` per
requirement and per hard constraint, then derives `reasons` and `missingEvidence`
**deterministically in code** from calibrated probabilities.

There is no prose to parse and no reasoning to hallucinate. `confidence` is a real
calibrated number rather than a model's self-report. This is precisely the
"speculative fan-out" pattern TypeSafe documents, and it costs one round trip
(~70–500 ms, $0.042/M input, output free).

### Cost of this choice

The `JudgeQuery` interface is therefore expressed as **typed questions**, not as a
prose prompt. A prose-based fallback Judge (the active Pi model) must answer the
same typed questions in JSON. That is implemented in `judges/model-judge.ts` and it
is the reason the Judge interface is shaped the way it is.

---

## 4. Proposed architecture (adapted to Pi 0.85.1)

```
user prompt
    │
    ▼
before_agent_start ─────────────────────────────────────┐
    │                                                   │
    ├─ TaskCompiler.compile()      ctx.modelRegistry    │  (active Pi model,
    ├─ ContractReviewer.review()   ctx.modelRegistry    │   provider-agnostic)
    ├─ contract locked → v1                             │
    └─ StateManager.init()  stateVersion = 1            │
                                                        │
worker model works ◄────────────────────────────────────┘
    │
    ├─ tool_call ──► CheckpointDetector.evaluate(contract, state, action)
    │                     │ needsGate = false ──► allow (cheap path, no Judge call)
    │                     │ needsGate = true
    │                     ▼
    │                EvidencePlanner.plan(...)      → EvidencePlan
    │                EvidenceCollector.collect(...) → Evidence[] (Level 1)
    │                JudgePayloadBuilder.build(...) → compact, harness-owned
    │                     ▼
    │                JudgeRouter ──► OpenRouterJevJudge ──► /api/alpha/decisions
    │                     │              (fallback: ModelJudge, DeterministicJudge)
    │                     ▼
    │                PASS → allow │ FAIL → block │ MORE_EVIDENCE → block+request │ REVIEW → ctx.ui.confirm
    │
    ├─ tool_result ──► EvidenceStore.ingest()   stateVersion++
    ├─ turn_end     ──► ProgressMonitor.observe()
    │
    └─ agent_settled ──► CompletionGate.evaluate()
                             PASS → state = COMPLETED
                             else → pi.sendMessage(structured feedback, triggerTurn)
```

Every arrow above writes an event to the append-only log (§19), and every state
mutation bumps `stateVersion` (§20).

---

## 5. Repository structure

```
pi-universal-harness/
├── index.ts                      # extension entry — symlink target for Pi
├── src/
│   ├── pi/          extension.ts · commands.ts · pi-adapter.ts · render.ts
│   ├── contract/    schema.ts · compiler.ts · reviewer.ts · revisions.ts
│   ├── state/       types.ts · event-store.ts · reducer.ts · state-manager.ts · freshness.ts
│   ├── checkpoints/ types.ts · detector.ts · signals.ts
│   ├── evidence/    types.ts · planner.ts · collector.ts · store.ts
│   ├── judges/      judge.ts · payload.ts · openrouter-jev.ts · model-judge.ts
│   │                deterministic.ts · router.ts · accounting.ts
│   ├── progress/    monitor.ts
│   ├── models/      model-adapter.ts · structured.ts
│   ├── config/      schema.ts · loader.ts · paths.ts
│   ├── security/    secrets.ts · redact.ts
│   └── util/        ids.ts · json.ts · logger.ts · errors.ts · hash.ts
├── scripts/         install.sh · uninstall.sh · doctor.sh
├── tests/           contract · state · checkpoints · judges · workflows · failures
└── README.md · package.json · tsconfig.json · .gitignore
```

Deviation from the brief's §58 sketch: `src/pi/extension.ts` is a thin wiring layer
and the real entry is a root `index.ts`, because Pi's subdirectory-extension loader
looks for `index.ts` at the directory root. `payload.ts`, `router.ts`, `signals.ts`,
`store.ts` and `structured.ts` were added rather than growing existing files past
their natural size (§68: small focused modules).

---

## 6. Answers to the §67 checklist

**How global installation works.** `scripts/install.sh` resolves `piConfig.configDir`
from the installed Pi package (never hardcodes `.pi`), resolves `$PI_CONFIG_DIR` /
`$XDG_CONFIG_HOME` / `$HOME` in that order, verifies the Pi version satisfies the
supported range, then symlinks the checkout into
`<configDir>/agent/extensions/pi-universal-harness`. It creates the state directory,
never rewrites `settings.json`, and never touches the four pre-existing Orca
extensions. Re-running is idempotent.

**How the Task Compiler calls a model.** Through `ModelAdapter`, a thin wrapper over
`ctx.modelRegistry.complete(ctx.model, …)`. It never references a provider name. The
adapter interface allows a different model — local, hosted, or a subagent — to be
injected later via config without touching the compiler.

**How Contract Review works.** A second, independent `ModelAdapter` call with the
original user request and the proposed contract, returning
`PASS | REVISE | NEEDS_USER_INPUT` plus structured findings. On `REVISE` the compiler
re-runs once with the findings; on `NEEDS_USER_INPUT` the harness asks the user via
`ctx.ui`. The interface is shaped so a Jev `choice` question can replace it later.

**How the State Manager persists.** Append-only JSONL event log plus a periodically
written state snapshot, under
`<configDir>/agent/harness/tasks/<taskId>/{events.jsonl, state.json, contract.json}`.
Snapshots are an optimization; the event log is the source of truth and the reducer
can rebuild any state from it. Writes use an atomic temp-file rename. Model contexts
are never persisted — only compact structured state (§49).

**How tool interception works.** The `tool_call` hook, with `{block, reason}`.
Non-checkpoint actions take a fast path that performs no I/O and no Judge call.

**How checkpoints work.** `CheckpointDetector` scores generic *signals* — the
contract's own `criticalActions` and `forbiddenConditions`, declared irreversibility,
external side effects, and completion claims. Signals are derived from the Task
Contract, never from a tool-name allowlist. Ambiguous cases escalate to a Jev `noul`
question. The word "git" appears nowhere in the detector.

**How evidence planning works.** `EvidencePlanner` maps the requirements relevant to
the detected checkpoint onto `EvidenceRequest`s. Request *kinds* are generic
(`command`, `file_state`, `tool_output`, `reviewer`, `deterministic`); the concrete
commands come from the Task Contract and, optionally, `.pi/harness.json`
`preferredCommands`. The harness works with no project config at all.

**How the OpenRouter/Jev Judge works.** `POST /api/alpha/decisions` with a fanned-out
question set; answers are normalized into `JudgeDecision` with deterministically
derived `reasons` and `missingEvidence`. All OpenRouter knowledge is confined to
`judges/openrouter-jev.ts`; core code only ever calls `Judge.evaluate()`.

**How `OPENROUTER_API_KEY` is stored and read.** Priority: (1) environment variable,
(2) `<configDir>/agent/harness/secrets.json` at mode `0600`, (3) Judge marked
unavailable. Never in source, never in tracked config, never written to logs — a
redaction pass runs over all log and diagnostic output, and `/harness status` shows
only a fingerprint (`sk-or-…abcd`, first 5 + last 4).

**How Judge failures behave.** `JudgeRouter` applies a per-severity policy.
**MVP default is conservative:** `critical → user_review` (block and ask the user;
`fail_closed` when there is no UI, e.g. print mode), `noncritical → fallback` to the
Deterministic Judge with a warning. `fail_open` exists but is never the default.
Malformed responses retry twice with backoff before the policy applies.

**MVP implementation order.** Config/paths/secrets → state + events + versioning →
contract schema/compiler/reviewer → Pi wiring + commands → checkpoints → evidence →
Judge interface + Jev adapter + fallbacks → progress monitor → completion gate →
installer/doctor → tests.

---

## 7. Known limitations

1. **`/api/alpha/decisions` is alpha.** The path is configurable
   (`judge.decisionsPath`) and `/harness doctor` reports a clear diagnostic if it
   moves. Worth re-checking periodically.
2. **Jev returns no prose.** `reasons` are synthesized by the harness from calibrated
   probabilities. Intentional, but it means Judge explanations are template-shaped
   rather than free-form.
3. **Checkpoint detection on novel actions is heuristic.** Contract-derived signals
   are exact; the generic irreversibility classifier is a documented heuristic with
   tunable thresholds. It is deliberately biased toward over-gating.
4. **The Task Compiler is one model call.** A bad contract produces bad gating for
   the whole task. The Contract Reviewer mitigates but does not eliminate this.
5. **Structured output is prompt-constrained, not schema-enforced**, for model
   portability. Small local models will fail validation more often; the repair loop
   is bounded at two attempts, after which the harness degrades to a minimal
   contract built from the raw request and tells the user.
6. **Tool interception cannot see sibling tool results** from the same assistant
   message in parallel tool mode — a documented Pi constraint. Evidence from a
   sibling call in the same batch may not be visible at gate time.
7. **No cost data from the decisions endpoint.** Accounting tracks calls, retries,
   failures, latency and token counts; cost is estimated from a configurable rate.
8. **Extensions run with full user permissions.** Pi has no sandbox for them. The
   harness only ever writes inside its own state directory.
