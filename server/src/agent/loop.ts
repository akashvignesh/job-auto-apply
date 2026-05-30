/**
 * Server-Side Managed Agent Loop
 *
 * Drives the browser automation agent from the server:
 * 1. Receives a task
 * 2. Calls Claude (via callLLM / @anthropic-ai/sdk) with system prompt + tools
 * 3. For each tool_use: sends execution request to extension via WebSocket relay
 * 4. Gets tool results back from extension
 * 5. Feeds results back to Claude
 * 6. Repeats until end_turn or max steps
 * 7. Returns the final answer
 *
 * Pattern replay (Phase P):
 *   When read_page returns a [fingerprint:XXX] tag and a VERIFIED pattern
 *   exists for that fingerprint (successCount ≥ 2), the loop auto-executes
 *   the fill steps via run_script WITHOUT an LLM call. Falls back to LLM if
 *   any step fails. This cuts per-page API calls from ~10 to ~2.
 *
 * Page completion tracking:
 *   completedFingerprints tracks which form pages have been fully filled this
 *   session. On restart, callers pass previouslyCompleted to inject skip-hints.
 */

import { callLLM } from "../llm/client.js";
import type {
  Message,
  ContentBlock,
  ContentBlockText,
  ContentBlockToolUse,
  LLMResponse,
} from "../llm/client.js";
import { AGENT_TOOLS } from "./tools.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { jsonrepair } from "jsonrepair";
import {
  PagePatternStore,
  parseRefsFromDom,
  extractFingerprintFromDom,
  type PagePattern,
} from "../local-runner/page-pattern-store.js";

// --- Types ---

export interface AgentLoopParams {
  task: string;
  url?: string;
  context?: string;
  executeTool: (toolName: string, toolInput: Record<string, any>) => Promise<ToolResult>;
  onStep?: (step: StepUpdate) => void;
  onText?: (chunk: string) => void;
  maxSteps?: number;
  signal?: AbortSignal;
  /** Filesystem pattern store for auto-replay (optional — degrades gracefully if absent). */
  patternStore?: PagePatternStore;
  /** Flat profile object for valueKind resolution during pattern replay. */
  profile?: Record<string, any>;
  /** Fingerprints of pages already completed in a prior session (for restart recovery). */
  previouslyCompleted?: Array<{ fingerprint: string; url: string; pageLabel: string }>;
  /** Called when a form page is detected as complete. Caller persists this. */
  onPageComplete?: (info: { fingerprint: string; url: string; pageLabel: string }) => void;
  /** LLM model override — defaults to DEFAULT_MODEL in client.ts (Haiku). Use "claude-sonnet-4-6" for harder pages. */
  model?: string;
}

export interface ToolResult {
  success: boolean;
  output?: any;
  error?: string;
  screenshot?: { data: string; mediaType: string };
}

export interface StepUpdate {
  step: number;
  status: "thinking" | "tool_use" | "tool_result" | "complete" | "error" | "pattern_replay";
  toolName?: string;
  toolInput?: Record<string, any>;
  text?: string;
  patternInfo?: { fingerprint: string; steps: number; matched: number };
}

export interface TurnLog {
  step: number;
  tools: Array<{
    name: string;
    input: Record<string, any>;
    result: string;
    durationMs: number;
  }>;
  ai_response: string | null;
  patternReplay?: boolean;
}

export interface AgentLoopResult {
  status: "complete" | "error" | "max_steps";
  answer: string;
  steps: number;
  usage: { inputTokens: number; outputTokens: number; apiCalls: number };
  model?: string;
  turns?: TurnLog[];
  completedPages?: Array<{ fingerprint: string; url: string; pageLabel: string }>;
}

// --- Token Reduction Helpers ---

const CONTEXT_WINDOW_SIZE = 20;

function pruneOldScreenshots(messages: Message[], keepLast = 2): Message[] {
  const imageMessageIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const hasImage = (msg.content as any[]).some(
        (b: any) =>
          b.type === "tool_result" &&
          Array.isArray(b.content) &&
          b.content.some((c: any) => c.type === "image")
      );
      if (hasImage) imageMessageIndices.push(i);
    }
  }
  const toStrip = new Set(imageMessageIndices.slice(0, -keepLast));
  if (toStrip.size === 0) return messages;
  return messages.map((msg, i) => {
    if (!toStrip.has(i)) return msg;
    const content = (msg.content as any[]).map((block: any) => {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) return block;
      return { ...block, content: block.content.filter((c: any) => c.type !== "image") };
    });
    return { ...msg, content };
  });
}

