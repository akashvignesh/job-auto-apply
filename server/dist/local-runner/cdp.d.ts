export interface CdpTargetInfo {
    id: string;
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl?: string;
}
export declare class CdpSession {
    private ws;
    private nextId;
    private pending;
    constructor(webSocketDebuggerUrl: string);
    ready(): Promise<void>;
    send<T = any>(method: string, params?: Record<string, any>): Promise<T>;
    close(): void;
    private onMessage;
}
export declare function createOrAttachTarget(debugPort: number, url?: string): Promise<CdpTargetInfo>;
