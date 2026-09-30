/**
 * jev-orchestrator — Jev as a dynamic task-orchestration DECISION layer.
 *
 * Roles (by design, see jev-orchestrator-IDEA.md):
 *   Pi/model  = execution authority (writes child tasks, spawns runners, works)
 *   Jev       = typed decisions only (route / check / final)
 *   Warden    = safety guardrail layer (untouched, separate hooks/territory)
 *   User      = final escalation point
 *
 * Safety contracts:
 *   - disabled (default): every hook no-ops; zero Jev requests, zero side effects
 *   - fail-open: any Jev failure → normal Pi behavior, never blocked
 *   - shadow (default when enabled): decisions are logged only; nothing is applied
 *   - enforce: decisions are applied via existing extension surfaces only
 *     (directive message / verdict line / bounded final turn) — this extension
 *     never executes commands, never spawns agents, never modifies provider requests
 *   - child subagents (PI_SUBAGENT_CHILD=1): CHECK only, never ROUTE/FINAL
 *
 * Kill switch: /jev-orch off (in-memory + persisted) — Pi returns to previous behavior.
 */
import {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, persistConfig, JevOrchConfig } from "../src/config.js";
import { CUSTOM_TYPE, loadOrchState, newOrchState, saveOrchState, OrchState } from "../src/state.js";
import { makeJev, JevAsk, TYPESAFE_INSTALL_CMD, isMissingDependency } from "../src/jev.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
import { ROUTE_QUESTIONS, decideRoute, routeDirective } from "../src/router.js";
import { CHECK_QUESTIONS, finalQuestions, decideCheck, decideFinal, buildFinalEvidence, sessionEntriesToMessages, retryLeftFor } from "../src/checker.js";

const IS_CHILD = process.env["PI_SUBAGENT_CHILD"] === "1";

interface Runtime {
  on: boolean;
  mode: "shadow" | "enforce";
  jev: JevAsk | null;
  state: OrchState | undefined;
  lastTrace: string;
  debug: boolean;
}

