/**
 * jev-orchestrator — Jev (TypeSafe) client wrapper.
 *
 * REUSES the existing pi-typesafe implementation (same library pi-warden uses):
 * auth (authState gate), typed requests (SystemOneRequest), ask() (never throws),
 * client-level budgeting (maxRequests / daily caps). This wrapper adds ONLY the
 * orchestration-side concerns: session budget, cooldown, verdict cache, fail-open
 * result typing. No new HTTP client, no duplicated auth.
 *
 * Resolution: pi-typesafe is a dependency of pi-warden under <agentDir>/npm/node_modules,
 * which is NOT on the plain node_modules lookup path from this extension directory,
 * so we resolve it explicitly (plain import first, in case it ever becomes top-level).
 */
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentDirOf } from "./config.js";
import type { JevOrchConfig } from "./config.js";

interface TypesafeModule {
  createTypeSafe: (options?: unknown) => unknown;
  ask: (judge: unknown, request: unknown, options?: unknown) => Promise<AskResult>;
  authState: (options?: unknown) => { usable: boolean; keyName: string; kind: string };
  recordAuthVerified?: (at?: Date) => void;
  recordAuthFailure?: (error: unknown, at?: Date) => void;
}

interface AskResult {
  ok: boolean;
  answers?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
  elapsedMs?: number;
  model?: string;
}

export type JevFailReason = "unavailable" | "no_key" | "budget" | "cooldown" | "skipped" | "timeout" | "auth" | "error";

export type JevAnswer =
  | { ok: true; answers: Record<string, unknown>; elapsedMs: number; cached: boolean }
  | { ok: false; reason: JevFailReason; message?: string };

export interface JevAsk {
  ask: (state: string, questions: Record<string, unknown>, signal?: AbortSignal) => Promise<JevAnswer>;
  available: () => boolean;
  reason: () => string;
  budgetUsed: number;
  keyLabel: string;
  /** Session request budget in effect (mutable via setMaxRequests). */
  maxRequests: number;
  setMaxRequests: (n: number) => void;
}

let modCache: TypesafeModule | null | undefined;
let loadError: unknown;

async function loadTypesafe(): Promise<TypesafeModule | null> {
  if (modCache !== undefined) return modCache;
  modCache = null;
  loadError = undefined;
  // 1) Plain specifier — works when pi-typesafe is on the normal node_modules path.
  let lastError: unknown;
  try {
    modCache = (await import("pi-typesafe")) as TypesafeModule;
    if (modCache && typeof (modCache as TypesafeModule).createTypeSafe === "function") return modCache;
    lastError = "bare import returned an incomplete module";
  } catch (err) {
    lastError = err;
  }
  // 2) CJS bridge — Pi's jiti loader can intercept transformed dynamic imports, so
  //    reach pi-typesafe through a native .cjs file (require(ESM), Node >= 22).
  try {
    const bridge = join(dirname(fileURLToPath(import.meta.url)), "typesafe-bridge.cjs");
    if (existsSync(bridge)) {
      const ns = (await import(pathToFileURL(bridge).href)) as { default?: unknown } & Record<string, unknown>;
      const loader = (typeof ns.default === "function" ? ns.default : ns) as
        | ((agentDir: string) => TypesafeModule)
        | undefined;
      if (loader) modCache = loader(agentDirOf());
    }
  } catch (err) {
    lastError = err;
  }
  if (!modCache) {
    lastError = lastError || "bridge unavailable";
    loadError = lastError;
  }
  return modCache;
}

