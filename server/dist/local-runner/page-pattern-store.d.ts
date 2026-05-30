/**
 * Filesystem-based page pattern store.
 *
 * Stores verified interaction patterns in patterns/<domain>.json so they
 * survive Chrome profile wipes, are version-controllable, and are shareable —
 * a new user only needs to change profile.json, not re-collect patterns.
 *
 * Pattern lifecycle:
 *   1. Extension records steps via plan-recorder.js → IDB (learned-plans.js)
 *   2. After a successful task, cli.ts exports IDB plans → this store
 *   3. On the next run, loop.ts reads patterns → if fingerprint matches a
 *      VERIFIED plan (successCount ≥ 2), auto-builds a run_script batch and
 *      executes it without an LLM call (pattern replay mode)
 *   4. If replay fails on any step, falls back to normal LLM guidance
 *
 * Storage layout:
 *   patterns/
 *     workday.wd5.myworkdayjobs.com.json
 *     greenhouse.io.json
 *     lever.co.json
 *     ...
 */
export interface PatternStep {
    tool: string;
    action?: string;
    label?: string;
    role?: string;
    valueKind?: string;
    value?: string;
    selectorHint?: string;
    variants?: Array<{
        selectorHint: string;
        firstSeenOn: string;
        successCount: number;
    }>;
}
export interface PagePattern {
    fingerprint: string;
    formLabel: string;
    domain: string;
    pageUrl?: string;
    steps: PatternStep[];
    mistakes?: Array<{
        tool: string;
        label: string;
        error: string;
        count: number;
    }>;
    successCount: number;
    firstSeen: string;
    lastSuccess: string;
}
interface DomainFile {
    domain: string;
    updatedAt: string;
    patterns: PagePattern[];
}
export declare class PagePatternStore {
    private dir;
    private cache;
    constructor(dir: string);
    static defaultPath(cwd?: string): string;
    private sanitizeDomain;
    private domainFile;
    /** Load all patterns for a domain, using in-memory cache. */
    load(domain: string): Promise<DomainFile>;
    /** Persist the domain file to disk. */
    private flush;
    /** Exact-fingerprint lookup — O(n) scan of the domain file (usually < 20 patterns). */
    getPattern(domain: string, fingerprint: string): Promise<PagePattern | null>;
    /** All patterns for a domain, sorted by successCount descending. */
    listPatterns(domain: string): Promise<PagePattern[]>;
    /**
     * Upsert a pattern from a completed run.
     * If the fingerprint already exists, increments successCount and merges steps.
     */
    savePattern(domain: string, pattern: Omit<PagePattern, "successCount" | "firstSeen" | "lastSuccess"> & Partial<Pick<PagePattern, "successCount" | "firstSeen" | "lastSuccess">>): Promise<void>;
    /**
     * Build a system-prompt hint block for all known patterns on a domain.
     * Injected BEFORE the task starts so the LLM knows what to expect.
     * Only includes VERIFIED patterns (successCount >= 2) to avoid misleading hints.
     */
    buildDomainHint(domain: string): Promise<string>;
    /**
     * Build a run_script-ready batch from a pattern + resolved ref map.
     * Returns null if too many steps can't be resolved.
     *
     * @param pattern - The pattern to replay
     * @param refMap  - Map of label (lowercased) → live backendNodeId from read_page
     * @param profile - Flat profile object for valueKind resolution
     */
    buildReplayBatch(pattern: PagePattern, refMap: Map<string, string>, profile: Record<string, any>): Array<{
        tool: string;
        input: Record<string, any>;
    }> | null;
    /** List all domains that have pattern files. */
    listDomains(): Promise<string[]>;
    /** Export summary for logging. */
    summary(): Promise<string>;
}
/**
 * Parse a read_page DOM string to build a label→ref map.
 * The serializer outputs lines like: [1234]<input aria-label="First Name" ...>
 * Returns Map<labelLower, ref>.
 */
export declare function parseRefsFromDom(domText: string): Map<string, string>;
/**
 * Extract form fingerprint from a read_page output string.
 * The read-page-core appends a `[fingerprint:XXXX]` tag when a fingerprint
 * is available. Returns null when the tag is absent (first read on a new page).
 */
export declare function extractFingerprintFromDom(domText: string): string | null;
export {};
