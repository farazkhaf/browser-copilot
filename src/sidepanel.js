import { BrowserAgent } from "./agent/browser-agent.js";
import { PROVIDERS } from "./agent/provider.js";
import { BrowserSession } from "./agent/browser-session.js";

const els = {
  messages: document.querySelector("#messages"),
  emptyState: document.querySelector("#emptyState"),
  message: document.querySelector("#messageInput"),
  send: document.querySelector("#sendMessage"),
  stop: document.querySelector("#stopTurn"),
  newSession: document.querySelector("#newSession"),
  openSettings: document.querySelector("#openSettings"),
  settingsDialog: document.querySelector("#settingsDialog"),
  settingsForm: document.querySelector("#settingsForm"),
  closeSettings: document.querySelector("#closeSettings"),
  provider: document.querySelector("#providerSelect"),
  apiKey: document.querySelector("#apiKeyInput"),
  rememberKey: document.querySelector("#rememberKey"),
  model: document.querySelector("#modelInput"),
  progressLine: document.querySelector("#progressLine"),
  currentProgress: document.querySelector("#currentProgress"),
  progressState: document.querySelector("#progressState"),
  progressSecondary: document.querySelector("#progressSecondary"),
  activityLabel: document.querySelector("#activityLabel"),
  activityDetails: document.querySelector("#activityDetails"),
  activityCount: document.querySelector("#activityCount"),
  activity: document.querySelector("#activity"),
  tracePreview: document.querySelector("#tracePreview"),
  exportCompactTrace: document.querySelector("#exportCompactTrace"),
  exportRawTrace: document.querySelector("#exportRawTrace"),
  tabSelect: document.querySelector("#tabSelect"),
  tabMeta: document.querySelector("#tabMeta"),
  output: document.querySelector("#output"),
  screenshot: document.querySelector("#screenshotPreview"),
  search: document.querySelector("#searchInput"),
  selector: document.querySelector("#selectorInput"),
  findText: document.querySelector("#findTextInput"),
  ref: document.querySelector("#refInput"),
  fill: document.querySelector("#fillInput"),
  select: document.querySelector("#selectInput"),
  key: document.querySelector("#keyInput"),
  openTab: document.querySelector("#openTabInput"),
  navigate: document.querySelector("#navigateInput"),
  scrollDirection: document.querySelector("#scrollDirection"),
  scrollAmount: document.querySelector("#scrollAmount"),
  waitSeconds: document.querySelector("#waitSeconds")
};

let tabs = [];
let agent = null;
let agentRunning = false;
let rawTrace = [];
let compactTrace = [];
let compactPromptRecorded = false;
let activityCount = 0;
let lastMeaningfulProgress = "Waiting for a task";
let currentConfig = { provider: "openai", model: PROVIDERS.openai.defaultModel, apiKey: "", remember: false };

const browser = new BrowserSession({
  invokeRaw,
  onEvent: (event) => {
    if (!agentRunning) addActivity(event.message || event.tool || "Browser tool");
  }
});

boot().catch((error) => {
  setProgress(error?.message || String(error), "error");
});

async function boot() {
  bindEvents();
  await loadSettings();
  await refreshTabs();
  setProgress("Waiting for a task", "idle");
  autoSizeComposer();
  if (!currentConfig.apiKey) queueMicrotask(() => els.settingsDialog.showModal());
}

