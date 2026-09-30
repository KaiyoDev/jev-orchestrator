/**
 * typesafe-bridge.cjs — native-loader bridge to the ESM-only pi-typesafe package.
 *
 * Why: Pi loads TS extensions through jiti, which can intercept transformed
 * dynamic imports. "pi-typesafe" is not on the plain node_modules lookup path
 * from this extension directory (Pi keeps its packages in <agentDir>/npm/node_modules),
 * and the package is ESM-only, so we reach it through Node's native CJS require()
 * of ESM (Node >= 22; this environment runs Node 24). jiti loads .cjs natively,
 * so this file is never transformed.
 */
const path = require("node:path");
const { existsSync } = require("node:fs");

module.exports = function loadPiTypesafe(agentDir) {
  const candidates = [];
  if (agentDir) {
    // Pi's package layout: <agentDir>/npm/node_modules (pi-typesafe is a dep of pi-warden there)
    candidates.push(path.join(agentDir, "npm", "node_modules", "pi-typesafe", "dist", "index.js"));
  }
  let lastError;
  for (const entry of candidates) {
    if (!existsSync(entry)) continue;
    try {
      return require(entry);
    } catch (error) {
      lastError = error;
    }
  }
  try {
    // Last resort: bare specifier (in case pi-typesafe ever becomes a top-level package)
    return require("pi-typesafe");
  } catch (error) {
    lastError = error;
  }
  throw lastError || new Error("pi-typesafe not found");
};
