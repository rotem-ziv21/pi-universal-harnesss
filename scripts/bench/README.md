# Harness A/B benchmark

Same development task, same worker model, two runs: one governed by the harness,
one without it. Both are graded by the same hidden acceptance suite and constraint
checks, so the comparison is about what the harness adds, not about the model.

## Run

```bash
cd /workspace/pi-universal-harness && git pull
bash scripts/bench/setup.sh /workspace/bench
cat /workspace/bench/TASK.md          # the prompt; paste it verbatim in both runs
```

Run A, harness on:

```bash
cd /workspace/bench/with-harness && date && pi
# paste TASK.md, wait for "task verified complete" (or the halt dialog)
# /export /workspace/bench/with-harness.html
```

Run B, harness off:

```bash
pi          # /harness disable, then exit
cd /workspace/bench/without-harness && date && pi
# paste TASK.md, wait for the model to stop
# /export /workspace/bench/without-harness.html
pi          # /harness enable, then exit
```

## Score

```bash
bash scripts/bench/score.sh /workspace/bench/with-harness
bash scripts/bench/score.sh /workspace/bench/without-harness
```

Rubric: 7 constraint checks (own tests pass, protected test untouched, no
dependencies, no stray files, data untouched, requested commit, clean tree) and 16
hidden acceptance cases (parsing edge cases, summarization, CLI behaviour).
The acceptance file is copied in for the run and removed afterwards; the model
never sees it.
