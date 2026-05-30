#!/usr/bin/env node
/**
 * Batch runner — drives N tasks against N Chrome targets in parallel.
 *
 * Each worker:
 *   - attaches to a separate Chrome remote-debug port (--base-port + workerIdx)
 *   - runs the full agent loop (same code path as cli.ts)
 *   - writes its own run dir under <runs-dir>/<stamp>/
 *   - logs results to <runs-dir>/batch-results.jsonl
 *
 * Shared across workers:
 *   - PagePatternStore on disk (concurrent writes are append-or-replace safe;
 *     the same filename is rewritten atomically per pattern key)
 *   - Profile JSON (read-only)
 *
 * Usage:
 *   node server/dist/local-runner/batch.js \
 *     --jobs ./jobs.jsonl \
 *     --concurrency 3 \
 *     --base-port 9222 \
 *     --runs-dir ./runs/batch \
 *     --profile ./profile/profile.json \
 *     --patterns ./patterns \
 *     --max-steps 80
 *
 * Each line of jobs.jsonl is JSON: { "task": "...", "url": "...", "context"?: "...", "maxSteps"?: 60 }
 *
 * Chrome setup (one per concurrency slot):
 *   chrome.exe --remote-debugging-port=9222 --user-data-dir="D:\…\chrome-batch-0"
 *   chrome.exe --remote-debugging-port=9223 --user-data-dir="D:\…\chrome-batch-1"
 *   chrome.exe --remote-debugging-port=9224 --user-data-dir="D:\…\chrome-batch-2"
 */
