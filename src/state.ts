/**
 * jev-orchestrator — per-episode orchestration state.
 *
 * Persisted as session CUSTOM entries (customType "jev_orch") via pi.appendEntry.
 * Custom entries never participate in LLM context (SessionManager semantics), so
 * persisting state here is side-effect-free for the model. Resume after /reload
 * or session resume reads the newest entry back in.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CUSTOM_TYPE = "jev_orch";

export interface OrchBranch {
  id: string;
  tool: string;
  task: string;
  retry: number;
  verdict?: "PASS" | "FAIL";
  reroute?: string;
  at?: number;
}

export type TaskCategory = "implementation" | "analysis" | "research_docs";

export interface OrchState {
  task: string;
  shape?: "direct" | "single" | "parallel" | "tree" | "deep_sequential";
  maxDepth?: number;
  modelFit?: string;
  category?: TaskCategory;
  /** Terminal flag: FINAL escalated (limit/budget spent) — episode closed; later settles skip FINAL. */
  finalClosed?: boolean;
  depthUsed: number;
  branches: OrchBranch[];
  failLoops: number;
  budgetUsed: number;
  updatedAt: number;
  lastNote?: string;
}

export function newOrchState(task: string): OrchState {
  return { task: task.slice(0, 300), depthUsed: 0, branches: [], failLoops: 0, budgetUsed: 0, updatedAt: Date.now() };
}

/** Newest persisted jev_orch state (resume after reload/resume). Fail-open. */
export function loadOrchState(ctx: ExtensionContext): OrchState | undefined {
  try {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as { type?: string; customType?: string; data?: unknown };
      if (e?.type === "custom" && e?.customType === CUSTOM_TYPE && e.data && typeof e.data === "object") {
        const d = e.data as Partial<OrchState>;
        if (typeof d.task === "string" && Array.isArray(d.branches)) {
          return d as OrchState;
        }
        return undefined;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Append state to the session (never throws). */
export function saveOrchState(pi: ExtensionAPI, state: OrchState): void {
  try {
    state.updatedAt = Date.now();
    pi.appendEntry(CUSTOM_TYPE, state);
  } catch {
    /* inert by contract */
  }
}
