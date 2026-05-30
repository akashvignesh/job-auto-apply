export interface LocalRunLog {
    task: string;
    url?: string;
    startTime: string;
    endTime?: string;
    status: string;
    model?: string;
    usage: {
        inputTokens: number;
        outputTokens: number;
        apiCalls: number;
    };
    turns: any[];
    analysis?: any;
}
export declare class RunLogger {
    readonly dir: string;
    private screenshotCount;
    private log;
    constructor(baseDir: string, task: string, url?: string);
    init(): Promise<void>;
    saveScreenshot(base64: string): Promise<void>;
    complete(params: {
        status: string;
        model?: string;
        usage: LocalRunLog["usage"];
        turns: any[];
        analysis?: any;
    }): Promise<void>;
    private flush;
    private writeReplayArtifacts;
}
export declare function analyzeTurns(turns: any[]): any;
/**
 * Render the Phase 7 metrics block for the run summary. Stable text format
 * so it can be diff'd between runs.
 */
export declare function formatMetricsSummary(usage: {
    inputTokens: number;
    outputTokens: number;
    apiCalls: number;
}, analysis: any): string;
