# Evaluation

`pnpm eval` measures two things: whether a request reaches the right agent, and whether each agent behaves correctly on tasks with a known right answer.

```sh
pnpm eval                              # everything, 3 trials per agent case
pnpm eval --trials 5 --gate            # fail if worse than baseline.json
pnpm eval --trials 5 --update-baseline # record this run as the baseline
pnpm eval --only agents --case brief   # a subset
```

## How it works

- **Routing** sends labelled requests through Jev and compares its pick with the label. Six requests fit no agent and must be declined; ten sit between two agents and must get one of the two or none.
- **Agent cases** run against two fictional companies served from fixtures (`northwind-metrics.example`, `harbor-ledger.example`), so the model cannot answer from memory. The gateway, approval queue, audit log, memory store and the Firecrawl connector's URL checks are the real ones; only the HTTP call to Firecrawl is replaced.
- **Grading is code.** Each check is a function over the reply and the gateway's records, such as "states no price that is not on the site" or "queues exactly one send, nothing sent". No model grades another model.
- Each case runs several times because the model is not deterministic. A case is all-green only when every check passes in a trial.

## Baseline: 17 November 2026

Model `deepseek-flash`, thinking off with escalation to high on a failed reply check, 5 trials per case. Per-case numbers are in `baseline.json`.

| Routing | Result |
|---|---|
| Labelled requests | 25 of 25 |
| Off-topic requests wrongly given an agent | 0 of 6 |
| Ambiguous requests given an acceptable agent or none | 10 of 10 |
| Latency | p50 0.38 s, p95 0.75 s |

| Agent cases | Result |
|---|---|
| Cases all-green in every trial | 17 of 20 at the baseline run; the three that missed one trial were fixed or reworded afterwards and each then passed 5 of 5 or 6 of 6 |
| Checks passed | 565 of 570 (99.1%) |
| Task latency | p50 8.2 s, p95 14.0 s |
| Tokens per task | about 1,500 (a plan) to 11,000 (outreach research) |

Against the previous baseline (thinking off, no tool budget, separate search and read calls): median task 9.6 s to 8.2 s, and tokens per task down by roughly a quarter to a half.

## Knowledge base retrieval: 25 November 2026

8 documents, 22 labelled questions (14 direct, 8 paraphrased so they share few words with the answer).

| Search | Answer document ranked first | In the top three | Median search time |
|---|---|---|---|
| Keyword only | 15 of 22 | 16 of 22 | 0.1 ms |
| Keyword plus embeddings (`bge-small-en-v1.5` on CPU) | 17 of 22 | 20 of 22 | about 30 ms |

Keyword search found every direct question and 2 of the 8 paraphrases; embeddings recovered 4 more. The two still missed need a stronger embedding model or a reranker. The set is small: treat it as a regression check, not a measure of quality on real documents.

Agent cases with the knowledge base, 5 trials: cited answer 5 of 5, planted instruction ignored 5 of 5, business facts used by another agent 5 of 5, "not covered" stated 4 of 5.

## Gate run: 25 November 2026

After loop detection, the outside-content flag, memory budgets and the audit-based report were added. Five trials, `deepseek-flash`, thinking off with escalation. The baseline file was not changed.

| Measure | Result |
|---|---|
| Routing | 28 of 28 correct, 0 of 6 off-topic requests wrongly routed, 9 of 10 ambiguous acceptable |
| Agent checks | 666 of 670 (99.4%) |
| Cases green in every trial | 23 of 24 |
| Latency per task | p50 7.3 s, p95 14.0 s |
| Input tokens served from DeepSeek's prompt cache | 86% of 874,035 |

The one case that is not green every time is `lessons/second-attempt-improves` (3 of 5; the baseline has 4 of 5): in one trial the agent ignored the lesson, in another it saved a draft where a send was expected.

The cache share is high without any change to prompt order: the system prompt is identical for every run of a template and approved memory is its last section. `pnpm eval` now prints this number, so a change that breaks the cache shows up.

The reranker has not been measured: no reranking server was running. Set `HELMGEAR_RERANKER_URL` and run `pnpm eval --only kb`.

## Known weaknesses

- **A send that becomes a draft.** Occasionally an agent asked to send to a given address saves a draft and asks for confirmation instead. It says so honestly, and `verified` stays true; check `pendingActionIds` to see whether a send was queued.
- **Five trials is a small sample.** A failure that happens 1 time in 20 will usually not show up. Raise `--trials` before relying on a case.
- **Not covered:** `email-triage` and `bookkeeping-proposal` (they need a second model host), writing quality, and real websites with sliders, cookie walls or scripts.

## Adding a case

Add an entry to `CASES` in `run.ts`: a template, a fixture variant, a request, and checks. Write the check so that it names the production behaviour it protects. When a case fails, fix the agent with a clearer general rule or a code change; never write an instruction that mentions the fixture.
