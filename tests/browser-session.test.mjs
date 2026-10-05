import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSession } from "../src/agent/browser-session.js";

function fakeRaw() {
  let listCount = 0;
  const calls = [];
  const invoke = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "tabs_list") {
      listCount += 1;
      if (listCount === 1) return [
        { tab_id: 101, active: true, pinned: false, title: "Alpha", url: "https://a.example" },
        { tab_id: 202, active: false, pinned: false, title: "Beta", url: "https://b.example" }
      ];
      return [
        { tab_id: 202, active: true, pinned: false, title: "Beta", url: "https://b.example" },
        { tab_id: 101, active: false, pinned: false, title: "Alpha", url: "https://a.example" }
      ];
    }
    if (tool === "click") return { action: "click", ref: "@e7", blocker: null, observation: { mode: "delta", busy: { active: false, signals: [] }, changes: { added: [{ ref: "@e9", role: "button", name: "Next" }] } } };
    if (tool === "page_state") return { mode: "unchanged", busy: { active: false, signals: [] }, url: "https://a.example" };
    throw new Error(`unexpected ${tool}`);
  };
  return { invoke, calls };
}

test("tab aliases stay stable when active tab/order changes", async () => {
  const fake = fakeRaw();
  const session = new BrowserSession({ invokeRaw: fake.invoke });
  const first = await session.listTabs();
  assert.deepEqual(first.tabs.map((x) => [x.tab, x.title]), [["T1", "Alpha"], ["T2", "Beta"]]);
  const second = await session.listTabs();
  assert.deepEqual(second.tabs.map((x) => [x.tab, x.title]), [["T2", "Beta"], ["T1", "Alpha"]]);
});

test("scoped refs route actions to the owning tab and externalize results", async () => {
  const fake = fakeRaw();
  const session = new BrowserSession({ invokeRaw: fake.invoke });
  await session.listTabs();
  const result = await session.call("click", { ref: "T1:e7" }, { settle: false });
  const click = fake.calls.find((x) => x.tool === "click");
  assert.equal(click.args.tab_id, 101);
  assert.equal(click.args.ref, "@e7");
  assert.equal(result.modelResult.ref, "T1:e7");
  assert.equal(result.modelResult.observation.changes.added[0].ref, "T1:e9");
});

test("mismatched scoped refs are rejected", async () => {
  const fake = fakeRaw();
  const session = new BrowserSession({ invokeRaw: fake.invoke });
  await session.listTabs();
  await assert.rejects(
    session.call("page_read", { tab: "T2", ref: "T1:e7" }, { settle: false }),
    /belongs to T1, not T2/
  );
});

test("post-action settling waits through busy state and returns async updates", async () => {
  let pagePoll = 0;
  const invoke = async (tool) => {
    if (tool === "tabs_list") return [{ tab_id: 101, active: true, title: "A", url: "https://a.example" }];
    if (tool === "click") return {
      action: "click",
      ref: "@e1",
      observation: { mode: "full", busy: { active: true, signals: [{ name: "Stop response" }] } }
    };
    if (tool === "page_state") {
      pagePoll += 1;
      if (pagePoll === 1) return { mode: "unchanged", busy: { active: true, signals: [{ name: "Stop response" }] } };
      if (pagePoll === 2) return { mode: "delta", busy: { active: false, signals: [] }, changes: { added: [{ ref: "@e2", role: "text", name: "Done" }] } };
      return { mode: "unchanged", busy: { active: false, signals: [] } };
    }
    throw new Error(`unexpected ${tool}`);
  };
  const session = new BrowserSession({
    invokeRaw: invoke,
    settleOptions: { pollMs: 1, quietTargetMs: 2, normalMaxWaitMs: 10, busyMaxWaitMs: 20 }
  });
  await session.listTabs();
  const result = await session.call("click", { ref: "T1:e1" });
  assert.equal(result.modelResult.settle.settled, true);
  assert.equal(result.modelResult.settle.busy, false);
  assert.equal(result.modelResult.async_page_updates.length, 1);
  assert.equal(result.modelResult.async_page_updates[0].observation.changes.added[0].ref, "T1:e2");
});

test("wait observes the same aliased tab after the delay", async () => {
  const calls = [];
  const invoke = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "tabs_list") return [{ tab_id: 7, active: true, title: "Wait", url: "https://wait.example" }];
    if (tool === "page_state") return { mode: "delta", busy: { active: false, signals: [] }, changes: { added: [] } };
    throw new Error(`unexpected ${tool}`);
  };
  const session = new BrowserSession({ invokeRaw: invoke });
  await session.listTabs();
  const result = await session.call("wait", { tab: "T1", seconds: 0.25 });
  assert.equal(result.modelResult.tab, "T1");
  assert.equal(result.modelResult.waited_ms, 250);
  const stateCall = calls.find((x) => x.tool === "page_state");
  assert.equal(stateCall.args.tab_id, 7);
});
