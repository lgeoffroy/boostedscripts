/* global browser, DOMPurify */

(function () {
  const global = typeof browser !== "undefined" ? browser : chrome;

  if (typeof DOMPurify !== "undefined") {
    try {
      DOMPurify.addHook("afterSanitizeAttributes", (node) => {
        if (node.tagName === "A" && node.getAttribute("href")) {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer");
        }
      });
    } catch (_) {
      /* ignore */
    }
  }

  const el = {
    domainLabel: document.getElementById("domainLabel"),
    scriptSelect: document.getElementById("scriptSelect"),
    enabledToggle: document.getElementById("enabledToggle"),
    btnNew: document.getElementById("btnNew"),
    btnDelete: document.getElementById("btnDelete"),
    btnSave: document.getElementById("btnSave"),
    chatLog: document.getElementById("chatLog"),
    chatInput: document.getElementById("chatInput"),
    btnSend: document.getElementById("btnSend"),
    btnApplyLast: document.getElementById("btnApplyLast"),
    scriptName: document.getElementById("scriptName"),
    providerHint: document.getElementById("providerHint"),
    gutter: document.getElementById("gutter"),
    paneCode: document.getElementById("paneCode"),
    paneChat: document.getElementById("paneChat"),
    editor: document.getElementById("editor"),
    agenticToggle: document.getElementById("agenticToggle"),
  };

  let ctx = { hostname: "", scripts: [], activeId: null };
  let currentScript = null;
  const chatByTab = {};
  let saveTimer = null;
  let cm = null;

  function getEditorValue() {
    return cm ? cm.getValue() : (el.editor ? el.editor.value : "");
  }
  function setEditorValue(v) {
    if (cm) { cm.setValue(v); cm.clearHistory(); }
    else if (el.editor) el.editor.value = v;
  }
  function isEditorReadOnly() {
    return cm ? !!cm.getOption("readOnly") : (el.editor ? el.editor.readOnly : true);
  }
  function setEditorReadOnly(ro) {
    if (cm) cm.setOption("readOnly", ro ? "nocursor" : false);
    else if (el.editor) el.editor.readOnly = ro;
  }

  function tabKey() {
    return ctx.tabId != null ? String(ctx.tabId) : "__default__";
  }
  function tabState() {
    const k = tabKey();
    if (!chatByTab[k]) chatByTab[k] = { messages: [], lastExtractedCode: null };
    return chatByTab[k];
  }

  function isWindowMode() {
    return new URLSearchParams(window.location.search).get("detach") === "1";
  }

  async function switchToWindow() {
    if (isWindowMode()) return;
    try {
      await global.windows.create({
        url: global.runtime.getURL("sidebar.html?detach=1"),
        type: "popup",
        width: 980,
        height: 820,
      });
    } catch (e) {
      console.error("[BoostedScript]", e);
    }
    try {
      if (global.sidebarAction?.close) await global.sidebarAction.close();
    } catch (_) {
      /* not in sidebar or unsupported */
    }
  }

  function initPanelModeButton() {
    const wrap = document.getElementById("panelModeWrap");
    const btn = document.getElementById("btnOpenWindow");
    if (!wrap || !btn) return;
    wrap.hidden = isWindowMode();
    if (!wrap.hidden) {
      btn.addEventListener("click", () => void switchToWindow());
    }
  }

  function genId() {
    if (global.crypto?.randomUUID) return global.crypto.randomUUID();
    return `s_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /** @param {any} snap */
  function buildInitialContextMessage(snap, ctx, code) {
    const pageUrl = (snap && snap.ok && snap.url) || ctx.url || "";
    const lines = [
      "Initial context for this new chat (use this as the ground truth for the active page):",
      "",
      `**Page URL:** ${pageUrl}`,
      `**Hostname (script scope):** ${ctx.hostname || ""}`,
    ];
    if (snap && snap.ok && snap.title) lines.push(`**Document title:** ${snap.title}`);

    lines.push("", "**Current userscript (editor):**", "```javascript", code ?? "", "```");

    lines.push("", "**Page DOM (serialized HTML):**");
    if (!snap || !snap.ok) {
      lines.push(`(Could not load: ${snap && snap.error ? snap.error : "unknown error"})`);
    } else if (snap.restricted) {
      lines.push("(Not available for this URL — open a normal http(s) page in a tab.)");
    } else {
      if (snap.truncated) lines.push("(Note: HTML was truncated for size.)");
      lines.push("```html", snap.html || "", "```");
    }

    return lines.join("\n");
  }

  function parseAssistantBlocks(text) {
    const re = /```(?:js|javascript|mjs|cjs)?\s*\n([\s\S]*?)```/gi;
    const blocks = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      blocks.push(m[1].trim());
    }
    return blocks;
  }

  /** In agentic mode, prefer ```boostedscript … ```; else last ```javascript``` block. */
  function extractScriptToApply(text, agentic) {
    if (!text) return null;
    if (agentic) {
      const bs = /```boostedscript\s*\n?([\s\S]*?)```/i;
      const m = text.match(bs);
      if (m) return m[1].trim();
    }
    const blocks = parseAssistantBlocks(text);
    return blocks.length ? blocks[blocks.length - 1] : null;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** Minimal markdown → HTML. Handles the subset an LLM typically produces. */
  function parseMarkdown(src) {
    function inline(s) {
      return escapeHtml(s)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
    }

    const out = [];
    let inUl = false;
    let inOl = false;
    const para = [];

    function flushPara() {
      if (!para.length) return;
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para.length = 0;
    }
    function closeLists() {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (inOl) { out.push("</ol>"); inOl = false; }
    }

    for (const line of src.split("\n")) {
      const trim = line.trim();

      const hm = trim.match(/^(#{1,6})\s+(.*)/);
      if (hm) {
        flushPara(); closeLists();
        const n = hm[1].length;
        out.push(`<h${n}>${inline(hm[2])}</h${n}>`);
        continue;
      }
      if (/^(?:[-*_] *){3,}$/.test(trim)) {
        flushPara(); closeLists();
        out.push("<hr>");
        continue;
      }
      const bq = trim.match(/^> (.*)/);
      if (bq) {
        flushPara(); closeLists();
        out.push(`<blockquote><p>${inline(bq[1])}</p></blockquote>`);
        continue;
      }
      const ulm = trim.match(/^[-*+] (.*)/);
      if (ulm) {
        flushPara();
        if (!inUl) { closeLists(); out.push("<ul>"); inUl = true; }
        out.push(`<li>${inline(ulm[1])}</li>`);
        continue;
      }
      const olm = trim.match(/^\d+\. (.*)/);
      if (olm) {
        flushPara();
        if (!inOl) { closeLists(); out.push("<ol>"); inOl = true; }
        out.push(`<li>${inline(olm[1])}</li>`);
        continue;
      }
      if (!trim) {
        flushPara(); closeLists();
        continue;
      }
      closeLists();
      para.push(line);
    }
    flushPara();
    closeLists();

    const html = out.join("\n");
    return typeof DOMPurify !== "undefined" ? DOMPurify.sanitize(html) : html;
  }

  /** @param {string} text */
  function appendAssistantContent(container, text) {
    const s = String(text);
    const re = /```([^\n`]*)\n([\s\S]*?)```/g;
    let last = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) {
        const md = document.createElement("div");
        md.className = "msg-md";
        const parsed = new DOMParser().parseFromString(parseMarkdown(s.slice(last, m.index)), "text/html");
        md.append(...parsed.body.childNodes);
        container.appendChild(md);
      }
      const pre = document.createElement("pre");
      pre.className = "msg-pre";
      const codeEl = document.createElement("code");
      codeEl.textContent = m[2].replace(/\n$/, "");
      pre.appendChild(codeEl);
      container.appendChild(pre);
      last = re.lastIndex;
    }
    if (last < s.length) {
      const md = document.createElement("div");
      md.className = "msg-md";
      const parsed = new DOMParser().parseFromString(parseMarkdown(s.slice(last)), "text/html");
      md.append(...parsed.body.childNodes);
      container.appendChild(md);
    }
  }

  function renderChat() {
    el.chatLog.textContent = "";
    for (const msg of tabState().messages) {
      const div = document.createElement("div");
      div.className = `bubble ${msg.role}${msg.error ? " error" : ""}`;
      if (msg.role === "assistant" && !msg.error) {
        appendAssistantContent(div, msg.content);
      } else {
        div.textContent = msg.content;
      }
      el.chatLog.appendChild(div);
    }
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  async function refreshContext() {
    const res = await global.runtime.sendMessage({ type: "GET_CONTEXT" });
    if (!res?.ok) return;
    ctx = res;

    // Auto-create a first script for real http(s) pages that have none yet
    if ((!ctx.scripts || ctx.scripts.length === 0) && ctx.hostname && ctx.hostname !== "_" && /^https?:/i.test(ctx.url || "")) {
      const script = {
        id: genId(),
        name: "Script 1",
        code: "(function() {\n  'use strict';\n\n  // your code here\n\n})();\n",
        enabled: true,
      };
      await global.runtime.sendMessage({ type: "SAVE_SCRIPT", hostname: ctx.hostname, script });
      await global.runtime.sendMessage({ type: "SET_ACTIVE_SCRIPT", hostname: ctx.hostname, scriptId: script.id });
      ctx.scripts = [script];
      ctx.activeId = script.id;
    }

    el.domainLabel.textContent = ctx.hostname || "—";
    const sel = el.scriptSelect;
    sel.replaceChildren();
    for (const s of ctx.scripts || []) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name || s.id;
      sel.appendChild(opt);
    }
    if (ctx.activeId) sel.value = ctx.activeId;
    else if (ctx.scripts?.length) sel.value = ctx.scripts[0].id;

    const active = (ctx.scripts || []).find((s) => s.id === sel.value) || null;
    currentScript = active;
    setEditorValue(active?.code || "");
    setEditorReadOnly(!active);
    el.scriptName.value = active?.name || "";
    el.scriptName.disabled = !active;
    el.enabledToggle.checked = active ? active.enabled !== false : true;
    el.btnDelete.disabled = !active;
    el.btnApplyLast.disabled = !tabState().lastExtractedCode;
    renderChat();
    await refreshProviderHint();
  }

  async function refreshProviderHint() {
    const res = await global.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (!res?.ok) return;
    const s = res.settings;
    if (s.provider === "ollama") {
      el.providerHint.textContent = `Ollama · ${s.ollamaModel || "model"} @ ${s.ollamaBaseUrl || ""}`;
    } else if (s.provider === "anthropic") {
      el.providerHint.textContent = s.anthropicKey
        ? `Anthropic · ${s.anthropicModel || ""}`
        : "Add Anthropic API key in Settings";
    } else {
      const hasKey = !!s.openaiKey;
      el.providerHint.textContent = hasKey
        ? `OpenAI-compatible · ${s.openaiModel || ""}`
        : "Free: use Ollama (local) or add a Groq/OpenAI key in Settings";
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void persistScript();
    }, 450);
  }

  async function persistScript() {
    if (!currentScript || !ctx.hostname) return;
    if (isEditorReadOnly()) return;
    const code = getEditorValue();
    const next = {
      ...currentScript,
      code,
      enabled: el.enabledToggle.checked,
    };
    await global.runtime.sendMessage({
      type: "SAVE_SCRIPT",
      hostname: ctx.hostname,
      script: next,
    });
    currentScript = next;
    await global.runtime.sendMessage({
      type: "BROADCAST_RERUN",
      hostname: ctx.hostname,
    });
  }

  async function flushSaveBeforeSwitch() {
    clearTimeout(saveTimer);
    if (!currentScript || !ctx.hostname || isEditorReadOnly()) return;
    const code = getEditorValue();
    await global.runtime.sendMessage({
      type: "SAVE_SCRIPT",
      hostname: ctx.hostname,
      script: {
        ...currentScript,
        code,
        enabled: el.enabledToggle.checked,
      },
    });
  }

  async function selectScript(id) {
    if (!id) return;
    await flushSaveBeforeSwitch();
    await global.runtime.sendMessage({
      type: "SET_ACTIVE_SCRIPT",
      hostname: ctx.hostname,
      scriptId: id,
    });
    await refreshContext();
  }

  async function renameScript() {
    if (!currentScript || !ctx.hostname) return;
    const name = el.scriptName.value.trim() || currentScript.name;
    el.scriptName.value = name;
    if (name === currentScript.name) return;
    currentScript = { ...currentScript, name };
    // Update the select option text in-place
    const opt = el.scriptSelect.querySelector(`option[value="${currentScript.id}"]`);
    if (opt) opt.textContent = name;
    await global.runtime.sendMessage({
      type: "SAVE_SCRIPT",
      hostname: ctx.hostname,
      script: currentScript,
    });
  }

  async function newScript() {
    await flushSaveBeforeSwitch();
    const n = (ctx.scripts?.length || 0) + 1;
    const script = {
      id: genId(),
      name: `Script ${n}`,
      code: "(function() {\n  'use strict';\n\n  // your code here\n\n})();\n",
      enabled: true,
    };
    await global.runtime.sendMessage({
      type: "SAVE_SCRIPT",
      hostname: ctx.hostname,
      script,
    });
    await global.runtime.sendMessage({
      type: "SET_ACTIVE_SCRIPT",
      hostname: ctx.hostname,
      scriptId: script.id,
    });
    const s = tabState();
    s.messages = [];
    s.lastExtractedCode = null;
    renderChat();
    await refreshContext();
  }

  async function deleteScript() {
    if (!currentScript) return;
    const ok = confirm(`Remove "${currentScript.name}" for this site?`);
    if (!ok) return;
    await global.runtime.sendMessage({
      type: "DELETE_SCRIPT",
      hostname: ctx.hostname,
      scriptId: currentScript.id,
    });
    const s = tabState();
    s.messages = [];
    s.lastExtractedCode = null;
    renderChat();
    await refreshContext();
  }

  async function sendChat() {
    const text = el.chatInput.value.trim();
    if (!text) return;
    el.chatInput.value = "";

    const ctxRes = await global.runtime.sendMessage({ type: "GET_CONTEXT" });
    if (ctxRes?.ok) ctx = ctxRes;

    const tab = tabState();
    tab.messages.push({ role: "user", content: text });
    renderChat();

    const codeContext = getEditorValue();
    const isFirstTurn = tab.messages.length === 1;

    let payloadMessages;
    if (isFirstTurn) {
      const snap = await global.runtime.sendMessage({
        type: "GET_PAGE_SNAPSHOT",
        tabId: ctx.tabId,
      });
      const initial = buildInitialContextMessage(snap, ctx, codeContext);
      payloadMessages = [
        { role: "user", content: initial },
        { role: "user", content: `**User request:**\n${text}` },
      ];
    } else {
      payloadMessages = tab.messages.map((m) => ({ role: m.role, content: m.content }));
      const last = payloadMessages[payloadMessages.length - 1];
      if (last && last.role === "user") {
        last.content +=
          `\n\n---\nCurrent userscript for ${ctx.hostname}:\n\`\`\`javascript\n${codeContext}\n\`\`\``;
      }
    }

    el.btnSend.disabled = true;
    const agentic = !!el.agenticToggle?.checked;
    const streamBubble = appendStreamingBubble();
    let accumulated = "";
    try {
      const fullText = await streamLlmChat(payloadMessages, agentic, (chunk) => {
        accumulated += chunk;
        updateStreamingBubble(streamBubble, accumulated);
      });
      finalizeStreamingBubble(streamBubble, fullText);
      tab.messages.push({ role: "assistant", content: fullText });
      tab.lastExtractedCode = extractScriptToApply(fullText, agentic);
      el.btnApplyLast.disabled = !tab.lastExtractedCode;
      if (agentic && tab.lastExtractedCode && !isEditorReadOnly()) {
        setEditorValue(tab.lastExtractedCode);
        void persistScript();
      }
    } catch (e) {
      streamBubble.classList.remove("streaming");
      streamBubble.classList.add("error");
      streamBubble.textContent = e.message || String(e);
      tab.messages.push({ role: "assistant", content: e.message || String(e), error: true });
    }
    el.btnSend.disabled = false;
  }

  function streamLlmChat(messages, agentic, onChunk) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = global.runtime.connect({ name: "llm-stream" });
      } catch (e) {
        reject(e);
        return;
      }
      let fullText = "";
      let settled = false;
      function finish(err) {
        if (settled) return;
        settled = true;
        try { port.disconnect(); } catch { /* ignore */ }
        if (err) reject(err); else resolve(fullText);
      }
      port.onMessage.addListener((msg) => {
        if (msg.type === "chunk") {
          fullText += msg.text;
          try { onChunk(msg.text); } catch { /* ignore */ }
        } else if (msg.type === "done") {
          finish(null);
        } else if (msg.type === "error") {
          finish(new Error(msg.error || "Stream error"));
        }
      });
      port.onDisconnect.addListener(() => {
        finish(new Error(global.runtime.lastError?.message || "Port disconnected"));
      });
      port.postMessage({ type: "LLM_CHAT", messages, agentic });
    });
  }

  function appendStreamingBubble() {
    const div = document.createElement("div");
    div.className = "bubble assistant streaming";
    const dots = document.createElement("span");
    dots.className = "typing-dots";
    dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
    div.appendChild(dots);
    el.chatLog.appendChild(div);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
    return div;
  }

  function updateStreamingBubble(bubble, fullText) {
    let textSpan = bubble.querySelector(".stream-text");
    if (!textSpan) {
      bubble.textContent = "";
      textSpan = document.createElement("span");
      textSpan.className = "stream-text";
      bubble.appendChild(textSpan);
      const cursor = document.createElement("span");
      cursor.className = "stream-cursor";
      cursor.textContent = "▋";
      bubble.appendChild(cursor);
    }
    textSpan.textContent = fullText;
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function finalizeStreamingBubble(bubble, fullText) {
    bubble.classList.remove("streaming");
    bubble.textContent = "";
    appendAssistantContent(bubble, fullText);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function applyLastBlock() {
    const code = tabState().lastExtractedCode;
    if (!code) return;
    setEditorValue(code);
    void persistScript();
  }

  function initEditor() {
    if (typeof CodeMirror === "undefined") {
      // Fallback: plain textarea with basic tab support via execCommand
      el.editor.addEventListener("input", () => scheduleSave());
      el.editor.addEventListener("keydown", (e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          const s = el.editor.selectionStart;
          const v = el.editor.value;
          el.editor.value = v.slice(0, s) + "  " + v.slice(el.editor.selectionEnd);
          el.editor.selectionStart = el.editor.selectionEnd = s + 2;
          scheduleSave();
        }
        if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void persistScript();
        }
      });
      return;
    }

    cm = CodeMirror.fromTextArea(el.editor, {
      mode: "javascript",
      theme: "bs-dark",
      lineNumbers: true,
      matchBrackets: true,
      indentUnit: 2,
      tabSize: 2,
      indentWithTabs: false,
      lineWrapping: false,
      extraKeys: {
        Tab(editor) {
          if (editor.somethingSelected()) editor.indentSelection("add");
          else editor.replaceSelection("  ", "end", "+input");
        },
        "Shift-Tab"(editor) {
          editor.indentSelection("subtract");
        },
        "Ctrl-S"() {
          void persistScript();
        },
        "Cmd-S"() {
          void persistScript();
        },
      },
    });
    cm.on("change", () => scheduleSave());
  }

  function initSplitter() {
    const main = document.querySelector(".main");
    let dragging = false;
    el.gutter.addEventListener("mousedown", (e) => {
      dragging = true;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging || !main) return;
      const rect = main.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = Math.min(0.85, Math.max(0.15, x / rect.width));
      el.paneCode.style.flex = `1 1 ${ratio * 100}%`;
      el.paneChat.style.flex = `1 1 ${(1 - ratio) * 100}%`;
      cm?.refresh();
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  el.scriptSelect.addEventListener("change", () => {
    void selectScript(el.scriptSelect.value);
  });
  el.scriptName.addEventListener("blur", () => void renameScript());
  el.scriptName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") el.scriptName.blur();
    if (e.key === "Escape") { el.scriptName.value = currentScript?.name || ""; el.scriptName.blur(); }
  });
  el.btnNew.addEventListener("click", () => void newScript());
  el.btnDelete.addEventListener("click", () => void deleteScript());
  el.btnSave.addEventListener("click", () => void persistScript());
  el.enabledToggle.addEventListener("change", () => void persistScript());
  el.btnSend.addEventListener("click", () => void sendChat());
  document.getElementById("btnNewChat")?.addEventListener("click", () => {
    const s = tabState();
    s.messages = [];
    s.lastExtractedCode = null;
    el.btnApplyLast.disabled = true;
    renderChat();
  });
  el.btnApplyLast.addEventListener("click", () => applyLastBlock());
  el.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendChat();
    }
  });

  global.tabs?.onActivated?.addListener(() => void refreshContext());
  global.tabs?.onUpdated?.addListener((id, info) => {
    if (info.status === "complete") void refreshContext();
  });

  async function initAgenticToggle() {
    const res = await global.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (res?.ok && el.agenticToggle) {
      el.agenticToggle.checked = !!res.settings.agenticMode;
    }
    el.agenticToggle?.addEventListener("change", async () => {
      await global.runtime.sendMessage({
        type: "SAVE_SETTINGS",
        settings: { agenticMode: !!el.agenticToggle?.checked },
      });
    });
    global.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local" || !changes.settings?.newValue || !el.agenticToggle) return;
      const m = changes.settings.newValue.agenticMode;
      if (typeof m === "boolean") el.agenticToggle.checked = m;
    });
  }

  initEditor();
  initSplitter();
  initPanelModeButton();
  void initAgenticToggle();
  const openSettings = document.getElementById("openSettings");
  if (openSettings) openSettings.href = global.runtime.getURL("options.html");

  void refreshContext();
})();
