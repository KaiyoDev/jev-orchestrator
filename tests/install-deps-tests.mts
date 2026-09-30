import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const mod: any = jiti("../src/jev.ts");
const { TYPESAFE_INSTALL_CMD, isMissingDependency } = mod;
let pass = 0, fail = 0;
const t = (n: string, c: boolean, d = "") => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + " :: " + d); } };
const fakeJev = (over: Record<string, unknown> = {}) =>
  ({ available: () => false, reason: () => "unavailable", keyLabel: "unknown", budgetUsed: 0, maxRequests: 40, ask: async () => ({ ok: false, reason: "unavailable" }), ...over });
t("cmd.exact", TYPESAFE_INSTALL_CMD === "pi install npm:pi-typesafe", String(TYPESAFE_INSTALL_CMD));
t("miss.missing", isMissingDependency(fakeJev()) === true);
t("miss.auth-fail-is-not-missing", isMissingDependency(fakeJev({ reason: () => "no_key", keyLabel: "openrouter" })) === false);
t("miss.available", isMissingDependency(fakeJev({ available: () => true, keyLabel: "openrouter" })) === false);
t("miss.undefined", isMissingDependency(undefined) === false);
console.log("INSTALL-DEPS SUMMARY pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