function bindEvents() {
  els.send.addEventListener("click", sendUserMessage);
  els.stop.addEventListener("click", () => agent?.stop());
  els.newSession.addEventListener("click", () => newSession());
  els.openSettings.addEventListener("click", openSettings);
  els.closeSettings.addEventListener("click", (event) => {
    event.preventDefault();
    els.settingsDialog.close();
  });
  els.settingsForm.addEventListener("submit", saveSettings);
  els.provider.addEventListener("change", () => applyProviderFields(els.provider.value));
  els.message.addEventListener("input", () => autoSizeComposer());
  els.message.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendUserMessage();
    }
  });

  els.exportCompactTrace.addEventListener("click", () => exportTrace("compact"));
  els.exportRawTrace.addEventListener("click", () => exportTrace("raw"));

  document.querySelector("#refreshTabs").addEventListener("click", refreshTabs);
  document.querySelector("#clearOutput").addEventListener("click", () => {
    els.output.textContent = "Ready.";
    els.screenshot.hidden = true;
    els.screenshot.removeAttribute("src");
  });
  els.tabSelect.addEventListener("change", updateTabMeta);
  document.querySelector("#focusTab").addEventListener("click", () => runManual("tabs_focus", { tab: selectedAlias() }));
  document.querySelector("#closeTab").addEventListener("click", () => runManual("tabs_close", { tab: selectedAlias() }));
  document.querySelector("#openTabButton").addEventListener("click", () => runManual("tabs_open", { url: els.openTab.value }));
  document.querySelector("#observeButton").addEventListener("click", () => runManual("page_state", { tab: selectedAlias(), mode: "auto" }));
  document.querySelector("#fullStateButton").addEventListener("click", () => runManual("page_state", { tab: selectedAlias(), mode: "full" }));
  document.querySelector('[data-tool="page_screenshot"]').addEventListener("click", () => runManual("page_screenshot", { tab: selectedAlias() }));
  document.querySelector("#searchButton").addEventListener("click", () => runManual("page_search", {
    tab: selectedAlias(), pattern: els.search.value, regex: looksLikeRegex(els.search.value), limit: 20
  }));
  document.querySelector("#findButton").addEventListener("click", () => runManual("page_find", {
    tab: selectedAlias(), selector: els.selector.value, text: els.findText.value || null, limit: 30
  }));
  document.querySelector("#readButton").addEventListener("click", () => runManual("page_read", {
    tab: selectedAlias(), ref: manualRefOrNull(), max_chars: 6000
  }));
  document.querySelector("#clickButton").addEventListener("click", () => runManual("click", { ref: manualRefRequired() }));
  document.querySelector("#fillButton").addEventListener("click", () => runManual("fill", { ref: manualRefRequired(), text: els.fill.value }));
  document.querySelector("#selectButton").addEventListener("click", () => runManual("select", { ref: manualRefRequired(), value: els.select.value }));
  document.querySelector("#pressButton").addEventListener("click", () => runManual("press", {
    tab: selectedAlias(), ref: manualRefOrNull(), key: els.key.value || "Enter"
  }));
  document.querySelector("#scrollButton").addEventListener("click", () => runManual("scroll", {
    tab: selectedAlias(), direction: els.scrollDirection.value || "down",
    amount: els.scrollAmount.value ? Number(els.scrollAmount.value) : null,
    ref: manualRefOrNull()
  }));
  document.querySelector("#waitButton").addEventListener("click", () => runManual("wait", {
    tab: selectedAlias(), seconds: Number(els.waitSeconds.value || 2)
  }));
  document.querySelector("#navigateButton").addEventListener("click", () => runManual("navigate", { tab: selectedAlias(), url: els.navigate.value }));
}

async function loadSettings() {
  const keys = ["agentProvider", "openaiApiKey", "openaiModel", "geminiApiKey", "geminiModel"];
  const [local, session] = await Promise.all([
    chrome.storage.local.get(keys),
    chrome.storage.session.get(["openaiApiKey", "geminiApiKey"])
  ]);
  const provider = local.agentProvider || "openai";
  currentConfig = {
    provider,
    model: local[`${provider}Model`] || PROVIDERS[provider].defaultModel,
    apiKey: session[`${provider}ApiKey`] || local[`${provider}ApiKey`] || "",
    remember: Boolean(local[`${provider}ApiKey`])
  };
  els.provider.value = provider;
  els.model.value = currentConfig.model;
  els.apiKey.value = currentConfig.apiKey;
  els.apiKey.placeholder = PROVIDERS[provider].keyPlaceholder;
  els.rememberKey.checked = currentConfig.remember;
}

async function applyProviderFields(provider) {
  const keys = [`${provider}ApiKey`, `${provider}Model`];
  const [local, session] = await Promise.all([
    chrome.storage.local.get(keys),
    chrome.storage.session.get([`${provider}ApiKey`])
  ]);
  els.model.value = local[`${provider}Model`] || PROVIDERS[provider].defaultModel;
  els.apiKey.value = session[`${provider}ApiKey`] || local[`${provider}ApiKey`] || "";
  els.apiKey.placeholder = PROVIDERS[provider].keyPlaceholder;
  els.rememberKey.checked = Boolean(local[`${provider}ApiKey`]);
}

