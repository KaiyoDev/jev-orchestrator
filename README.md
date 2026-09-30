# jev-orchestrator

Adaptive task orchestration for the Pi coding agent. **Jev** (the TypeSafe judgment layer) decides; **Pi** executes. The orchestrator is a Pi extension that injects typed, structured judgments (choice / score / noul, with probabilities) at three lifecycle points — it never codes and never spawns agents itself.

## Pipeline

```
task (≥ 150 chars)
  │
  ▼
[1] ROUTE   Jev types the task: shape (direct|parallel|tree|…), depth, model tier,
            and TASK CATEGORY (implementation | analysis | research_docs).
            → "ORCHESTRATOR ROUTE" directive with the category completion contract.
  ▼
[2] EXECUTE Pi/model executes — inline (direct) or via subagent runners (parallel/tree).
  ▼
[3] CHECK   Every agent-runner tool result is judged: PASS / FAIL (cause, reroute,
            retry budget per branch, depth budget, parallelMax fan-out cap).
  ▼
[4] FINAL   Settlement check against the CATEGORY contract, using full-transcript
            evidence (task + longest reports + recent tail + subagent verdicts).
  │
  ├── PASS ──────────────► normal settlement
  └── FAIL ─► bounded correction (maxFailLoops = 2) ─► escalate to user (episode closed)
```

Jev requests per task: 1 ROUTE + 1 CHECK per agent result + 1 FINAL per correction turn (verdicts are cached for 60 s; a cache hit costs no request).

## Completion contracts (per category)

| Category | Required | NOT required |
|---|---|---|
| implementation | scope, matching diff/state, task-demanded tests/build evidence | — |
| analysis | every requested section, evidenced findings, synthesis | diff, changed files, tests |
| research/docs | requested output with source coverage, scope/consistency | code diff |

"No file changed" is a valid state for read-only/analysis/docs tasks — it must not produce `gap=review`.

## Layout

```
├── package.json          # pi-package manifest (pi.extensions → extensions/index.ts)
├── README.md
├── CHANGELOG.md
├── LICENSE
├── extensions/
│   └── index.ts          # extension entry: hooks, /jev-orch command, TUI panel
├── src/
│   ├── checker.ts       # decision layer: decideCheck/decideFinal, contracts, evidence builder
│   ├── config.ts        # config load/merge/persist, agent dir discovery
│   ├── jev.ts           # Jev adapter: judge lifecycle, budget, cooldown, verdict cache, fail-open
│   ├── router.ts        # ROUTE questions, decideRoute (strategy gate, category, depth), directive
│   ├── state.ts         # episode state (OrchState, OrchBranch, persistence via custom entries)
│   └── typesafe-bridge.cjs
├── tests/               # unit/regression suites (plain node, Node ≥ 24 TS type-stripping)
└── docs/                # IDEA (design) + ROLLBACK (change history & revert)
```

## Install

Pi auto-loads this directory because its `package.json` declares the entry:

```json
"pi": { "extensions": ["extensions/index.ts"] }
```

Two ways to install:

```bash
# A. as a pi package — pi also installs the pi-typesafe dependency (declared in package.json):
pi install git:github.com/KaiyoDev/jev-orchestrator

# B. local directory (this repo's home): pi auto-loads it from ~/.pi/agent/extensions/;
#    install the dependency once:  pi install npm:pi-typesafe
```  
No build step (TypeScript is transpiled by Pi's jiti loader). If pi-typesafe is missing at runtime the extension toasts the exact install command; you can also run **`/jev-orch install-deps`** to install it and retry the judge in-process. Login: `/login typesafe` (or OpenRouter / Vercel AI Gateway).

Config file: `~/.pi/agent/jev-orchestrator.json` (global, new sessions). All fields:

```jsonc
{
  "enabled": true,          // global default
  "mode": "enforce",        // enforce (inject directives) | shadow (log only)
  "minTaskChars": 150,      // below → orchestrator stays out
  "cooldownMs": 30000,      // min gap between Jev asks
  "maxRequests": 40,        // global default for the session request budget
  "stateChars": 6000,       // evidence slice bound inside the ask (block cap ~16KB, ask cap 20KB)
  "cacheSec": 60,           // verdict cache window
  "thresholds": {           // decision layer (IDEA §3)
    "needs_decomp": 0.7, "split_ok": 0.7, "strategy_conf": 0.6,
    "accept": 0.8, "reroute_conf": 0.7, "deeper": 0.7, "done_ok": 0.85
  },
  "limits": { "maxDepth": 3, "maxRetriesPerBranch": 2, "maxFailLoops": 2, "parallelMax": 4 }
}
```

## Commands (per session)

| Command | Effect |
|---|---|
| `/jev-orch` | footer status (state, req x/y, mode) |
| `/jev-orch on \| off \| shadow \| enforce` | **session-scoped** toggle/mode (never touches other sessions) |
| `/jev-orch global on\|off\|shadow\|enforce\|budget N` | persist to the global config file (new sessions) |
| `/jev-orch budget [N]` | show / set this session's Jev request budget |
| `/jev-orch debug` | live TUI widget: stage, last verdict, evidence size |
| `/jev-orch status` | episode detail (task, shape, category, branches, failLoops, budget) |
| `/jev-orch clear` | drop the episode (stops any loop instantly) |
| `/jev-orch install-deps` | install the missing pi-typesafe dependency and retry the judge in-process |
| `/jev-orch new-task` | start a fresh episode |

## Verifying

```bash
npm run typecheck   # tsc strict over src/ + extensions/ (needs tsc, e.g. npx tsc)
npm test            # 4 suites: regress (31) + final-category (12) + evidence (7) + session-msgs (5)
```

Live acceptance (in a fresh Pi process): send a task ≥ 150 chars and watch `/jev-orch debug` — expect `ROUTE …` → `CHECK …` (if agents ran) → `FINAL PASS/FAIL` with bounded correction only.

## Known boundaries

- `done_ok` calibration is judge-side (TypeSafe model); the orchestrator stays bounded and honest (2 corrections → escalate) instead of forcing a pass.
- Subagent work lives in subagent sessions; FINAL sees their results via CHECK verdicts + transcript, not raw artifacts.
- CHECK only judges agent-runner tools (`cfg.agentTools`); bash/read etc. are never judged there.

See `docs/IDEA.md` (design) and `docs/ROLLBACK.md` (full change history & revert procedure).
