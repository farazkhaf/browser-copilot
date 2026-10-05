import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), "utf8");
}

test("primary UI keeps settings and developer tools secondary", async () => {
  const html = await read("sidepanel.html");
  assert.match(html, /id="settingsDialog"/);
  assert.match(html, /<details class="dev-card">/);
  assert.match(html, /id="progressState"/);
  assert.match(html, /id="activityDetails"/);
  assert.match(html, /id="progressSecondary"/);
  assert.doesNotMatch(html, /class="brand-mark"/);
  assert.match(html, /id="sendMessage"[\s\S]*?<svg/);
  assert.match(html, /class="composer-box"/);
});
