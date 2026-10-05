import test from "node:test";
import assert from "node:assert/strict";

import {
  OpenAIResponsesClient,
  functionCalls,
  functionResult,
  interactionText
} from "../src/agent/openai.js";

test("OpenAI adapter builds a Responses request with instructions, tools and previous response", async () => {
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ id: "resp_2", status: "completed", output: [] }); }
    };
  };
  const client = new OpenAIResponsesClient({ apiKey: "test-key", model: "gpt-6-luna", fetchImpl });
  await client.createInteraction({
    input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    systemInstruction: "browser rules",
    tools: [{ type: "function", name: "tabs_list", parameters: { type: "object", properties: {} } }],
    previousInteractionId: "resp_1"
  });
  assert.equal(seen.url, "https://api.openai.com/v1/responses");
  assert.equal(seen.options.headers.Authorization, "Bearer test-key");
  assert.equal(seen.body.model, "gpt-6-luna");
  assert.equal(seen.body.instructions, "browser rules");
  assert.equal(seen.body.previous_response_id, "resp_1");
  assert.equal(seen.body.reasoning.effort, "medium");
});

test("OpenAI adapter normalizes function calls and final text", () => {
  const response = {
    output: [
      { type: "function_call", call_id: "call_7", name: "page_search", arguments: '{"tab":"T1","pattern":"SSO"}' },
      { type: "message", content: [{ type: "output_text", text: "Done." }] }
    ]
  };
  const calls = functionCalls(response);
  assert.deepEqual(calls[0].arguments, { tab: "T1", pattern: "SSO" });
  assert.equal(calls[0].id, "call_7");
  assert.equal(interactionText(response), "Done.");
});

test("OpenAI screenshot tool result carries text plus an input image", () => {
  const result = functionResult(
    { id: "call_img", call_id: "call_img", name: "page_screenshot" },
    { tab: "T1", screenshot_included: true },
    { mimeType: "image/png", base64: "YWJj" }
  );
  assert.equal(result.type, "function_call_output");
  assert.equal(result.call_id, "call_img");
  assert.equal(Array.isArray(result.output), true);
  assert.equal(result.output[0].type, "input_text");
  assert.equal(result.output[1].type, "input_image");
  assert.match(result.output[1].image_url, /^data:image\/png;base64,/);
});


test("OpenAI adapter preserves the native fetch receiver when no fetch implementation is injected", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;

  globalThis.fetch = async function(url, options) {
    assert.equal(this, globalThis);
    called = true;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ id: "resp_native", status: "completed", output: [] });
      }
    };
  };

  try {
    const client = new OpenAIResponsesClient({ apiKey: "test-key" });
    await client.createInteraction({
      input: "hello",
      systemInstruction: "browser rules",
      tools: []
    });
    assert.equal(called, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
