/**
 * Tests for background.js
 *
 * background.js is a plain global-scope script (not a module), so we run it
 * inside a vm context seeded with the browser API and fetch mocks. All
 * top-level function declarations become properties of the context object and
 * can be called directly in tests.
 */

import vm from "vm";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeBrowserMock } from "./helpers/make-browser-mock.js";
import {
  makeJsonResponse,
  makeErrorResponse,
  makeSseResponse,
  makeNdjsonResponse,
} from "./helpers/make-fetch-mock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BG_SOURCE = readFileSync(join(__dirname, "../background.js"), "utf-8");

/** Load background.js into a fresh vm context and return it. */
function loadBackground({ storage = {}, fetchMock } = {}) {
  const { browserMock, store } = makeBrowserMock(storage);
  const fetch = fetchMock ?? vi.fn();
  const ctx = vm.createContext({
    browser: browserMock,
    fetch,
    console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
    TextDecoder,
    TextEncoder,
    URL,
  });
  vm.runInContext(BG_SOURCE, ctx);
  // Capture the registered onMessage listener
  const onMessage = browserMock.runtime.onMessage.addListener.mock.calls[0]?.[0];
  // Capture the registered onConnect listener
  const onConnect = browserMock.runtime.onConnect.addListener.mock.calls[0]?.[0];
  return { ctx, browserMock, store, fetch, onMessage, onConnect };
}

/** Call the background onMessage listener and wait for async resolution. */
async function dispatch(onMessage, message) {
  const sendResponse = vi.fn();
  onMessage(message, {}, sendResponse);
  await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
  return sendResponse.mock.calls[0][0];
}

// ─── Pure functions ───────────────────────────────────────────────────────────

describe("hostnameFromUrl", () => {
  let ctx;
  beforeEach(() => { ({ ctx } = loadBackground()); });

  it("extracts hostname from https URL", () => {
    expect(ctx.hostnameFromUrl("https://example.com/page")).toBe("example.com");
  });

  it("extracts hostname from http URL with path and query", () => {
    expect(ctx.hostnameFromUrl("http://sub.domain.org/a/b?q=1")).toBe("sub.domain.org");
  });

  it("returns _ for a URL with no hostname", () => {
    expect(ctx.hostnameFromUrl("file:///local")).toBe("_");
  });

  it("returns _ for an empty string", () => {
    expect(ctx.hostnameFromUrl("")).toBe("_");
  });

  it("returns _ for a non-URL string", () => {
    expect(ctx.hostnameFromUrl("not-a-url")).toBe("_");
  });
});

describe("mergeAnthropicTurns", () => {
  let ctx;
  beforeEach(() => { ({ ctx } = loadBackground()); });

  it("returns empty array for empty input", () => {
    expect(ctx.mergeAnthropicTurns([])).toEqual([]);
  });

  it("keeps alternating turns separate", () => {
    const input = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "bye" },
    ];
    expect(ctx.mergeAnthropicTurns(input)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "bye" },
    ]);
  });

  it("merges consecutive same-role messages with double newline", () => {
    const input = [
      { role: "user", content: "part one" },
      { role: "user", content: "part two" },
    ];
    const result = ctx.mergeAnthropicTurns(input);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("part one\n\npart two");
  });

  it("normalises non-assistant roles to user", () => {
    const input = [{ role: "system", content: "ctx" }, { role: "user", content: "q" }];
    const result = ctx.mergeAnthropicTurns(input);
    expect(result[0].role).toBe("user");
  });
});

describe("systemPromptWithAgentic", () => {
  let ctx;
  beforeEach(() => { ({ ctx } = loadBackground()); });

  it("returns the base prompt when agenticMode is false", () => {
    const s = ctx.systemPromptWithAgentic({ systemPrompt: "base", agenticMode: false });
    expect(s).toBe("base");
  });

  it("appends the agentic suffix when agenticMode is true", () => {
    const s = ctx.systemPromptWithAgentic({ systemPrompt: "base", agenticMode: true });
    expect(s).toContain("base");
    expect(s).toContain("boostedscript");
  });

  it("falls back to DEFAULT_SETTINGS.systemPrompt when none is provided", () => {
    const s = ctx.systemPromptWithAgentic({ agenticMode: false });
    expect(s).toContain("userscripts");
  });
});