function openSettings() {
  els.provider.value = currentConfig.provider;
  els.model.value = currentConfig.model;
  els.apiKey.value = currentConfig.apiKey;
  els.rememberKey.checked = currentConfig.remember;
  els.apiKey.placeholder = PROVIDERS[currentConfig.provider].keyPlaceholder;
  els.settingsDialog.showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  const provider = els.provider.value || "openai";
  const model = els.model.value.trim() || PROVIDERS[provider].defaultModel;
  const apiKey = els.apiKey.value.trim();
  const remember = els.rememberKey.checked;
  if (!apiKey) {
    els.apiKey.focus();
    return;
  }

  const keyField = `${provider}ApiKey`;
  const modelField = `${provider}Model`;
  await chrome.storage.local.set({ agentProvider: provider, [modelField]: model });
  if (remember) {
    await chrome.storage.local.set({ [keyField]: apiKey });
    await chrome.storage.session.remove(keyField);
  } else {
    await chrome.storage.session.set({ [keyField]: apiKey });
    await chrome.storage.local.remove(keyField);
  }

  const changed = provider !== currentConfig.provider || model !== currentConfig.model || apiKey !== currentConfig.apiKey;
  currentConfig = { provider, model, apiKey, remember };
  els.settingsDialog.close();
  if (changed && agent) await newSession({ quiet: true });
}

async function sendUserMessage() {
  if (agentRunning) return;
  const message = els.message.value.trim();
  if (!message) return;
  if (!currentConfig.apiKey) {
    openSettings();
    return;
  }

  if (!agent) createAgent();
  appendMessage("user", message);
  els.message.value = "";
  autoSizeComposer();
  setRunning(true);
  lastMeaningfulProgress = "Planning the next step";
  setProgress(lastMeaningfulProgress, "running", "Thinking…");

  try {
    const result = await agent.send(message);
    appendMessage("assistant", result.text);
    setProgress("Task completed", "complete");
  } catch (error) {
    if (error?.name === "AbortError") {
      setProgress("Stopped", "idle");
    } else {
      const text = error?.message || String(error);
      appendMessage("error", text);
      setProgress(text, "error");
      appendTrace({ type: "run_error", at: Date.now(), value: { message: text, stack: error?.stack || null } });
    }
  } finally {
    setRunning(false);
    await refreshTabs().catch(() => {});
  }
}

function createAgent() {
  agent = new BrowserAgent({
    provider: currentConfig.provider,
    apiKey: currentConfig.apiKey,
    model: currentConfig.model,
    browserSession: browser,
    onEvent: (event) => {
      if (event.type === "assistant") return;
      if (event.type === "model") {
        setProgress(lastMeaningfulProgress || "Planning the next step", "running", "Thinking…");
        return;
      }
      const message = progressionLabel(event);
      lastMeaningfulProgress = message;
      addActivity(message, "tool");
      setProgress(message, "running", "");
    },
    onTrace: appendTrace
  });
}

async function newSession({ quiet = false } = {}) {
  if (agent) agent.resetSession();
  else browser.reset();
  agent = null;
  agentRunning = false;
  rawTrace = [];
  compactTrace = [];
  compactPromptRecorded = false;
  activityCount = 0;
  lastMeaningfulProgress = "Waiting for a task";
  els.activity.replaceChildren();
  els.activityCount.textContent = "0";
  els.activityLabel.textContent = "steps";
  els.tracePreview.textContent = "No model activity yet.";
  [...els.messages.querySelectorAll(".message")].forEach((node) => node.remove());
  els.emptyState.hidden = false;
  setRunning(false);
  setProgress("Waiting for a task", "idle");
  autoSizeComposer();
  await refreshTabs().catch(() => {});
  if (!quiet) els.message.focus();
}

