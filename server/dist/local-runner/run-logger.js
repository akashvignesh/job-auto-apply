import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
export class RunLogger {
    dir;
    screenshotCount = 0;
    log;
    constructor(baseDir, task, url) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        this.dir = join(baseDir, stamp);
        this.log = {
            task,
            url,
            startTime: new Date().toISOString(),
            status: "running",
            usage: { inputTokens: 0, outputTokens: 0, apiCalls: 0 },
            turns: [],
        };
    }
    async init() {
        await mkdir(this.dir, { recursive: true });
        await this.flush();
    }
    async saveScreenshot(base64) {
        this.screenshotCount++;
        await writeFile(join(this.dir, `screenshot_${this.screenshotCount}.jpg`), Buffer.from(base64, "base64"));
    }
    async complete(params) {
        this.log.status = params.status;
        this.log.endTime = new Date().toISOString();
        this.log.model = params.model;
        this.log.usage = params.usage;
        this.log.turns = params.turns;
        this.log.analysis = params.analysis;
        await this.flush();
        await this.writeReplayArtifacts(params.turns);
        // Phase 7.7 — write metrics.json beside log.json so external tooling
        // (cost dashboards, regression tests) can ingest without parsing the
        // full conversation log.
        if (params.analysis) {
            const metrics = {
                startTime: this.log.startTime,
                endTime: this.log.endTime,
                status: this.log.status,
                model: this.log.model,
                usage: this.log.usage,
                analysis: this.log.analysis,
            };
            await writeFile(join(this.dir, "metrics.json"), JSON.stringify(metrics, null, 2), "utf8");
        }
    }
    async flush() {
        await writeFile(join(this.dir, "log.json"), JSON.stringify(this.log, null, 2), "utf8");
    }
    async writeReplayArtifacts(turns) {
        const actions = extractReplayableActions(turns);
        await writeFile(join(this.dir, "actions.json"), JSON.stringify(actions, null, 2), "utf8");
        const here = dirname(fileURLToPath(import.meta.url));
        const cdpUrl = pathToFileURL(join(here, "cdp.js")).href;
        const browserUrl = pathToFileURL(join(here, "browser.js")).href;
        const script = `#!/usr/bin/env node
import { createOrAttachTarget, CdpSession } from ${JSON.stringify(cdpUrl)};
import { LocalBrowser } from ${JSON.stringify(browserUrl)};

const actions = ${JSON.stringify(actions, null, 2)};
const debugPortArg = process.argv.find((x) => x.startsWith("--debug-port="));
const debugPort = debugPortArg ? Number(debugPortArg.split("=")[1]) : 9222;
const startUrl = process.argv.find((x) => /^https?:\\/\\//i.test(x)) || ${JSON.stringify(this.log.url || "")};

const target = await createOrAttachTarget(debugPort, startUrl || undefined);
const cdp = new CdpSession(target.webSocketDebuggerUrl);
const browser = new LocalBrowser(cdp);
await browser.init();

for (const [i, action] of actions.entries()) {
  const result = await browser.executeTool(action.name, action.input || {});
  console.log(\`[\${result.success ? "OK" : "FAIL"}] #\${i + 1} \${action.name}: \${result.error || result.output || ""}\`);
  if (!result.success) process.exitCode = 1;
}

cdp.close();
`;
        await writeFile(join(this.dir, "replay.mjs"), script, "utf8");
    }
}
export function analyzeTurns(turns) {
    const toolCounts = {};
    const repeatedActions = new Map();
    let readPageCount = 0;
    let failures = 0;
    // Phase 7.7 — per-feature metrics.
    const readPageByMode = {
        summary: 0, actions: 0, errors: 0, form_summary: 0, full: 0, region: 0, unspecified: 0,
    };
    let screenshotsCaptured = 0;
    let screenshotsBlocked = 0;
    let patternReplayTurns = 0;
    let patternReplaySuccess = 0;
    let blockedMalformedComputer = 0;
    let blockedRepeatedFailure = 0;
    let blockedFullReadThrottle = 0;
    let blockedUploadClick = 0;
    let blockedSubmitClick = 0;
    let blockedCrossDomainNav = 0;
    let blockedDisabledClick = 0;
    let blockedDisabledFormInput = 0;
    let blockedReadonlyFormInput = 0;
    let dateAdaptedFills = 0;
    let formInputRejectedRevert = 0;
    let staleRefSelfHeals = 0;
    let pagesComplete = 0;
    for (const turn of turns || []) {
        if (turn.patternReplay) {
            patternReplayTurns += 1;
            // Heuristic: a pattern replay turn that didn't lead to a "Page fill complete" was a miss.
            const hadCompleteMarker = (turn.tools || []).some((t) => typeof t.result === "string" && /Page fill complete via pattern replay/.test(t.result));
            if (hadCompleteMarker)
                patternReplaySuccess += 1;
        }
        for (const tool of turn.tools || []) {
            toolCounts[tool.name] = (toolCounts[tool.name] || 0) + 1;
            const resultText = String(tool.result || "");
            // Read-mode breakdown.
            if (tool.name === "read_page") {
                readPageCount++;
                const m = String(tool.input?.mode || "unspecified");
                readPageByMode[m] = (readPageByMode[m] || 0) + 1;
            }
            // Screenshots: distinguish actually-captured from budget-blocked.
            const isScreenshotCall = (tool.name === "computer" && tool.input?.action === "screenshot")
                || (tool.name === "read_page" && tool.input?.screenshot === true);
            if (isScreenshotCall) {
                if (/Screenshot skipped|SCREENSHOT BLOCKED/.test(resultText)) {
                    screenshotsBlocked += 1;
                }
                else if (/Successfully captured screenshot/.test(resultText)) {
                    screenshotsCaptured += 1;
                }
            }
            // Phase 7.5 hard guards (loop.ts emits "BLOCKED: ..." messages).
            if (/^Error: BLOCKED:.*identical/.test(resultText))
                blockedRepeatedFailure += 1;
            if (/^Error: BLOCKED: read_page mode="full"/.test(resultText))
                blockedFullReadThrottle += 1;
            if (/^Error: computer call|^Error: computer action/.test(resultText))
                blockedMalformedComputer += 1;
            // Phase 7.3 upload click guard (computer-core.js emits this).
            if (/is blocked — clicking it would open the OS file picker/.test(resultText)) {
                blockedUploadClick += 1;
            }
            // Phase 7.8 policy guards.
            if (/BLOCKED \(policy\):.*FINAL submit/.test(resultText))
                blockedSubmitClick += 1;
            if (/BLOCKED \(policy\): cross-domain navigation/.test(resultText))
                blockedCrossDomainNav += 1;
            // Playwright actionability — pre-action gates added after the URL audit.
            if (/element is DISABLED/.test(resultText)) {
                if (tool.name === "computer")
                    blockedDisabledClick += 1;
                else if (tool.name === "form_input")
                    blockedDisabledFormInput += 1;
            }
            if (/element is READONLY/.test(resultText))
                blockedReadonlyFormInput += 1;
            // Phase 7.4 date adapter / verification.
            if (tool.name === "form_input" && /\[reformatted .* to match /.test(resultText))
                dateAdaptedFills += 1;
            if (tool.name === "form_input" && /the field is empty after blur/.test(resultText))
                formInputRejectedRevert += 1;
            // Stale-ref self-heal logs from element-resolver.
            if (/self-heal succeeded|stale ref recovered/i.test(resultText))
                staleRefSelfHeals += 1;
            // Page-complete signal from pattern replay.
            if (/Page fill complete via pattern replay/.test(resultText))
                pagesComplete += 1;
            if (/error|failed|stale|missing|BLOCKED/i.test(resultText))
                failures++;
            const key = `${tool.name}:${JSON.stringify(tool.input || {}).slice(0, 160)}`;
            repeatedActions.set(key, (repeatedActions.get(key) || 0) + 1);
        }
    }
    // Heuristic LLM-cost trim from Phase 7.1 — estimate how many input tokens we
    // saved by emitting compact modes instead of the 20K-char full DOM.
    const SUMMARY_TOKENS = 375; // ~1500 chars
    const FULL_TOKENS = 5000; // 20K-char cap
    const compactReads = (readPageByMode.summary || 0) + (readPageByMode.actions || 0)
        + (readPageByMode.errors || 0) + (readPageByMode.form_summary || 0);
    const estimatedReadPageTokensSavedVsAllFull = Math.max(0, compactReads * (FULL_TOKENS - SUMMARY_TOKENS));
    return {
        toolCounts,
        readPageCount,
        failures,
        pagesComplete,
        readPageByMode,
        screenshotsCaptured,
        screenshotsBlocked,
        patternReplayTurns,
        patternReplaySuccess,
        blockedMalformedComputer,
        blockedRepeatedFailure,
        blockedFullReadThrottle,
        blockedUploadClick,
        blockedSubmitClick,
        blockedCrossDomainNav,
        blockedDisabledClick,
        blockedDisabledFormInput,
        blockedReadonlyFormInput,
        dateAdaptedFills,
        formInputRejectedRevert,
        staleRefSelfHeals,
        estimatedReadPageTokensSavedVsAllFull,
        repeatedActions: [...repeatedActions.entries()]
            .filter(([, count]) => count > 1)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([action, count]) => ({ action, count })),
    };
}
/**
 * Render the Phase 7 metrics block for the run summary. Stable text format
 * so it can be diff'd between runs.
 */
