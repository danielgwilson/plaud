import test from "node:test";
import assert from "node:assert/strict";
import { plaudRequest } from "../src/plaud-api.js";

test("plaudRequest sends browser-like headers accepted by Plaud edge checks", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> | undefined;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string> | undefined;
    return {
      ok: true,
      json: async () => ({ status: 0, data_file_list: [] }),
    } as Response;
  }) as typeof fetch;

  try {
    await plaudRequest({ token: "bearer test-token", endpoint: "/file/simple/web", retries: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(capturedHeaders?.authorization, "bearer test-token");
  assert.equal(capturedHeaders?.["app-platform"], "web");
  assert.match(capturedHeaders?.["user-agent"] ?? "", /Mozilla\/5\.0/);
  assert.match(capturedHeaders?.["user-agent"] ?? "", /Chrome\/\d+/);
});
