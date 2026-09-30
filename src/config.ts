/**
 * jev-orchestrator — configuration (phase 1: inert by default).
 *
 * Purely additive: this file lives next to the extension; enabling it never
 * touches any existing Pi file. Config source (later wins):
 *   1. defaults below (enabled: false — extension does NOTHING)
 *   2. <agentDir>/jev-orchestrator.json  (additive config file, optional)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface JevOrchConfig {
  enabled: boolean;
  mode: "shadow" | "enforce";
  /** Agent-runner tools whose results the CHECK stage judges. Never bash/read/write/edit. */
  agentTools: string[];
  /** What the orchestrator may do inside a child subagent process (PI_SUBAGENT_CHILD=1). */
  childMode: "check-only" | "off";
  /** Skip ROUTE for prompts shorter than this. */
  minTaskChars: number;
  /** Max chars of state sent to Jev per request. */
  stateChars: number;
  /** Reuse an identical verdict for this many seconds. */
  cacheSec: number;
  /** Minimum ms between Jev requests. */
  cooldownMs: number;
  /** Session request budget (hard stop → escalate, never queue more). */
  maxRequests: number;
  timeoutMs: number;
  thresholds: {
    needs_decomp: number;
    split_ok: number;
    strategy_conf: number;
    accept: number;
    reroute_conf: number;
    deeper: number;
    done_ok: number;
  };
  limits: {
    maxDepth: number;
    maxRetriesPerBranch: number;
    maxFailLoops: number;
    /** IDEA: hard cap on parallel branches per episode. */
    parallelMax: number;
  };
}

export const DEFAULTS: JevOrchConfig = {
  enabled: false,
  mode: "shadow",
  agentTools: ["subagent", "agent", "chief", "peer", "TaskExecute"],
  childMode: "check-only",
  minTaskChars: 150,
  stateChars: 6000,
  cacheSec: 60,
  cooldownMs: 30000,
  maxRequests: 40,
  timeoutMs: 15000,
  thresholds: {
    needs_decomp: 0.7,
    split_ok: 0.7,
    strategy_conf: 0.6,
    accept: 0.8,
    reroute_conf: 0.7,
    deeper: 0.7,
    done_ok: 0.85,
  },
  limits: { maxDepth: 3, maxRetriesPerBranch: 2, maxFailLoops: 2, parallelMax: 4 },
};

/**
 * Locate the Pi agent dir (~/.pi/agent) from this file — portable across layouts:
 * walk up until the level that contains `extensions/jev-orchestrator` (the project),
 * e.g. agent/ · agent/extensions/ · agent/extensions/jev-orchestrator/ · …/src/.
 * Falls back to two levels up (legacy assumption) when no marker is found.
 */
export function agentDirOf(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "extensions", "jev-orchestrator"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(here, "..", "..");
}

export function configPath(): string {
  return join(agentDirOf(), "jev-orchestrator.json");
}

export function loadConfig(): { cfg: JevOrchConfig; source: "defaults" | "file"; error?: string } {
  let file: Record<string, unknown> | undefined;
  let error: string | undefined;
  const p = configPath();
  if (existsSync(p)) {
    try {
      file = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch (e) {
      error = `config file invalid, using defaults: ${e instanceof Error ? e.message : String(e)}`;
      file = undefined;
    }
  }
  const merged = { ...DEFAULTS, ...(file ?? {}) } as JevOrchConfig;
  // Sanitize: only known values, never crash on malformed files.
  if (merged.mode !== "enforce") merged.mode = "shadow";
  if (merged.childMode !== "off") merged.childMode = "check-only";
  if (!Array.isArray(merged.agentTools) || merged.agentTools.length === 0) merged.agentTools = [...DEFAULTS.agentTools];
  merged.agentTools = merged.agentTools.filter((t) => typeof t === "string");
  merged.enabled = merged.enabled === true; // anything else = off
  return { cfg: merged, source: file ? "file" : "defaults", error };
}

/** Persist a single key (used by /jev-orch on|off|shadow|enforce). Additive file only. */
export function persistConfig(patch: Record<string, unknown>): string {
  const p = configPath();
  let current: Record<string, unknown> = {};
  if (existsSync(p)) {
    try { current = JSON.parse(readFileSync(p, "utf8")); } catch { current = {}; }
  }
  const next = { ...current, ...patch };
  writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  return p;
}
