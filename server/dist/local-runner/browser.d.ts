import { CdpSession } from "./cdp.js";
import type { ToolResult } from "../agent/loop.js";
export declare class LocalBrowser {
    private cdp;
    private screenshotSink?;
    constructor(cdp: CdpSession, screenshotSink?: ((base64: string) => Promise<void> | void) | undefined);
    init(): Promise<void>;
    executeTool(toolName: string, input: Record<string, any>): Promise<ToolResult>;
    private navigate;
    private readPage;
    private getPageText;
    private find;
    private formInput;
    private computer;
    private runScript;
    private verifyAction;
    private javascriptTool;
    private screenshot;
    private evaluate;
    private wait;
}
