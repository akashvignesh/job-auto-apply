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
import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
export class PagePatternStore {
    dir;
    cache = new Map();
    constructor(dir) {
        this.dir = dir;
    }
    static defaultPath(cwd = process.cwd()) {
        return join(cwd, "patterns");
    }
    sanitizeDomain(domain) {
        return domain.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
    }
    domainFile(domain) {
        return join(this.dir, `${this.sanitizeDomain(domain)}.json`);
    }
    /** Load all patterns for a domain, using in-memory cache. */
    async load(domain) {
        const key = this.sanitizeDomain(domain);
        if (this.cache.has(key))
            return this.cache.get(key);
        try {
            const raw = await readFile(this.domainFile(domain), "utf8");
            const data = JSON.parse(raw);
            this.cache.set(key, data);
            return data;
        }
        catch {
            const empty = { domain, updatedAt: new Date().toISOString(), patterns: [] };
            this.cache.set(key, empty);
            return empty;
        }
    }
    /** Persist the domain file to disk. */
    async flush(domain) {
        const key = this.sanitizeDomain(domain);
        const data = this.cache.get(key);
        if (!data)
            return;
        await mkdir(this.dir, { recursive: true });
        data.updatedAt = new Date().toISOString();
        await writeFile(this.domainFile(domain), JSON.stringify(data, null, 2), "utf8");
    }
    /** Exact-fingerprint lookup — O(n) scan of the domain file (usually < 20 patterns). */
    async getPattern(domain, fingerprint) {
        const data = await this.load(domain);
        return data.patterns.find((p) => p.fingerprint === fingerprint) || null;
    }
    /** All patterns for a domain, sorted by successCount descending. */
    async listPatterns(domain) {
        const data = await this.load(domain);
        return [...data.patterns].sort((a, b) => b.successCount - a.successCount);
    }
    /**
     * Upsert a pattern from a completed run.
     * If the fingerprint already exists, increments successCount and merges steps.
     */
    async savePattern(domain, pattern) {
        const data = await this.load(domain);
        const now = new Date().toISOString();
        const idx = data.patterns.findIndex((p) => p.fingerprint === pattern.fingerprint);
        if (idx >= 0) {
            const existing = data.patterns[idx];
            data.patterns[idx] = {
                ...existing,
                steps: mergeSteps(existing.steps, pattern.steps),
                formLabel: pattern.formLabel || existing.formLabel,
                pageUrl: pattern.pageUrl || existing.pageUrl,
                successCount: (existing.successCount || 0) + 1,
                lastSuccess: now,
            };
        }
        else {
            data.patterns.push({
                ...pattern,
                successCount: 1,
                firstSeen: now,
                lastSuccess: now,
            });
        }
        // Cap at 100 patterns per domain, keep highest successCount
        if (data.patterns.length > 100) {
            data.patterns.sort((a, b) => b.successCount - a.successCount);
            data.patterns = data.patterns.slice(0, 100);
        }
        await this.flush(domain);
    }
    /**
     * Build a system-prompt hint block for all known patterns on a domain.
     * Injected BEFORE the task starts so the LLM knows what to expect.
     * Only includes VERIFIED patterns (successCount >= 2) to avoid misleading hints.
     */
    async buildDomainHint(domain) {
        const patterns = await this.listPatterns(domain);
        const verified = patterns.filter((p) => p.successCount >= 2).slice(0, 6);
        if (verified.length === 0)
            return "";
        const blocks = verified.map((p) => {
            const steps = p.steps
                .filter((s) => s.tool !== "navigate")
                .map((s, i) => {
                const val = s.valueKind
                    ? `→ <${s.valueKind}>`
                    : s.value != null
                        ? `→ "${s.value}"`
                        : "";
                const hint = s.selectorHint ? ` [${s.selectorHint.slice(0, 60)}]` : "";
                return `  ${i + 1}. ${s.tool}${s.action ? `[${s.action}]` : ""} label="${s.label || ""}" role=${s.role || ""}${hint} ${val}`;
            })
                .join("\n");
            const mistakeBlock = p.mistakes && p.mistakes.length > 0
                ? "\n  AVOID:\n" +
                    p.mistakes
                        .slice(0, 4)
                        .map((m) => `    ✗ ${m.tool} label="${m.label}" failed ${m.count}x: ${m.error.slice(0, 80)}`)
                        .join("\n")
                : "";
            return `[${p.formLabel || p.fingerprint}] fingerprint=${p.fingerprint} successes=${p.successCount}\n${steps}${mistakeBlock}`;
        });
        return `<learned_page_patterns domain="${domain}" count="${verified.length}">\nVERIFIED fill plans — use these as strong hints. If a step label does not appear on the live page, skip it.\n\n${blocks.join("\n\n")}\n</learned_page_patterns>`;
    }
    /**
     * Build a run_script-ready batch from a pattern + resolved ref map.
     * Returns null if too many steps can't be resolved.
     *
     * @param pattern - The pattern to replay
     * @param refMap  - Map of label (lowercased) → live backendNodeId from read_page
     * @param profile - Flat profile object for valueKind resolution
     */
    buildReplayBatch(pattern, refMap, profile) {
        const actions = [];
        let unresolved = 0;
        for (const step of pattern.steps) {
            if (step.tool === "navigate")
                continue;
            if (step.tool !== "form_input" && step.tool !== "computer")
                continue;
            const label = (step.label || "").toLowerCase().trim();
            const ref = refMap.get(label) || findBestRef(label, refMap);
            if (!ref) {
                unresolved++;
                if (unresolved > 2)
                    return null; // too many unresolved → fall back to LLM
                continue;
            }
            const value = step.valueKind
                ? resolveValueKind(step.valueKind, profile)
                : step.value;
            if (value == null)
                continue;
            if (step.tool === "form_input") {
                actions.push({ tool: "form_input", input: { ref, value: String(value) } });
            }
            else if (step.tool === "computer" && step.action === "left_click") {
                actions.push({ tool: "computer", input: { action: "left_click", ref } });
            }
        }
        return actions.length >= 2 ? actions : null;
    }
    /** List all domains that have pattern files. */
    async listDomains() {
        try {
            const files = await readdir(this.dir);
            return files
                .filter((f) => f.endsWith(".json"))
                .map((f) => f.replace(/\.json$/, "").replace(/_/g, "."));
        }
        catch {
            return [];
        }
    }
    /** Export summary for logging. */
    async summary() {
        const domains = await this.listDomains();
        const lines = [];
        for (const d of domains) {
            const patterns = await this.listPatterns(d);
            if (patterns.length > 0) {
                lines.push(`  ${d}: ${patterns.length} patterns (${patterns.filter((p) => p.successCount >= 2).length} verified)`);
            }
        }
        return lines.length > 0 ? lines.join("\n") : "  (no patterns yet)";
    }
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
/** Merge new steps into existing steps, preserving variants. Pure function. */
function mergeSteps(oldSteps, newSteps) {
    const result = oldSteps.map((s) => ({ ...s }));
    const sigOf = (s) => [s.tool, s.action || "", (s.label || "").toLowerCase(), s.role || "", s.valueKind || s.value || ""].join("::");
    const idxMap = new Map();
    result.forEach((s, i) => idxMap.set(sigOf(s), i));
    for (const ns of newSteps) {
        const sig = sigOf(ns);
        if (idxMap.has(sig)) {
            // Merge new selectorHint as variant
            const tgt = result[idxMap.get(sig)];
            const hint = ns.selectorHint || "";
            if (hint && !(tgt.selectorHint === hint)) {
                tgt.variants = tgt.variants || [];
                if (!tgt.variants.some((v) => v.selectorHint === hint)) {
                    tgt.variants.push({ selectorHint: hint, firstSeenOn: new Date().toISOString(), successCount: 1 });
                }
            }
        }
        else {
            result.push({ ...ns });
            idxMap.set(sig, result.length - 1);
        }
    }
    return result;
}
/**
 * Fuzzy label match: given a target label, find the closest key in refMap.
 * Handles partial matches (e.g. "first name" matches "firstname" or "first name *").
 */
function findBestRef(label, refMap) {
    const labelWords = label.replace(/[^a-z0-9]/g, " ").split(/\s+/).filter(Boolean);
    if (labelWords.length === 0)
        return null;
    let bestRef = null;
    let bestScore = 0;
    for (const [key, ref] of refMap) {
        const keyWords = key.replace(/[^a-z0-9]/g, " ").split(/\s+/).filter(Boolean);
        let matches = 0;
        for (const w of labelWords) {
            if (keyWords.some((kw) => kw.startsWith(w) || w.startsWith(kw)))
                matches++;
        }
        const score = matches / Math.max(labelWords.length, keyWords.length);
        if (score > bestScore && score >= 0.6) {
            bestScore = score;
            bestRef = ref;
        }
    }
    return bestRef;
}
/**
 * Resolve a valueKind string (e.g. "profile.personal.firstName") against the
 * flat profile object. Supports dot-notation for nested keys.
 */
function resolveValueKind(valueKind, profile) {
    if (!valueKind.startsWith("profile."))
        return null;
    const path = valueKind.slice("profile.".length).split(".");
    let cur = profile;
    for (const key of path) {
        if (cur == null || typeof cur !== "object")
            return null;
        cur = cur[key];
    }
    return cur != null ? String(cur) : null;
}
/**
 * Parse a read_page DOM string to build a label→ref map.
 * The serializer outputs lines like: [1234]<input aria-label="First Name" ...>
 * Returns Map<labelLower, ref>.
 */
export function parseRefsFromDom(domText) {
    const map = new Map();
    const lineRe = /^\[(\d+)\](.*)/;
    const attrRe = /(?:aria-label|label|placeholder|name)="([^"]{1,120})"/gi;
    for (const line of domText.split("\n")) {
        const lineMatch = line.match(lineRe);
        if (!lineMatch)
            continue;
        const ref = lineMatch[1];
        const attrs = lineMatch[2];
        let attrMatch;
        attrRe.lastIndex = 0;
        while ((attrMatch = attrRe.exec(attrs)) !== null) {
            const label = attrMatch[1].toLowerCase().replace(/\s*\*\s*$/, "").trim();
            if (label.length >= 2 && !map.has(label)) {
                map.set(label, ref);
            }
        }
    }
    return map;
}
/**
 * Extract form fingerprint from a read_page output string.
 * The read-page-core appends a `[fingerprint:XXXX]` tag when a fingerprint
 * is available. Returns null when the tag is absent (first read on a new page).
 */
export function extractFingerprintFromDom(domText) {
    const match = domText.match(/\[fingerprint:([a-f0-9]{8,32})\]/);
    return match ? match[1] : null;
}