async function refreshTabs() {
  const result = await browser.listTabs();
  tabs = result.tabs;
  const prior = els.tabSelect.value;
  els.tabSelect.replaceChildren();
  for (const item of tabs) {
    const option = document.createElement("option");
    option.value = item.tab;
    option.textContent = `${item.tab} · ${item.active ? "● " : ""}${truncate(item.title || item.url, 48)}`;
    els.tabSelect.append(option);
  }
  if (tabs.some((item) => item.tab === prior)) els.tabSelect.value = prior;
  else {
    const active = tabs.find((item) => item.active);
    if (active) els.tabSelect.value = active.tab;
  }
  updateTabMeta();
}

async function runManual(tool, args) {
  const started = performance.now();
  document.body.classList.add("busy");
  try {
    const executed = await browser.call(tool, compactArgs(args), { settle: false });
    const ms = Math.round(performance.now() - started);
    renderResult(tool, executed.displayResult);
    addActivity(`${tool} · ${summarize(tool, executed.displayResult)} · ${ms}ms`, "dev");
    if (["tabs_open", "tabs_focus", "tabs_close", "navigate", "click"].includes(tool)) setTimeout(() => refreshTabs().catch(() => {}), 300);
  } catch (error) {
    showError(error);
    addActivity(`${tool} · ${error.message}`, "error");
  } finally {
    document.body.classList.remove("busy");
  }
}

async function invokeRaw(tool, args) {
  const response = await chrome.runtime.sendMessage({ type: "browser:tool", tool, args });
  if (!response?.ok) throw new Error(response?.error?.message || `Tool failed: ${tool}`);
  return response.result;
}

function selectedAlias() {
  const alias = els.tabSelect.value;
  if (!alias) throw new Error("Select a tab first");
  return alias;
}

function manualRefOrNull() {
  const raw = els.ref.value.trim();
  if (!raw) return null;
  if (/^T\d+:/i.test(raw)) return raw;
  const normalized = raw.replace(/^@?e/i, "e");
  return `${selectedAlias()}:${normalized}`;
}

function manualRefRequired() {
  const ref = manualRefOrNull();
  if (!ref) throw new Error("Enter an element ref first");
  return ref;
}

