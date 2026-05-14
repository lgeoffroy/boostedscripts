/* global browser */

(function () {
  const global = typeof browser !== "undefined" ? browser : chrome;

  const DEFAULT_SYSTEM_PROMPT =
    "You help the user write JavaScript userscripts for web pages. The script is injected into the page and runs in the page's JavaScript context (same globals as the site). Prefer plain DOM APIs. On each new chat, the user message may include a fresh page URL, serialized HTML snapshot of the DOM, and the current editor script—treat that bundle as the ground truth for the active tab. When modifying an existing script, always preserve and build upon all existing features unless the user explicitly asks to remove them—never drop working functionality when adding something new. When you output code, wrap the full script in a single markdown fenced block with language tag js or javascript. Be concise: use brief markdown (short bullets or 1–2 sentences) when describing what changed or why—avoid long essays and redundant preambles.";

  const DEFAULT_AGENTIC_PROMPT =
    "You can change the userscript in the editor directly. When the user gives instructions, it's actually instructions to change the JS code of the userscript to reflect what the user wants. When you output an updated script, wrap the FULL replacement (entire file, not a diff) in a single fenced block with the language tag boostedscript exactly like this:\n```boostedscript\n// full script here\n```\nIf you only answer questions or explain without changing code, omit the boostedscript block. If you change code, always include the complete script in that block. This is always the full userscript so you should always output js code.";

  function el(id) {
    return document.getElementById(id);
  }

  function panels() {
    const p = el("provider").value;
    el("panelOllama").style.display = p === "ollama" ? "block" : "none";
    el("panelOpenAI").style.display = p === "openai-compatible" ? "block" : "none";
    el("panelAnthropic").style.display = p === "anthropic" ? "block" : "none";
  }

  async function load() {
    const res = await global.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (!res?.ok) return;
    const s = res.settings;
    el("provider").value = s.provider || "ollama";
    el("ollamaBaseUrl").value = s.ollamaBaseUrl || "";
    el("ollamaModel").value = s.ollamaModel || "";
    el("openaiBaseUrl").value = s.openaiBaseUrl || "";
    el("openaiModel").value = s.openaiModel || "";
    el("openaiKey").value = s.openaiKey || "";
    el("anthropicBaseUrl").value = s.anthropicBaseUrl || "";
    el("anthropicModel").value = s.anthropicModel || "";
    el("anthropicKey").value = s.anthropicKey || "";
    el("systemPrompt").value = s.systemPrompt || "";
    el("agenticPrompt").value = s.agenticPrompt || "";
    el("agenticMode").checked = !!s.agenticMode;
    el("llmAutosave").checked = !!s.llmAutosave;
    panels();
  }

  async function save() {
    const settings = {
      provider: el("provider").value,
      ollamaBaseUrl: el("ollamaBaseUrl").value.trim(),
      ollamaModel: el("ollamaModel").value.trim(),
      openaiBaseUrl: el("openaiBaseUrl").value.trim(),
      openaiModel: el("openaiModel").value.trim(),
      openaiKey: el("openaiKey").value.trim(),
      anthropicBaseUrl: el("anthropicBaseUrl").value.trim(),
      anthropicModel: el("anthropicModel").value.trim(),
      anthropicKey: el("anthropicKey").value.trim(),
      systemPrompt: el("systemPrompt").value.trim(),
      agenticPrompt: el("agenticPrompt").value.trim(),
      agenticMode: el("agenticMode").checked,
      llmAutosave: el("llmAutosave").checked,
    };
    const res = await global.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    el("status").textContent = res?.ok ? "Saved." : "Could not save.";
    setTimeout(() => {
      el("status").textContent = "";
    }, 2500);
  }

  el("resetSystemPrompt").addEventListener("click", (e) => {
    e.preventDefault();
    el("systemPrompt").value = DEFAULT_SYSTEM_PROMPT;
  });
  el("resetAgenticPrompt").addEventListener("click", (e) => {
    e.preventDefault();
    el("agenticPrompt").value = DEFAULT_AGENTIC_PROMPT;
  });

  el("provider").addEventListener("change", panels);
  el("save").addEventListener("click", () => void save());
  el("presetGroq").addEventListener("click", () => {
    el("provider").value = "openai-compatible";
    el("openaiBaseUrl").value = "https://api.groq.com/openai/v1";
    el("openaiModel").value = "llama-3.1-8b-instant";
    panels();
  });
  el("presetOpenAI").addEventListener("click", () => {
    el("provider").value = "openai-compatible";
    el("openaiBaseUrl").value = "https://api.openai.com/v1";
    el("openaiModel").value = "gpt-4o-mini";
    panels();
  });
  el("presetAnthropic").addEventListener("click", () => {
    el("provider").value = "anthropic";
    el("anthropicBaseUrl").value = "https://api.anthropic.com";
    el("anthropicModel").value = "claude-sonnet-4-6";
    panels();
  });

  void load();
})();
