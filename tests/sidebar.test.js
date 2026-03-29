// @vitest-environment jsdom

/**
 * Tests for sidebar.js pure functions:
 *  - parseMarkdown
 *  - escapeHtml
 *  - parseAssistantBlocks
 *  - extractScriptToApply
 *  - buildInitialContextMessage
 *
 * sidebar.js is a self-invoking script that immediately queries DOM elements,
 * so we set up all required elements and mock globals before running it.
 */

import vm from "vm";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { makeBrowserMock } from "./helpers/make-browser-mock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIDEBAR_SOURCE = readFileSync(join(__dirname, "../sidebar.js"), "utf-8");

/** Minimal HTML matching the IDs sidebar.js queries on load. */
const SIDEBAR_HTML = `
  <span id="domainLabel"></span>
  <select id="scriptSelect"></select>
  <input type="checkbox" id="enabledToggle">
  <button id="btnNew"></button>
  <button id="btnDelete"></button>
  <button id="btnSave"></button>
  <div id="chatLog"></div>
  <textarea id="chatInput"></textarea>
  <button id="btnSend"></button>
  <button id="btnApplyLast"></button>
  <input type="text" id="scriptName">
  <div id="providerHint"></div>
  <div id="gutter"></div>
  <div id="paneCode"></div>
  <div id="paneChat"></div>
  <textarea id="editor"></textarea>
  <input type="checkbox" id="agenticToggle">
  <div id="panelModeWrap"></div>
  <button id="btnOpenWindow"></button>
`;

/**
 * Run sidebar.js once and pull the private functions out of a small test shim
 * we inject into the global scope before execution.
 *
 * The shim exposes an `__sidebarExports` object; the source is wrapped so that
 * the IIFE body has access to it via closure — but actually, because we inject
 * it into globalThis before vm.runInThisContext, any code inside the IIFE that
 * reads a bare identifier `__sidebarExports` finds it on the global scope.
 */
let fns;

beforeAll(() => {
  document.body.innerHTML = SIDEBAR_HTML;

  // DOMPurify passthrough — no sanitisation in tests, HTML is trusted test input
  globalThis.DOMPurify = {
    sanitize: (s) => s,
    addHook: vi.fn(),
  };

  // Minimal browser mock (sidebar.js only uses runtime.sendMessage during interactions)
  const { browserMock } = makeBrowserMock();
  browserMock.runtime.sendMessage.mockResolvedValue({ ok: true, settings: { provider: "ollama" } });
  globalThis.browser = browserMock;
  globalThis.chrome = undefined;

  // Shim: sidebar.js will write its private functions here if we expose the object globally
  globalThis.__sidebarExports = {};

  // Patch: append export statements after the closing of the outer IIFE so the
  // functions are captured. We reopen the IIFE scope by extracting the names we
  // need. The cleanest way without modifying source is to shadow the functions
  // after the IIFE runs — but since they're scoped inside the IIFE we instead
  // wrap the whole source so the inner functions assign to __sidebarExports.
  const patched = SIDEBAR_SOURCE.replace(
    /\}\)\(\);(\s*)$/, // closing of the IIFE (last occurrence, anchored to end)
    `
  // --- test shim: export private functions ---
  if (typeof __sidebarExports !== "undefined") {
    __sidebarExports.parseMarkdown = parseMarkdown;
    __sidebarExports.escapeHtml = escapeHtml;
    __sidebarExports.parseAssistantBlocks = parseAssistantBlocks;
    __sidebarExports.extractScriptToApply = extractScriptToApply;
    __sidebarExports.buildInitialContextMessage = buildInitialContextMessage;
  }
})();`
  );

  vm.runInThisContext(patched);
  fns = globalThis.__sidebarExports;
});

// ─── escapeHtml ───────────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  it("escapes & < >", () => {
    expect(fns.escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("returns plain strings unchanged", () => {
    expect(fns.escapeHtml("hello world")).toBe("hello world");
  });

  it("coerces non-strings to string", () => {
    expect(fns.escapeHtml(42)).toBe("42");
  });
});

// ─── parseMarkdown ────────────────────────────────────────────────────────────