function appendMessage(role, text) {
  els.emptyState.hidden = true;
  const node = document.createElement("div");
  node.className = `message ${role}`;
  if (role === "assistant") node.innerHTML = renderSafeMessage(text);
  else node.textContent = text;
  els.messages.append(node);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function setProgress(message, state = "idle", secondary = "") {
  els.currentProgress.textContent = message;
  els.progressLine.className = `progress-card ${state}`;
  const labels = { idle: "Ready", running: "Working", complete: "Complete", error: "Needs attention" };
  els.progressState.textContent = labels[state] || "Status";
  els.progressSecondary.textContent = secondary;
  els.progressSecondary.classList.toggle("thinking", state === "running" && Boolean(secondary));
}

function autoSizeComposer() {
  const node = els.message;
  node.style.height = "auto";
  const min = 40;
  const max = 112;
  const next = Math.max(min, Math.min(max, node.scrollHeight));
  node.style.height = `${next}px`;
  node.style.overflowY = node.scrollHeight > max ? "auto" : "hidden";
}

function progressionLabel(event) {
  const name = event.tool || "";
  const args = event.args || {};
  const tab = args.tab || extractAlias(args.ref);
  const target = friendlyTabName(tab);
  if (name === "tabs_list") return "Checking open tabs";
  if (name === "tabs_open") return "Opening a new tab";
  if (name === "tabs_focus") return target ? `Showing ${target}` : "Showing a browser tab";
  if (name === "tabs_close") return target ? `Closing ${target}` : "Closing a browser tab";
  if (name === "page_state") return target ? `Inspecting ${target}` : "Inspecting the page";
  if (name === "page_search") return target ? `Searching ${target}` : "Searching page content";
  if (name === "page_find") return target ? `Checking ${target} structure` : "Checking page structure";
  if (name === "page_read") return "Reading relevant content";
  if (name === "page_screenshot") return target ? `Checking ${target} visually` : "Checking the page visually";
  if (name === "fill") return "Entering text";
  if (name === "select") return "Choosing an option";
  if (name === "click") return "Interacting with the page";
  if (name === "press") return String(args.key || "").toLowerCase() === "enter" ? "Submitting input" : `Pressing ${args.key || "a key"}`;
  if (name === "scroll") return target ? `Browsing ${target}` : "Browsing the page";
  if (name === "navigate") return target ? `Opening a page in ${target}` : "Opening a page";
  if (name === "wait") return target ? `Waiting on ${target}` : "Waiting for the page";
  return event.message || "Working";
}

function friendlyTabName(alias) {
  if (!alias) return "";
  const item = tabs.find((tab) => tab.tab === alias);
  if (!item) return "";
  const title = String(item.title || "").trim();
  if (title) {
    const short = title.split(/\s+[—|–|-]\s+/)[0].trim();
    return truncate(short || title, 26);
  }
  try {
    return new URL(item.url).hostname.replace(/^www\./, "");
  } catch {
    return alias;
  }
}

function extractAlias(ref) {
  const match = /^([A-Z]\d+):/i.exec(ref || "");
  return match?.[1]?.toUpperCase() || "";
}

function renderSafeMessage(text) {
  let html = escapeHtml(String(text ?? ""));
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  const lines = html.split("\n");
  return lines.map((line) => {
    if (/^&gt;\s?/.test(line)) return `<blockquote>${line.replace(/^&gt;\s?/, "")}</blockquote>`;
    return line || "<br>";
  }).join("<br>");
}

function setRunning(running) {
  agentRunning = running;
  els.send.disabled = running;
  els.stop.hidden = !running;
  els.newSession.disabled = running;
  els.openSettings.disabled = running;
}

function addActivity(message, kind = "tool") {
  activityCount += 1;
  els.activityCount.textContent = String(activityCount);
  els.activityLabel.textContent = activityCount === 1 ? "step" : "steps";
  const li = document.createElement("li");
  if (kind === "error") li.className = "error";
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  li.innerHTML = `<span>${escapeHtml(time)}</span><strong>${escapeHtml(message)}</strong>`;
  els.activity.append(li);
  while (els.activity.children.length > 80) els.activity.firstElementChild.remove();
  els.activity.scrollTop = els.activity.scrollHeight;
}

function appendTrace(event) {
  rawTrace.push(event);
  const compact = compactTraceEvent(event);
  if (compact) compactTrace.push(compact);
  els.tracePreview.textContent = JSON.stringify(compactTrace.slice(-10), null, 2);
}

function compactTraceEvent(event) {
  const at = new Date(event.at).toISOString();
  const value = event.value || {};
  if (event.type === "model_request") {
    const out = {
      at,
      type: "model_request",
      turn: value.turn,
      session_message: value.session_message,
      provider: value.provider,
      model: value.model,
      input: value.input
    };
    if (!compactPromptRecorded) {
      out.system_instruction = value.system_instruction;
      out.tools = (value.tools || []).map((tool) => tool.name);
      compactPromptRecorded = true;
    }
    return out;
  }
  if (event.type === "model_response") {
    return {
      at,
      type: "model_response",
      id: value.id || null,
      status: value.status || null,
      usage: value.usage || value.usageMetadata || null,
      output: summarizeModelOutput(value)
    };
  }
  if (event.type === "tool_call") return { at, type: "tool_call", name: value.name, args: value.args };
  if (event.type === "tool_result") return { at, type: "tool_result", name: value.name, args: value.args, result: summarizeToolResult(value.name, value.result), media: value.media || null };
  if (event.type === "run_error") return { at, type: "run_error", message: value.message };
  return null;
}

function summarizeModelOutput(value) {
  const calls = [];
  const texts = [];
  for (const item of value.output || []) {
    if (item?.type === "function_call") calls.push({ name: item.name, arguments: item.arguments });
    if (item?.type === "message") {
      for (const part of item.content || []) if (part?.type === "output_text" && part.text) texts.push(part.text);
    }
  }
  if (calls.length || texts.length) return { tool_calls: calls, text: texts.join("\n") || undefined };
  return { text: value.output_text || undefined };
}

function summarizeToolResult(name, result) {
  if (!result || typeof result !== "object") return result;
  if (name === "tabs_list") return result;
  if (name === "page_state") return summarizeObservation(result);
  if (name === "page_search" || name === "page_find") return { count: result.count, results: (result.results || []).slice(0, 8) };
  if (name === "page_read") return { ref: result.ref, text: result.text, truncated: result.truncated, controls: result.controls };
  if (name === "wait") return { tab: result.tab, waited_ms: result.waited_ms, observation: summarizeObservation(result.observation) };
  if (["click", "fill", "select", "press", "scroll", "navigate"].includes(name)) {
    return {
      action: result.action || name,
      ref: result.ref,
      blocked: result.blocked,
      blocked_reason: result.blocked_reason,
      verified: result.verified,
      page_changed: result.page_changed,
      url_changed: result.url_changed,
      settle: result.settle,
      observation: summarizeObservation(result.observation),
      async_page_updates: (result.async_page_updates || []).map((item) => ({ tab: item.tab, observation: summarizeObservation(item.observation) }))
    };
  }
  if (name === "page_screenshot") return { tab: result.tab, mime_type: result.mime_type, screenshot_included: result.screenshot_included };
  return result;
}

function summarizeObservation(observation) {
  if (!observation || typeof observation !== "object") return observation;
  return {
    mode: observation.mode,
    revision: observation.revision,
    url: observation.url,
    title: observation.title,
    busy: observation.busy,
    attention: observation.attention,
    changes: observation.changes,
    viewport: observation.viewport,
    coverage: observation.coverage,
    budget: observation.budget
  };
}

function exportTrace(kind) {
  const trace = kind === "raw" ? rawTrace : compactTrace;
  if (!trace.length) return;
  const payload = { exported_at: new Date().toISOString(), kind, trace };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `browser-copilot-${kind}-trace-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderResult(tool, result) {
  if (tool === "page_screenshot" && result?.data_url) {
    els.screenshot.src = result.data_url;
    els.screenshot.hidden = false;
    const printable = { ...result, data_url: `<png data URL: ${result.data_url.length} chars>` };
    els.output.textContent = JSON.stringify(printable, null, 2);
  } else {
    els.screenshot.hidden = true;
    els.output.textContent = JSON.stringify(result, null, 2);
  }
}

function updateTabMeta() {
  const item = tabs.find((tab) => tab.tab === els.tabSelect.value);
  els.tabMeta.textContent = item ? `${item.tab} · ${item.url}` : "No supported tab selected";
}

function showError(error) { els.output.textContent = JSON.stringify({ error: error?.message ?? String(error) }, null, 2); }

function summarize(tool, result) {
  if (tool === "page_state") {
    const chars = JSON.stringify(result).length;
    const detail = result.mode === "full"
      ? `${result.elements?.length ?? 0}/${result.coverage?.interactive_total ?? 0} detailed elements`
      : result.mode === "delta"
        ? `${(result.changes?.added?.length ?? 0) + (result.changes?.changed?.length ?? 0) + (result.changes?.removed?.length ?? 0)} element changes`
        : "no relevant changes";
    return `${result.mode ?? "state"} · ${detail} · ${chars} chars`;
  }
  if (tool === "page_search" || tool === "page_find") return `${result.count ?? 0} matches`;
  if (tool === "page_read") return `${result.text?.length ?? 0} chars read`;
  if (tool === "page_screenshot") return "captured visible tab";
  if (tool === "wait") return `${result.waited_ms ?? 0}ms`;
  if (tool === "fill" || tool === "select") return result.blocked ? `blocked: ${result.blocked_reason}` : (result.verified ? "verified" : "dispatched; verification failed");
  if (tool === "click") return result.blocked ? `blocked: ${result.blocked_reason}` : (result.page_changed ? "page changed" : "click dispatched");
  if (tool === "scroll") return result.changed ? "scrolled" : "no movement";
  return "completed";
}

function compactArgs(args) {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null && value !== undefined && value !== ""));
}
function looksLikeRegex(value) { return /[|()[\]{}.*+?^$\\]/.test(value); }
function truncate(value, n) { return value.length <= n ? value : `${value.slice(0, n - 1)}…`; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch])); }
