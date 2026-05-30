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
import { PagePatternStore } from "../local-runner/page-pattern-store.js";
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
    previouslyCompleted?: Array<{
        fingerprint: string;
        url: string;
        pageLabel: string;
    }>;
    /** Called when a form page is detected as complete. Caller persists this. */
    onPageComplete?: (info: {
        fingerprint: string;
        url: string;
        pageLabel: string;
    }) => void;
    /** LLM model override — defaults to DEFAULT_MODEL in client.ts (Haiku). Use "claude-sonnet-4-6" for harder pages. */
    model?: string;
}
export interface ToolResult {
    success: boolean;
    output?: any;
    error?: string;
    screenshot?: {
        data: string;
        mediaType: string;
    };
}
export interface StepUpdate {
    step: number;
    status: "thinking" | "tool_use" | "tool_result" | "complete" | "error" | "pattern_replay";
    toolName?: string;
    toolInput?: Record<string, any>;
    text?: string;
    patternInfo?: {
        fingerprint: string;
        steps: number;
        matched: number;
    };
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
    usage: {
        inputTokens: number;
        outputTokens: number;
        apiCalls: number;
    };
    model?: string;
    turns?: TurnLog[];
    completedPages?: Array<{
        fingerprint: string;
        url: string;
        pageLabel: string;
    }>;
}
export declare function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult>;
