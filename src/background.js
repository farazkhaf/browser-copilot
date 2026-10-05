const CONTENT_SCRIPT = "src/content/runtime.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "browser:tool") return false;

  dispatchTool(message.tool, message.args ?? {})
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));

  return true;
});

async function dispatchTool(tool, args) {
  switch (tool) {
    case "tabs_list":
      return tabsList();
    case "tabs_open":
      return tabsOpen(args.url);
    case "tabs_focus":
      return tabsFocus(args.tab_id);
    case "tabs_close":
      return tabsClose(args.tab_id);
    case "navigate":
      return navigate(args.tab_id, args.url);
    case "page_screenshot":
      return pageScreenshot(args.tab_id);
    case "page_state":
    case "page_search":
    case "page_find":
    case "page_read":
    case "click":
    case "fill":
    case "select":
    case "press":
    case "scroll":
      return sendPageTool(args.tab_id, tool, args);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

async function tabsList() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => Number.isInteger(tab.id))
    .map((tab) => ({
      tab_id: tab.id,
      window_id: tab.windowId,
      active: Boolean(tab.active),
      pinned: Boolean(tab.pinned),
      title: tab.title ?? "",
      url: tab.url ?? ""
    }));
}

async function tabsOpen(url) {
  assertHttpUrl(url);
  const tab = await chrome.tabs.create({ url, active: true });
  return { tab_id: tab.id, title: tab.title ?? "", url: tab.url ?? url };
}

async function tabsFocus(tabId) {
  const tab = await requireTab(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  const focused = await chrome.tabs.update(tab.id, { active: true });
  return { tab_id: focused.id, window_id: focused.windowId, active: focused.active, url: focused.url ?? "" };
}

async function tabsClose(tabId) {
  await requireTab(tabId);
  await chrome.tabs.remove(tabId);
  return { closed: true, tab_id: tabId };
}

async function navigate(tabId, url) {
  assertHttpUrl(url);
  await requireTab(tabId);
  const updated = await chrome.tabs.update(tabId, { url });
  const observation = await observeAfterNavigation(tabId);
  return { tab_id: updated.id, url, navigation_started: true, observation };
}

async function pageScreenshot(tabId) {
  const tab = await requireTab(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  await sleep(120);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return {
    tab_id: tabId,
    mime_type: "image/png",
    data_url: dataUrl,
    note: "Tab was focused because captureVisibleTab captures the visible tab."
  };
}

async function sendPageTool(tabId, tool, args) {
  const tab = await requireTab(tabId);
  await ensureContentRuntime(tabId);
  const beforeUrl = tab.url ?? "";

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "browser:page-tool",
      tool,
      args: { ...args, tab_id: undefined }
    });
    if (response?.error) throw new Error(response.error);
    return response;
  } catch (error) {
    // Never replay an action automatically: a click can destroy its own content
    // context by navigating. Replaying after reinjection could duplicate effects.
    const current = await chrome.tabs.get(tabId).catch(() => null);
    const afterUrl = current?.url ?? "";
    if (afterUrl && afterUrl !== beforeUrl) {
      const observation = await observeAfterNavigation(tabId);
      return {
        action: tool,
        page_changed: true,
        url_changed: true,
        before_url: beforeUrl,
        after_url: afterUrl,
        outcome: "navigation_observed_after_message_disconnect",
        note: "The action was not replayed. The new page was observed after navigation.",
        observation
      };
    }
    throw error;
  }
}

async function observeAfterNavigation(tabId) {
  await waitForTabReady(tabId, 3000);
  try {
    await ensureContentRuntime(tabId, true);
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "browser:page-tool",
      tool: "page_state",
      args: { mode: "full" }
    });
    if (response?.error) throw new Error(response.error);
    return response;
  } catch (error) {
    return {
      mode: "unavailable",
      note: `Navigation completed but the new page could not be observed yet: ${error.message}`
    };
  }
}

async function waitForTabReady(tabId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status === "complete") return;
    await sleep(100);
  }
}

async function ensureContentRuntime(tabId, force = false) {
  if (!force) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: "browser:ping" });
      if (pong?.ok) return;
    } catch (_) {
      // Inject below.
    }
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  } catch (error) {
    throw new Error(`Cannot inject page runtime into tab ${tabId}: ${error.message}`);
  }
}

async function requireTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("tab_id must be an integer");
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? "";
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Unsupported tab URL: ${url || "<unknown>"}`);
  }
  return tab;
}

function assertHttpUrl(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new Error("url must be an http(s) URL");
  }
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? null
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
