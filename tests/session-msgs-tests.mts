const mod: any = await import(new URL("../src/checker.ts", import.meta.url).href);
if (!mod) { console.log("FAIL checker module not importable"); process.exit(1); }
const { sessionEntriesToMessages } = mod;
let pass = 0, fail = 0;
const t = (name: string, cond: boolean, d = "") => { if (cond) { pass++; console.log("PASS " + name); } else { fail++; console.log("FAIL " + name + " " + d); } };
const sm = { getEntries: () => [
  { type: "message", message: { role: "user", content: "task text" } },
  { type: "compaction", tokensBefore: 1 },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "report" }] } },
  { type: "message", message: { role: "toolResult" } },
  { type: "usage" },
] };
const out = sessionEntriesToMessages(sm);
t("sm.message-only", out.length === 3, JSON.stringify(out.map((o: { role: string }) => o.role)));
t("sm.roles", out.map((o: { role: string }) => o.role).join(",") === "user,assistant,toolResult");
t("sm.content-passthrough", Array.isArray(out[1]?.content));
t("sm.undefined-sm", sessionEntriesToMessages(undefined).length === 0);
t("sm.no-getentries", sessionEntriesToMessages({}).length === 0);
console.log("SM-TESTS pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
