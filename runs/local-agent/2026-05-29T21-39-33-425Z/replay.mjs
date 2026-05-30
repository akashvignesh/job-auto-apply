#!/usr/bin/env node
import { createOrAttachTarget, CdpSession } from "file:///D:/Code/Git/job_apply/job-auto-apply/server/dist/local-runner/cdp.js";
import { LocalBrowser } from "file:///D:/Code/Git/job_apply/job-auto-apply/server/dist/local-runner/browser.js";

const actions = [];
const debugPortArg = process.argv.find((x) => x.startsWith("--debug-port="));
const debugPort = debugPortArg ? Number(debugPortArg.split("=")[1]) : 9222;
const startUrl = process.argv.find((x) => /^https?:\/\//i.test(x)) || "https://workday.wd5.myworkdayjobs.com/en-US/Workday/details/Senior-Software-Development-Engineer_JR-0107127";

const target = await createOrAttachTarget(debugPort, startUrl || undefined);
const cdp = new CdpSession(target.webSocketDebuggerUrl);
const browser = new LocalBrowser(cdp);
await browser.init();

for (const [i, action] of actions.entries()) {
  const result = await browser.executeTool(action.name, action.input || {});
  console.log(`[${result.success ? "OK" : "FAIL"}] #${i + 1} ${action.name}: ${result.error || result.output || ""}`);
  if (!result.success) process.exitCode = 1;
}

cdp.close();
