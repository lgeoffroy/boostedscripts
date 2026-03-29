/* global browser */

/** Appended to system prompt when agentic mode is on (sidebar checkbox). */
const AGENTIC_SYSTEM_SUFFIX = `

You can change the userscript in the editor directly. When the user gives instructions, it's actually instructions to change the JS code of the userscript to reflect what the user wants. When you output an updated script, wrap the FULL replacement (entire file, not a diff) in a single fenced block with the language tag boostedscript exactly like this:
\`\`\`boostedscript
// full script here
\`\`\`
If you only answer questions or explain without changing code, omit the boostedscript block. If you change code, always include the complete script in that block. This is always the full userscript so you should always output js code.`;

const DEFAULT_SETTINGS = {
  agenticMode: true,
  provider: "ollama",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: "gpt-4o-mini",
  openaiKey: "",
  anthropicBaseUrl: "https://api.anthropic.com",
  anthropicModel: "claude-sonnet-4-6",
  anthropicKey: "",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  ollamaModel: "llama3.2",
  systemPrompt:
    "You help the user write JavaScript userscripts for web pages. The script is injected into the page and runs in the page's JavaScript context (same globals as the site). Prefer plain DOM APIs. On each new chat, the user message may include a fresh page URL, serialized HTML snapshot of the DOM, and the current editor script—treat that bundle as the ground truth for the active tab. When you output code, wrap the full script in a single markdown fenced block with language tag js or javascript. Be concise: use brief markdown (short bullets or 1–2 sentences) when describing what changed or why—avoid long essays and redundant preambles.",
};

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function getScriptsStore() {
  const { scripts = {}, activeScriptByDomain = {} } = await browser.storage.local.get([
    "scripts",
    "activeScriptByDomain",
  ]);
  return { scripts, activeScriptByDomain };
}

function hostnameFromUrl(url) {
  try {
    const h = new URL(url).hostname;
    return h || "_";
  } catch {
    return "_";
  }
}