function windowMessages(messages: Message[], windowSize = CONTEXT_WINDOW_SIZE): Message[] {
  if (messages.length <= windowSize + 1) return messages;
  let sliceStart = messages.length - windowSize;
  // Always start the retained window on an ASSISTANT message so every tool_result
  // in the window has its corresponding tool_use in the immediately preceding
  // assistant message. Starting on a user message would create an orphaned
  // tool_result that references a tool_use_id the API can no longer see.
  while (sliceStart < messages.length - 1 && messages[sliceStart].role !== "assistant") {
    sliceStart++;
  }
  return [messages[0], ...messages.slice(sliceStart)];
}

// --- Pattern Replay ---

/**
 * Attempt to auto-fill a known form page using a verified pattern.
 * Returns { success, summary } — summary is injected into messages.
 * Falls back gracefully on any failure.
 */
async function attemptPatternReplay(
  pattern: PagePattern,
  domText: string,
  profile: Record<string, any>,
  patternStore: PagePatternStore,
  executeTool: AgentLoopParams["executeTool"],
  onStep: AgentLoopParams["onStep"] | undefined,
  step: number
): Promise<{ success: boolean; summary: string; matched: number }> {
  try {
    const refMap = parseRefsFromDom(domText);
    const actions = patternStore.buildReplayBatch(pattern, refMap, profile);

    if (!actions || actions.length < 2) {
      return { success: false, summary: "Pattern replay skipped: too few refs resolved.", matched: 0 };
    }

    onStep?.({
      step,
      status: "pattern_replay",
      patternInfo: { fingerprint: pattern.fingerprint, steps: pattern.steps.length, matched: actions.length },
    });

    console.error(
      `[PatternReplay] ${pattern.formLabel || pattern.fingerprint}: replaying ${actions.length}/${pattern.steps.length} steps`
    );

    // Execute as a single run_script batch — one extension round-trip.
    const result = await executeTool("run_script", {
      actions,
      stopOnError: false,
    });

    const resultText = result.error
      ? `Error: ${result.error}`
      : typeof result.output === "string"
      ? result.output
      : JSON.stringify(result.output);

    const failCount = (resultText.match(/FAIL|error|failed/gi) || []).length;
    const success = !result.error && failCount < Math.ceil(actions.length / 3);

    const summary = [
      `[PatternReplay] Form: "${pattern.formLabel || pattern.fingerprint}" (${pattern.successCount} prior successes)`,
      `Auto-executed ${actions.length} steps from verified pattern. ${success ? "All critical steps succeeded." : `${failCount} step(s) had errors — verify the page state.`}`,
      `Results:\n${resultText.slice(0, 800)}`,
      success
        ? "Page fill complete via pattern replay. Please verify with verify_action or read_page, then advance to the next page."
        : "Partial pattern replay. Review the errors above and manually fill any failed fields.",
    ].join("\n");

    return { success, summary, matched: actions.length };
  } catch (err: any) {
    return {
      success: false,
      summary: `Pattern replay failed: ${err.message}`,
      matched: 0,
    };
  }
}

// --- Agent Loop ---

