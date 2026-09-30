const checkerMod: any = await import(new URL("../src/checker.ts", import.meta.url).href);
const { buildFinalEvidence } = checkerMod;
let pass = 0, fail = 0;
const t = (name: string, cond: boolean, detail = "") => { if (cond) { pass++; console.log("PASS " + name); } else { fail++; console.log("FAIL " + name + " " + detail); } };
const longReport = "BÁO CÁO SECURITY\n" + "finding evidence line " + Array.from({ length: 200 }, (_, i) => "item" + i).join(", ");
const msgs = [
  { role: "user", content: "Phân tích 3 phần: security, code quality, IDEA-vs-code (read-only)" },
  { role: "assistant", content: "short ack" },
  { role: "toolResult", content: "<multi-line string, see section: ls>" },
  { role: "assistant", content: longReport },
  { role: "user", content: "ORCHESTRATOR FINAL: FAIL correction" },
  { role: "assistant", content: "correction turn text " + "x".repeat(500) },
];
const out = buildFinalEvidence(msgs, 6000);
t("ev.includes-task", out.includes("Phân tích 3 phần"), out.slice(0, 120));
t("ev.includes-report", out.includes("BÁO CÁO SECURITY"));
t("ev.includes-recent-tail", out.includes("correction turn text"));
t("ev.bounded", out.length <= 16000 && out.length > 0, String(out.length));
t("ev.empty-input", buildFinalEvidence([], 6000) === "");
const huge = "TỔNG KẾT " + "z".repeat(15000);
t("ev.big-report-near-full", (() => { const o = buildFinalEvidence([{ role: "assistant", content: huge }], 6000); return o.length > 9000 && o.length <= 16000; })(), String(buildFinalEvidence([{ role: "assistant", content: huge }], 6000).length));
t("ev.small-cfg-still-served", buildFinalEvidence(msgs, 6000).length >= buildFinalEvidence(msgs, 200000).length * 0.99);
console.log("EVIDENCE SUMMARY pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
