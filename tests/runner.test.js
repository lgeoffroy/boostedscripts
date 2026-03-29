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
