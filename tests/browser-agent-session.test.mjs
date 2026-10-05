import assert from "node:assert/strict";
import test from "node:test";
import { BrowserAgent } from "../src/agent/browser-agent.js";

function fakeClient() {
  const requests = [];
  let n = 0;
  return {
    provider: "fake",
    model: "fake-model",
    requests,
    async createInteraction(args) {
      requests.push(args);
      n += 1;
      return { id: `resp_${n}`, status: "completed", text: `reply ${n}` };
    },
    functionCalls() { return []; },
    interactionText(value) { return value.text; },
    functionResult() { throw new Error("not used"); }
  };
}

test("multiple user messages continue one provider/browser session", async () => {
  const client = fakeClient();
  let resets = 0;
  const browser = { reset() { resets += 1; }, async call() { throw new Error("not used"); } };
  const agent = new BrowserAgent({ browserSession: browser, client });

  const first = await agent.send("hello");
  const second = await agent.send("continue");

  assert.equal(first.text, "reply 1");
  assert.equal(second.text, "reply 2");
  assert.equal(resets, 1);
  assert.equal(client.requests[0].previousInteractionId, null);
  assert.equal(client.requests[1].previousInteractionId, "resp_1");
});

test("resetSession clears provider continuity and browser aliases", async () => {
  const client = fakeClient();
  let resets = 0;
  const browser = { reset() { resets += 1; }, async call() { throw new Error("not used"); } };
  const agent = new BrowserAgent({ browserSession: browser, client });

  await agent.send("first");
  agent.resetSession();
  await agent.send("new session");

  assert.equal(client.requests[1].previousInteractionId, null);
  assert.equal(resets, 3); // initial send, explicit reset, next new-session send
});
