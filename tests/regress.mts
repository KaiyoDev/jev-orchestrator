const checker: any = await import(new URL("../src/checker.ts", import.meta.url).href);
const router: any = await import(new URL("../src/router.ts", import.meta.url).href);
const { decideCheck, decideFinal } = checker;
const { decideRoute } = router;
const cfg: any = {
  enabled: true, mode: "enforce", minTaskChars: 150, cooldownMs: 30000, maxRequests: 40, timeoutMs: 15000,
  thresholds: { needs_decomp: 0.7, split_ok: 0.7, strategy_conf: 0.6, accept: 0.8, reroute_conf: 0.7, deeper: 0.7, done_ok: 0.85 },
  limits: { maxDepth: 3, maxRetriesPerBranch: 2, maxFailLoops: 2, parallelMax: 4 },
};
let pass = 0, fail = 0;
const t = (n: string, c: boolean, d = "") => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + " :: " + d); } };
// ── ROUTE (strategy gate + category + depth clamp) ──
const R = (strategy: string, conf: number, nd: number, so: number, cat?: any, depth = 1) =>
  decideRoute({ strategy: { choice: strategy, confidence: conf }, needs_decomp: { noul: nd }, split_ok: { noul: so }, ...(cat ? { task_cat: cat } : {}), depth: { score: depth } }, cfg);
t("route.gate-override: weak noul + conf>=0.6 parallel", (() => { const d = R("parallel", 0.9, 0.2, 0.3); return d.shape === "parallel"; })(), JSON.stringify(R("parallel", 0.9, 0.2, 0.3).shape));
t("route.no-signal: weak noul + conf<0.6 -> direct", R("parallel", 0.3, 0.2, 0.3).shape === "direct");
t("route.strong-noul: parallel via split_ok", R("parallel", 0.9, 0.9, 0.9).shape === "parallel");
t("route.tree-needs-conf", R("tree", 0.9, 0.2, 0.3).shape === "tree");
t("route.tree-rejected-weak-conf", (() => { const d = R("tree", 0.5, 0.8, 0.8); return d.shape !== "tree"; })());
t("route.cat-analysis", R("parallel", 0.9, 0.2, 0.3, { choice: "analysis" }).category === "analysis");
t("route.cat-malformed->implementation", R("parallel", 0.9, 0.2, 0.3, { choice: "banana" }).category === "implementation");
t("route.cat-research", R("direct", 0.9, 0.1, 0.1, { choice: "research_docs" }).category === "research_docs");
t("route.depth-clamp-down", R("parallel", 0.9, 0.9, 0.9, undefined, 9).maxDepth === cfg.limits.maxDepth);
t("route.depth-round-up", R("parallel", 0.9, 0.9, 0.9, undefined, 1.4).maxDepth === 1);
// ── CHECK ──
const C = (acc: number, extra: Record<string, any> = {}, ctx: any = { retryLeft: 1, depthLeft: 1 }) =>
  decideCheck({ accept: { noul: acc }, why_fail: { choice: "incomplete" }, ...extra, ...({} as object) }, cfg, ctx);
t("check.pass-0.95", C(0.95).verdict === "PASS");
t("check.fail-low", C(0.4).verdict === "FAIL");
t("check.reroute-conf-high", (() => { const d: any = C(0.4, { reroute: { choice: "retry_same", confidence: 0.9 } }); return d.reroute === "retry_same"; })(), JSON.stringify(C(0.4, { reroute: { choice: "retry_same", confidence: 0.9 } } as any).reroute));
t("check.reroute-conf-low->escalate", (() => { const d: any = C(0.4, { reroute: { choice: "retry_same", confidence: 0.2 } }); return d.reroute === "escalate_user"; })());
t("check.bounded-retry0->escalate", (() => { const d: any = C(0.4, { reroute: { choice: "retry_same", confidence: 0.9 } }, { retryLeft: 0, depthLeft: 1 }); return d.reroute === "escalate_user"; })());
t("check.bounded-retry0-drop", (() => { const d: any = C(0.4, { reroute: { choice: "drop", confidence: 0.9 } }, { retryLeft: 0, depthLeft: 1 }); return d.reroute === "drop"; })());
t("check.deeper-gated", C(0.95, { deeper: { noul: 0.8 } }, { retryLeft: 0, depthLeft: 1 }).deeper === true);
t("check.deeper-depth0", C(0.95, { deeper: { noul: 0.9 } }, { retryLeft: 0, depthLeft: 0 }).deeper === false);
t("check.malformed-failopen-fail", (() => { const d: any = decideCheck({}, cfg, { retryLeft: 1, depthLeft: 1 }); return d.verdict === "FAIL" && d.reroute === "escalate_user"; })());
// ── FINAL ──
const F = (done: number, cat: string, gap = "missing_section") =>
  decideFinal({ done_ok: { noul: done }, verify_gap: { choice: gap }, scope: { noul: 0.2 } }, cfg, cat as any);
t("final.pass-0.9", F(0.9, "implementation").pass === true);
t("final.fail-low-analysis", (() => { const d: any = F(0.5, "analysis"); return d.pass === false && /Do not modify files/.test(d.directive); })());
t("final.implementation-review-advice", (() => { const d: any = decideFinal({ done_ok: { noul: 0.4 }, verify_gap: { choice: "review" }, scope: { noul: 0.2 } }, cfg, "implementation" as any); return /diff|review/i.test(d.directive ?? ""); })());
t("final.research-advice-not-diff", (() => { const d: any = F(0.5, "research_docs", "incomplete_evidence"); return !/diff/.test(d.directive ?? ""); })());
t("final.malformed-fail", (() => { const d: any = decideFinal({}, cfg, "analysis" as any); return d.pass === false; })());
t("final.scope-creep", (() => { const d: any = decideFinal({ done_ok: { noul: 0.9 }, verify_gap: { choice: "none" }, scope: { noul: 0.6 } }, cfg, "implementation" as any); return d.scopeCreep === true; })());
// ── retryLeftFor + parallelMax ──
const { retryLeftFor } = checker;
t("retry.undefined", retryLeftFor(undefined, 2) === 2);
t("retry.zero-used", retryLeftFor({ retry: 0 }, 2) === 2);
t("retry.one-used", retryLeftFor({ retry: 1 }, 2) === 1);
t("retry.exhausted", retryLeftFor({ retry: 2 }, 2) === 0);
t("route.parallelMax-parallel", R("parallel", 0.9, 0.9, 0.9).parallelMax === 4, JSON.stringify(R("parallel", 0.9, 0.9, 0.9).parallelMax));
t("route.parallelMax-direct-none", R("parallel", 0.3, 0.2, 0.3).parallelMax === undefined);
console.log("REGRESS SUMMARY pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
