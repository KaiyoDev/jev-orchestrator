/**
 * jev-orchestrator — CHECK (branch results) and FINAL (settlement) stages (Phases 4–5).
 *
 * CHECK inspects ONLY configured agent-runner tool results (default: subagent /
 * agent / chief / peer / TaskExecute). Ordinary bash/read/write/edit results are
 * never judged here — that territory belongs to pi-warden (safety layer).
 *
 * Jev produces decisions (PASS/FAIL + reroute). The extension never executes a
 * retry itself: in shadow mode it only logs; in enforce mode it appends a verdict
 * line to the tool result and (FINAL only) requests one bounded extra turn.
 */
import type { JevOrchConfig } from "./config.js";
import type { TaskCategory } from "./state.js";

export const CHECK_QUESTIONS: Record<string, unknown> = {
  accept: {
    type: "noul",
    instructions:
      "Judging ONLY the evidence in this subagent result against the subtask it was given: does the result satisfy the subtask's acceptance criteria? Judge substance and completeness, not style.",
  },
  why_fail: {
    type: "choice",
    instructions: "If the result does not fully satisfy the subtask, what is the dominant cause?",
    criteria: {
      none: "It actually does satisfy it",
      incomplete: "The work is partially done and pieces are missing",
      wrong_approach: "It was done, but the approach contradicts the subtask",
      env_blocker: "Blocked by the environment/permissions/tools, not by the agent's work",
      needs_user: "Only the user can make the required decision",
    },
  },
  reroute: {
    type: "choice",
    instructions: "Best next move for this subtask?",
    criteria: {
      retry_same: "Rerun the same agent unchanged",
      reassign_strong: "Reassign to a stronger model/agent",
      reassign_other: "Reassign to a different agent or skill",
      escalate_user: "Stop this branch and ask the user",
      drop: "Discard this subtask (not needed or not feasible)",
    },
  },
  deeper: {
    type: "noul",
    instructions:
      "Is further decomposition of the remaining gap useful AND within the remaining depth budget? Answer no when the depth budget is exhausted or the gap is small.",
  },
};

export const FINAL_QUESTIONS: Record<string, unknown> = {
  done_ok: {
    type: "noul",
    instructions:
      "Judging the whole session evidence so far: does the delivered work actually satisfy the user's task acceptance criteria? Base the answer on concrete evidence (tests run, files changed, output shown), not on claims.",
  },
  verify_gap: {
    type: "choice",
    instructions: "What verification is still missing, if any?",
    criteria: {
      none: "All needed verification has been done",
      tests: "Automated tests have not been run or are failing",
      runtime: "The change has not been observed running",
      review: "No review/diff check of the final state",
      user_confirm: "Only the user can confirm the result (UI/behavior they must see)",
    },
  },
  scope: {
    type: "noul",
    instructions: "Did the delivered work exceed what the user asked for (scope creep, unrequested refactors)?",
  },
};

export interface CheckDecision {
  verdict: "PASS" | "FAIL";
  cause?: string;
  reroute: string;
  deeper: boolean;
  line: string;
}

/** Remaining retry budget for one branch (0 = escalate, not more retries). Pure — unit-testable. */
export function retryLeftFor(branch: { retry?: number } | undefined, maxRetries: number): number {
  return Math.max(0, maxRetries - (branch?.retry ?? 0));
}
export function decideCheck(answers: Record<string, unknown>, cfg: JevOrchConfig, ctx: { retryLeft: number; depthLeft: number }): CheckDecision {
  const p = Number((answers.accept as { noul?: number } | undefined)?.noul ?? 0);
  const pass = p >= cfg.thresholds.accept;
  const causeRaw = typeof (answers.why_fail as { choice?: string } | undefined)?.choice === "string"
    ? ((answers.why_fail as { choice: string }).choice)
    : "incomplete";
  const rerouteRaw = typeof (answers.reroute as { choice?: string } | undefined)?.choice === "string"
    ? ((answers.reroute as { choice: string }).choice)
    : "escalate_user";
  const rerouteConf = Number((answers.reroute as { confidence?: number } | undefined)?.confidence ?? 0);
  const pDeeper = Number((answers.deeper as { noul?: number } | undefined)?.noul ?? 0);

  let reroute = rerouteConf >= cfg.thresholds.reroute_conf || pass ? rerouteRaw : "escalate_user";
  let deeper = pDeeper >= cfg.thresholds.deeper && ctx.depthLeft > 0;
  if (ctx.retryLeft <= 0 && !pass) reroute = rerouteRaw === "drop" ? "drop" : "escalate_user"; // bounded retries
  if (ctx.depthLeft <= 0) deeper = false;

  const line = pass
    ? `[jev-orch] PASS (accept p=${p.toFixed(2)})` 
    : `[jev-orch] FAIL (accept p=${p.toFixed(2)}) cause=${causeRaw === "none" ? "incomplete" : causeRaw} -> next=${reroute} (retry budget left: ${ctx.retryLeft}, depth left: ${ctx.depthLeft}). ${reroute === "escalate_user" ? "Present the situation to the user; do not spawn more agents." : `Act on this verdict yourself (you are the executor).${deeper ? " Further decomposition of the remaining gap is within the depth budget." : " Depth budget exhausted: finish inline or escalate."}`}`;
  return { verdict: pass ? "PASS" : "FAIL", cause: pass ? undefined : causeRaw, reroute, deeper, line };
}