export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const {
    task,
    url,
    context,
    executeTool,
    onStep,
    onText,
    maxSteps = 50,
    signal,
    patternStore,
    profile = {},
    previouslyCompleted = [],
    onPageComplete,
    model,
  } = params;

  const targetUrl = url || task.match(/https?:\/\/[^\s"')]+/)?.[0];

  // Build system prompt. Pass profile and patternStore for injection.
  const system = buildSystemPrompt(targetUrl, profile);
  const tools = AGENT_TOOLS;
  const messages: Message[] = [];
  const turns: TurnLog[] = [];
  let totalUsage = { inputTokens: 0, outputTokens: 0, apiCalls: 0 };
  let lastModel: string | undefined;

  // Phase 5: Loop detection
  const urlHistory: string[] = [];
  const actionLog: string[] = [];
  let budgetWarningInjected = false;

  // Phase 7.5 — hard guards. Track per-(tool,input) failure counts and the last
  // full-DOM read state so we can refuse to execute the same failing action a
  // third time and refuse to dispatch a malformed `computer` call to the extension.
  const failedActionCounts = new Map<string, number>();
  let consecutiveFullReadDomKey: string | null = null;
  let consecutiveFullReadCount = 0;

  // Page completion tracking
  const completedPages = new Map<string, { fingerprint: string; url: string; pageLabel: string }>();
  for (const p of previouslyCompleted) {
    completedPages.set(p.fingerprint, p);
  }

  // Pattern replay state — track which fingerprints we've already attempted
  // replay on so we don't double-execute on consecutive identical reads.
  const replayAttempted = new Set<string>();

  // Track last read_page output for pattern detection
  let lastDomText = "";
  let lastDomFingerprint: string | null = null;
  let currentUrl = targetUrl || "";

  // Build initial user message
  let userMessage = task;
  if (url) userMessage = `Navigate to ${url} first, then: ${task}`;
  if (context) userMessage += `\n\n<context>\n${context}\n</context>`;

  // Inject restart-recovery hint for previously completed pages
  if (previouslyCompleted.length > 0) {
    const skipList = previouslyCompleted
      .map((p) => `  - "${p.pageLabel || p.fingerprint}" (${p.url})`)
      .join("\n");
    userMessage += `\n\n<restart_recovery>
These form pages were FULLY COMPLETED in a previous session. DO NOT re-fill them:
${skipList}
Navigate past them using "Save and Continue" or similar to reach the next incomplete page.
If the browser is already past them, continue from the current page.
</restart_recovery>`;
  }

  messages.push({ role: "user", content: userMessage });

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) {
      return { status: "error", answer: "Task was cancelled.", steps: step - 1, usage: totalUsage, model: lastModel, turns, completedPages: [...completedPages.values()] };
    }

    onStep?.({ step, status: "thinking" });

    // Phase 5: Budget awareness at 75%
    if (!budgetWarningInjected && step / maxSteps >= 0.75) {
      budgetWarningInjected = true;
      messages.push({
        role: "user",
        content: `<system_note>You have used ${step} of ${maxSteps} steps (${Math.round((step / maxSteps) * 100)}% of budget). Focus on the highest-priority remaining items only.</system_note>`,
      });
    }

    const messagesForCall = windowMessages(pruneOldScreenshots(messages, 2));
    let response: LLMResponse;
    try {
      response = await callLLM({ messages: messagesForCall, system, tools, signal, onText, ...(model ? { model } : {}) });
    } catch (err: any) {
      console.error(`[AgentLoop] LLM call failed at step ${step}:`, err.message);
      return { status: "error", answer: `LLM call failed: ${err.message}`, steps: step, usage: totalUsage, model: lastModel, turns, completedPages: [...completedPages.values()] };
    }

    totalUsage.apiCalls++;
    totalUsage.inputTokens += response.usage?.input_tokens || 0;
    totalUsage.outputTokens += response.usage?.output_tokens || 0;
    if (response.model) lastModel = response.model;

    const assistantMsg: any = { role: "assistant", content: response.content };
    if ((response as any)._rawGeminiParts) assistantMsg._rawGeminiParts = (response as any)._rawGeminiParts;
    messages.push(assistantMsg);

    const textBlocks = response.content.filter((b): b is ContentBlockText => b.type === "text");
    const toolUseBlocks = response.content.filter((b): b is ContentBlockToolUse => b.type === "tool_use");

    const currentTurn: TurnLog = {
      step,
      tools: [],
      ai_response: textBlocks.map((b) => b.text).join("\n").trim() || null,
    };

    if (toolUseBlocks.length === 0) {
      const answer = textBlocks.map((b) => b.text).join("\n").trim();
      turns.push(currentTurn);
      console.error(`[AgentLoop] Complete at step ${step} (${totalUsage.apiCalls} API calls, ${totalUsage.inputTokens} input tokens)`);
      onStep?.({ step, status: "complete", text: answer });
      return { status: "complete", answer: answer || "Task completed.", steps: step, usage: totalUsage, model: lastModel, turns, completedPages: [...completedPages.values()] };
    }

    const allowedToolNames = new Set(tools.map((t) => t.name));
    const toolResults: ContentBlock[] = [];

    for (const toolUse of toolUseBlocks) {
      if (!allowedToolNames.has(toolUse.name)) {
        console.error(`[AgentLoop] LLM requested unknown tool: ${toolUse.name}`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: [{ type: "text", text: `Error: Unknown tool "${toolUse.name}". Available: ${[...allowedToolNames].join(", ")}` }],
        } as any);
        continue;
      }

      const inputSummary =
        toolUse.name === "navigate" ? toolUse.input.url
        : toolUse.name === "computer" ? `${toolUse.input.action}${toolUse.input.ref ? ` ref=${toolUse.input.ref}` : ""}`
        : toolUse.name === "javascript_tool" ? toolUse.input.text?.slice(0, 80)
        : JSON.stringify(toolUse.input).slice(0, 80);
      console.error(`[AgentLoop] Step ${step}: ${toolUse.name}(${inputSummary})`);

      onStep?.({ step, status: "tool_use", toolName: toolUse.name, toolInput: toolUse.input });

      // Phase 7.5 — pre-flight guards. These short-circuit BEFORE the extension
      // round-trip so a malformed call or a confirmed-stuck loop doesn't cost
      // a tool execution + a follow-up LLM call to "process" the error.
      let result: ToolResult | null = null;
      const actionKey = `${toolUse.name}:${stableKey(toolUse.input)}`;

      // Guard 1: malformed `computer` call. The Anthropic tool schema lets the
      // LLM pass minimal/missing fields when it gets confused; the extension
      // then throws a vague error and the LLM tries the same broken call again.
      // Reject those at the loop boundary with an actionable message.
      if (toolUse.name === "computer") {
        const malformed = checkComputerMalformed(toolUse.input);
        if (malformed) {
          result = { success: false, error: malformed };
        }
      }

      // Guard 2: hard-block a third identical failure. The previous "you are
      // stuck" warning was advisory; the LLM ignored it. Now the third attempt
      // returns an error tool_result without invoking the extension, plus an
      // explicit instruction to vary the approach.
      if (!result) {
        const failCount = failedActionCounts.get(actionKey) || 0;
        if (failCount >= 2) {
          result = {
            success: false,
            error: `BLOCKED: this exact tool call has already failed ${failCount} times this run. Repeating it will fail again. Choose a different approach: change the ref, switch tool (e.g., form_input → computer, computer → javascript_tool for inspection), call read_page mode="errors" to see what the page is rejecting, or escalate.`,
          };
        }
      }

      // Guard 3: throttle full-mode read_page on the SAME unchanged DOM. The
      // extension already caps two collapses (MAX_COLLAPSE=2). If the LLM keeps
      // requesting mode="full" on a hash we've already collapsed twice, reject
      // here and redirect to mode="errors" / verify_action.
      if (!result && toolUse.name === "read_page" && (toolUse.input.mode === "full" || toolUse.input.mode === undefined)) {
        // Only enforce when explicitly mode="full"; default summary is cheap enough.
        if (toolUse.input.mode === "full"
            && consecutiveFullReadDomKey !== null
            && consecutiveFullReadCount >= 2) {
          result = {
            success: false,
            error: `BLOCKED: read_page mode="full" called ${consecutiveFullReadCount + 1} times on the unchanged DOM. Switch to mode="errors" or mode="summary", or call verify_action — full re-read of the same state yields nothing new.`,
          };
        }
      }

      const toolStartMs = Date.now();
      if (result === null) {
        try {
          result = await executeTool(toolUse.name, toolUse.input);
        } catch (err: any) {
          const isTransient =
            err.message?.includes("timed out") ||
            err.message?.includes("not connected") ||
            err.message?.includes("Relay");
          if (isTransient && !signal?.aborted) {
            console.error(`[AgentLoop] Transient error on ${toolUse.name}, retrying once: ${err.message}`);
            try {
              result = await executeTool(toolUse.name, toolUse.input);
            } catch (retryErr: any) {
              result = { success: false, error: `${retryErr.message} (after retry)` };
            }
          } else {
            result = { success: false, error: err.message };
          }
        }
      }

      // Phase 7.5 — update failure counter so future identical calls are blocked.
      if (result.error) {
        failedActionCounts.set(actionKey, (failedActionCounts.get(actionKey) || 0) + 1);
      } else {
        failedActionCounts.delete(actionKey);
      }

      // Phase 7.5 — track consecutive full-mode read_page on the same DOM.
      if (toolUse.name === "read_page" && toolUse.input.mode === "full" && !result.error) {
        const txt = typeof result.output === "string" ? result.output : "";
        const key = djb2(txt.slice(0, 4000));
        if (key === consecutiveFullReadDomKey) {
          consecutiveFullReadCount += 1;
        } else {
          consecutiveFullReadDomKey = key;
          consecutiveFullReadCount = 1;
        }
      } else if (toolUse.name !== "read_page") {
        // Any other tool resets the consecutive counter — the page may have moved.
        consecutiveFullReadDomKey = null;
        consecutiveFullReadCount = 0;
      }

      const toolDurationMs = Date.now() - toolStartMs;
      const resultText = result.error
        ? `Error: ${result.error}`
        : typeof result.output === "string"
        ? result.output
        : JSON.stringify(result.output);
      const resultSummary = resultText.length > 120 ? resultText.slice(0, 120) + "..." : resultText;
      console.error(`[AgentLoop] Step ${step}: ${toolUse.name} → ${resultSummary}`);

      currentTurn.tools.push({
        name: toolUse.name,
        input: toolUse.input,
        result: resultText.length > 5000 ? resultText.slice(0, 5000) + "... [truncated]" : resultText,
        durationMs: toolDurationMs,
      });

      onStep?.({ step, status: "tool_result", toolName: toolUse.name });

      if (signal?.aborted) {
        turns.push(currentTurn);
        return { status: "error", answer: "Task was cancelled.", steps: step, usage: totalUsage, model: lastModel, turns, completedPages: [...completedPages.values()] };
      }

      // Track navigation URL changes
      if (toolUse.name === "navigate" && toolUse.input.url && !["forward", "back"].includes(toolUse.input.url)) {
        currentUrl = toolUse.input.url;
      }
      urlHistory.push(currentUrl);
      actionLog.push(`${toolUse.name}:${JSON.stringify(toolUse.input).slice(0, 40)}`);

      // ── Phase P: Pattern Replay ───────────────────────────────────────────
      // After a read_page result, check for a [fingerprint:XXX] tag.
      // If a verified pattern exists, auto-execute without an extra LLM call.
      let finalText = resultText;

      if (toolUse.name === "read_page" && !result.error) {
        const domText = resultText;
        lastDomText = domText;

        const fingerprint = extractFingerprintFromDom(domText);
        if (fingerprint && fingerprint !== lastDomFingerprint) {
          lastDomFingerprint = fingerprint;

          // Check if this page is already complete in this session
          if (completedPages.has(fingerprint)) {
            const pg = completedPages.get(fingerprint)!;
            finalText +=
              `\n\n[PAGE_ALREADY_COMPLETE] This form page ("${pg.pageLabel || pg.fingerprint}") was already filled in a previous session or earlier in this session. Skip its fields and click Save & Continue / Next to advance.`;
          } else if (patternStore && !replayAttempted.has(fingerprint)) {
            // Attempt pattern replay for unfinished but known pages
            const domain = extractDomain(currentUrl);
            if (domain) {
              const pattern = await patternStore.getPattern(domain, fingerprint);
              if (pattern && pattern.successCount >= 2) {
                replayAttempted.add(fingerprint);
                currentTurn.patternReplay = true;

                const flatProfile = flattenProfile(profile);
                const replayResult = await attemptPatternReplay(
                  pattern, domText, flatProfile, patternStore, executeTool, onStep, step
                );

                finalText += `\n\n${replayResult.summary}`;

                if (replayResult.success) {
                  // Mark page complete and notify caller for persistence
                  const pageInfo = {
                    fingerprint,
                    url: currentUrl,
                    pageLabel: pattern.formLabel || fingerprint,
                  };
                  completedPages.set(fingerprint, pageInfo);
                  onPageComplete?.(pageInfo);
                  console.error(`[PatternReplay] Page "${pattern.formLabel}" completed via pattern (${replayResult.matched} steps)`);
                }
              } else if (pattern) {
                // Low-confidence pattern — inject as hint only
                finalText += `\n\n[PATTERN_HINT] This form matches a known pattern with ${pattern.successCount} success(es) but confidence is below auto-replay threshold. Consider following the learned steps: ${pattern.steps.slice(0, 5).map(s => s.label).filter(Boolean).join(", ")}...`;
              }
            }
          }
        }
      }

      // ── Phase 5: Loop detection ───────────────────────────────────────────
      if (urlHistory.length >= 3) {
        const last3Urls = urlHistory.slice(-3);
        if (last3Urls.every((u) => u === last3Urls[0])) {
          finalText += "\n[SYSTEM: Same URL for 3 consecutive steps — try scrolling, taking a screenshot, or a completely different approach]";
        }
      }
      if (actionLog.length >= 3) {
        const last3 = actionLog.slice(-3);
        if (last3[0] === last3[1] && last3[1] === last3[2]) {
          finalText += "\n[SYSTEM: Same action repeated 3 times — you are stuck in a loop. Take a completely different approach.]";
        }
      }

      const resultContent: Array<ContentBlockText | { type: "image"; source: any }> = [
        { type: "text", text: finalText },
      ];

      if (result.screenshot) {
        resultContent.push({
          type: "image",
          source: { type: "base64", media_type: result.screenshot.mediaType, data: result.screenshot.data },
        });
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: resultContent,
      } as any);
    }

    messages.push({ role: "user", content: toolResults });
    turns.push(currentTurn);
  }

  // Exceeded max steps
  const lastText = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text)
        : [m.content]
    )
    .pop();

  return {
    status: "max_steps",
    answer: lastText || "Task did not complete within the step limit.",
    steps: maxSteps,
    usage: totalUsage,
    model: lastModel,
    turns,
    completedPages: [...completedPages.values()],
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Phase 7.5 — cheap stable stringification of tool input so repeats key the same. */
function stableKey(input: any): string {
  if (input == null || typeof input !== "object") return JSON.stringify(input);
  const sortedKeys = Object.keys(input).sort();
  const trimmed: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    const v = input[k];
    // Drop volatile fields and oversized strings so the key is bounded.
    if (k === "tabId" || k === "imageId") continue;
    if (typeof v === "string" && v.length > 200) {
      trimmed[k] = v.slice(0, 200);
    } else {
      trimmed[k] = v;
    }
  }
  return JSON.stringify(trimmed);
}

