/**
 * jev-orchestrator — ROUTE stage (Phase 3).
 *
 * ONE typed Jev request per new task. Jev returns numbers; the CODE below turns
 * them into a decision. The extension never writes task prose and never spawns
 * anything: in enforce mode it emits a directive message that the MODEL acts on
 * with the existing agent/subagent tools (pi-subagents / pi-herdsman / pi-fabric / pi-tasks).
 */
import type { JevOrchConfig } from "./config.js";
import type { TaskCategory } from "./state.js";

export const ROUTE_QUESTIONS: Record<string, unknown> = {
  needs_decomp: {
    type: "noul",
    instructions:
      "Can this task NOT be completed by one agent working in a single pass? Answer yes only if it genuinely needs independent parallel work streams or several distinct specialized skills.",
  },
  split_ok: {
    type: "noul",
    instructions:
      "Would splitting this task into independent subtasks (for example: research / implementation / testing) speed it up WITHOUT contract risk between the subtasks? Answer no when the work is tightly coupled or when the task is small.",
  },
  strategy: {
    type: "choice",
    instructions: "Which execution shape fits this task best?",
    criteria: {
      single: "One agent handles the whole task end to end",
      parallel: "Independent subtasks are delegated to subagents at once and their results are merged",
      tree: "The task decomposes into subtasks that may themselves need further decomposition",
      deep_sequential: "A long dependency chain of small sequential steps, no parallelism",
    },
  },
  model_fit: {
    type: "choice",
    instructions: "Which model tier best fits the dominant kind of work in this task?",
    criteria: {
      fast: "Short lookups, mechanical edits, simple commands",
      balanced: "Ordinary coding and research work",
      strong: "Hard architecture, deep debugging, long-horizon multi-file work",
    },
  },
  depth: {
    type: "score",
    instructions: "Maximum useful decomposition depth for this task.",
    criteria: [
      "0: no decomposition, single pass",
      "1: one layer of subagents under the main agent",
      "2: subagents that may spawn one more layer",
      "3: three layers (rarely useful)",
      "4: four layers (almost never useful)",
    ],
  },
  task_cat: {
    type: "choice",
    instructions: "Which completion contract fits this task? Pick the category matching what the user actually asked for — do not default to implementation.",
    criteria: {
      implementation: "Success requires changing/creating files or working code; the change itself (diff/build/tests as the task demands) is the deliverable",
      analysis: "Read-only audit/analysis: the deliverable is findings with evidence plus a conclusion; no file changes are required or expected",
      research_docs: "The deliverable is produced documentation or research: complete output with source coverage; no code changes required",
    },
  },};

export interface RouteDecision {
  shape: "direct" | "single" | "parallel" | "tree" | "deep_sequential";
  maxDepth: number;
  modelFit: string;
  strategyConfidence: number;
  p: { needs_decomp: number; split_ok: number };
  category: TaskCategory;
  note: string;
  /** Fan-out cap for parallel/tree shapes (undefined for direct/single). */
  parallelMax?: number;
}