export interface FinalDecision {
  pass: boolean;
  gap?: string;
  scopeCreep: boolean;
  line: string;
  directive?: string;
}

export function finalQuestions(category: TaskCategory): Record<string, unknown> {
  switch (category) {
    case "analysis":
      return {
        done_ok: {
          type: "noul",
          instructions:
            "This is a READ-ONLY analysis task. No changed files, an empty diff, and unrun tests are EXPECTED and must not count against completion. Judge only the analysis contract: (1) every requested part/section is answered, (2) each finding carries concrete evidence (file:line, quotes, counts), (3) scope matches the request, (4) a synthesis/conclusion is present.",
        },
        verify_gap: {
          type: "choice",
          instructions: "For this read-only analysis, what (if anything) is still missing?",
          criteria: {
            none: "The analysis is complete as requested",
            missing_section: "A requested part/section is missing or unanswered",
            weak_evidence: "Findings lack concrete evidence (file:line / quotes / counts)",
            out_of_scope: "Work drifted into unrequested implementation or extras",
            user_confirm: "Only the user can confirm the findings",
          },
        },
        scope: {
          type: "noul",
          instructions: "Did the delivered work exceed the request (unrequested file changes, refactors, extra work)?",
        },
      };
    case "research_docs":
      return {
        done_ok: {
          type: "noul",
          instructions:
            "This task's deliverable is produced documentation/research. Code diffs and test runs are NOT required. Judge only: (1) the requested output was produced completely, (2) claims carry adequate source/evidence coverage for the task, (3) it is internally consistent, (4) no scope drift beyond the requested document.",
        },
        verify_gap: {
          type: "choice",
          instructions: "For this documentation task, what (if anything) is still missing?",
          criteria: {
            none: "The requested output is complete",
            missing_output: "A requested output/section was not produced",
            weak_sources: "Claims lack adequate source coverage",
            out_of_scope: "The document drifted beyond the requested scope",
            user_confirm: "Only the user can confirm the document",
          },
        },
        scope: {
          type: "noul",
          instructions: "Did the delivered document exceed what was asked (unrequested sections, unrequested code changes)?",
        },
      };
    default:
      return FINAL_QUESTIONS; // implementation: unchanged contract (diff/tests/review apply)
  }
}

/** Per-category correction advice: 'no diff' is valid for read-only categories; diff review applies to implementation only. */
function finalAdvice(category: TaskCategory, gap: string): string {
  if (category === "analysis") {
    if (gap === "missing_section") return "Answer the missing requested part(s) with cited evidence, then update the synthesis. Do not modify files unless the task asked for it.";
    if (gap === "weak_evidence") return "Strengthen the findings with concrete evidence (file:line, quotes, counts); keep the work read-only.";
    if (gap === "out_of_scope") return "Trim the work back to the requested analysis; drop unrequested changes or extras.";
    if (gap === "user_confirm") return "Present the findings to the user and stop; only they can confirm.";
    return "Close the identified analysis gap without adding unrequested work.";
  }
  if (category === "research_docs") {
    if (gap === "missing_output") return "Produce the missing requested output/section(s).";
    if (gap === "weak_sources") return "Add source citations/coverage for the claims that lack them.";
    if (gap === "out_of_scope") return "Bring the document back within the requested scope.";
    if (gap === "user_confirm") return "Present the document to the user and stop; only they can confirm.";
    return "Close the identified documentation gap.";
  }
  if (gap === "tests") return "run the relevant tests and fix or report the failures";
  if (gap === "runtime") return "observe the change running and report what you saw";
  if (gap === "review") return "review the final diff/state before declaring done";
  if (gap === "user_confirm") return "present the result to the user and stop";
  return "close the evidence gap you identified";
}