// ─── readJsonOrThrow ──────────────────────────────────────────────────────────

describe("readJsonOrThrow", () => {
  let ctx;
  beforeEach(() => { ({ ctx } = loadBackground()); });

  it("parses and returns JSON body on ok response", async () => {
    const res = makeJsonResponse({ choices: [] });
    const data = await ctx.readJsonOrThrow(res, "http://x");
    expect(data).toEqual({ choices: [] });
  });

  it("throws with API error message on non-ok response", async () => {
    const res = makeErrorResponse("invalid_api_key", 401);
    await expect(ctx.readJsonOrThrow(res, "http://x")).rejects.toThrow("invalid_api_key");
  });

  it("throws on invalid JSON body", async () => {
    const res = { ok: true, status: 200, text: vi.fn().mockResolvedValue("not-json") };
    await expect(ctx.readJsonOrThrow(res, "http://x")).rejects.toThrow(/Invalid JSON/);
  });
});

// ─── OpenAI-compatible (non-streaming) ───────────────────────────────────────

describe("callOpenAICompatible", () => {
  it("sends correct request and returns message content", async () => {
    const response = makeJsonResponse({
      choices: [{ message: { content: "hello from gpt" } }],
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    const { ctx } = loadBackground({ fetchMock });

    const settings = {
      openaiBaseUrl: "https://api.openai.com/v1",
      openaiModel: "gpt-4o-mini",
      openaiKey: "sk-test",
      systemPrompt: "You help.",
      agenticMode: false,
    };
    const result = await ctx.callOpenAICompatible(settings, [{ role: "user", content: "hi" }]);

    expect(result).toBe("hello from gpt");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages[0].role).toBe("system");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
  });

  it("omits Authorization header when no key is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeJsonResponse({ choices: [{ message: { content: "ok" } }] })
    );
    const { ctx } = loadBackground({ fetchMock });
    const settings = { openaiBaseUrl: "http://localhost/v1", openaiModel: "m", openaiKey: "", systemPrompt: "", agenticMode: false };
    await ctx.callOpenAICompatible(settings, []);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("throws when the response has no content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeJsonResponse({ choices: [{ message: { content: null } }] })
    );
    const { ctx } = loadBackground({ fetchMock });
    const settings = { openaiBaseUrl: "http://x/v1", openaiModel: "m", openaiKey: "", systemPrompt: "", agenticMode: false };
    await expect(ctx.callOpenAICompatible(settings, [])).rejects.toThrow("Empty model response");
  });
});

// ─── Anthropic (non-streaming) ───────────────────────────────────────────────

describe("callAnthropic", () => {
  it("throws when no API key is configured", async () => {
    const { ctx } = loadBackground();
    await expect(
      ctx.callAnthropic({ anthropicKey: "", systemPrompt: "", agenticMode: false }, [])
    ).rejects.toThrow(/API key/);
  });

  it("sends correct headers and returns text block content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeJsonResponse({ content: [{ type: "text", text: "pong" }] })
    );
    const { ctx } = loadBackground({ fetchMock });
    const settings = {
      anthropicKey: "ant-key",
      anthropicBaseUrl: "https://api.anthropic.com",
      anthropicModel: "claude-3",
      systemPrompt: "sys",
      agenticMode: false,
    };
    const result = await ctx.callAnthropic(settings, [{ role: "user", content: "ping" }]);

    expect(result).toBe("pong");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("ant-key");
    expect(init.headers["anthropic-version"]).toBeDefined();
  });

  it("throws when response has no text block", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeJsonResponse({ content: [] })
    );
    const { ctx } = loadBackground({ fetchMock });
    const settings = { anthropicKey: "k", anthropicBaseUrl: "https://api.anthropic.com", anthropicModel: "m", systemPrompt: "", agenticMode: false };
    await expect(ctx.callAnthropic(settings, [])).rejects.toThrow("Empty model response");
  });
});