import { join, resolve } from "path";
import { readFile, writeFile, appendFile, mkdir } from "fs/promises";
import { runAgentLoop } from "../agent/loop.js";
import { LocalBrowser } from "./browser.js";
import { CdpSession, createOrAttachTarget } from "./cdp.js";
import { LearningStore } from "./learning-store.js";
import { PagePatternStore } from "./page-pattern-store.js";
import { analyzeTurns, formatMetricsSummary, RunLogger } from "./run-logger.js";
function arg(name, fallback = "") {
    const idx = process.argv.indexOf(name);
    return idx >= 0 ? process.argv[idx + 1] || fallback : fallback;
}
function has(name) {
    return process.argv.includes(name);
}
async function loadJobs(jobsPath) {
    const raw = await readFile(jobsPath, "utf8");
    const jobs = [];
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        try {
            const j = JSON.parse(trimmed);
            if (!j.task) {
                console.error(`[batch] skipping line without task: ${trimmed.slice(0, 80)}`);
                continue;
            }
            jobs.push(j);
        }
        catch (e) {
            console.error(`[batch] skipping unparseable line: ${e.message}`);
        }
    }
    return jobs;
}
async function loadProfile(profilePath) {
    try {
        const raw = await readFile(profilePath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
/**
 * Run one job on a specific Chrome port. Self-contained — mirrors cli.ts main()
 * minus the restart-recovery wiring (batch jobs are fire-and-forget).
 */
async function runOneTask(job, workerIdx, debugPort, defaultMaxSteps, runsDir, profile, patternStore, learning) {
    const jobId = job.id || `job-${workerIdx}-${Date.now()}`;
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const logger = new RunLogger(runsDir, job.task, job.url);
    await logger.init();
    console.error(`[batch worker ${workerIdx}] starting ${jobId} on port ${debugPort} → ${logger.dir}`);
    try {
        const target = await createOrAttachTarget(debugPort, job.url);
        if (!target.webSocketDebuggerUrl)
            throw new Error(`Chrome target on port ${debugPort} has no debugger URL`);
        const cdp = new CdpSession(target.webSocketDebuggerUrl);
        const browser = new LocalBrowser(cdp, (base64) => logger.saveScreenshot(base64));
        await browser.init();
        // Pattern hint injection (same as cli.ts)
        let patternHint = "";
        if (job.url) {
            try {
                const domain = new URL(job.url).hostname.toLowerCase();
                patternHint = await patternStore.buildDomainHint(domain);
            }
            catch { /* ignore */ }
        }
        const fullContext = [patternHint, learning.buildPromptHint(), job.context].filter(Boolean).join("\n\n");
        const result = await runAgentLoop({
            task: job.task,
            url: job.url,
            context: fullContext || undefined,
            executeTool: (tool, input) => browser.executeTool(tool, input),
            maxSteps: job.maxSteps || defaultMaxSteps,
            patternStore,
            profile,
            model: job.model,
            previouslyCompleted: [],
        });
        const analysis = analyzeTurns(result.turns || []);
        await logger.complete({ status: result.status, model: result.model, usage: result.usage, turns: result.turns || [], analysis });
        await learning.recordRun({ runDir: logger.dir, status: result.status, task: job.task, url: job.url, turns: result.turns || [], analysis });
        cdp.close();
        const finishedAt = new Date().toISOString();
        console.error(`[batch worker ${workerIdx}] ${jobId} → ${result.status} in ${result.steps} steps (${result.usage.apiCalls} calls)`);
        console.error(formatMetricsSummary(result.usage, analysis));
        return {
            id: jobId,
            task: job.task,
            url: job.url,
            workerIdx,
            status: result.status,
            steps: result.steps,
            usage: result.usage,
            runDir: logger.dir,
            startedAt,
            finishedAt,
            durationMs: Date.now() - startMs,
            completedPages: result.completedPages?.length || 0,
        };
    }
    catch (err) {
        const finishedAt = new Date().toISOString();
        console.error(`[batch worker ${workerIdx}] ${jobId} FAILED: ${err.message}`);
        return {
            id: jobId,
            task: job.task,
            url: job.url,
            workerIdx,
            status: "error",
            steps: 0,
            usage: { inputTokens: 0, outputTokens: 0, apiCalls: 0 },
            runDir: logger.dir,
            startedAt,
            finishedAt,
            durationMs: Date.now() - startMs,
            completedPages: 0,
            error: err.message,
        };
    }
}
/**
 * Simple worker-pool: dequeue jobs and assign each to the next idle worker.
 * The pool size = concurrency. Worker idx maps to debug port (basePort + idx).
 */
async function runPool(opts) {
    const results = [];
    let nextJobIdx = 0;
    const workers = Array.from({ length: opts.concurrency }, (_, workerIdx) => (async () => {
        while (true) {
            const myIdx = nextJobIdx++;
            if (myIdx >= opts.jobs.length)
                return;
            const job = opts.jobs[myIdx];
            const r = await runOneTask(job, workerIdx, opts.basePort + workerIdx, opts.defaultMaxSteps, opts.runsDir, opts.profile, opts.patternStore, opts.learning);
            results.push(r);
            // Append result immediately so a crash mid-batch doesn't lose progress.
            try {
                await appendFile(opts.resultsPath, JSON.stringify(r) + "\n", "utf8");
            }
            catch (e) {
                console.error(`[batch] failed to append result for ${r.id}: ${e.message}`);
            }
        }
    })());
    await Promise.all(workers);
    return results;
}
async function main() {
    const wantsHelp = has("--help") || has("-h");
    const jobsPath = arg("--jobs");
    const concurrency = Math.max(1, Number(arg("--concurrency", "2")));
    const basePort = Number(arg("--base-port", "9222"));
    const runsDir = resolve(arg("--runs-dir", join(process.cwd(), "runs", "batch")));
    const profilePath = resolve(arg("--profile", join(process.cwd(), "profile", "profile.json")));
    const patternsDir = resolve(arg("--patterns", PagePatternStore.defaultPath(process.cwd())));
    const learningPath = resolve(arg("--learning", LearningStore.defaultPath(process.cwd())));
    const defaultMaxSteps = Number(arg("--max-steps", "80"));
    if (wantsHelp || !jobsPath) {
        console.log(`Usage:
  node dist/local-runner/batch.js --jobs ./jobs.jsonl [options]

Required:
  --jobs <path.jsonl>        JSONL file, one job per line: { "task", "url"?, "context"?, "maxSteps"?, "model"? }

Optional:
  --concurrency 2            Number of parallel workers (and Chrome targets)
  --base-port 9222           First worker uses this port; worker N uses basePort+N
  --runs-dir ./runs/batch    Where per-task run dirs go
  --profile ./profile/profile.json
  --patterns ./patterns
  --learning ./.local-agent/learning.json
  --max-steps 80             Default per-task step budget (job.maxSteps overrides)

Chrome setup (one per concurrency slot):
  chrome.exe --remote-debugging-port=9222 --user-data-dir="…\\chrome-batch-0"
  chrome.exe --remote-debugging-port=9223 --user-data-dir="…\\chrome-batch-1"
  chrome.exe --remote-debugging-port=9224 --user-data-dir="…\\chrome-batch-2"

Outputs:
  <runs-dir>/<stamp>/         One per task (log.json, actions.json, replay.mjs, metrics.json)
  <runs-dir>/batch-results.jsonl   Appended per-task result line
  <runs-dir>/batch-summary.json    Final aggregated summary`);
        process.exit(wantsHelp ? 0 : 1);
    }
    const jobs = await loadJobs(jobsPath);
    if (jobs.length === 0) {
        console.error(`[batch] no valid jobs found in ${jobsPath}`);
        process.exit(1);
    }
    await mkdir(runsDir, { recursive: true });
    const resultsPath = join(runsDir, "batch-results.jsonl");
    // Truncate prior results file at the start of a new batch (callers wanting to
    // resume should pass a fresh --runs-dir).
    await writeFile(resultsPath, "", "utf8");
    const [profile, learning] = await Promise.all([
        loadProfile(profilePath),
        (async () => { const ls = new LearningStore(learningPath); await ls.load(); return ls; })(),
    ]);
    const patternStore = new PagePatternStore(patternsDir);
    console.error(`[batch] ${jobs.length} job(s) × concurrency ${concurrency} on ports ${basePort}..${basePort + concurrency - 1}`);
    console.error(`[batch] runs dir: ${runsDir}`);
    console.error(`[batch] profile:  ${profilePath}`);
    console.error(`[batch] patterns: ${patternsDir}`);
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const results = await runPool({
        jobs, concurrency, basePort, runsDir, defaultMaxSteps,
        profile, patternStore, learning, resultsPath,
    });
    // Aggregate summary.
    const byStatus = {};
    let totalCalls = 0, totalIn = 0, totalOut = 0;
    for (const r of results) {
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
        totalCalls += r.usage.apiCalls;
        totalIn += r.usage.inputTokens;
        totalOut += r.usage.outputTokens;
    }
    const summary = {
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        jobs: jobs.length,
        concurrency,
        byStatus,
        totalApiCalls: totalCalls,
        totalInputTokens: totalIn,
        totalOutputTokens: totalOut,
    };
    await writeFile(join(runsDir, "batch-summary.json"), JSON.stringify(summary, null, 2), "utf8");
    console.error(`\n[batch] DONE — ${jobs.length} job(s) in ${Math.round((Date.now() - startMs) / 1000)}s`);
    console.error(`        statuses:    ${Object.entries(byStatus).map(([k, v]) => `${k}:${v}`).join(" ")}`);
    console.error(`        api calls:   ${totalCalls}`);
    console.error(`        input tok:   ${totalIn.toLocaleString()}`);
    console.error(`        output tok:  ${totalOut.toLocaleString()}`);
    console.error(`        results:     ${resultsPath}`);
    console.error(`        summary:     ${join(runsDir, "batch-summary.json")}`);
    // Exit non-zero if any job didn't complete successfully — useful for CI.
    if ((byStatus["complete"] || 0) < jobs.length)
        process.exitCode = 2;
}
main().catch((err) => {
    console.error(`[batch] Fatal: ${err.message}`);
    process.exit(1);
});