/** Prefer a real http(s) tab (sidebar in a popup window has no usable active tab in that window). */
async function getActiveWebTab() {
  const queries = [
    () => browser.tabs.query({ active: true, currentWindow: true }),
    () => browser.tabs.query({ active: true, lastFocusedWindow: true }),
  ];
  for (const run of queries) {
    const tabs = await run();
    const t = tabs.find((x) => x.url && /^https?:/i.test(x.url));
    if (t) return t;
  }
  const active = await browser.tabs.query({ active: true });
  return active.find((x) => x.url && /^https?:/i.test(x.url));
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "GET_CONTEXT": {
          const tab = await getActiveWebTab();
          const url = tab?.url || "";
          const hostname = hostnameFromUrl(url);
          const { scripts, activeScriptByDomain } = await getScriptsStore();
          const list = scripts[hostname] || [];
          let activeId = activeScriptByDomain[hostname];
          if (activeId && !list.some((s) => s.id === activeId)) activeId = list[0]?.id || null;
          if (!activeId && list.length) activeId = list[0].id;
          sendResponse({ ok: true, hostname, url, tabId: tab?.id, scripts: list, activeId });
          return;
        }
        case "GET_PAGE_SNAPSHOT": {
          let tabId = message.tabId;
          if (tabId == null) {
            const t = await getActiveWebTab();
            tabId = t?.id;
          }
          if (tabId == null) {
            sendResponse({ ok: false, error: "No web page tab to snapshot" });
            return;
          }
          let tab;
          try {
            tab = await browser.tabs.get(tabId);
          } catch (e) {
            sendResponse({ ok: false, error: e.message || String(e) });
            return;
          }
          const url = tab.url || "";
          if (!/^https?:/i.test(url)) {
            sendResponse({
              ok: true,
              url,
              title: "",
              html: "",
              truncated: false,
              restricted: true,
            });
            return;
          }
          try {
            const results = await browser.scripting.executeScript({
              target: { tabId },
              func: () => ({
                html: document.documentElement ? document.documentElement.outerHTML : "",
                title: document.title || "",
                href: location.href,
              }),
            });
            const r = results[0]?.result || {};
            let html = r.html || "";
            const max = 120000;
            let truncated = false;
            if (html.length > max) {
              html = `${html.slice(0, max)}\n\n<!-- … truncated for size (${max} chars) … -->`;
              truncated = true;
            }
            sendResponse({
              ok: true,
              url: r.href || url,
              title: r.title || "",
              html,
              truncated,
              restricted: false,
            });
          } catch (e) {
            sendResponse({ ok: false, error: e.message || String(e) });
          }
          return;
        }
        case "SAVE_SCRIPT": {
          const { hostname, script } = message;
          if (!hostname || !script?.id) {
            sendResponse({ ok: false, error: "Invalid payload" });
            return;
          }
          const { scripts, activeScriptByDomain } = await getScriptsStore();
          const list = [...(scripts[hostname] || [])];
          const i = list.findIndex((s) => s.id === script.id);
          if (i >= 0) list[i] = { ...list[i], ...script };
          else list.push(script);
          scripts[hostname] = list;
          if (!activeScriptByDomain[hostname]) activeScriptByDomain[hostname] = script.id;
          await browser.storage.local.set({ scripts, activeScriptByDomain });
          sendResponse({ ok: true });
          return;
        }
        case "DELETE_SCRIPT": {
          const { hostname, scriptId } = message;
          const { scripts, activeScriptByDomain } = await getScriptsStore();
          const list = (scripts[hostname] || []).filter((s) => s.id !== scriptId);
          if (list.length) scripts[hostname] = list;
          else delete scripts[hostname];
          if (activeScriptByDomain[hostname] === scriptId) {
            activeScriptByDomain[hostname] = list[0]?.id || null;
            if (!activeScriptByDomain[hostname]) delete activeScriptByDomain[hostname];
          }
          await browser.storage.local.set({ scripts, activeScriptByDomain });
          sendResponse({ ok: true });
          return;
        }
        case "SET_ACTIVE_SCRIPT": {
          const { hostname, scriptId } = message;
          const { activeScriptByDomain } = await getScriptsStore();
          if (scriptId) activeScriptByDomain[hostname] = scriptId;
          else delete activeScriptByDomain[hostname];
          await browser.storage.local.set({ activeScriptByDomain });
          sendResponse({ ok: true });
          return;
        }
        case "GET_SETTINGS": {
          sendResponse({ ok: true, settings: await getSettings() });
          return;
        }
        case "SAVE_SETTINGS": {
          const { settings: next } = message;
          const merged = { ...(await getSettings()), ...next };
          await browser.storage.local.set({ settings: merged });
          sendResponse({ ok: true });
          return;
        }
        case "LLM_CHAT": {
          const { messages, agentic } = message;
          const settings = await getSettings();
          const merged = {
            ...settings,
            agenticMode: typeof agentic === "boolean" ? agentic : settings.agenticMode,
          };
          const text = await callLlm(merged, messages);
          sendResponse({ ok: true, text });
          return;
        }
        case "BROADCAST_RERUN": {
          const { hostname } = message;
          const tabs = await browser.tabs.query({});
          for (const tab of tabs) {
            try {
              if (!tab.id || !tab.url) continue;
              if (hostnameFromUrl(tab.url) !== hostname) continue;
              await browser.tabs.sendMessage(tab.id, { type: "RERUN_SCRIPTS", hostname });
            } catch (_) {
              /* tab may not have content script */
            }
          }
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message" });
      }
    } catch (e) {
      console.error("[BoostedScript]", e);
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true;
});

function mergeAnthropicTurns(messages) {
  const out = [];
  let acc = null;
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const text = typeof m.content === "string" ? m.content : "";
    if (!acc || acc.role !== role) {
      if (acc) out.push(acc);
      acc = { role, content: text };
    } else {
      acc.content += "\n\n" + text;
    }
  }
  if (acc) out.push(acc);
  return out;
}

/**
 * Parse fetch body, log failures (see about:debugging → Background Script console),
 * and throw with status + API message when possible.
 */
