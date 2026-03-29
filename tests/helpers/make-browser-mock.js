import { vi } from "vitest";

/**
 * Returns a fresh browser API mock and the in-memory storage map it uses.
 * Pass `storage` to pre-seed data.
 */
export function makeBrowserMock(storage = {}) {
  const store = { ...storage };

  const browserMock = {
    storage: {
      local: {
        get: vi.fn(async (keys) => {
          if (typeof keys === "string") return { [keys]: store[keys] };
          if (Array.isArray(keys))
            return Object.fromEntries(keys.map((k) => [k, store[k]]));
          // object form: keys are keys with defaults
          return Object.fromEntries(Object.keys(keys).map((k) => [k, store[k] ?? keys[k]]));
        }),
        set: vi.fn(async (data) => Object.assign(store, data)),
      },
    },
    runtime: {
      onMessage: { addListener: vi.fn() },
      onConnect: { addListener: vi.fn() },
      sendMessage: vi.fn(),
      getURL: vi.fn((p) => `moz-extension://test/${p}`),
    },
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(),
      sendMessage: vi.fn(),
    },
    scripting: {
      executeScript: vi.fn(),
    },
    action: {
      onClicked: { addListener: vi.fn() },
    },
    sidebarAction: {
      open: vi.fn(),
      close: vi.fn(),
    },
    windows: {
      create: vi.fn(),
    },
    // No onBeforeSendHeaders → installOllamaOriginWorkaround() exits early
    webRequest: {},
  };

  return { browserMock, store };
}
