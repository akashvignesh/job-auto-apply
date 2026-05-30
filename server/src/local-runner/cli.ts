#!/usr/bin/env node

/**
 * Local runner CLI — runs the agent loop against a Chrome instance with
 * remote debugging enabled.
 *
 * Usage:
 *   node dist/local-runner/cli.js --task "apply to job" --url "https://..."
 *
 * Chrome must be running with:
 *   chrome.exe --remote-debugging-port=9222 --user-data-dir="D:\\Code\\Git\\job_apply\\chrome-local-agent"
 *
 * Profile separation:
 *   --profile <path>   Path to profile.json (default: ./profile/profile.json)
 *                      Different users only change this file; patterns are shared.
 *
 * Pattern store:
 *   --patterns <dir>   Directory for filesystem patterns (default: ./patterns)
 *                      Patterns accumulate across runs; committed alongside code.
 */

import { join, resolve } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { runAgentLoop } from "../agent/loop.js";
import { LocalBrowser } from "./browser.js";
import { CdpSession, createOrAttachTarget } from "./cdp.js";
import { LearningStore } from "./learning-store.js";
import { PagePatternStore } from "./page-pattern-store.js";
import { analyzeTurns, formatMetricsSummary, RunLogger } from "./run-logger.js";

function arg(name: string, fallback = ""): string {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] || fallback : fallback;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

/** Load profile.json — returns empty object if not found (graceful degradation). */
async function loadProfile(profilePath: string): Promise<Record<string, any>> {
  try {
    const raw = await readFile(profilePath, "utf8");
    const profile = JSON.parse(raw);
    console.error(`[local-runner] Profile loaded: ${profilePath} (${Object.keys(profile).length} top-level keys)`);
    return profile;
  } catch {
    console.error(`[local-runner] Profile not found at ${profilePath} — running without profile context`);
    return {};
  }
}

/**
 * After a successful task, export patterns from the result's completedPages
 * into the filesystem pattern store.  The server-side loop doesn't have IDB
 * access, so we persist what we know from completedPages + turn analysis.
 */
async function exportPatternsFromResult(
  result: Awaited<ReturnType<typeof runAgentLoop>>,
  patternStore: PagePatternStore,
  targetUrl: string
): Promise<void> {
  if (!result.completedPages || result.completedPages.length === 0) return;

  let domain = "";
  try {
    domain = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return;
  }

  for (const page of result.completedPages) {
    if (!page.fingerprint) continue;

    // Build lightweight pattern steps from turn logs
    const steps: Array<{ tool: string; label?: string; role?: string; valueKind?: string; value?: string }> = [];
    for (const turn of result.turns || []) {
      if (turn.patternReplay) continue; // already in store
      for (const tool of turn.tools) {
        if (tool.name === "form_input" && tool.input?.ref != null && tool.input?.value != null) {
          // Extract label from DOM result context (best-effort)
          steps.push({ tool: "form_input", value: tool.input.value });
        }
        if (tool.name === "computer" && tool.input?.action === "left_click" && tool.input?.ref != null) {
          steps.push({ tool: "computer", action: "left_click" } as any);
        }
      }
    }

    if (steps.length >= 2) {
      await patternStore.savePattern(domain, {
        fingerprint: page.fingerprint,
        formLabel: page.pageLabel || page.fingerprint,
        domain,
        pageUrl: page.url,
        steps,
      });
    }
  }
}