async function readJsonOrThrow(res, url) {
  const bodyText = await res.text();
  if (!res.ok) {
    let parsed = {};
    try {
      parsed = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      parsed = { _raw: bodyText.slice(0, 800) };
    }
    const apiMsg =
      parsed.error?.message ||
      (typeof parsed.error === "string" ? parsed.error : null) ||
      parsed.message ||
      (parsed._raw ? parsed._raw : null);
    console.error("[BoostedScript] LLM HTTP error", {
      url,
      status: res.status,
      statusText: res.statusText,
      body: parsed,
    });
    const msg = apiMsg || `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  try {
    return bodyText ? JSON.parse(bodyText) : {};
  } catch (e) {
    throw new Error(`Invalid JSON from ${url}: ${bodyText.slice(0, 200)}`);
  }
}

async function callLlm(settings, messages) {
  if (settings.provider === "anthropic") {
    return callAnthropic(settings, messages);
  }
  if (settings.provider === "ollama") {
    return callOllama(settings, messages);
  }
  return callOpenAICompatible(settings, messages);
}

function systemPromptWithAgentic(settings) {
  let s = settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt;
  if (settings.agenticMode) s += AGENTIC_SYSTEM_SUFFIX;
  return s;
}

async function callOpenAICompatible(settings, messages) {
  const base = (settings.openaiBaseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const url = `${base}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (settings.openaiKey) headers.Authorization = `Bearer ${settings.openaiKey}`;
  const body = {
    model: settings.openaiModel || "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPromptWithAgentic(settings) },
      ...messages,
    ],
    temperature: 0.3,
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await readJsonOrThrow(res, url);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty model response");
  return text;
}

async function callAnthropic(settings, messages) {
  const key = settings.anthropicKey;
  if (!key) throw new Error("Add an Anthropic API key in BoostedScript settings.");
  const base = (settings.anthropicBaseUrl || "https://api.anthropic.com").replace(/\/$/, "").replace(/\/v1$/, "");
  const url = `${base}/v1/messages`;
  const system = systemPromptWithAgentic(settings);
  const nonSystem = messages.filter((m) => m.role !== "system");
  const anthropicMessages = mergeAnthropicTurns(nonSystem).map((m) => ({
    role: m.role,
    content: [{ type: "text", text: m.content }],
  }));
  const body = {
    model: settings.anthropicModel || "claude-sonnet-4-20250514",
    max_tokens: 8192,
    system,
    messages: anthropicMessages,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  const data = await readJsonOrThrow(res, url);
  const block = data.content?.find((c) => c.type === "text");
  if (!block?.text) throw new Error("Empty model response");
  return block.text;
}

/**
 * Ollama: use /api/generate (same as `ollama run` / CLI) so models like gemma work
 * the same as manual POSTs. /api/chat is separate and can behave differently per model.
 */
function buildOllamaGeneratePrompt(settings, messages) {
  const system = systemPromptWithAgentic(settings);
  const parts = [`System instructions:\n${system}`];
  for (const m of messages) {
    if (!m || typeof m.content !== "string") continue;
    if (m.role === "system") continue;
    const label = m.role === "assistant" ? "Assistant" : "User";
    parts.push(`${label}:\n${m.content}`);
  }
  return parts.join("\n\n---\n\n");
}

async function callOllama(settings, messages) {
  const base = (settings.ollamaBaseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
  const url = `${base}/api/chat`;
  const system = systemPromptWithAgentic(settings);
  const ollamaMessages = [{ role: "system", content: system }, ...messages];
  const body = {
    model: settings.ollamaModel || "llama3.2",
    messages: ollamaMessages,
    stream: false,
  };
  console.log({ body });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log({ res });
  const data = await readJsonOrThrow(res, url);
  const text = data.message?.content;
  if (!text) throw new Error("Empty model response");
  return text;
}

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.open();
});

// ── Streaming via long-lived port ──────────────────────────────────────────

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "llm-stream") return;
  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "LLM_CHAT") return;
    const { messages, agentic } = msg;
    const settings = await getSettings();
    const merged = {
      ...settings,
      agenticMode: typeof agentic === "boolean" ? agentic : settings.agenticMode,
    };
    try {
      await callLlmStream(merged, messages, (text) => {
        port.postMessage({ type: "chunk", text });
      });
      port.postMessage({ type: "done" });
    } catch (e) {
      console.error("[BoostedScript] stream error", e);
      port.postMessage({ type: "error", error: e.message || String(e) });
    }
  });
});

