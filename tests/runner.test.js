// @vitest-environment jsdom

/**
 * Tests for content_scripts/runner.js
 *
 * runner.js is a self-invoking script that:
 *  - reads scripts from browser.storage.local on load
 *  - injects enabled scripts as <script> nodes into the page
 *  - re-runs on RERUN_SCRIPTS messages
 *
 * Each test loads a fresh copy via vm.runInThisContext so the IIFE re-executes
 * and picks up the browser mock we set on globalThis.
 */

import vm from "vm";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeBrowserMock } from "./helpers/make-browser-mock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_SOURCE = readFileSync(
  join(__dirname, "../content_scripts/runner.js"),
  "utf-8"
);

/** Execute runner.js in the current jsdom context with the given browser mock. */
function loadRunner(browserMock) {
  globalThis.browser = browserMock;
  vm.runInThisContext(RUNNER_SOURCE);
}

/** Wait one microtask tick for the loadAndRun async function to complete. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

afterEach(() => {
  delete globalThis.browser;
});

describe("runner.js — DOM ready guard", () => {
  it("runs immediately when readyState is not 'loading'", async () => {
    // jsdom default is 'complete' — runner should call loadAndRun right away
    expect(document.readyState).not.toBe("loading");
    const { browserMock } = makeBrowserMock({
      scripts: { localhost: [{ id: "s1", name: "T", code: "1;", enabled: true }] },
    });
    loadRunner(browserMock);
    await flush();
    expect(browserMock.storage.local.get).toHaveBeenCalledWith("scripts");
  });

  it("defers execution until DOMContentLoaded when readyState is 'loading'", async () => {
    Object.defineProperty(document, "readyState", { value: "loading", configurable: true });
    const listeners = {};
    const origAdd = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, fn, ...rest) => {
      if (type === "DOMContentLoaded") listeners[type] = fn;
      else origAdd(type, fn, ...rest);
    });

    const { browserMock } = makeBrowserMock({
      scripts: { localhost: [{ id: "s1", name: "T", code: "1;", enabled: true }] },
    });
    loadRunner(browserMock);
    await flush();

    // Should not have run yet
    expect(browserMock.storage.local.get).not.toHaveBeenCalled();

    // Fire the deferred event
    Object.defineProperty(document, "readyState", { value: "interactive", configurable: true });
    listeners["DOMContentLoaded"]();
    await flush();

    expect(browserMock.storage.local.get).toHaveBeenCalledWith("scripts");

    document.addEventListener.mockRestore();
    Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
  });
});

describe("runner.js — script injection", () => {
  it("does nothing when there are no scripts for the hostname", async () => {
    const { browserMock } = makeBrowserMock({ scripts: {} });
    loadRunner(browserMock);
    await flush();
    // No script elements should be injected (they're removed after injection,
    // but side-effects from running code would still appear if any ran)
    expect(browserMock.storage.local.get).toHaveBeenCalledWith("scripts");
  });

  it("injects and immediately removes the <script> tag for each enabled script", async () => {
    const appendSpy = vi.spyOn(Element.prototype, "appendChild");

    const { browserMock } = makeBrowserMock({
      scripts: {
        localhost: [
          { id: "s1", name: "Test", code: "window.__ran = true;", enabled: true },
        ],
      },
    });
    loadRunner(browserMock);
    await flush();

    // The script tag is appended then immediately removed — verify it was created
    const scriptCalls = appendSpy.mock.calls.filter(
      ([el]) => el instanceof HTMLScriptElement
    );
    expect(scriptCalls.length).toBeGreaterThanOrEqual(1);
    const scriptEl = scriptCalls[0][0];
    expect(scriptEl.textContent).toBe("window.__ran = true;");
    expect(scriptEl.dataset.boostedscript).toBe("Test");

    appendSpy.mockRestore();
  });

  it("skips scripts where enabled is explicitly false", async () => {
    const appendSpy = vi.spyOn(Element.prototype, "appendChild");

    const { browserMock } = makeBrowserMock({
      scripts: {
        localhost: [
          { id: "s1", name: "Disabled", code: "window.__nope = true;", enabled: false },
        ],
      },
    });
    loadRunner(browserMock);
    await flush();

    const scriptCalls = appendSpy.mock.calls.filter(
      ([el]) => el instanceof HTMLScriptElement
    );
    expect(scriptCalls).toHaveLength(0);

    appendSpy.mockRestore();
  });

  it("treats missing enabled field as enabled", async () => {
    const appendSpy = vi.spyOn(Element.prototype, "appendChild");

    const { browserMock } = makeBrowserMock({
      scripts: {
        localhost: [{ id: "s1", name: "Default", code: "1+1;" }], // no enabled field
      },
    });
    loadRunner(browserMock);
    await flush();

    const scriptCalls = appendSpy.mock.calls.filter(
      ([el]) => el instanceof HTMLScriptElement
    );
    expect(scriptCalls.length).toBeGreaterThanOrEqual(1);

    appendSpy.mockRestore();
  });

  it("runs all enabled scripts when multiple are stored", async () => {
    const appendSpy = vi.spyOn(Element.prototype, "appendChild");

    const { browserMock } = makeBrowserMock({
      scripts: {
        localhost: [
          { id: "s1", name: "A", code: "1;", enabled: true },
          { id: "s2", name: "B", code: "2;", enabled: true },
          { id: "s3", name: "C", code: "3;", enabled: false },
        ],
      },
    });
    loadRunner(browserMock);
    await flush();

    const scriptCalls = appendSpy.mock.calls.filter(
      ([el]) => el instanceof HTMLScriptElement
    );
    expect(scriptCalls).toHaveLength(2);

    appendSpy.mockRestore();
  });
});

describe("runner.js — CSP nonce propagation", () => {
  it("copies the nonce from an existing page script to the injected script element", async () => {
    const appendSpy = vi.spyOn(Element.prototype, "appendChild");

    // Simulate a page that already has a nonced script (e.g. Instagram)
    const pageScript = document.createElement("script");
    pageScript.setAttribute("nonce", "bd8c220a9a8ee236ea216c8775d29c60");
    document.head.appendChild(pageScript);

    const { browserMock } = makeBrowserMock({
      scripts: {
        localhost: [{ id: "s1", name: "N", code: "1;", enabled: true }],
      },
    });
    loadRunner(browserMock);
    await flush();

    const scriptCalls = appendSpy.mock.calls.filter(
      ([el]) => el instanceof HTMLScriptElement && el.dataset.boostedscript
    );
    expect(scriptCalls.length).toBeGreaterThanOrEqual(1);
    expect(scriptCalls[0][0].nonce).toBe("bd8c220a9a8ee236ea216c8775d29c60");

    appendSpy.mockRestore();
  });

  it("reads the nonce from the IDL property even when the content attribute has been stripped (browser nonce concealment)", async () => {
    const appendSpy = vi.spyOn(Element.prototype, "appendChild");

    // Browsers strip the nonce content attribute to "" after parsing to prevent
    // CSS-selector leaks, but keep the value accessible via the .nonce IDL property.
    const pageScript = document.createElement("script");
    pageScript.setAttribute("nonce", ""); // content attribute emptied by browser
    Object.defineProperty(pageScript, "nonce", { get: () => "unquB2d0", configurable: true });
    document.head.appendChild(pageScript);

    const { browserMock } = makeBrowserMock({
      scripts: {
        localhost: [{ id: "s1", name: "N", code: "1;", enabled: true }],
      },
    });
    loadRunner(browserMock);
    await flush();

    const scriptCalls = appendSpy.mock.calls.filter(
      ([el]) => el instanceof HTMLScriptElement && el.dataset.boostedscript
    );
    expect(scriptCalls.length).toBeGreaterThanOrEqual(1);
    // Must use the IDL property value, not the stripped attribute
    expect(scriptCalls[0][0].nonce).toBe("unquB2d0");

    appendSpy.mockRestore();
  });

  it("injects without a nonce when no nonced script exists on the page", async () => {
    const appendSpy = vi.spyOn(Element.prototype, "appendChild");

    // No page scripts with nonce — hash-based CSP or no CSP
    const { browserMock } = makeBrowserMock({
      scripts: {
        localhost: [{ id: "s1", name: "N", code: "1;", enabled: true }],
      },
    });
    loadRunner(browserMock);
    await flush();

    const scriptCalls = appendSpy.mock.calls.filter(
      ([el]) => el instanceof HTMLScriptElement && el.dataset.boostedscript
    );
    expect(scriptCalls.length).toBeGreaterThanOrEqual(1);
    expect(scriptCalls[0][0].nonce).toBeFalsy();

    appendSpy.mockRestore();
  });
});

describe("runner.js — RERUN_SCRIPTS message", () => {
  it("re-runs scripts when it receives RERUN_SCRIPTS for the current hostname", async () => {
    const { browserMock } = makeBrowserMock({
      scripts: {
        localhost: [{ id: "s1", name: "R", code: "1;", enabled: true }],
      },
    });
    loadRunner(browserMock);
    await flush();

    // Capture the registered message listener
    const listener = browserMock.runtime.onMessage.addListener.mock.calls[0][0];
    expect(listener).toBeDefined();

    // Re-run by sending the message
    const appendSpy = vi.spyOn(Element.prototype, "appendChild");
    listener({ type: "RERUN_SCRIPTS", hostname: "localhost" });
    await flush();

    const scriptCalls = appendSpy.mock.calls.filter(
      ([el]) => el instanceof HTMLScriptElement
    );
    expect(scriptCalls.length).toBeGreaterThanOrEqual(1);
    appendSpy.mockRestore();
  });

  it("ignores RERUN_SCRIPTS messages for a different hostname", async () => {
    const { browserMock } = makeBrowserMock({
      scripts: {
        localhost: [{ id: "s1", name: "R", code: "1;", enabled: true }],
      },
    });
    loadRunner(browserMock);
    await flush();

    const listener = browserMock.runtime.onMessage.addListener.mock.calls[0][0];
    const appendSpy = vi.spyOn(Element.prototype, "appendChild");

    listener({ type: "RERUN_SCRIPTS", hostname: "other.com" });
    await flush();

    const scriptCalls = appendSpy.mock.calls.filter(
      ([el]) => el instanceof HTMLScriptElement
    );
    expect(scriptCalls).toHaveLength(0);
    appendSpy.mockRestore();
  });

  it("ignores messages of unknown type", async () => {
    const { browserMock } = makeBrowserMock({ scripts: {} });
    loadRunner(browserMock);
    await flush();

    const listener = browserMock.runtime.onMessage.addListener.mock.calls[0][0];
    const getSpy = browserMock.storage.local.get;
    getSpy.mockClear();

    listener({ type: "SOMETHING_ELSE", hostname: "localhost" });
    await flush();

    expect(getSpy).not.toHaveBeenCalled();
  });
});