export function formatMetricsSummary(usage, analysis) {
    const a = analysis || {};
    const mode = a.readPageByMode || {};
    const lines = [];
    lines.push("───── Phase 7 metrics ─────");
    lines.push(`API calls: ${usage.apiCalls} | input tokens: ${usage.inputTokens.toLocaleString()} | output: ${usage.outputTokens.toLocaleString()}`);
    lines.push(`read_page total: ${a.readPageCount || 0}  (summary:${mode.summary || 0} actions:${mode.actions || 0} errors:${mode.errors || 0} form_summary:${mode.form_summary || 0} full:${mode.full || 0} region:${mode.region || 0} unspecified:${mode.unspecified || 0})`);
    lines.push(`screenshots: captured ${a.screenshotsCaptured || 0} | budget-blocked ${a.screenshotsBlocked || 0}`);
    lines.push(`pattern replay: ${a.patternReplayTurns || 0} turns (${a.patternReplaySuccess || 0} flagged complete)`);
    lines.push(`pages complete: ${a.pagesComplete || 0}`);
    lines.push(`hard guards fired — malformed_computer:${a.blockedMalformedComputer || 0}  repeated_failure:${a.blockedRepeatedFailure || 0}  full_read_throttle:${a.blockedFullReadThrottle || 0}  upload_click:${a.blockedUploadClick || 0}`);
    lines.push(`policy guards fired — submit_click:${a.blockedSubmitClick || 0}  cross_domain_nav:${a.blockedCrossDomainNav || 0}`);
    lines.push(`actionability gates fired — disabled_click:${a.blockedDisabledClick || 0}  disabled_form_input:${a.blockedDisabledFormInput || 0}  readonly_form_input:${a.blockedReadonlyFormInput || 0}`);
    lines.push(`form_input — date_adapted:${a.dateAdaptedFills || 0}  rejected_revert:${a.formInputRejectedRevert || 0}  self_heals:${a.staleRefSelfHeals || 0}`);
    lines.push(`failures total: ${a.failures || 0}`);
    lines.push(`estimated read_page tokens saved vs all-full baseline: ${(a.estimatedReadPageTokensSavedVsAllFull || 0).toLocaleString()}`);
    lines.push("───────────────────────────");
    return lines.join("\n");
}
function extractReplayableActions(turns) {
    const replayable = new Set(["navigate", "computer", "form_input", "run_script", "javascript_tool", "verify_action"]);
    const actions = [];
    for (const turn of turns || []) {
        for (const tool of turn.tools || []) {
            if (!replayable.has(tool.name))
                continue;
            if (tool.success === false)
                continue;
            actions.push({ name: tool.name, input: tool.input || {}, turn: turn.turn });
        }
    }
    return actions;
}