// ─── Ollama (non-streaming) ───────────────────────────────────────────────────

describe("callOllama", () => {
  it("sends correct request to /api/chat and returns message content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeJsonResponse({ message: { content: "ollama says hi" } })
    );
    const { ctx } = loadBackground({ fetchMock });
    const settings = {
      ollamaBaseUrl: "http://127.0.0.1:11434",
      ollamaModel: "llama3.2",
      systemPrompt: "sys",
      agenticMode: false,
    };
    const result = await ctx.callOllama(settings, [{ role: "user", content: "hello" }]);

    expect(result).toBe("ollama says hi");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
  });

  it("throws on empty Ollama response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeJsonResponse({ message: { content: "" } })
    );
    const { ctx } = loadBackground({ fetchMock });
    const settings = { ollamaBaseUrl: "http://127.0.0.1:11434", ollamaModel: "m", systemPrompt: "", agenticMode: false };
    await expect(ctx.callOllama(settings, [])).rejects.toThrow("Empty model response");
  });
});

// ─── OpenAI streaming ────────────────────────────────────────────────────────

describe("callOpenAICompatibleStream", () => {
  it("calls onChunk for each delta content token", async () => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { content: "hel" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
      "[DONE]",
    ];
    const fetchMock = vi.fn().mockResolvedValue(makeSseResponse(chunks));
    const { ctx } = loadBackground({ fetchMock });

    const onChunk = vi.fn();
    await ctx.callOpenAICompatibleStream(
      { openaiBaseUrl: "http://x/v1", openaiModel: "m", openaiKey: "", systemPrompt: "", agenticMode: false },
      [{ role: "user", content: "hi" }],
      onChunk
    );

    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(onChunk).toHaveBeenNthCalledWith(1, "hel");
    expect(onChunk).toHaveBeenNthCalledWith(2, "lo");
  });

  it("ignores malformed SSE lines without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeSseResponse(["not-json", "[DONE]"]));
    const { ctx } = loadBackground({ fetchMock });
    const onChunk = vi.fn();
    await expect(
      ctx.callOpenAICompatibleStream(
        { openaiBaseUrl: "http://x/v1", openaiModel: "m", openaiKey: "", systemPrompt: "", agenticMode: false },
        [],
        onChunk
      )
    ).resolves.not.toThrow();
    expect(onChunk).not.toHaveBeenCalled();
  });
});

// ─── Anthropic streaming ─────────────────────────────────────────────────────

describe("callAnthropicStream", () => {
  it("calls onChunk for content_block_delta text events", async () => {
    const events = [
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "world" } }),
      JSON.stringify({ type: "message_stop" }),
    ];
    const fetchMock = vi.fn().mockResolvedValue(makeSseResponse(events));
    const { ctx } = loadBackground({ fetchMock });
    const onChunk = vi.fn();

    await ctx.callAnthropicStream(
      { anthropicKey: "k", anthropicBaseUrl: "https://api.anthropic.com", anthropicModel: "m", systemPrompt: "", agenticMode: false },
      [{ role: "user", content: "ping" }],
      onChunk
    );

    expect(onChunk).toHaveBeenCalledOnce();
    expect(onChunk).toHaveBeenCalledWith("world");
  });

  it("throws when no API key is configured", async () => {
    const { ctx } = loadBackground();
    await expect(
      ctx.callAnthropicStream({ anthropicKey: "" }, [], vi.fn())
    ).rejects.toThrow(/API key/);
  });
});

// ─── Ollama streaming ─────────────────────────────────────────────────────────