/**
 * Phase 7.5 — validate a `computer` tool input before dispatching to the extension.
 * Returns an actionable error message if the call is malformed, otherwise null.
 * Catches the most common LLM mistakes (action missing, scroll without coordinate,
 * left_click without ref or coordinate, etc.).
 */
function checkComputerMalformed(input: any): string | null {
  if (input == null || typeof input !== "object") {
    return 'computer call has no input object. Provide { action, ... }.';
  }
  const action = input.action;
  if (typeof action !== "string" || action.length === 0) {
    return 'computer call missing "action". Pass action: "left_click" | "type" | "scroll" | "screenshot" | "key" | "wait" | "scroll_to" | "hover" | "left_click_drag" | "double_click" | "triple_click" | "zoom".';
  }
  const needsRefOrCoord = ["left_click", "right_click", "double_click", "triple_click", "hover"];
  if (needsRefOrCoord.includes(action) && input.ref == null && !Array.isArray(input.coordinate)) {
    return `computer action="${action}" needs either ref (from read_page) or coordinate=[x,y]. Prefer ref; coordinate is a last resort.`;
  }
  if (action === "scroll" && !Array.isArray(input.coordinate)) {
    return 'computer action="scroll" needs coordinate=[x,y] (the point to scroll at). Default to [500, 400] if you have no specific target.';
  }
  if (action === "type" && typeof input.text !== "string") {
    return 'computer action="type" needs text. Pass text: "...". For form fields, use the form_input tool instead.';
  }
  if (action === "key" && typeof input.text !== "string") {
    return 'computer action="key" needs text (the key name or chord, e.g., "Enter" or "ctrl+a").';
  }
  if (action === "wait" && !(typeof input.duration === "number" && input.duration > 0)) {
    return 'computer action="wait" needs duration (seconds, 1-30).';
  }
  if (action === "scroll_to" && input.ref == null) {
    return 'computer action="scroll_to" needs ref (from read_page).';
  }
  if (action === "left_click_drag") {
    if (!Array.isArray(input.start_coordinate) || !Array.isArray(input.coordinate)) {
      return 'computer action="left_click_drag" needs start_coordinate=[x,y] AND coordinate=[x,y].';
    }
  }
  if (action === "zoom" && (!Array.isArray(input.region) || input.region.length !== 4)) {
    return 'computer action="zoom" needs region=[x0,y0,x1,y1].';
  }
  return null;
}

/** Cheap djb2 hash for fingerprinting tool result text. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

function flattenProfile(profile: Record<string, any>, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(profile || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v == null) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      flattenProfile(v, key, out);
    } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[key] = String(v);
    }
  }
  return out;
}