/**
 * Evidence block for the FINAL stage.
 *
 * A bare 12-message tail can miss completed work: correction/escalation turns
 * push the real reports out of the window, so Jev then scores done_ok low and
 * the task loops. This builder includes: the original task (contract), the
 * longest assistant reports (capped each), and a short recent tail. Pure and
 * bounded by maxChars — unit-testable.
 */
/** Map raw session entries to {role, content} messages for the evidence builder (exported for tests). */
export function sessionEntriesToMessages(
  sm: { getEntries?: () => unknown[] } | undefined,
): Array<{ role: string; content?: unknown }> {
  const entries = sm?.getEntries?.() ?? [];
  const out: Array<{ role: string; content?: unknown }> = [];
  for (const e of entries) {
    const entry = e as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry.type === "message" && entry.message?.role) out.push({ role: entry.message.role, content: entry.message.content });
  }
  return out;
}
export function buildFinalEvidence(
  messages: Array<{ role: string; content?: unknown }>,
  maxChars: number,
): string {
  const textOfMsg = (m: { role: string; content?: unknown }): string => {
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return (c as Array<{ type?: string; text?: string }>)
        .filter((x) => x?.type === "text" && typeof x.text === "string")
        .map((x) => x.text as string)
        .join("\n");
    }
    return "";
  };
  const users = messages.filter((m) => m.role === "user").map(textOfMsg).filter((t) => t.length > 0);
  // Longest report gets near-full view (synthesis often exceeds any small cap); the rest stay short.
  const reports = messages
    .filter((m) => m.role === "assistant")
    .map((m) => "[assistant] " + textOfMsg(m))
    .filter((t) => t.length >= 400)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .map((t, i) => t.slice(0, i === 0 ? 9000 : 2000));
  const tail = messages.slice(-6).map((m) => `[${m.role}] ${textOfMsg(m)}`.slice(0, 800)).join("\n");
  const parts: string[] = [];
  if (users.length) parts.push("task:\n" + users[0].slice(0, 600));
  if (reports.length) parts.push("reports:\n" + reports.join("\n---\n"));
  if (tail) parts.push("recent:\n" + tail);
  // FINAL evidence allowance: reports are the contract artifact; cap = maxChars + 10000 (bounded).
  return parts.join("\n").slice(0, Math.max(maxChars, 16000));
}

export function decideFinal(answers: Record<string, unknown>, cfg: JevOrchConfig, category: TaskCategory = "implementation"): FinalDecision {
  const p = Number((answers.done_ok as { noul?: number } | undefined)?.noul ?? 0);
  const gap = typeof (answers.verify_gap as { choice?: string } | undefined)?.choice === "string"
    ? ((answers.verify_gap as { choice: string }).choice)
    : "none";
  const pScope = Number((answers.scope as { noul?: number } | undefined)?.noul ?? 0);
  const pass = p >= cfg.thresholds.done_ok;
  const scopeCreep = pScope >= 0.5;
  const line = pass
    ? `[jev-orch] FINAL PASS (done p=${p.toFixed(2)})${scopeCreep ? "; scope-creep noted" : ""}`
    : `[jev-orch] FINAL FAIL (done p=${p.toFixed(2)}) gap=${gap}`;
  let directive: string | undefined;
  if (!pass) {
    const advice = finalAdvice(category, gap);
    directive = `ORCHESTRATOR FINAL: FAIL (p=${p.toFixed(2)}, cat=${category}, gap=${gap}). ${advice}. This is a bounded correction turn; if it cannot be closed, present the situation to the user instead of looping.`;
  }
  return { pass, gap: pass ? undefined : gap, scopeCreep, line, directive };
}
