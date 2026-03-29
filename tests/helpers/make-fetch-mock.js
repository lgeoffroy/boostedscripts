import { vi } from "vitest";

/** Regular JSON response mock (non-streaming). */
export function makeJsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Bad Request",
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    body: null,
  };
}

/** Error response where the API returns a JSON error body. */
export function makeErrorResponse(apiMessage, status = 400) {
  return makeJsonResponse({ error: { message: apiMessage } }, { ok: false, status });
}

/**
 * SSE streaming response mock.
 * `events` is an array of strings that become individual `data: …` lines.
 */
export function makeSseResponse(events) {
  const encoder = new TextEncoder();
  const rawLines = events.map((e) => `data: ${e}\n\n`).join("");
  const chunk = encoder.encode(rawLines);
  let exhausted = false;
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: vi.fn(),
    body: {
      getReader: () => ({
        read: vi.fn().mockImplementation(async () => {
          if (!exhausted) { exhausted = true; return { done: false, value: chunk }; }
          return { done: true, value: undefined };
        }),
        releaseLock: vi.fn(),
      }),
    },
  };
}

/**
 * Ollama-style NDJSON streaming response mock.
 * `objects` is an array of objects serialised as newline-delimited JSON.
 */
export function makeNdjsonResponse(objects) {
  const encoder = new TextEncoder();
  const raw = objects.map((o) => JSON.stringify(o)).join("\n") + "\n";
  const chunk = encoder.encode(raw);
  let exhausted = false;
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: vi.fn(),
    body: {
      getReader: () => ({
        read: vi.fn().mockImplementation(async () => {
          if (!exhausted) { exhausted = true; return { done: false, value: chunk }; }
          return { done: true, value: undefined };
        }),
        releaseLock: vi.fn(),
      }),
    },
  };
}
