/* global browser */

(function () {
  const global = typeof browser !== "undefined" ? browser : chrome;

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
    el("agenticMode").checked = !!s.agenticMode;
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
      systemPrompt: el("systemPrompt").value,
      agenticMode: el("agenticMode").checked,
    };
    const res = await global.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    el("status").textContent = res?.ok ? "Saved." : "Could not save.";
    setTimeout(() => {
      el("status").textContent = "";
    }, 2500);
  }

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