/** Save completed-pages state to a checkpoint file for restart recovery. */
async function saveRestartState(
  checkpointPath: string,
  task: string,
  url: string,
  completedPages: Array<{ fingerprint: string; url: string; pageLabel: string }>
): Promise<void> {
  try {
    const dir = join(checkpointPath, "..");
    await mkdir(dir, { recursive: true });
    await writeFile(
      checkpointPath,
      JSON.stringify({ task, url, completedPages, savedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
  } catch {
    // best-effort
  }
}

/** Load previously completed pages for restart recovery. */
async function loadRestartState(
  checkpointPath: string,
  task: string
): Promise<Array<{ fingerprint: string; url: string; pageLabel: string }>> {
  try {
    const raw = await readFile(checkpointPath, "utf8");
    const state = JSON.parse(raw);
    // Only use if task matches and saved within 24h
    const age = Date.now() - new Date(state.savedAt || 0).getTime();
    if (state.task === task && age < 24 * 60 * 60 * 1000) {
      return state.completedPages || [];
    }
    return [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const task = arg("--task") || process.argv.slice(2).filter((x) => !x.startsWith("--"))[0] || "";
  const wantsHelp = has("--help") || has("-h");
  const url = arg("--url") || undefined;
  const context = arg("--context") || undefined;
  const debugPort = Number(arg("--debug-port", "9222"));
  const maxSteps = Number(arg("--max-steps", "80"));
  const modelOverride = arg("--model") || undefined;
  const runsDir = resolve(arg("--runs-dir", join(process.cwd(), "runs", "local-agent")));
  const learningPath = resolve(arg("--learning", LearningStore.defaultPath(process.cwd())));
  const profilePath = resolve(arg("--profile", join(process.cwd(), "profile", "profile.json")));
  const patternsDir = resolve(arg("--patterns", PagePatternStore.defaultPath(process.cwd())));
  const checkpointPath = resolve(join(process.cwd(), ".local-agent", "restart-state.json"));

  if (wantsHelp || !task.trim()) {
    console.log(`Usage:
  node dist/local-runner/cli.js --task "apply to jobs" --url "https://jobright.ai/jobs/recommend"

Chrome setup (run once):
  chrome.exe --remote-debugging-port=9222 --user-data-dir="D:\\Code\\Git\\job_apply\\chrome-local-agent"

Options:
  --debug-port 9222          Chrome remote debugging port
  --max-steps 80             Max agent loop iterations
  --context "..."            Extra form/profile context (appended to task)
  --profile ./profile/profile.json   Path to applicant profile JSON
  --patterns ./patterns      Directory for page pattern files
  --runs-dir ./runs/local-agent
  --learning ./.local-agent/learning.json`);
    process.exit(wantsHelp ? 0 : 1);
  }

  // Load profile + learning state + pattern store
  const [profile, learning] = await Promise.all([
    loadProfile(profilePath),
    (async () => {
      const ls = new LearningStore(learningPath);
      await ls.load();
      return ls;
    })(),
  ]);

  const patternStore = new PagePatternStore(patternsDir);

  // Print known patterns for the target domain
  if (url) {
    try {
      const domain = new URL(url).hostname.toLowerCase();
      const patternCount = (await patternStore.listPatterns(domain)).length;
      if (patternCount > 0) {
        console.error(`[local-runner] Patterns for ${domain}: ${patternCount} (${(await patternStore.listPatterns(domain)).filter(p => p.successCount >= 2).length} verified)`);
      }
    } catch { /* ignore */ }
  }

  // Load restart state (previously completed pages for this task)
  const previouslyCompleted = await loadRestartState(checkpointPath, task);
  if (previouslyCompleted.length > 0) {
    console.error(`[local-runner] Restart recovery: ${previouslyCompleted.length} page(s) already completed from prior session`);
    for (const p of previouslyCompleted) {
      console.error(`  ✓ ${p.pageLabel || p.fingerprint} (${p.url})`);
    }
  }

  // Inject domain pattern hint into context
  let patternHint = "";
  if (url) {
    try {
      const domain = new URL(url).hostname.toLowerCase();
      patternHint = await patternStore.buildDomainHint(domain);
    } catch { /* ignore */ }
  }

  const learningHint = learning.buildPromptHint();
  const fullContext = [patternHint, learningHint, context].filter(Boolean).join("\n\n");

  const logger = new RunLogger(runsDir, task, url);
  await logger.init();
  console.error(`[local-runner] Run dir: ${logger.dir}`);
  console.error(`[local-runner] Profile: ${profilePath}`);
  console.error(`[local-runner] Patterns: ${patternsDir}`);

  const target = await createOrAttachTarget(debugPort, url);
  if (!target.webSocketDebuggerUrl) throw new Error("Selected Chrome target has no debugger URL.");
  const cdp = new CdpSession(target.webSocketDebuggerUrl);
  const browser = new LocalBrowser(cdp, (base64) => logger.saveScreenshot(base64));
  await browser.init();

  // Track completed pages during this run (for restart recovery)
  const completedThisRun: Array<{ fingerprint: string; url: string; pageLabel: string }> = [];

  const result = await runAgentLoop({
    task,
    url,
    context: fullContext || undefined,
    executeTool: (tool, input) => browser.executeTool(tool, input),
    maxSteps,
    patternStore,
    profile,
    previouslyCompleted,
    model: modelOverride,
    onPageComplete: (info) => {
      completedThisRun.push(info);
      console.error(`[local-runner] ✓ Page complete: "${info.pageLabel}" fingerprint=${info.fingerprint}`);
      // Persist immediately so restarts see it
      void saveRestartState(checkpointPath, task, url || "", [...previouslyCompleted, ...completedThisRun]);
    },
    onStep: (step) => {
      if (step.status === "thinking") return;
      const extra = step.patternInfo
        ? ` [pattern: ${step.patternInfo.matched}/${step.patternInfo.steps} steps matched]`
        : "";
      console.error(`[local-runner] step ${step.step}: ${step.status}${step.toolName ? ` ${step.toolName}` : ""}${extra}`);
    },
  });

  const analysis = analyzeTurns(result.turns || []);
  await logger.complete({ status: result.status, model: result.model, usage: result.usage, turns: result.turns || [], analysis });
  await learning.recordRun({ runDir: logger.dir, status: result.status, task, url, turns: result.turns || [], analysis });

  // Export patterns from successful run
  if (result.status === "complete" && url) {
    await exportPatternsFromResult(result, patternStore, url);
    const summary = await patternStore.summary();
    if (summary.trim() !== "(no patterns yet)") {
      console.error(`[local-runner] Saved patterns:\n${summary}`);
    }
  }

  // Update restart state on completion — clear if fully done
  if (result.status === "complete") {
    await saveRestartState(checkpointPath, task, url || "", []);
  } else if (result.completedPages && result.completedPages.length > 0) {
    // Persist progress for restart recovery
    await saveRestartState(checkpointPath, task, url || "", result.completedPages);
    console.error(`[local-runner] Progress saved: ${result.completedPages.length} page(s) completed`);
  }

  cdp.close();

  // Phase 7.7 — print the metrics summary to stderr so the JSON on stdout
  // stays machine-parseable for callers piping the result.
  console.error("\n" + formatMetricsSummary(result.usage, analysis));

  console.log(
    JSON.stringify(
      {
        status: result.status,
        answer: result.answer,
        steps: result.steps,
        usage: result.usage,
        model: result.model,
        runDir: logger.dir,
        completedPages: result.completedPages?.length || 0,
        analysis,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(`[local-runner] Fatal: ${err.message}`);
  process.exit(1);
});
