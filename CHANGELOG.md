# Changelog

All notable changes to jev-orchestrator.

## 0.3.0 — 2026-09-30

- **Fix loop-after-escalate**: `state.finalClosed` terminal flag — the FINAL stage no longer re-fires on later settles after the escalation (one "limit reached" injection, then closed). Incident: session 01a0f0d0 (5× byte-identical verdicts, runaway escalate).
- **Fix `retryLeft`**: CHECK now looks up the branch *before* asking and computes remaining retries from `branch.retry` (`retryLeftFor`) — the constant `maxRetries-1` (which reported "1 left" forever) is gone.
- **`parallelMax` (IDEA)**: `limits.parallelMax = 4` — ROUTE directive states the cap; CHECK clamps `depthLeft` to 0 once the episode spawned ≥ parallelMax branches (fan-out stop at the decision layer).
- **Fix evidence truncation**: the Jev ask sliced state to `stateChars` (6KB), silently cutting the 13–16KB FINAL evidence block before the judge saw it; now bounded at 20KB.
- **Fix verdict cache**: key = sha1(full state ≤ 20KB + JSON(questions)) instead of a 1500-char prefix + key names (the byte-identical-verdict replay mechanism); cache hits no longer inflate `budgetUsed`; cache pruned past 64 entries.
- **Project layout**: pi-package structure — `extensions/index.ts` entry declared in `package.json` (`pi.extensions`), modules in `src/`, suites in `tests/`, design/ops docs in `docs/`; `agentDirOf()` is now marker-based (walks up to the dir containing `extensions/jev-orchestrator`) instead of a hardcoded level.
- Tests: 55 asserts (regress 31 · final-category 12 · evidence 7 · session-msgs 5), tsc strict clean.

## 0.2.0 — 2026-09-29

- **Task categories**: ROUTE adds `task_cat` (implementation | analysis | research_docs); FINAL questions + gap vocabulary + correction advice are per-category; analysis/research docs no longer demand diff/review/tests; "no files changed" is a valid terminal state for read-only tasks. Malformed category → implementation (legacy behavior).
- **Session-scoped toggles**: `/jev-orch on|off|shadow|enforce` changes only the running process; `global` subcommands persist to `~/.pi/agent/jev-orchestrator.json`.
- **Jev request budget**: `/jev-orch budget [N]` (session, `JevAsk.setMaxRequests`) and `/jev-orch global budget N` (persist `maxRequests`); status/footer show the live limit.
- **FINAL evidence builder**: `buildFull-transcript evidence` — original task + top-3 reports (9000/2000/2000 caps) + recent tail, total cap 16KB; subagent CHECK verdicts appended so parallel runs are not misjudged as missing sections.
- **ROUTE strategy gate (IDEA §3.1)**: a confident strategy answer (conf ≥ 0.6) may override weak noul signals; no signal at all stays `direct`.
- Fixed double directive prefix; removed stale compiled `.js` artifacts that shadowed `.ts` under jiti.

## 0.1.0 — 2026-09-26/28

- Initial pipeline: ROUTE / CHECK / FINAL with enforce + shadow modes, bounded correction (`maxFailLoops`), fail-open on every Jev unavailability, verdict cache + cooldown + session budget, episode persistence via `jev_orch` custom entries, footer panel + `/jev-orch` command with argument completion, and the debug widget.