export async function makeJev(cfg: JevOrchConfig): Promise<JevAsk> {
  const mod = await loadTypesafe();
  const rt = {
    ok: false,
    reason: "unavailable" as JevFailReason,
    message: "pi-typesafe module not resolvable",
    budgetUsed: 0,
    lastAt: 0,
    keyLabel: "unknown",
  };
  // session-scoped request budget (mutable at runtime; the client-level cap stays as created)
  let budgetLimit = cfg.maxRequests;
  const cache = new Map<string, { answers: Record<string, unknown>; at: number; elapsedMs: number }>();
  let judge: unknown;

  async function ensureJudge(): Promise<boolean> {
    if (!mod) return false;
    const auth = mod.authState({});
    rt.keyLabel = auth.keyName;
    if (!auth.usable) {
      rt.ok = false; rt.reason = "no_key"; rt.message = `no usable key (${auth.kind})`;
      return false;
    }
    if (!judge) {
      try {
        judge = mod.createTypeSafe({ timeoutMs: cfg.timeoutMs, maxRequests: cfg.maxRequests });
      } catch (e) {
        rt.ok = false; rt.reason = "error"; rt.message = e instanceof Error ? e.message : String(e);
        return false;
      }
    }
    rt.ok = true; rt.reason = "unavailable"; rt.message = "";
    return true;
  }

  function classifyError(errorCode: string | undefined, message: string): JevFailReason {
    if (errorCode === "budget") return "budget";
    if (errorCode === "timeout") return "timeout";
    if (errorCode === "aborted") return "skipped";
    if (errorCode === "http" && /40[13]|429/.test(message)) return "auth";
    if (/timeout|timed out/i.test(message)) return "timeout";
    if (/auth|key|credential|401|403/i.test(message)) return "auth";
    return "error";
  }

  await ensureJudge(); // run the auth gate eagerly so available() is accurate before the first ask()
  return {
    async ask(state, questions, signal): Promise<JevAnswer> {
      const m = mod; // narrowed once: ensureJudge() can only be true when the module resolved
      if (!m || !(await ensureJudge())) return { ok: false, reason: rt.reason, message: rt.message };
      // Session budget — bounded, hard stop.
      if (rt.budgetUsed >= budgetLimit) {
        rt.reason = "budget"; rt.message = `session budget ${budgetLimit} exhausted`;
        return { ok: false, reason: "budget" };
      }
      // Cooldown between requests.
      const now = Date.now();
      if (rt.lastAt && now - rt.lastAt < cfg.cooldownMs && cfg.cooldownMs > 0) {
        return { ok: false, reason: "cooldown" };
      }
      // Verdict cache (identical state+questions within cacheSec). Full state (bounded below),
      // not a prefix: a prefix key replays stale verdicts when only the evidence tail changes.
      const key = createHash("sha1").update(state.slice(0, 20000)).update("|" + JSON.stringify(questions)).digest("hex");
      const hit = cache.get(key);
      if (hit && now - hit.at < cfg.cacheSec * 1000) {
        return { ok: true, answers: hit.answers, elapsedMs: 0, cached: true }; // cache hit costs no Jev request
      }
      if (signal?.aborted) return { ok: false, reason: "skipped" };
      // Full evidence to the judge: FINAL evidence blocks are bounded (~16KB) — a stateChars
      // slice here was silently truncating the report before Jev ever saw it.
      const req = { state: state.slice(0, 20000), questions };
      let res: AskResult;
      try {
        res = await m.ask(judge, req, { timeoutMs: cfg.timeoutMs, signal });
      } catch {
        // ask() is documented never-throw; belt and suspenders → fail open.
        rt.lastAt = Date.now();
        return { ok: false, reason: "error", message: "ask() threw" };
      }
      rt.lastAt = Date.now();
      if (res.ok && res.answers) {
        rt.budgetUsed++;
        if (cache.size > 64) {
          for (const [k, v] of Array.from(cache)) if (now - v.at > cfg.cacheSec * 1000) cache.delete(k);
        }
        cache.set(key, { answers: res.answers, at: Date.now(), elapsedMs: res.elapsedMs ?? 0 });
        try { m.recordAuthVerified?.(); } catch { /* bookkeeping only */ }
        return { ok: true, answers: res.answers, elapsedMs: res.elapsedMs ?? 0, cached: false };
      }
      rt.budgetUsed++;
      const reason = classifyError(res.errorCode, res.error ?? "");
      rt.reason = reason;
      rt.message = res.error ?? "";
      try { if (m.recordAuthFailure && (reason === "auth" || reason === "budget")) m.recordAuthFailure(new Error(res.error ?? "")); } catch { /* bookkeeping only */ }
      return { ok: false, reason, message: res.error };
    },
    available() { return rt.ok; },
    reason() {
      if (rt.reason === "unavailable") {
        return "pi-typesafe unresolvable: " + (loadError instanceof Error ? loadError.message : String(loadError ?? "unknown"));
      }
      return rt.message || rt.reason;
    },
    get budgetUsed() { return rt.budgetUsed; },
    get keyLabel() { return rt.keyLabel; },
    get maxRequests() { return budgetLimit; },
    setMaxRequests(n: number) {
      if (Number.isFinite(n) && n >= 1) budgetLimit = Math.floor(n);
    },
  };
}