describe("callOllamaStream", () => {
  it("calls onChunk for each NDJSON message line", async () => {
    const lines = [
      { message: { content: "foo" }, done: false },
      { message: { content: "bar" }, done: true },
    ];
    const fetchMock = vi.fn().mockResolvedValue(makeNdjsonResponse(lines));
    const { ctx } = loadBackground({ fetchMock });
    const onChunk = vi.fn();

    await ctx.callOllamaStream(
      { ollamaBaseUrl: "http://127.0.0.1:11434", ollamaModel: "m", systemPrompt: "", agenticMode: false },
      [{ role: "user", content: "hi" }],
      onChunk
    );

    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(onChunk).toHaveBeenNthCalledWith(1, "foo");
    expect(onChunk).toHaveBeenNthCalledWith(2, "bar");
  });
});

// ─── readSse ─────────────────────────────────────────────────────────────────

describe("readSse", () => {
  let ctx;
  beforeEach(() => { ({ ctx } = loadBackground()); });

  it("calls onData for each data: line", async () => {
    const encoder = new TextEncoder();
    const raw = "data: hello\n\ndata: world\n\n";
    let done = false;
    const mockRes = {
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: encoder.encode(raw) })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: vi.fn(),
        }),
      },
    };
    const onData = vi.fn();
    await ctx.readSse(mockRes, onData);
    expect(onData).toHaveBeenCalledWith("hello");
    expect(onData).toHaveBeenCalledWith("world");
  });
});

// ─── Message handlers ─────────────────────────────────────────────────────────

describe("GET_CONTEXT message", () => {
  it("returns hostname and scripts for the active tab", async () => {
    const scripts = { "example.com": [{ id: "s1", name: "Test", code: "", enabled: true }] };
    const { browserMock, onMessage } = loadBackground({
      storage: { scripts, activeScriptByDomain: { "example.com": "s1" } },
    });
    browserMock.tabs.query.mockResolvedValue([{ id: 1, url: "https://example.com/page" }]);

    const res = await dispatch(onMessage, { type: "GET_CONTEXT" });

    expect(res.ok).toBe(true);
    expect(res.hostname).toBe("example.com");
    expect(res.scripts).toHaveLength(1);
    expect(res.activeId).toBe("s1");
  });

  it("returns hostname _ when no web tab is active", async () => {
    const { browserMock, onMessage } = loadBackground();
    browserMock.tabs.query.mockResolvedValue([]);

    const res = await dispatch(onMessage, { type: "GET_CONTEXT" });

    expect(res.ok).toBe(true);
    expect(res.hostname).toBe("_");
  });
});

describe("SAVE_SCRIPT message", () => {
  it("persists a new script to storage", async () => {
    const { onMessage, store } = loadBackground();
    const script = { id: "abc", name: "My Script", code: "alert(1)", enabled: true };

    const res = await dispatch(onMessage, { type: "SAVE_SCRIPT", hostname: "foo.com", script });

    expect(res.ok).toBe(true);
    expect(store.scripts["foo.com"]).toHaveLength(1);
    expect(store.scripts["foo.com"][0].id).toBe("abc");
  });

  it("updates an existing script in-place", async () => {
    const existing = { id: "abc", name: "Old", code: "1", enabled: true };
    const { onMessage, store } = loadBackground({
      storage: { scripts: { "foo.com": [existing] } },
    });

    await dispatch(onMessage, { type: "SAVE_SCRIPT", hostname: "foo.com", script: { id: "abc", code: "2" } });

    expect(store.scripts["foo.com"][0].code).toBe("2");
  });

  it("returns error when payload is invalid", async () => {
    const { onMessage } = loadBackground();
    const res = await dispatch(onMessage, { type: "SAVE_SCRIPT", hostname: "", script: null });
    expect(res.ok).toBe(false);
  });
});

