const READ_PAGE_SCRIPT = String.raw `(() => {
  window.__hanziLocalRefs = window.__hanziLocalRefs || new Map();
  window.__hanziLocalRefCounter = window.__hanziLocalRefCounter || 1;
  const refFor = (el) => {
    if (!el.__hanziLocalRef) {
      Object.defineProperty(el, "__hanziLocalRef", { value: String(window.__hanziLocalRefCounter++), configurable: true });
    }
    window.__hanziLocalRefs.set(el.__hanziLocalRef, el);
    return el.__hanziLocalRef;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const labelOf = (el) => {
    let label = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || "";
    const labelledBy = el.getAttribute("aria-labelledby");
    if (!label && labelledBy) {
      label = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
    }
    if (!label && el.id) label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')?.textContent || "";
    if (!label) label = el.closest("label,[role=group],fieldset,[data-automation-id]")?.textContent || "";
    if (!label) label = el.textContent || "";
    return String(label).replace(/\s+/g, " ").trim().slice(0, 140);
  };
  const selector = [
    "a[href]", "button", "input", "textarea", "select",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]",
    "[role=combobox]", "[role=textbox]", "[contenteditable=true]"
  ].join(",");
  const out = [];
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el)) continue;
    const ref = refFor(el);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const type = el.getAttribute("type") || "";
    const href = el.getAttribute("href") || "";
    const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
      ? (el.value ? " value=[set]" : "")
      : "";
    const label = labelOf(el);
    out.push("[" + ref + "]<" + tag + (role ? " role=" + role : "") + (type ? " type=" + type : "") + (href ? " href=" + href.slice(0, 80) : "") + value + "> " + label);
  }
  const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 3000);
  return { url: location.href, title: document.title, bodyText, elements: out.slice(0, 350) };
})()`;
export class LocalBrowser {
    cdp;
    screenshotSink;
    constructor(cdp, screenshotSink) {
        this.cdp = cdp;
        this.screenshotSink = screenshotSink;
    }
    async init() {
        await this.cdp.send("Page.enable");
        await this.cdp.send("Runtime.enable");
    }
    async executeTool(toolName, input) {
        switch (toolName) {
            case "navigate":
                return await this.navigate(String(input.url || ""));
            case "read_page":
                return await this.readPage(Number(input.max_chars) || 20000);
            case "get_page_text":
                return await this.getPageText(Number(input.max_chars) || 20000);
            case "find":
                return await this.find(String(input.query || ""));
            case "form_input":
                return await this.formInput(String(input.ref || ""), input.value);
            case "computer":
                return await this.computer(input);
            case "run_script":
                return await this.runScript(input);
            case "verify_action":
                return await this.verifyAction(input);
            case "javascript_tool":
                return await this.javascriptTool(input);
            default:
                return { success: false, error: `Local runner does not support tool: ${toolName}` };
        }
    }
    async navigate(url) {
        if (url === "back") {
            const history = await this.cdp.send("Page.getNavigationHistory");
            const previous = history.entries[history.currentIndex - 1];
            if (!previous)
                return { success: false, error: "No browser history entry to navigate back to" };
            await this.cdp.send("Page.navigateToHistoryEntry", { entryId: previous.id });
            await this.wait(800);
            return { success: true, output: "Navigated back" };
        }
        if (!/^https?:\/\//i.test(url))
            return { success: false, error: `Invalid URL: ${url}` };
        await this.cdp.send("Page.navigate", { url });
        await this.wait(1200);
        return { success: true, output: `Navigated to ${url}` };
    }
    async readPage(maxChars) {
        const result = await this.evaluate(READ_PAGE_SCRIPT);
        if (result.error)
            return result;
        const data = result.output;
        const text = [`URL: ${data.url}`, `TITLE: ${data.title}`, "", "INTERACTIVE ELEMENTS:", ...data.elements, "", "VISIBLE TEXT:", data.bodyText].join("\n");
        return { success: true, output: text.length > maxChars ? text.slice(0, maxChars) + "\n[truncated]" : text };
    }
    async getPageText(maxChars) {
        const result = await this.evaluate(`(() => (document.body && document.body.innerText || "").trim())()`);
        const text = String(result.output || "");
        return { success: !result.error, output: text.slice(0, maxChars), error: result.error };
    }
    async find(query) {
        const q = query.toLowerCase();
        const result = await this.evaluate(`(() => {
      const q = ${JSON.stringify(q)};
      const refs = [];
      for (const [ref, el] of (window.__hanziLocalRefs || new Map()).entries()) {
        const text = ((el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "") + "").toLowerCase();
        if (text.includes(q)) refs.push("[" + ref + "] " + text.slice(0, 160));
      }
      return refs.slice(0, 30).join("\\n") || "No matches. Call read_page to refresh refs.";
    })()`);
        return { success: !result.error, output: result.output, error: result.error };
    }
    async formInput(ref, value) {
        return await this.evaluate(`(async () => {
      const el = window.__hanziLocalRefs && window.__hanziLocalRefs.get(${JSON.stringify(ref)});
      if (!el || !document.contains(el)) return { error: "ref ${ref} is stale or missing; call read_page" };
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus();
      const value = ${JSON.stringify(value)};
      if (el instanceof HTMLSelectElement) {
        const wanted = String(value).toLowerCase();
        const opt = [...el.options].find(o => o.text.toLowerCase() === wanted || o.value.toLowerCase() === wanted || o.text.toLowerCase().includes(wanted));
        if (!opt) return { error: "option not found: " + value };
        el.value = opt.value;
      } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        if (el.type === "checkbox") el.checked = Boolean(value);
        else el.click();
      } else if (el.isContentEditable) {
        el.textContent = String(value);
      } else {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
        if (setter) setter.call(el, String(value)); else el.value = String(value);
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur();
      return { output: "Set ref ${ref} to value" };
    })()`);
    }
    async computer(input) {
        const action = input.action;
        if (action === "wait") {
            await this.wait(Math.min(Math.max(Number(input.duration) || 1, 0.1), 30) * 1000);
            return { success: true, output: `Waited ${input.duration || 1}s` };
        }
        if (action === "screenshot")
            return await this.screenshot();
        if (action === "scroll") {
            const amount = Number(input.scroll_amount) || 3;
            const dir = input.scroll_direction === "up" ? -1 : 1;
            await this.evaluate(`window.scrollBy({ top: ${dir * amount * 450}, behavior: "instant" }); "scrolled"`);
            return { success: true, output: `Scrolled ${input.scroll_direction || "down"}` };
        }
        if (action === "key") {
            await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: input.text || "Enter" });
            await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: input.text || "Enter" });
            return { success: true, output: `Pressed ${input.text || "Enter"}` };
        }
        if ((action === "left_click" || action === "double_click") && input.ref) {
            const clicks = action === "double_click" ? 2 : 1;
            return await this.evaluate(`(() => {
        const el = window.__hanziLocalRefs && window.__hanziLocalRefs.get(${JSON.stringify(String(input.ref))});
        if (!el || !document.contains(el)) return { error: "ref ${input.ref} is stale or missing; call read_page" };
        el.scrollIntoView({ block: "center", inline: "center" });
        for (let i = 0; i < ${clicks}; i++) el.click();
        return { output: "Clicked ref ${input.ref}" };
      })()`);
        }
        if ((action === "left_click" || action === "double_click") && Array.isArray(input.coordinate)) {
            const [x, y] = input.coordinate;
            await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
            await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
            return { success: true, output: `Clicked at ${x},${y}` };
        }
        return { success: false, error: `Unsupported computer action: ${action || "(missing)"}` };
    }
    async runScript(input) {
        const actions = Array.isArray(input.actions) ? input.actions.slice(0, 12) : [];
        const lines = [];
        let ok = 0;
        let fail = 0;
        for (let i = 0; i < actions.length; i++) {
            const a = actions[i];
            const res = await this.executeTool(String(a.tool || ""), a.input || {});
            if (res.success)
                ok++;
            else
                fail++;
            lines.push(`[${res.success ? "OK" : "FAIL"}] #${i} ${a.tool}: ${res.error || res.output}`);
            if (!res.success && input.stopOnError)
                break;
        }
        return { success: fail === 0, output: `run_script: ${ok} OK, ${fail} FAIL\n${lines.join("\n")}` };
    }
    async verifyAction(input) {
        const expect = String(input.expect || "");
        const hint = String(input.hint || "");
        const started = Date.now();
        const timeoutMs = Math.min(Number(input.timeoutMs) || 3000, 15000);
        while (Date.now() - started < timeoutMs) {
            if (expect === "text-appeared") {
                const r = await this.getPageText(10000);
                if (String(r.output || "").includes(hint))
                    return { success: true, output: `verify_action OK: text appeared ${hint}` };
            }
            else if (expect === "navigated") {
                const r = await this.evaluate("location.href");
                if (!hint || String(r.output || "").includes(hint))
                    return { success: true, output: `verify_action OK: ${r.output}` };
            }
            await this.wait(250);
        }
        return { success: false, error: `verify_action FAIL (${expect}): no evidence within ${timeoutMs}ms` };
    }
    async javascriptTool(input) {
        if (input.action && input.action !== "javascript_exec")
            return { success: false, error: "'javascript_exec' is the only supported action" };
        const text = String(input.text || "");
        if (/\.value\s*=|\.checked\s*=|setAttribute\(\s*['"]value['"]/i.test(text)) {
            return { success: false, error: "javascript_tool cannot set form field values. Use form_input so controlled state is updated correctly." };
        }
        const source = JSON.stringify(text);
        return await this.evaluate(`(async () => {
      const source = ${source};
      try {
        return await (0, eval)(source);
      } catch (e) {
        if (e instanceof SyntaxError && /Illegal return statement/.test(String(e.message || e))) {
          const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
          return await AsyncFunction(source)();
        }
        throw e;
      }
    })()`);
    }
    async screenshot() {
        const res = await this.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 75, fromSurface: true });
        await this.screenshotSink?.(res.data);
        return { success: true, output: "Captured screenshot", screenshot: { data: res.data, mediaType: "image/jpeg" } };
    }
    async evaluate(expression) {
        try {
            const res = await this.cdp.send("Runtime.evaluate", {
                expression,
                awaitPromise: true,
                returnByValue: true,
            });
            const value = res.result?.value;
            if (value && typeof value === "object" && value.error)
                return { success: false, error: String(value.error) };
            if (value && typeof value === "object" && value.output)
                return { success: true, output: value.output };
            return { success: true, output: value };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    }
    async wait(ms) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }
}
