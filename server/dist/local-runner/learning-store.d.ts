export declare class LearningStore {
    private filePath;
    private state;
    /** Phase 7.9 — serialize recordRun() calls so concurrent workers don't lose
     *  updates via read-modify-write races. Workers chain onto this promise. */
    private writeChain;
    constructor(filePath: string);
    static defaultPath(cwd?: string): string;
    load(): Promise<void>;
    buildPromptHint(): string;
    recordRun(params: {
        runDir: string;
        status: string;
        task: string;
        url?: string;
        turns: any[];
        analysis?: any;
    }): Promise<void>;
    private save;
}
