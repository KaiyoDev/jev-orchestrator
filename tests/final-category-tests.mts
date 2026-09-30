const checkerMod: any = await import(new URL("../src/checker.ts", import.meta.url).href);
const routerMod: any = await import(new URL("../src/router.ts", import.meta.url).href);
const { decideFinal, finalQuestions } = checkerMod;
const { decideRoute } = routerMod;

const cfg = {
  thresholds: { needs_decomp: 0.7, split_ok: 0.7, strategy_conf: 0.6, accept: 0.8, reroute_conf: 0.7, deeper: 0.7, done_ok: 0.85 },
  limits: { maxDepth: 3, maxRetriesPerBranch: 2, maxFailLoops: 2 },
};
let pass = 0, fail = 0;
const t = (name: string, cond: boolean, detail = "") => { if (cond) { pass++; console.log("PASS " + name); } else { fail++; console.log("FAIL " + name + " " + detail); } };

// A) implementation + required change missing (Jev: low done_ok, gap=review) => FAIL, advice = review diff
t("A.impl-no-diff-fail", (() => { const d = decideFinal({ done_ok: { noul: 0.5 }, verify_gap: { choice: "review" } }, cfg, "implementation"); return !d.pass && d.gap === "review" && (d.directive ?? "").includes("review the final diff"); })(), JSON.stringify(decideFinal({ done_ok: { noul: 0.5 }, verify_gap: { choice: "review" } }, cfg, "implementation")));
// B) implementation + valid evidence => PASS
t("B.impl-evidence-pass", (() => { const d = decideFinal({ done_ok: { noul: 0.9 }, verify_gap: { choice: "none" } }, cfg, "implementation"); return d.pass === true && d.directive === undefined; })());
// C) analysis + no diff + complete findings/evidence => PASS (the old loop's starting state must now PASS)
t("C.analysis-nodiff-pass", (() => { const d = decideFinal({ done_ok: { noul: 0.9 }, verify_gap: { choice: "none" } }, cfg, "analysis"); return d.pass === true; })());
// D) analysis + missing requested section => FAIL, advice about sections (never about diff)
t("D.analysis-missing-section", (() => { const d = decideFinal({ done_ok: { noul: 0.55 }, verify_gap: { choice: "missing_section" } }, cfg, "analysis"); return !d.pass && d.gap === "missing_section" && (d.directive ?? "").includes("missing requested part") && !(d.directive ?? "").includes("diff"); })());
// E) docs/research + no code changes + output complete => PASS
t("E.docs-nocode-pass", (() => { const d = decideFinal({ done_ok: { noul: 0.88 }, verify_gap: { choice: "none" } }, cfg, "research_docs"); return d.pass === true; })());
// F) REGRESSION: the 3-part read-only task (safety / code quality / IDEA-vs-code) must NOT loop on gap=review:
//    structurally, the analysis/research gap options no longer offer 'review'
t("F.regression-no-review-loop", (() => {
  const ana = finalQuestions("analysis"), doc = finalQuestions("research_docs");
  const anaKeys = Object.keys((ana.verify_gap as { criteria: Record<string, string> }).criteria);
  const docKeys = Object.keys((doc.verify_gap as { criteria: Record<string, string> }).criteria);
  const d = decideFinal({ done_ok: { noul: 0.9 }, verify_gap: { choice: "none" } }, cfg, "analysis");
  return anaKeys.includes("none") && !anaKeys.includes("review") && !docKeys.includes("review") && d.pass === true;
})(), JSON.stringify(finalQuestions("analysis").verify_gap));
// G) legacy 2-arg call keeps implementation behavior (back-compat)
t("G.legacy-2arg-implementation", (() => { const d = decideFinal({ done_ok: { noul: 0.5 }, verify_gap: { choice: "review" } }, cfg); return !d.pass && (d.directive ?? "").includes("review the final diff"); })());
// H) malformed answers + analysis => no crash, sensible default
t("H.malformed-analysis", (() => { const d = decideFinal({}, cfg, "analysis"); return d.pass === false && d.gap === "none" && typeof d.directive === "string"; })());
// I-L) ROUTE now types the category (Jev answer -> validated in code)
t("I.route-analysis", (() => { const d = decideRoute({ task_cat: { choice: "analysis" } }, cfg); return d.category === "analysis"; })(), JSON.stringify(decideRoute({ task_cat: { choice: "analysis" } }, cfg).category));
t("J.route-malformed-default", (() => { const d = decideRoute({}, cfg); return d.category === "implementation"; })());
t("K.route-research-docs", (() => { const d = decideRoute({ task_cat: { choice: "research_docs" } }, cfg); return d.category === "research_docs"; })());
t("L.route-bogus-validated", (() => { const d = decideRoute({ task_cat: { choice: "bogus" } }, cfg); return d.category === "implementation"; })());

console.log("CAT SUMMARY pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
