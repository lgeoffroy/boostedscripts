/* global browser */

(function () {
  const hostname = window.location.hostname || "_";

  /**
   * Run user code in the page context via a <script> node.
   * Extension isolated worlds forbid `eval` / `new Function` (CSP); injected scripts
   * execute in the page and follow the page's CSP instead.
   */
  function runScript(code, label) {
    if (!code || typeof code !== "string") return;
    const el = document.createElement("script");
    if (label) el.dataset.boostedscript = String(label);
    el.textContent = code;
    try {
      const root = document.head || document.documentElement;
      root.appendChild(el);
    } catch (e) {
      console.error("[BoostedScript] Error in script:", label, e);
    } finally {
      el.remove();
    }
  }

  async function loadAndRun() {
    const { scripts = {} } = await browser.storage.local.get("scripts");
    const list = scripts[hostname];
    if (!list || !list.length) return;
    const enabled = list.filter((s) => s.enabled !== false);
    for (const s of enabled) {
      runScript(s.code, s.name || s.id);
    }
  }

  loadAndRun();

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "RERUN_SCRIPTS" && msg.hostname === hostname) {
      loadAndRun();
    }
  });
})();