export default function registerJevOrchestrator(pi: ExtensionAPI): void {
  const { cfg, source, error: cfgErr } = loadConfig();
  const rt: Runtime = { on: cfg.enabled, mode: cfg.mode, jev: null, state: undefined, lastTrace: "", debug: true };

  const capabilities = {
    route: () => rt.on && !!rt.jev?.available() && !IS_CHILD,
    check: () =>
      rt.on && !!rt.jev?.available() && (!IS_CHILD || (cfg.childMode === "check-only" ? true : false)),
    final: () => rt.on && !!rt.jev?.available() && !IS_CHILD,
    apply: () => rt.mode === "enforce",
  };

  function statusLine(): string {
    const avail = rt.jev ? (rt.jev.available() ? `key=${rt.jev.keyLabel}` : `off(${rt.jev.reason()})`) : "judge=loading";
    const shape = rt.state?.shape ? ` shape=${rt.state.shape}` : "";
    const mode = rt.on ? ` ${rt.mode}` : " disabled";
    return `jev-orch:${mode}${shape} req=${rt.jev?.budgetUsed ?? 0}/${cfg.maxRequests} ${avail}`;
  }

  function setStatus(ctx: ExtensionContext, text?: string): void {
    try {
      ctx.ui.setStatus?.("jev-orch", text);
    } catch {
      /* UI unavailable (headless) — status is optional */
    }
  }

  function trace(ctx: ExtensionContext, msg: string): void {
    rt.lastTrace = msg;
    if (rt.state) {
      rt.state.lastNote = msg; // persisted on the next saveOrchState
    }
    setStatus(ctx, statusLine());
    refreshPanel(ctx);
    if (rt.debug) {
      try {
        ctx.ui.notify?.(msg, "info");
      } catch {
        /* headless */
      }
    }
  }

  function renderPanel(): string[] {
    const s = rt.state;
    const lines: string[] = [];
    lines.push(
      "jev-orch: " + (rt.on ? rt.mode : "disabled") + " · key=" + (rt.jev ? (rt.jev.available() ? rt.jev.keyLabel : "off(" + rt.jev.reason() + ")") : "loading") + " · req=" + (rt.jev?.budgetUsed ?? 0) + "/" + (rt.jev?.maxRequests ?? cfg.maxRequests),
    );
    if (!s) {
      lines.push("episode: none (no task ≥ " + cfg.minTaskChars + " chars yet → ROUTE skipped)");
    } else {
      lines.push('episode: shape=' + (s.shape ?? "-") + " depth=" + s.depthUsed + "/" + (s.maxDepth ?? 0) + " fit=" + (s.modelFit ?? "-") + " failLoops=" + s.failLoops + ' · task="' + s.task.slice(0, 40) + "…");
      for (const b of s.branches.slice(-4)) lines.push("branch " + b.tool + ": " + (b.verdict ?? "…") + (b.reroute ? " → " + b.reroute : ""));
    }
    if (rt.lastTrace) lines.push("last: " + rt.lastTrace);
    return lines.slice(0, 9);
  }

  function refreshPanel(ctx: ExtensionContext): void {
    try {
      if (rt.on && rt.debug) ctx.ui.setWidget?.("jev-orch", renderPanel(), { placement: "belowEditor" });
      else ctx.ui.setWidget?.("jev-orch", undefined, { placement: "belowEditor" });
    } catch {
      /* widget is optional (headless) */
    }
  }

  function textOf(content: unknown): string {
    try {
      if (!Array.isArray(content)) return "";
      return (content as Array<{ type?: string; text?: string }>)
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n");
    } catch {
      return "";
    }
  }

  pi.on("session_start", async (_ev, ctx) => {
    if (!rt.on) return; // fully inert when disabled: no judge, no state read, nothing
    rt.jev = await makeJev(cfg);
    rt.state = loadOrchState(ctx);
    if (!rt.jev.available() && isMissingDependency(rt.jev)) {
      ctx.ui.notify?.(`jev-orch: Jev unavailable — pi-typesafe is missing. Fix: ${TYPESAFE_INSTALL_CMD} (applies to new sessions) or /jev-orch install-deps (this session).`, "warning");
    }
    if (cfgErr) trace(ctx, `config warning: ${cfgErr}`);
    trace(ctx, `session_start (config source=${source}, child=${IS_CHILD})`);
  });

  // ── Phase 3: ROUTE — one typed judgment per new user task ──────────────────
  pi.on("before_agent_start", async (ev: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | undefined> => {
    if (!capabilities.route() || !rt.jev) return undefined;
    const prompt = ev.prompt ?? "";
    if (/^\s*ORCHESTRATOR\b/.test(prompt)) return undefined; // our own directive follow-ups never re-route
    if (prompt.length < cfg.minTaskChars) return undefined; // short task: single pass, no Jev cost
    let state = rt.state;
    if (!state || state.shape === undefined) state = newOrchState(prompt);
    const result = await rt.jev.ask(
      `User task (ROUTE): ${prompt.slice(0, cfg.stateChars)}`,
      ROUTE_QUESTIONS,
      ctx.signal,
    );
    if (!result.ok) {
      trace(ctx, `route skipped (${result.reason})`); // fail-open
      return undefined;
    }
    state.budgetUsed = rt.jev.budgetUsed;
    const dec = decideRoute(result.answers, cfg);
    state.shape = dec.shape;
    state.maxDepth = dec.maxDepth;
    state.modelFit = dec.modelFit;
    state.category = dec.category;
    saveOrchState(pi, state);
    rt.state = state;
    trace(ctx, `ROUTE ${dec.note}${result.cached ? " (cached)" : ""}`);
    if (!capabilities.apply()) return undefined; // shadow: logged, Pi behaves exactly as before
    return {
      message: {
        customType: CUSTOM_TYPE,
        content: routeDirective(dec), // directive already carries its own "ORCHESTRATOR ROUTE:" prefix
        display: false,
        details: { stage: "route", ...dec },
      },
    };
  });

  // ── Phase 4: CHECK — verdicts on agent-runner tool results only ────────────
  pi.on("tool_result", async (ev: ToolResultEvent, ctx: ExtensionContext) => {
    if (!capabilities.check() || !rt.jev) return undefined;
    if (!cfg.agentTools.includes(ev.toolName)) return undefined; // warden territory: never judge bash/read/etc. here
    let state = rt.state;
    if (!state) return undefined; // no active orchestration episode
    // Look up this branch BEFORE asking so retryLeft reflects the retries it already spent
    // (old code used the constant maxRetries-1 → the decision layer said "1 left" forever).
    const branchId = ev.toolCallId;
    let branch = state.branches.find((b) => b.id === branchId);
    const retryLeft = retryLeftFor(branch, cfg.limits.maxRetriesPerBranch);
    // IDEA parallelMax: once the episode spawned enough branches, stop fanning out deeper.
    const fannedOut = state.branches.length >= (cfg.limits.parallelMax ?? 4);
    const depthLeft = fannedOut ? 0 : Math.max(0, (state.maxDepth ?? 0) - state.depthUsed);
    const input = JSON.stringify(ev.input ?? {}).slice(0, 600);
    const resultText = textOf(ev.content).slice(0, cfg.stateChars);
    const answer = await rt.jev.ask(
      `Subtask (${ev.toolName}, subagent result to judge):\nassignment: ${input}\nresult:\n${resultText}`,
      CHECK_QUESTIONS,
      ctx.signal,
    );
    if (!answer.ok) {
      trace(ctx, `check ${ev.toolName} skipped (${answer.reason})`); // fail-open
      return undefined;
    }
    state.budgetUsed = rt.jev.budgetUsed;
    const dec = decideCheck(answer.answers, cfg, { retryLeft, depthLeft });
    if (!branch) {
      branch = { id: branchId, tool: ev.toolName, task: input.slice(0, 200), retry: 0 };
      state.branches.push(branch);
    }
    if (dec.verdict === "FAIL") {
      if (branch.retry < cfg.limits.maxRetriesPerBranch && dec.reroute !== "drop") branch.retry++;
      if (dec.deeper && depthLeft > 0) state.depthUsed = Math.min(cfg.limits.maxDepth, state.depthUsed + 1);
      if (dec.reroute === "drop") branch.reroute = "drop";
    }
    branch.verdict = dec.verdict;
    branch.reroute = dec.reroute;
    branch.at = Date.now();
    saveOrchState(pi, state);
    trace(ctx, `CHECK ${ev.toolName} ${dec.line}`);
    if (!capabilities.apply()) return undefined; // shadow: verdict logged only
    return { content: [...(ev.content ?? []), { type: "text" as const, text: dec.line }] };
  });

  // ── Phase 5: FINAL — bounded settlement check ──────────────────────────────
  pi.on("agent_before_settle", async (ev: AgentBeforeSettleEvent, ctx: ExtensionContext): Promise<AgentBeforeSettleEventResult | undefined> => {
    if (!capabilities.final() || !rt.jev) return undefined;
    const state = rt.state;
    if (!state) return undefined; // no active episode → nothing to verify
    if (state.finalClosed) return undefined; // escalated & closed: no more FINAL calls or injections for this episode
    // FINAL needs the FULL transcript: reports written on earlier turns may no longer be in
    // the settle window. Use session entries when available; fall back to the settle window.
    const sessionMsgs = sessionEntriesToMessages((ctx as { sessionManager?: { getEntries?: () => unknown[] } }).sessionManager); // full transcript beats the settle window
    const evidence = sessionMsgs.length ? sessionMsgs : (ev.context?.contextMessages ?? []);
    const category = state.category ?? "implementation"; // legacy episodes: implementation contract (current behavior)
    const evidenceBlock = buildFinalEvidence(evidence, cfg.stateChars);
    // Subagent work lives in its own sessions — the main transcript only holds the CHECK verdicts.
    // Feed those to Jev so parallel runs are not misjudged as "sections missing".
    const branchLines = state.branches
      .map((b) => `- ${b.tool} ${b.verdict}: ${String(b.task).slice(0, 140)}`)
      .join("\n");
    const branchesBlock = state.branches.length ? `\nsubagent check verdicts:\n${branchLines}` : "";
    const answer = await rt.jev.ask(
      `Task (${category} completion contract): ${state.task}\nshape: ${state.shape ?? "single"} (depth used ${state.depthUsed}/${state.maxDepth ?? 0}, branches ${state.branches.length})${branchesBlock}\nevidence:\n${evidenceBlock}`,
      finalQuestions(category),
      ctx.signal,
    );
    if (!answer.ok) {
      trace(ctx, `final skipped (${answer.reason})`); // fail-open: normal settlement
      return undefined;
    }
    state.budgetUsed = rt.jev.budgetUsed;
    const dec = decideFinal(answer.answers, cfg, category);
    if (dec.pass) {
      saveOrchState(pi, state);
      trace(ctx, `FINAL ${dec.line}`);
      return undefined; // PASS: allow normal settlement (both modes)
    }
    // FAIL:
    if (!capabilities.apply()) {
      saveOrchState(pi, state);
      trace(ctx, `FINAL ${dec.line} (shadow: logged, settlement unchanged)`);
      return undefined;
    }
    if (state.failLoops >= cfg.limits.maxFailLoops || (rt.jev.budgetUsed ?? 0) >= cfg.maxRequests) {
      state.failLoops++;
      state.finalClosed = true; // terminal: close the episode so later settles do not re-fire FINAL
      saveOrchState(pi, state);
      trace(ctx, `FINAL limit reached -> escalate to user (bounded, no more loops; episode closed)`);
      return {
        entries: [
          {
            type: "custom_message",
            customType: CUSTOM_TYPE,
            content:
              `ORCHESTRATOR FINAL (limit reached): ${dec.line} — the bounded correction budget is spent. Present the current state and the remaining gap to the user; let the user decide the next step.`,
            display: true,
            details: { stage: "final", escalated: true },
          },
        ],
      };
    }
    state.failLoops++;
    saveOrchState(pi, state);
    trace(ctx, `FINAL ${dec.line} -> bounded correction turn ${state.failLoops}/${cfg.limits.maxFailLoops}`);
    // One bounded extra turn: directive entry (context) + follow-up user message (drives the turn).
    pi.sendUserMessage(dec.directive ?? `ORCHESTRATOR FINAL: FAIL (gap=${dec.gap ?? "unknown"}). Close the evidence gap or present the situation to the user.`, { deliverAs: "followUp" });
    return {
      entries: [
        {
          type: "custom_message",
          customType: CUSTOM_TYPE,
          content: dec.directive ?? dec.line,
          display: false,
          details: { stage: "final", gap: dec.gap, loop: state.failLoops },
        },
      ],
      continue: true,
    };
  });

  pi.on("session_shutdown", async (_ev, ctx) => {
    setStatus(ctx, undefined); // clear footer status on quit/reload/replace
    try {
      ctx.ui.setWidget?.("jev-orch", undefined, { placement: "belowEditor" });
    } catch {
      /* headless */
    }
  });

  // ── Kill switch + status ────────────────────────────────────────────────────
  const ORCH_ACTIONS = [
    { value: "status", description: "state + budget + last verdicts" },
    { value: "on", description: "enable (keeps current mode; default shadow)" },
    { value: "off", description: "disable (all hooks no-op)" },
    { value: "shadow", description: "enable, log only (nothing applied)" },
    { value: "enforce", description: "enable, apply bounded decisions" },
    { value: "debug", description: "TUI live panel + stage toasts (on/off/toggle)" },
    { value: "global", description: "persist on/off/shadow/enforce/budget to the global config file" },
    { value: "budget", description: "show or set the Jev request budget for this session (/jev-orch budget N)" },
    { value: "install-deps", description: "install the missing pi-typesafe dependency and retry the judge" },
    { value: "clear", description: "clear episode state" },
  ];
  pi.registerCommand("jev-orch", {
    description: "Jev orchestrator: /jev-orch <status | on | off | shadow | enforce | debug | global | clear> — on/off/shadow/enforce/debug act on THIS session; global <action> persists to the config file (new sessions)",
    getArgumentCompletions: (argumentPrefix: string) => {
      const tok = (argumentPrefix || "").trim().toLowerCase().split(/\s+/)[0] ?? "";
      const items = ORCH_ACTIONS.filter((a) => a.value.startsWith(tok)).map((a) => ({ value: a.value, label: a.value, description: a.description }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const known = ORCH_ACTIONS.map((a) => a.value);
      let a = (args || "").trim().split(/\s+/).filter(Boolean)[0];
      const ui = ctx.ui;
      const notify = (msg: string) => ui.notify?.(msg, "info");
      // no subcommand (or an unknown one) → let the user pick; headless → show the menu instead
      if (a === undefined || !known.includes(a)) {
        let picked: string | undefined;
        try {
          picked = ui.select ? await ui.select("jev-orch — chọn hành động", known) : undefined;
        } catch {
          picked = undefined; // picker unavailable (headless / no TUI)
        }
        if (!picked) {
          // picker unavailable (headless / no TUI) or dismissed → print the menu so the choices stay visible
          const menu =
            "jev-orch — subcommands:\n" +
            ORCH_ACTIONS.map((a) => `  /jev-orch ${a.value.padEnd(8)} ${a.description}`).join("\n");
          notify(a ? `unknown action "${a}" —\n` + menu : menu);
          return;
        }
        a = picked;
      }
      switch (a) {
        case "status": {
          const g = loadConfig();
          const lines = [
            `session: enabled=${rt.on} mode=${rt.mode} child=${IS_CHILD} (config source at start=${source})`,
            `global  : enabled=${g.cfg.enabled} mode=${g.cfg.mode} (${g.source}${g.error ? " — " + g.error : ""}) — new sessions inherit this`,
            `key: ${rt.jev ? (rt.jev.available() ? `usable (${rt.jev.keyLabel})` : `unavailable (${rt.jev.reason()})`) : "not loaded"}`,
            `budget: ${rt.jev?.budgetUsed ?? 0}/${rt.jev?.maxRequests ?? cfg.maxRequests}`,
            `state: ${rt.state ? `task="${rt.state.task.slice(0, 60)}" shape=${rt.state.shape ?? "-"} depth=${rt.state.depthUsed}/${rt.state.maxDepth ?? 0} branches=${rt.state.branches.length} failLoops=${rt.state.failLoops}` : "none"}`,
            rt.lastTrace ? `last: ${rt.lastTrace}` : "",
          ].filter(Boolean).join("\n");
          notify(lines);
          break;
        }
        case "on": {
          rt.on = true; rt.mode = rt.mode === "enforce" ? "enforce" : "shadow"; // turning on keeps current mode; default shadow
          if (cfg.mode === "shadow") rt.mode = "shadow";
          if (!rt.jev) rt.jev = await makeJev(cfg);
          rt.state = rt.state ?? loadOrchState(ctx);
          refreshPanel(ctx);
          notify(`jev-orch ON (${rt.mode}${rt.jev && !rt.jev.available() ? `, key unavailable → fail-open` : ""}) — this session only. Persist: /jev-orch global on.`);
          break;
        }
        case "off": {
          rt.on = false;
          setStatus(ctx, undefined);
          refreshPanel(ctx);
          notify("jev-orch OFF for this session (hooks no-op). Other sessions unaffected. Persist: /jev-orch global off");
          break;
        }
        case "shadow": {
          rt.on = true; rt.mode = "shadow";
          if (!rt.jev) rt.jev = await makeJev(cfg);
          refreshPanel(ctx);
          notify("jev-orch SHADOW for this session (decisions logged, Pi behavior unchanged). Persist: /jev-orch global shadow");
          break;
        }
        case "enforce": {
          rt.on = true; rt.mode = "enforce";
          if (!rt.jev) rt.jev = await makeJev(cfg);
          refreshPanel(ctx);
          notify("jev-orch ENFORCE for this session: directives/verdicts applied (bounded). Disable: /jev-orch off. Persist: /jev-orch global enforce");
          break;
        }
        case "clear": {
          rt.state = undefined;
          refreshPanel(ctx);
          notify("jev-orch episode state cleared.");
          break;
        }
        case "budget": {
          const sub = ((args || "").trim().split(/\s+/).filter(Boolean)[1] ?? "");
          const n = parseInt(sub, 10);
          if (sub !== "" && !(Number.isInteger(n) && n >= 1)) {
            notify("usage: /jev-orch budget [N] — N = max Jev requests this session (e.g. 20, 80); no N = show only. Persist: /jev-orch global budget N");
            break;
          }
          if (sub !== "") rt.jev?.setMaxRequests(n);
          refreshPanel(ctx);
          notify(`jev-orch budget: ${rt.jev?.budgetUsed ?? 0}/${rt.jev?.maxRequests ?? cfg.maxRequests} used this session${sub ? ` (limit now ${n}, this session only)` : ""}. Change other sessions: /jev-orch global budget ${n || (rt.jev?.maxRequests ?? cfg.maxRequests)}`);
          break;
        }
        case "install-deps": {
          if (rt.jev?.available()) {
            notify("pi-typesafe already available (key=" + rt.jev.keyLabel + "); nothing to install.");
            break;
          }
          try {
            const bin = process.platform === "win32" ? "pi.cmd" : "pi";
            const { stdout, stderr } = await execFileP(bin, ["install", "npm:pi-typesafe"], { timeout: 120000, maxBuffer: 1024 * 1024 });
            const ready = await rt.jev?.retryLoad?.() ?? false;
            if (ready) {
              notify("pi-typesafe installed — judge ready (key=" + rt.jev?.keyLabel + ").");
            } else {
              const tail = String(stdout || stderr || "").trim().slice(0, 200);
              notify("install finished but judge is not ready yet" + (tail ? " — " + tail : "") + "; retry /jev-orch install-deps or /reload.");
            }
          } catch (e) {
            notify("install failed: " + String(e instanceof Error ? e.message : e).slice(0, 200) + " — manual: " + TYPESAFE_INSTALL_CMD);
          }
          break;
        }
        case "debug": {
          const sub = ((args || "").trim().split(/\s+/).filter(Boolean)[1] ?? "").toLowerCase();
          if (sub === "off") rt.debug = false;
          else if (sub === "on") rt.debug = true;
          else rt.debug = !rt.debug; // bare /jev-orch debug → toggle
          refreshPanel(ctx);
          notify("jev-orch debug " + (rt.debug ? "ON (live panel + stage toasts)" : "OFF") + " — switch: /jev-orch debug " + (rt.debug ? "off" : "on"));
          break;
        }
        case "global": {
          const toks = (args || "").trim().split(/\s+/).filter(Boolean);
          const gsub = (toks[0] ?? "").toLowerCase();
          let patch: Record<string, unknown> | null =
            gsub === "on" ? { enabled: true }
            : gsub === "off" ? { enabled: false }
            : gsub === "shadow" ? { enabled: true, mode: "shadow" }
            : gsub === "enforce" ? { enabled: true, mode: "enforce" }
            : null;
          let usage = "usage: /jev-orch global <on|off|shadow|enforce|budget N> — writes the GLOBAL config file (applies to new sessions / after /reload). Bare on/off/shadow/enforce only affect this session.";
          if (gsub === "budget") {
            const n = parseInt(toks[1] ?? "", 10);
            if (Number.isInteger(n) && n >= 1) patch = { maxRequests: n };
            else usage = "usage: /jev-orch global budget <N> (positive integer) — persists the Jev request budget for new sessions";
          }
          if (!patch) {
            notify(usage);
            break;
          }
          const p = persistConfig(patch);
          notify("global config updated (" + p + ") — applies to NEW sessions; this session keeps its current settings, use /jev-orch on|off|shadow|enforce|budget to change this session");
          break;
        }
      }
    },
  });
}