describe("parseMarkdown", () => {
  it("wraps plain text in a paragraph", () => {
    const html = fns.parseMarkdown("hello");
    expect(html).toContain("<p>hello</p>");
  });

  it("converts **bold** to <strong>", () => {
    expect(fns.parseMarkdown("**bold**")).toContain("<strong>bold</strong>");
  });

  it("converts *italic* to <em>", () => {
    expect(fns.parseMarkdown("*italic*")).toContain("<em>italic</em>");
  });

  it("converts ***bold italic*** to <strong><em>", () => {
    const html = fns.parseMarkdown("***bi***");
    expect(html).toContain("<strong><em>bi</em></strong>");
  });

  it("converts `inline code` to <code>", () => {
    expect(fns.parseMarkdown("`code`")).toContain("<code>code</code>");
  });

  it("converts # heading to <h1>", () => {
    expect(fns.parseMarkdown("# Title")).toContain("<h1>Title</h1>");
  });

  it("converts ## heading to <h2>", () => {
    expect(fns.parseMarkdown("## Sub")).toContain("<h2>Sub</h2>");
  });

  it("converts - list item to <ul><li>", () => {
    const html = fns.parseMarkdown("- item");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>item</li>");
  });

  it("converts 1. ordered item to <ol><li>", () => {
    const html = fns.parseMarkdown("1. first");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
  });

  it("converts > blockquote", () => {
    expect(fns.parseMarkdown("> quote")).toContain("<blockquote>");
  });

  it("renders --- as <hr>", () => {
    expect(fns.parseMarkdown("---")).toContain("<hr>");
  });

  it("renders a markdown link as <a> with the href", () => {
    const html = fns.parseMarkdown("[Click](https://example.com)");
    expect(html).toContain('<a href="https://example.com">Click</a>');
  });

  it("escapes HTML in plain text to prevent injection", () => {
    const html = fns.parseMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("separates paragraphs on blank lines", () => {
    const html = fns.parseMarkdown("para one\n\npara two");
    expect(html).toContain("<p>para one</p>");
    expect(html).toContain("<p>para two</p>");
  });
});

// ─── parseAssistantBlocks ─────────────────────────────────────────────────────

describe("parseAssistantBlocks", () => {
  it("returns empty array when no code blocks are present", () => {
    expect(fns.parseAssistantBlocks("just text")).toEqual([]);
  });

  it("extracts a single ```javascript block", () => {
    const text = "```javascript\nconsole.log(1);\n```";
    expect(fns.parseAssistantBlocks(text)).toEqual(["console.log(1);"]);
  });

  it("extracts multiple blocks and trims whitespace", () => {
    const text = "```js\nfoo();\n```\n\n```js\nbar();\n```";
    expect(fns.parseAssistantBlocks(text)).toEqual(["foo();", "bar();"]);
  });

  it("matches ```js, ```javascript, ```mjs, ```cjs variants", () => {
    for (const lang of ["js", "javascript", "mjs", "cjs"]) {
      const text = `\`\`\`${lang}\ncode;\n\`\`\``;
      expect(fns.parseAssistantBlocks(text)).toEqual(["code;"]);
    }
  });

  it("ignores non-javascript fenced blocks", () => {
    const text = "```python\nprint('hi')\n```";
    expect(fns.parseAssistantBlocks(text)).toEqual([]);
  });
});

// ─── extractScriptToApply ─────────────────────────────────────────────────────

describe("extractScriptToApply", () => {
  it("returns null for empty or missing text", () => {
    expect(fns.extractScriptToApply("", false)).toBeNull();
    expect(fns.extractScriptToApply(null, false)).toBeNull();
  });

  it("returns last js block in non-agentic mode", () => {
    const text = "```js\nfirst();\n```\n```js\nsecond();\n```";
    expect(fns.extractScriptToApply(text, false)).toBe("second();");
  });

  it("returns null when no js blocks exist in non-agentic mode", () => {
    expect(fns.extractScriptToApply("just prose", false)).toBeNull();
  });

  it("returns the ```boostedscript block in agentic mode", () => {
    const text = "Here is the update:\n```boostedscript\nscript();\n```";
    expect(fns.extractScriptToApply(text, true)).toBe("script();");
  });

  it("falls back to last js block when no boostedscript block in agentic mode", () => {
    const text = "```js\nfallback();\n```";
    expect(fns.extractScriptToApply(text, true)).toBe("fallback();");
  });

  it("prefers boostedscript over js blocks in agentic mode", () => {
    const text = "```js\nignored();\n```\n```boostedscript\nchosen();\n```";
    expect(fns.extractScriptToApply(text, true)).toBe("chosen();");
  });
});

// ─── buildInitialContextMessage ───────────────────────────────────────────────

describe("buildInitialContextMessage", () => {
  const baseCtx = { hostname: "example.com", url: "https://example.com/" };

  it("includes the page URL and hostname", () => {
    const snap = { ok: true, url: "https://example.com/", title: "Test", html: "<p>hi</p>", truncated: false, restricted: false };
    const msg = fns.buildInitialContextMessage(snap, baseCtx, "// code");
    expect(msg).toContain("https://example.com/");
    expect(msg).toContain("example.com");
  });

  it("includes the current editor code inside a fenced block", () => {
    const snap = { ok: true, url: "https://example.com/", title: "", html: "", truncated: false, restricted: false };
    const msg = fns.buildInitialContextMessage(snap, baseCtx, "myCode();");
    expect(msg).toContain("```javascript");
    expect(msg).toContain("myCode();");
  });

  it("includes the HTML snapshot inside a fenced block", () => {
    const snap = { ok: true, url: "https://example.com/", title: "", html: "<body>content</body>", truncated: false, restricted: false };
    const msg = fns.buildInitialContextMessage(snap, baseCtx, "");
    expect(msg).toContain("```html");
    expect(msg).toContain("<body>content</body>");
  });

  it("notes truncation when snap.truncated is true", () => {
    const snap = { ok: true, url: "https://example.com/", title: "", html: "...", truncated: true, restricted: false };
    const msg = fns.buildInitialContextMessage(snap, baseCtx, "");
    expect(msg).toContain("truncated");
  });

  it("handles restricted pages gracefully", () => {
    const snap = { ok: true, restricted: true };
    const msg = fns.buildInitialContextMessage(snap, baseCtx, "");
    expect(msg).toContain("Not available");
  });

  it("handles failed snapshot (ok: false) gracefully", () => {
    const snap = { ok: false, error: "Permission denied" };
    const msg = fns.buildInitialContextMessage(snap, baseCtx, "");
    expect(msg).toContain("Permission denied");
  });

  it("falls back to ctx.url when snap has no url", () => {
    const snap = { ok: false };
    const msg = fns.buildInitialContextMessage(snap, { ...baseCtx, url: "https://fallback.com/" }, "");
    expect(msg).toContain("https://fallback.com/");
  });
});