describe("DELETE_SCRIPT message", () => {
  it("removes the script from storage", async () => {
    const { onMessage, store } = loadBackground({
      storage: {
        scripts: { "foo.com": [{ id: "s1", name: "A", code: "", enabled: true }] },
        activeScriptByDomain: { "foo.com": "s1" },
      },
    });

    const res = await dispatch(onMessage, { type: "DELETE_SCRIPT", hostname: "foo.com", scriptId: "s1" });

    expect(res.ok).toBe(true);
    expect(store.scripts["foo.com"]).toBeUndefined();
    expect(store.activeScriptByDomain["foo.com"]).toBeUndefined();
  });

  it("promotes the next script to active when deleting the active one", async () => {
    const { onMessage, store } = loadBackground({
      storage: {
        scripts: {
          "foo.com": [
            { id: "s1", name: "A", code: "", enabled: true },
            { id: "s2", name: "B", code: "", enabled: true },
          ],
        },
        activeScriptByDomain: { "foo.com": "s1" },
      },
    });

    await dispatch(onMessage, { type: "DELETE_SCRIPT", hostname: "foo.com", scriptId: "s1" });

    expect(store.activeScriptByDomain["foo.com"]).toBe("s2");
  });
});

describe("SET_ACTIVE_SCRIPT message", () => {
  it("updates the active script for a hostname", async () => {
    const { onMessage, store } = loadBackground();

    const res = await dispatch(onMessage, { type: "SET_ACTIVE_SCRIPT", hostname: "foo.com", scriptId: "s2" });

    expect(res.ok).toBe(true);
    expect(store.activeScriptByDomain["foo.com"]).toBe("s2");
  });

  it("removes the active entry when scriptId is null", async () => {
    const { onMessage, store } = loadBackground({
      storage: { activeScriptByDomain: { "foo.com": "s1" } },
    });

    await dispatch(onMessage, { type: "SET_ACTIVE_SCRIPT", hostname: "foo.com", scriptId: null });

    expect(store.activeScriptByDomain["foo.com"]).toBeUndefined();
  });
});

describe("GET_SETTINGS message", () => {
  it("returns merged settings with defaults", async () => {
    const { onMessage } = loadBackground({ storage: { settings: { provider: "anthropic" } } });

    const res = await dispatch(onMessage, { type: "GET_SETTINGS" });

    expect(res.ok).toBe(true);
    expect(res.settings.provider).toBe("anthropic");
    // default field still present
    expect(res.settings.ollamaModel).toBeDefined();
  });
});

describe("SAVE_SETTINGS message", () => {
  it("merges new settings with existing ones", async () => {
    const { onMessage, store } = loadBackground({
      storage: { settings: { provider: "ollama", ollamaModel: "llama3.2" } },
    });

    await dispatch(onMessage, { type: "SAVE_SETTINGS", settings: { provider: "anthropic" } });

    expect(store.settings.provider).toBe("anthropic");
    expect(store.settings.ollamaModel).toBe("llama3.2");
  });
});

describe("BROADCAST_RERUN message", () => {
  it("sends RERUN_SCRIPTS to all tabs matching the hostname", async () => {
    const { browserMock, onMessage } = loadBackground();
    browserMock.tabs.query.mockResolvedValue([
      { id: 10, url: "https://example.com/a" },
      { id: 11, url: "https://other.com/" },
    ]);

    const res = await dispatch(onMessage, { type: "BROADCAST_RERUN", hostname: "example.com" });

    expect(res.ok).toBe(true);
    expect(browserMock.tabs.sendMessage).toHaveBeenCalledOnce();
    expect(browserMock.tabs.sendMessage).toHaveBeenCalledWith(10, {
      type: "RERUN_SCRIPTS",
      hostname: "example.com",
    });
  });
});

describe("unknown message type", () => {
  it("returns ok: false with Unknown message error", async () => {
    const { onMessage } = loadBackground();
    const res = await dispatch(onMessage, { type: "DOES_NOT_EXIST" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unknown/i);
  });
});
