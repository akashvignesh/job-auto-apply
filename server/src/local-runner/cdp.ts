import WebSocket from "ws";

export interface CdpTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();

  constructor(webSocketDebuggerUrl: string) {
    this.ws = new WebSocket(webSocketDebuggerUrl);
    this.ws.on("message", (data) => this.onMessage(String(data)));
    this.ws.on("close", () => {
      for (const [, p] of this.pending) p.reject(new Error("CDP socket closed"));
      this.pending.clear();
    });
  }

  async ready(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (err) => reject(err));
    });
  }

  async send<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    await this.ready();
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg.id) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    } else {
      pending.resolve(msg.result);
    }
  }
}

export async function createOrAttachTarget(debugPort: number, url?: string): Promise<CdpTargetInfo> {
  const base = `http://127.0.0.1:${debugPort}`;
  if (url) {
    const res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (res.ok) return await res.json() as CdpTargetInfo;
  }

  const targetsRes = await fetch(`${base}/json/list`);
  if (!targetsRes.ok) {
    throw new Error(`Could not connect to Chrome on port ${debugPort}. Start Chrome with --remote-debugging-port=${debugPort}.`);
  }
  const targets = await targetsRes.json() as CdpTargetInfo[];
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("No debuggable Chrome page target found.");
  return page;
}