async function callLlmStream(settings, messages, onChunk) {
  if (settings.provider === "anthropic") return callAnthropicStream(settings, messages, onChunk);
  if (settings.provider === "ollama") return callOllamaStream(settings, messages, onChunk);
  return callOpenAICompatibleStream(settings, messages, onChunk);
}

/** Read a Server-Sent Events response body, calling onData for each `data:` line. */
async function readSse(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) onData(line.slice(6));
      }
    }
    if (buf.startsWith("data: ")) onData(buf.slice(6));
  } finally {
    reader.releaseLock();
  }
}

async function callAnthropicStream(settings, messages, onChunk) {
  const key = settings.anthropicKey;
  if (!key) throw new Error("Add an Anthropic API key in BoostedScript settings.");
  const base = (settings.anthropicBaseUrl || "https://api.anthropic.com").replace(/\/$/, "").replace(/\/v1$/, "");
  const url = `${base}/v1/messages`;
  const system = systemPromptWithAgentic(settings);
  const anthropicMessages = mergeAnthropicTurns(messages.filter((m) => m.role !== "system")).map((m) => ({
    role: m.role,
    content: [{ type: "text", text: m.content }],
  }));
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: settings.anthropicModel || "claude-sonnet-4-6",
      max_tokens: 8192,
      system,
      messages: anthropicMessages,
      stream: true,
    }),
  });
  if (!res.ok) await readJsonOrThrow(res, url);
  await readSse(res, (data) => {
    if (data === "[DONE]") return;
    try {
      const evt = JSON.parse(data);
      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
        onChunk(evt.delta.text);
      }
    } catch { /* malformed SSE line — skip */ }
  });
}

async function callOpenAICompatibleStream(settings, messages, onChunk) {
  const base = (settings.openaiBaseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const url = `${base}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (settings.openaiKey) headers.Authorization = `Bearer ${settings.openaiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: settings.openaiModel || "gpt-4o-mini",
      messages: [{ role: "system", content: systemPromptWithAgentic(settings) }, ...messages],
      temperature: 0.3,
      stream: true,
    }),
  });
  if (!res.ok) await readJsonOrThrow(res, url);
  await readSse(res, (data) => {
    if (data === "[DONE]") return;
    try {
      const text = JSON.parse(data).choices?.[0]?.delta?.content;
      if (text) onChunk(text);
    } catch { /* skip */ }
  });
}

async function callOllamaStream(settings, messages, onChunk) {
  const base = (settings.ollamaBaseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
  const url = `${base}/api/chat`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.ollamaModel || "llama3.2",
      messages: [{ role: "system", content: systemPromptWithAgentic(settings) }, ...messages],
      stream: true,
    }),
  });
  if (!res.ok) await readJsonOrThrow(res, url);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const text = JSON.parse(t).message?.content;
          if (text) onChunk(text);
        } catch { /* skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Ollama returns 403 for requests that send `Origin: moz-extension://…` unless
 * OLLAMA_ORIGINS is configured. CLI/PowerShell don't send Origin. Strip it for
 * extension fetches to http://localhost / 127.0.0.1 on paths containing `/api`.
 */
function installOllamaOriginWorkaround() {
  if (!browser.webRequest?.onBeforeSendHeaders) return;
  try {
    browser.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        try {
          const u = new URL(details.url);
          if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return {};
          if (!u.pathname.includes("/api")) return {};
          const req = details.requestHeaders;
          if (!req) return {};
          const origin = req.find((h) => h.name.toLowerCase() === "origin");
          if (!origin?.value) return {};
          if (!/^(moz|chrome)-extension:\/\//.test(origin.value)) return {};
          return {
            requestHeaders: req.filter((h) => h.name.toLowerCase() !== "origin"),
          };
        } catch {
          return {};
        }
      },
      { urls: ["http://127.0.0.1/*", "http://localhost/*"] },
      ["blocking", "requestHeaders"]
    );
  } catch (e) {
    console.warn("[BoostedScript] Ollama Origin workaround not registered:", e);
  }
}

installOllamaOriginWorkaround();
