const ACTION_TOOLS = new Set(["click", "fill", "select", "press", "scroll", "navigate"]);

export class BrowserSession {
  constructor({ invokeRaw, onEvent = () => {}, settleOptions = {} }) {
    this.invokeRaw = invokeRaw;
    this.onEvent = onEvent;
    this.settleOptions = {
      pollMs: 250,
      quietTargetMs: 750,
      normalMaxWaitMs: 2500,
      busyMaxWaitMs: 10000,
      ...settleOptions
    };
    this.reset();
  }

  reset() {
    this.aliasToTabId = new Map();
    this.tabIdToAlias = new Map();
    this.nextAlias = 1;
  }

  async listTabs() {
    const raw = await this.invokeRaw("tabs_list", {});
    const supported = raw.filter((item) => /^https?:\/\//i.test(item.url || ""));
    const liveIds = new Set(supported.map((item) => item.tab_id));
    for (const [tabId, alias] of [...this.tabIdToAlias.entries()]) {
      if (!liveIds.has(tabId)) {
        this.tabIdToAlias.delete(tabId);
        this.aliasToTabId.delete(alias);
      }
    }
    const tabs = supported.map((item) => {
      const alias = this.ensureAlias(item.tab_id);
      return {
        tab: alias,
        active: Boolean(item.active),
        pinned: Boolean(item.pinned),
        title: item.title || "",
        url: item.url || ""
      };
    });
    return { count: tabs.length, tabs };
  }

  async call(tool, args = {}, { settle = true } = {}) {
    const result = await this.callCore(tool, args);
    if (settle && ACTION_TOOLS.has(tool)) {
      const alias = this.actionAlias(tool, args);
      if (alias && this.aliasToTabId.has(alias)) {
        const settlement = await this.settleAfterAction(alias, result.modelResult?.observation);
        result.modelResult.settle = settlement.summary;
        if (settlement.updates.length) result.modelResult.async_page_updates = settlement.updates;
      }
    }
    return result;
  }

  async callCore(tool, args = {}) {
    switch (tool) {
      case "tabs_list": {
        const modelResult = await this.listTabs();
        return { modelResult, displayResult: modelResult };
      }
      case "tabs_open": {
        const raw = await this.invokeRaw("tabs_open", { url: args.url });
        const alias = this.ensureAlias(raw.tab_id);
        const modelResult = { tab: alias, title: raw.title || "", url: raw.url || args.url };
        this.emit(tool, `${alias} opened`);
        return { modelResult, displayResult: modelResult };
      }
      case "tabs_focus":
      case "tabs_close": {
        const tabId = this.resolveTab(args.tab);
        const raw = await this.invokeRaw(tool, { tab_id: tabId });
        const modelResult = { tab: args.tab, ...(tool === "tabs_close" ? { closed: true } : { active: true, url: raw.url || "" }) };
        if (tool === "tabs_close") {
          this.aliasToTabId.delete(args.tab);
          this.tabIdToAlias.delete(tabId);
        }
        this.emit(tool, `${args.tab} ${tool === "tabs_close" ? "closed" : "focused"}`);
        return { modelResult, displayResult: modelResult };
      }
      case "wait": {
        const alias = args.tab;
        const tabId = this.resolveTab(alias);
        const seconds = clampNumber(args.seconds ?? 2, 0.25, 15);
        await sleep(Math.round(seconds * 1000));
        const raw = await this.invokeRaw("page_state", { tab_id: tabId, mode: "auto" });
        const observation = this.externalize(raw, alias);
        const modelResult = { tab: alias, waited_ms: Math.round(seconds * 1000), observation };
        this.emit(tool, `${alias} waited ${seconds}s`);
        return { modelResult, displayResult: modelResult };
      }
      case "page_state":
      case "page_search":
      case "page_find":
      case "page_read":
      case "scroll":
      case "navigate":
      case "page_screenshot":
      case "press": {
        const alias = args.tab;
        const tabId = this.resolveTab(alias);
        const payload = { ...args, tab_id: tabId };
        delete payload.tab;
        if (payload.ref) payload.ref = this.parseRef(payload.ref, alias).internalRef;
        if (payload.scope_ref) payload.scope_ref = this.parseRef(payload.scope_ref, alias).internalRef;
        const raw = await this.invokeRaw(tool, payload);
        const external = this.externalize(raw, alias);
        this.emit(tool, this.describeTool(tool, alias, external));
        if (tool === "page_screenshot" && raw?.data_url) {
          const match = /^data:(image\/[^;]+);base64,(.+)$/s.exec(raw.data_url);
          const modelResult = { ...external, data_url: undefined, screenshot_included: Boolean(match) };
          delete modelResult.data_url;
          return {
            modelResult,
            displayResult: external,
            media: match ? { mimeType: match[1], base64: match[2] } : null
          };
        }
        return { modelResult: external, displayResult: external };
      }
      case "click":
      case "fill":
      case "select": {
        const parsed = this.parseRef(args.ref);
        const tabId = this.resolveTab(parsed.alias);
        const payload = { ...args, tab_id: tabId, ref: parsed.internalRef };
        const raw = await this.invokeRaw(tool, payload);
        const external = this.externalize(raw, parsed.alias);
        this.emit(tool, this.describeTool(tool, parsed.alias, external));
        return { modelResult: external, displayResult: external };
      }
      default:
        throw new Error(`Unsupported model tool: ${tool}`);
    }
  }

  actionAlias(tool, args) {
    if (["click", "fill", "select"].includes(tool)) return this.parseRef(args.ref).alias;
    return args.tab || null;
  }

  async settleAfterAction(alias, initialObservation) {
    const tabId = this.resolveTab(alias);
    const { pollMs, quietTargetMs, normalMaxWaitMs, busyMaxWaitMs } = this.settleOptions;
    let maxWaitMs = initialObservation?.busy?.active ? busyMaxWaitMs : normalMaxWaitMs;
    let elapsed = 0;
    let quietMs = 0;
    let lastBusy = Boolean(initialObservation?.busy?.active);
    const updates = [];
    let omittedUpdates = 0;

    while (elapsed < maxWaitMs) {
      await sleep(pollMs);
      elapsed += pollMs;
      let raw;
      try {
        raw = await this.invokeRaw("page_state", { tab_id: tabId, mode: "auto" });
      } catch (_) {
        break;
      }
      const observation = this.externalize(raw, alias);
      lastBusy = Boolean(observation?.busy?.active);
      if (lastBusy) maxWaitMs = Math.max(maxWaitMs, busyMaxWaitMs);

      if (observation?.mode && observation.mode !== "unchanged") {
        quietMs = 0;
        if (updates.length < 4) updates.push({ tab: alias, observation });
        else {
          updates[updates.length - 1] = { tab: alias, observation };
          omittedUpdates += 1;
        }
      } else {
        quietMs += pollMs;
      }

      if (!lastBusy && quietMs >= quietTargetMs) break;
    }

    return {
      updates,
      summary: {
        waited_ms: elapsed,
        settled: !lastBusy && quietMs >= quietTargetMs,
        busy: lastBusy,
        async_updates: updates.length,
        omitted_updates: omittedUpdates
      }
    };
  }

  ensureAlias(tabId) {
    const existing = this.tabIdToAlias.get(tabId);
    if (existing) return existing;
    const alias = `T${this.nextAlias++}`;
    this.tabIdToAlias.set(tabId, alias);
    this.aliasToTabId.set(alias, tabId);
    return alias;
  }

  resolveTab(alias) {
    if (typeof alias !== "string" || !this.aliasToTabId.has(alias)) {
      throw new Error(`Unknown tab alias: ${alias || "<missing>"}. Call tabs_list to refresh session tabs.`);
    }
    return this.aliasToTabId.get(alias);
  }

  parseRef(ref, expectedAlias = null) {
    if (typeof ref !== "string") throw new Error("ref is required");
    const match = /^([A-Z]\d+):@?e(\d+)$/i.exec(ref.trim());
    if (!match) throw new Error(`Invalid ref: ${ref}. Expected a tab-scoped ref such as T1:e12.`);
    const alias = match[1].toUpperCase();
    if (expectedAlias && alias !== expectedAlias) throw new Error(`Ref ${ref} belongs to ${alias}, not ${expectedAlias}.`);
    this.resolveTab(alias);
    return { alias, internalRef: `@e${match[2]}` };
  }

  externalize(value, alias) {
    if (Array.isArray(value)) return value.map((item) => this.externalize(item, alias));
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === "tab_id") out.tab = alias;
        else out[key] = this.externalize(item, alias);
      }
      return out;
    }
    if (typeof value === "string") return value.replace(/@e(\d+)/g, `${alias}:e$1`);
    return value;
  }

  describeTool(tool, alias, result) {
    if (tool === "page_state") return `${alias} ${result.mode || "state"}`;
    if (tool === "page_search" || tool === "page_find") return `${alias} ${result.count ?? 0} matches`;
    if (tool === "page_read") return `${alias} read ${result.text?.length ?? 0} chars`;
    if (tool === "page_screenshot") return `${alias} screenshot`;
    if (tool === "navigate") return `${alias} navigated`;
    if (["click", "fill", "select"].includes(tool)) return result.blocked ? `${alias} blocked` : `${alias} ${tool}`;
    return `${alias} ${tool}`;
  }

  emit(tool, message) {
    this.onEvent({ tool, message, at: Date.now() });
  }
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
