import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
export class LearningStore {
    filePath;
    state = { runs: [], mistakes: [] };
    /** Phase 7.9 — serialize recordRun() calls so concurrent workers don't lose
     *  updates via read-modify-write races. Workers chain onto this promise. */
    writeChain = Promise.resolve();
    constructor(filePath) {
        this.filePath = filePath;
    }
    static defaultPath(cwd = process.cwd()) {
        return join(cwd, ".local-agent", "learning.json");
    }
    async load() {
        try {
            this.state = JSON.parse(await readFile(this.filePath, "utf8"));
            if (!Array.isArray(this.state.runs))
                this.state.runs = [];
            if (!Array.isArray(this.state.mistakes))
                this.state.mistakes = [];
        }
        catch {
            this.state = { runs: [], mistakes: [] };
        }
    }
    buildPromptHint() {
        const mistakes = this.state.mistakes
            .sort((a, b) => b.count - a.count)
            .slice(0, 10)
            .map((m, i) => `${i + 1}. ${m.action} failed ${m.count}x: ${m.sample}`)
            .join("\n");
        const recent = this.state.runs.slice(-5).map((r) => `- ${r.status}: ${r.url || "(no url)"} (${r.analysis?.readPageCount || 0} read_page calls)`).join("\n");
        if (!mistakes && !recent)
            return "";
        return `<local_learning>
Recent local runs:
${recent || "(none)"}

Avoid repeating these failed/repeated actions:
${mistakes || "(none)"}
</local_learning>`;
    }
    async recordRun(params) {
        // Phase 7.9 — chain onto writeChain so concurrent batch workers serialize.
        // Without this, the read-modify-write below loses updates from any worker
        // whose recordRun runs concurrently with another's. Cost is bounded: one
        // save per task end, not per turn.
        const next = this.writeChain.then(async () => {
            this.state.runs.push({
                at: new Date().toISOString(),
                runDir: params.runDir,
                status: params.status,
                task: params.task,
                url: params.url,
                analysis: params.analysis,
            });
            this.state.runs = this.state.runs.slice(-100);
            for (const turn of params.turns || []) {
                for (const tool of turn.tools || []) {
                    const result = String(tool.result || "");
                    if (!/error|failed|stale|missing|unsupported/i.test(result))
                        continue;
                    const action = `${tool.name}:${JSON.stringify(tool.input || {}).slice(0, 180)}`;
                    const existing = this.state.mistakes.find((m) => m.action === action);
                    if (existing) {
                        existing.count++;
                        existing.at = new Date().toISOString();
                        existing.sample = result.slice(0, 240);
                    }
                    else {
                        this.state.mistakes.push({ at: new Date().toISOString(), action, count: 1, sample: result.slice(0, 240) });
                    }
                }
            }
            this.state.mistakes = this.state.mistakes.sort((a, b) => b.count - a.count).slice(0, 200);
            await this.save();
        });
        // Keep the chain alive even if one writer rejects — we don't want a single
        // failure to permanently break the mutex for later workers.
        this.writeChain = next.catch(() => undefined);
        await next;
    }
    async save() {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
    }
}