/** Numbers → decision. Branching lives here (in code), never in Jev prose. */
export function decideRoute(answers: Record<string, unknown>, cfg: JevOrchConfig): RouteDecision {
  const p = {
    needs_decomp: typeof answers.needs_decomp === "object" && answers.needs_decomp !== null ? Number((answers.needs_decomp as { noul?: number }).noul ?? 0) : 0,
    split_ok: typeof answers.split_ok === "object" && answers.split_ok !== null ? Number((answers.split_ok as { noul?: number }).noul ?? 0) : 0,
  };
  const strategy = typeof (answers.strategy as { choice?: string } | undefined)?.choice === "string"
    ? ((answers.strategy as { choice: string }).choice)
    : "single";
  const confidence = Number((answers.strategy as { confidence?: number } | undefined)?.confidence ?? 0);
  const modelFit = typeof (answers.model_fit as { choice?: string } | undefined)?.choice === "string"
    ? ((answers.model_fit as { choice: string }).choice)
    : "balanced";
  // completion contract for the FINAL stage: typed by Jev, validated here (malformed → implementation, i.e. current behavior)
  const catRaw = (answers.task_cat as { choice?: string } | undefined)?.choice;
  const category: TaskCategory = catRaw === "analysis" || catRaw === "research_docs" ? catRaw : "implementation";
  const depthScore = Number((answers.depth as { score?: number } | undefined)?.score ?? 0);
  const maxDepthRaw = Math.max(0, Math.min(cfg.limits.maxDepth, Math.round(depthScore)));

  // IDEA §3.1: a confident strategy answer (conf >= strategy_conf) may override a weak
  // noul signal; with NO signal at all, stay direct.
  const strategyConfident = confidence >= cfg.thresholds.strategy_conf;
  const wantsDecomp = strategy === "parallel" || strategy === "tree" || strategy === "deep_sequential";
  let shape: RouteDecision["shape"];
  if (p.needs_decomp < cfg.thresholds.needs_decomp && p.split_ok < cfg.thresholds.split_ok) {
    if (wantsDecomp && strategyConfident) {
      if (strategy === "parallel") shape = "parallel";
      else if (strategy === "tree") shape = "tree";
      else shape = "deep_sequential";
    } else {
      shape = "direct";
    }
  } else if (strategy === "parallel" && (p.split_ok >= cfg.thresholds.split_ok || strategyConfident)) {
    shape = "parallel";
  } else if (strategy === "tree" && strategyConfident) {
    shape = "tree";
  } else if (strategy === "deep_sequential" && strategyConfident) {
    shape = "deep_sequential";
  } else {
    shape = "single"; // decomposition signal but strategy untrusted → one agent, no decomposition
  }

  const maxDepth = shape === "direct" || shape === "single" ? 0 : maxDepthRaw;
  const note = `shape=${shape} depth=${maxDepth} fit=${modelFit} cat=${category} (pDecomp=${p.needs_decomp.toFixed(2)}, pSplit=${p.split_ok.toFixed(2)}, stratConf=${confidence.toFixed(2)})`;
  const parallelMax = shape === "direct" || shape === "single" ? undefined : (cfg.limits.parallelMax ?? 4); // 4 = IDEA default, guarded against old config files
  return { shape, maxDepth, modelFit, strategyConfidence: confidence, p, category, note, parallelMax };
}

/** Directive text appended to the model context in ENFORCE mode only. */
export function routeDirective(d: RouteDecision): string {
  const lines: string[] = [];
  lines.push(`ORCHESTRATOR ROUTE: recommended shape=${d.shape} (max decomposition depth ${d.maxDepth}); suggested model tier: ${d.modelFit}.`);
  if (d.category === "analysis") {
    lines.push("Completion contract (analysis): answer every requested part with cited evidence; changing files is NOT required and an empty diff is a valid outcome.");
  } else if (d.category === "research_docs") {
    lines.push("Completion contract (docs/research): deliver the requested output with adequate source coverage; code changes are NOT required.");
  } else {
    lines.push("Completion contract (implementation): the change itself is the deliverable — include the evidence the task asks for (diff/build/tests).");
  }
  if (d.shape === "parallel" || d.shape === "tree" || d.shape === "deep_sequential") {
    lines.push(
      `If agent/subagent tools are available, execute in that shape: write each child task with its own objective, scope, inputs, and acceptance criteria. You are the executor; delegate with the existing tools. Depth budget: ${d.maxDepth}.${d.parallelMax ? ` At most ${d.parallelMax} parallel branches (parallelMax).` : ""}`,
    );
  } else {
    lines.push("Work it yourself in one pass; do not spawn subagents.");
  }
  lines.push("This directive is a recommendation: follow it unless it conflicts with the user's instructions.");
  return lines.join(" ");
}
