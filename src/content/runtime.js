(() => {
  if (globalThis.__BROWSER_COPILOT_RUNTIME__) return;
  globalThis.__BROWSER_COPILOT_RUNTIME__ = true;

  const elementToRef = new WeakMap();
  const refToElement = new Map();
  let nextRef = 1;
  let observationBaseline = null;
  let observationRevision = 0;
  let dirty = true;

  const INTERACTIVE_SELECTOR = [
    "a[href]", "button", "input", "textarea", "select", "summary",
    "[contenteditable=true]", "[role=button]", "[role=link]", "[role=checkbox]",
    "[role=radio]", "[role=switch]", "[role=tab]", "[role=menuitem]", "[tabindex]"
  ].join(",");

  const REGION_SELECTOR = [
    "dialog[open]", "main", "nav", "form", "section", "article", "aside",
    "table", "fieldset", "[role=main]", "[role=region]", "[role=dialog]"
  ].join(",");

  installDirtyTracking();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "browser:ping") {
      sendResponse({ ok: true, revision: observationRevision });
      return false;
    }

    if (message?.type !== "browser:page-tool") return false;

    Promise.resolve()
      .then(() => dispatch(message.tool, message.args ?? {}))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error?.message ?? String(error) }));

    return true;
  });

  async function dispatch(tool, args) {
    pruneRefs();
    switch (tool) {
      case "page_state": return pageState(args);
      case "page_search": return pageSearch(args);
      case "page_find": return pageFind(args);
      case "page_read": return pageRead(args);
      case "click": return click(args);
      case "fill": return fill(args);
      case "select": return select(args);
      case "press": return press(args);
      case "scroll": return scroll(args);
      default: throw new Error(`Unknown page tool: ${tool}`);
    }
  }

  function pageState({
    mode = "auto",
    max_elements = 24,
    max_regions = 12,
    max_scrollables = 6,
    delta_limit = 36,
    max_chars = 12000
  } = {}) {
    if (!["auto", "full"].includes(mode)) throw new Error("mode must be 'auto' or 'full'");

    if (mode === "auto" && observationBaseline && !dirty && observationBaseline.url === location.href) {
      return {
        mode: "unchanged",
        revision: observationBaseline.revision,
        base_revision: observationBaseline.revision,
        url: location.href,
        title: document.title,
        reason: "document_not_dirty",
        busy: observationBaseline.busy,
        budget: { max_chars: clampInt(max_chars, 4000, 30000), approx_chars: 0, trimmed: false }
      };
    }

    const current = capturePageSnapshot({
      maxElements: clampInt(max_elements, 4, 60),
      maxRegions: clampInt(max_regions, 4, 30),
      maxScrollables: clampInt(max_scrollables, 1, 12)
    });

    let result;
    if (mode === "full" || !observationBaseline || observationBaseline.url !== current.url) {
      result = fullObservation(current, mode === "full" ? "forced" : "baseline");
    } else {
      result = deltaObservation(observationBaseline, current, clampInt(delta_limit, 8, 100));
      if (result.mode === "delta") {
        const fullChars = JSON.stringify(fullObservation(current, "comparison", false)).length;
        const deltaChars = JSON.stringify(result).length;
        if (deltaChars >= fullChars * 0.85) result = fullObservation(current, "delta_not_smaller");
      }
    }

    result = boundObservation(result, clampInt(max_chars, 4000, 30000));
    observationBaseline = current;
    observationRevision = current.revision;
    dirty = false;
    return result;
  }

  function capturePageSnapshot({ maxElements, maxRegions, maxScrollables }) {
    observationRevision += 1;

    const allInteractive = interactiveElements().filter(isRendered);
    const allRegions = collectRegions().filter(isRendered);
    const scrollables = collectScrollableRegions();
    const active = document.activeElement instanceof Element ? document.activeElement : null;

    const interactiveRecords = allInteractive.map((el) => ({
      el,
      descriptor: describeCompact(el),
      viewport: intersectsViewport(el),
      score: elementPriority(el, active)
    }));

    interactiveRecords.sort((a, b) => b.score - a.score);
    const selectedElements = interactiveRecords.slice(0, maxElements).map(({ descriptor, viewport }) => ({
      ...descriptor,
      ...(viewport ? { viewport: true } : {})
    }));

    const regionRecords = allRegions.map((el) => ({
      el,
      descriptor: describeRegion(el),
      score: regionPriority(el, active)
    }));
    regionRecords.sort((a, b) => b.score - a.score);
    const selectedRegions = regionRecords.slice(0, maxRegions).map((x) => x.descriptor);

    const selectedScrollables = scrollables.slice(0, maxScrollables).map(describeScrollable);
    const outline = collectOutline(14);

    const elementMap = new Map(interactiveRecords.map(({ descriptor }) => [descriptor.ref, descriptor]));
    const viewportRefs = new Set(interactiveRecords.filter((x) => x.viewport).map((x) => x.descriptor.ref));

    return {
      revision: observationRevision,
      url: location.href,
      title: document.title,
      page: {
        viewport: { width: innerWidth, height: innerHeight },
        document: {
          width: Math.max(document.documentElement.scrollWidth, innerWidth),
          height: Math.max(document.documentElement.scrollHeight, innerHeight)
        },
        scroll: documentScrollState(),
        counts: {
          links: document.links.length,
          buttons: document.querySelectorAll('button,input[type="button"],input[type="submit"],[role="button"]').length,
          inputs: document.querySelectorAll("input,textarea,select,[contenteditable=true]").length,
          forms: document.forms.length,
          tables: document.querySelectorAll("table").length,
          interactive_rendered: allInteractive.length,
          interactive_in_viewport: viewportRefs.size,
          regions_rendered: allRegions.length
        }
      },
      outline,
      regions: selectedRegions,
      scrollables: selectedScrollables,
      attention: collectAttentionSurfaces(4),
      busy: collectBusyState(),
      elements: selectedElements,
      coverage: {
        interactive_total: allInteractive.length,
        interactive_included: selectedElements.length,
        interactive_omitted: Math.max(0, allInteractive.length - selectedElements.length),
        regions_total: allRegions.length,
        regions_included: selectedRegions.length,
        regions_omitted: Math.max(0, allRegions.length - selectedRegions.length),
        note: "The page index is intentionally bounded. page_search/page_find/page_read can inspect omitted loaded DOM content. Content not yet materialized by the site cannot be searched until the site loads it."
      },
      active_ref: active ? ensureRef(active) : null,
      elementMap,
      viewportRefs
    };
  }

  function fullObservation(snapshot, reason, advance = true) {
    return {
      mode: "full",
      revision: snapshot.revision,
      reason,
      url: snapshot.url,
      title: snapshot.title,
      page: snapshot.page,
      outline: snapshot.outline,
      regions: snapshot.regions,
      scrollables: snapshot.scrollables,
      attention: snapshot.attention,
      busy: snapshot.busy,
      elements: snapshot.elements,
      coverage: snapshot.coverage,
      active_ref: snapshot.active_ref
    };
  }

  function deltaObservation(before, current, deltaLimit) {
    const added = [];
    const changed = [];
    const removed = [];

    for (const [ref, descriptor] of current.elementMap.entries()) {
      const prior = before.elementMap.get(ref);
      if (!prior) added.push(descriptor);
      else if (descriptorSignature(prior) !== descriptorSignature(descriptor)) changed.push(descriptor);
    }
    for (const ref of before.elementMap.keys()) {
      if (!current.elementMap.has(ref)) removed.push(ref);
    }

    const enteredViewport = [];
    const leftViewport = [];
    for (const ref of current.viewportRefs) {
      if (!before.viewportRefs.has(ref)) {
        const descriptor = current.elementMap.get(ref);
        if (descriptor) enteredViewport.push(descriptor);
      }
    }
    for (const ref of before.viewportRefs) {
      if (!current.viewportRefs.has(ref)) leftViewport.push(ref);
    }

    const scrollChanged = JSON.stringify(before.page.scroll) !== JSON.stringify(current.page.scroll);
    const titleChanged = before.title !== current.title;
    const structureChanged = JSON.stringify(before.page.counts) !== JSON.stringify(current.page.counts)
      || JSON.stringify(before.outline) !== JSON.stringify(current.outline);
    const attentionChanged = JSON.stringify(before.attention) !== JSON.stringify(current.attention);
    const busyChanged = JSON.stringify(before.busy) !== JSON.stringify(current.busy);
    const totalElementChanges = added.length + changed.length + removed.length;

    if (totalElementChanges > deltaLimit) return fullObservation(current, "large_delta");

    if (!titleChanged && !structureChanged && !attentionChanged && !busyChanged && !scrollChanged && totalElementChanges === 0
      && enteredViewport.length === 0 && leftViewport.length === 0) {
      return {
        mode: "unchanged",
        revision: current.revision,
        base_revision: before.revision,
        url: current.url,
        title: current.title,
        busy: current.busy
      };
    }

    const cap = 14;
    return {
      mode: "delta",
      revision: current.revision,
      base_revision: before.revision,
      url: current.url,
      ...(titleChanged ? { title: current.title } : {}),
      ...(scrollChanged ? { scroll: current.page.scroll } : {}),
      busy: current.busy,
      ...(attentionChanged ? { attention: current.attention } : {}),
      ...(structureChanged ? {
        structure: {
          counts: current.page.counts,
          outline: current.outline,
          regions: current.regions,
          attention: current.attention,
          coverage: current.coverage
        }
      } : {}),
      changes: {
        added: added.slice(0, cap),
        changed: changed.slice(0, cap),
        removed: removed.slice(0, cap),
        omitted: Math.max(0, added.length - cap) + Math.max(0, changed.length - cap) + Math.max(0, removed.length - cap)
      },
      viewport: {
        entered: enteredViewport.slice(0, cap),
        left: leftViewport.slice(0, cap),
        omitted: Math.max(0, enteredViewport.length - cap) + Math.max(0, leftViewport.length - cap)
      },
      active_ref: current.active_ref
    };
  }

  function boundObservation(result, maxChars) {
    const measure = () => JSON.stringify(result).length;
    let trimmed = false;

    const shrinkArray = (arr, minimum) => {
      while (Array.isArray(arr) && arr.length > minimum && measure() > maxChars) {
        arr.pop();
        trimmed = true;
      }
    };

    if (result.mode === "full") {
      shrinkArray(result.elements, 8);
      shrinkArray(result.regions, 4);
      shrinkArray(result.outline, 4);
      shrinkArray(result.scrollables, 2);
      if (trimmed && result.coverage) result.coverage.detail_budget_truncated = true;
    } else if (result.mode === "delta") {
      shrinkArray(result.changes?.added, 4);
      shrinkArray(result.changes?.changed, 4);
      shrinkArray(result.changes?.removed, 4);
      shrinkArray(result.viewport?.entered, 4);
      shrinkArray(result.viewport?.left, 4);
      if (measure() > maxChars && result.structure) {
        delete result.structure.regions;
        trimmed = true;
      }
    }

    result.budget = {
      max_chars: maxChars,
      approx_chars: measure(),
      trimmed
    };
    result.budget.approx_chars = measure();
    return result;
  }

  function pageSearch({ pattern, regex = false, scope_selector = null, scope_ref = null, limit = 20 } = {}) {
    if (typeof pattern !== "string" || !pattern.trim()) throw new Error("pattern is required");
    const root = scope_ref ? resolveRef(scope_ref) : (scope_selector ? document.querySelector(scope_selector) : document.body);
    if (!root) throw new Error(`scope not found: ${scope_ref || scope_selector}`);

    const matcher = createMatcher(pattern, regex);
    const candidates = collectSearchCandidates(root);
    const seen = new Set();
    const results = [];
    let matchedTotal = 0;

    for (const el of candidates) {
      if (!isRendered(el)) continue;
      const descriptor = describeSearchResult(el);
      const haystack = [
        descriptor.name,
        descriptor.text,
        descriptor.href,
        descriptor.placeholder,
        descriptor.title,
        descriptor.role,
        descriptor.tag
      ].filter(Boolean).join("\n");

      const match = matcher(haystack);
      if (!match) continue;
      matchedTotal += 1;
      if (seen.has(descriptor.ref)) continue;
      seen.add(descriptor.ref);
      if (results.length < clampInt(limit, 1, 100)) results.push({ ...descriptor, match });
    }

    return {
      pattern,
      regex: Boolean(regex),
      count: results.length,
      matched_total: matchedTotal,
      truncated: matchedTotal > results.length,
      scope: scope_ref || scope_selector || "document",
      results
    };
  }

  function pageFind({ selector, text = null, text_regex = false, limit = 30 } = {}) {
    if (typeof selector !== "string" || !selector.trim()) throw new Error("selector is required");
    let nodes;
    try {
      nodes = [...document.querySelectorAll(selector)];
    } catch (error) {
      const hint = selector.includes(":has-text(")
        ? " Native CSS does not support :has-text(). Use selector plus the text parameter, or page_search()."
        : "";
      throw new Error(`Invalid native CSS selector: ${error.message}.${hint}`);
    }
    let rendered = nodes.filter(isRendered);
    if (typeof text === "string" && text.trim()) {
      const matcher = createMatcher(text, Boolean(text_regex));
      rendered = rendered.filter((el) => matcher([
        accessibleName(el),
        cleanText(el.innerText || el.textContent || ""),
        el.getAttribute?.("aria-label") || "",
        el.getAttribute?.("title") || ""
      ].join("\n")));
    }
    const max = clampInt(limit, 1, 100);
    const results = rendered.slice(0, max).map(describeSearchResult);
    return {
      selector,
      ...(text ? { text, text_regex: Boolean(text_regex) } : {}),
      count: results.length,
      matched_total: rendered.length,
      truncated: rendered.length > results.length,
      results
    };
  }

  function pageRead({ ref = null, selector = null, max_chars = 6000, max_controls = 24 } = {}) {
    let target = null;
    if (ref) target = resolveRef(ref);
    if (!target && selector) target = document.querySelector(selector);
    if (!target) target = document.body;

    const container = meaningfulContainer(target);
    const fullText = cleanText(container.innerText || container.textContent || "");
    const charLimit = clampInt(max_chars, 200, 20000);
    const text = fullText.slice(0, charLimit);
    const controlsAll = [...container.querySelectorAll(INTERACTIVE_SELECTOR)].filter(isRendered);
    const controlLimit = clampInt(max_controls, 1, 60);
    const controls = controlsAll.slice(0, controlLimit).map(describeCompact);

    return {
      target: describeSearchResult(target),
      container: summarizeNode(container),
      text,
      truncated: fullText.length > text.length,
      text_chars_total: fullText.length,
      controls,
      controls_total: controlsAll.length,
      controls_omitted: Math.max(0, controlsAll.length - controls.length)
    };
  }

  async function click({ ref } = {}) {
    const el = resolveRef(ref);
    const gate = await actionability(el);
    if (!gate.ok) return blockedActionResult("click", ref, gate);
    const before = snapshotForAction(el);
    el.focus?.({ preventScroll: true });
    el.click();
    dirty = true;
    await settle();
    const after = snapshotForAction(el);
    return actionResult("click", ref, before, after, {
      target_connected: el.isConnected,
      active_element: describeActiveElement(),
      actionability: gate.summary
    });
  }

  async function fill({ ref, text } = {}) {
    const el = resolveRef(ref);
    if (typeof text !== "string") throw new Error("text must be a string");
    const gate = await actionability(el);
    if (!gate.ok) return blockedActionResult("fill", ref, gate);
    const before = snapshotForAction(el);
    el.focus();
    setElementValue(el, text);
    dirty = true;
    await settle();
    const actual = readValue(el);
    const after = snapshotForAction(el);
    return actionResult("fill", ref, before, after, {
      expected_value: text,
      actual_value: actual,
      verified: actual === text
    });
  }

  async function select({ ref, value } = {}) {
    const el = resolveRef(ref);
    if (!(el instanceof HTMLSelectElement)) throw new Error(`${ref} is not a <select>`);
    const requested = String(value);
    const option = [...el.options].find((item) => item.value === requested)
      || [...el.options].find((item) => cleanText(item.textContent || "").toLowerCase() === requested.toLowerCase());
    if (!option) throw new Error(`No option matching value/label: ${requested}`);

    const gate = await actionability(el);
    if (!gate.ok) return blockedActionResult("select", ref, gate);
    const before = snapshotForAction(el);
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    dirty = true;
    await settle();
    const after = snapshotForAction(el);
    return actionResult("select", ref, before, after, {
      requested,
      selected_value: option.value,
      selected_label: cleanText(option.textContent || ""),
      actual_value: el.value,
      verified: el.value === option.value
    });
  }

  async function press({ key, ref = null } = {}) {
    if (typeof key !== "string" || !key) throw new Error("key is required");
    const el = ref ? resolveRef(ref) : (document.activeElement || document.body);
    const before = snapshotForAction(el);
    el.focus?.();
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true }));
    }
    dirty = true;
    await settle();
    const after = snapshotForAction(el);
    return actionResult("press", ref, before, after, {
      key,
      active_element: describeActiveElement(),
      input_channel: "synthetic_dom",
      note: "Synthetic KeyboardEvents do not guarantee native browser default behavior. Browser-level input is deferred."
    });
  }

  async function scroll({ direction = "down", amount = null, ref = null } = {}) {
    if (!["up", "down", "left", "right"].includes(direction)) throw new Error("direction must be up/down/left/right");
    const targetInfo = ref ? explicitScrollTarget(ref, direction) : choosePrimaryScrollTarget(direction);
    if (!targetInfo) throw new Error(`No scrollable target can move ${direction}`);

    const horizontal = direction === "left" || direction === "right";
    const before = scrollPosition(targetInfo);
    const viewportSize = horizontal ? targetInfo.clientWidth : targetInfo.clientHeight;
    const distance = Number.isFinite(Number(amount)) ? Math.abs(Number(amount)) : Math.max(120, Math.round(viewportSize * 0.7));
    const delta = ["up", "left"].includes(direction) ? -distance : distance;

    if (targetInfo.kind === "document") {
      window.scrollBy(horizontal
        ? { left: delta, behavior: "instant" }
        : { top: delta, behavior: "instant" });
    } else {
      targetInfo.el.scrollBy(horizontal
        ? { left: delta, behavior: "instant" }
        : { top: delta, behavior: "instant" });
    }

    dirty = true;
    await settle();
    const after = scrollPosition(targetInfo);
    const changed = before.x !== after.x || before.y !== after.y;

    return {
      action: "scroll",
      direction,
      requested_amount: distance,
      target: describeScrollTarget(targetInfo),
      before,
      after,
      changed,
      observation: pageState({ mode: "auto" })
    };
  }

  function actionResult(action, ref, before, after, extra = {}) {
    return {
      action,
      ref,
      dispatched: true,
      page_changed: before.url !== after.url || before.title !== after.title || before.body_text_length !== after.body_text_length,
      url_changed: before.url !== after.url,
      before,
      after,
      input_channel: "synthetic_dom",
      ...extra,
      observation: pageState({ mode: "auto" })
    };
  }

  async function actionability(el) {
    if (!(el instanceof Element) || !el.isConnected) {
      return { ok: false, reason: "detached", summary: "target is detached" };
    }
    if (!isRendered(el)) {
      return { ok: false, reason: "not_rendered", summary: "target is not rendered" };
    }
    if (("disabled" in el && el.disabled) || el.getAttribute("aria-disabled") === "true") {
      return { ok: false, reason: "disabled", summary: "target is disabled" };
    }

    el.scrollIntoView({ block: "center", inline: "center" });
    await settle(60);
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) {
      return { ok: false, reason: "outside_viewport", summary: "target could not be brought into the viewport" };
    }

    const x = Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    const receivesPointer = Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el)));
    if (!receivesPointer) {
      return {
        ok: false,
        reason: "obscured",
        summary: "target is obscured by another element",
        point: { x: Math.round(x), y: Math.round(y) },
        target: describeSearchResult(el),
        blocker: hit instanceof Element ? describeSearchResult(hit) : null
      };
    }

    return {
      ok: true,
      summary: "rendered, enabled, and receives pointer events",
      point: { x: Math.round(x), y: Math.round(y) }
    };
  }

  function blockedActionResult(action, ref, gate) {
    return {
      action,
      ref,
      dispatched: false,
      blocked: true,
      blocked_reason: gate.reason,
      note: gate.summary,
      blocker: gate.blocker || null,
      observation: pageState({ mode: "auto" })
    };
  }

  function snapshotForAction(el) {
    return {
      url: location.href,
      title: document.title,
      body_text_length: cleanText(document.body?.innerText || "").length,
      target: el ? summarizeNode(el) : null,
      value: el ? readValue(el) : null
    };
  }

  function collectSearchCandidates(root) {
    const set = new Set();
    if (root instanceof Element) set.add(root);

    for (const el of root.querySelectorAll("a,button,input,textarea,select,option,label,[role],[aria-label],[title],[alt],h1,h2,h3,h4,h5,h6,p,li,td,th,summary,legend,caption")) {
      set.add(el);
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    let visited = 0;
    while ((node = walker.nextNode()) && visited < 12000) {
      visited += 1;
      if (!cleanText(node.nodeValue || "")) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const semantic = parent.closest("a,button,label,li,p,td,th,h1,h2,h3,h4,h5,h6,summary,legend,caption,section,article,main,form") || parent;
      set.add(semantic);
    }

    return [...set];
  }

  function interactiveElements() {
    return [...document.querySelectorAll(INTERACTIVE_SELECTOR)];
  }

  function collectRegions() {
    const set = new Set([...document.querySelectorAll(REGION_SELECTOR)]);
    for (const heading of document.querySelectorAll("h1,h2,h3")) {
      if (isRendered(heading)) set.add(heading);
    }
    return [...set];
  }

  function collectOutline(limit) {
    return [...document.querySelectorAll("h1,h2,h3")]
      .filter(isRendered)
      .slice(0, limit)
      .map((el) => ({
        ref: ensureRef(el),
        level: Number(el.tagName.slice(1)),
        text: cleanText(el.innerText || el.textContent || "").slice(0, 180)
      }))
      .filter((x) => x.text);
  }

  function collectAttentionSurfaces(limit = 4) {
    const out = [];
    const seen = new Set();
    const candidates = [...document.querySelectorAll("dialog[open],[role=dialog],[aria-modal=true],body *")];
    for (const el of candidates) {
      if (!(el instanceof Element) || seen.has(el) || !isRendered(el) || !intersectsViewport(el)) continue;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const isDialog = el.matches("dialog[open],[role=dialog],[aria-modal=true]");
      const fixedOverlay = ["fixed", "sticky"].includes(style.position) && rect.width * rect.height >= innerWidth * innerHeight * 0.18 && Number(style.zIndex || 0) >= 1;
      if (!isDialog && !fixedOverlay) continue;
      seen.add(el);
      out.push({
        ref: ensureRef(el),
        kind: isDialog ? "dialog" : "overlay",
        name: accessibleName(el).slice(0, 160),
        text: cleanText(el.innerText || el.textContent || "").slice(0, 240),
        controls: el.querySelectorAll(INTERACTIVE_SELECTOR).length
      });
      if (out.length >= limit) break;
    }
    return out;
  }


  function collectBusyState() {
    const signals = [];
    const seen = new Set();

    for (const el of document.querySelectorAll('[aria-busy="true"],progress,[role="progressbar"]')) {
      if (!(el instanceof Element) || !isRendered(el)) continue;
      const ref = ensureRef(el);
      if (seen.has(ref)) continue;
      seen.add(ref);
      signals.push({
        ref,
        kind: el.matches('[aria-busy="true"]') ? 'aria-busy' : (el.matches('progress') ? 'progress' : 'progressbar'),
        name: accessibleName(el).slice(0, 120)
      });
      if (signals.length >= 6) break;
    }

    if (signals.length < 6) {
      const pattern = /^(stop (response|generating|generation)|cancel (generation|response)|generating|loading|working|thinking)$/i;
      for (const el of document.querySelectorAll('button,[role="button"]')) {
        if (!(el instanceof Element) || !isRendered(el)) continue;
        const name = accessibleName(el).trim();
        if (!pattern.test(name)) continue;
        const ref = ensureRef(el);
        if (seen.has(ref)) continue;
        seen.add(ref);
        signals.push({ ref, kind: 'control', name: name.slice(0, 120) });
        if (signals.length >= 6) break;
      }
    }

    return { active: signals.length > 0, signals };
  }

  function collectScrollableRegions() {
    const candidates = [];
    const doc = document.scrollingElement || document.documentElement;
    const docMaxY = Math.max(0, doc.scrollHeight - innerHeight);
    const docMaxX = Math.max(0, doc.scrollWidth - innerWidth);
    if (docMaxY > 4 || docMaxX > 4) {
      candidates.push({
        kind: "document",
        el: doc,
        clientWidth: innerWidth,
        clientHeight: innerHeight,
        scrollWidth: doc.scrollWidth,
        scrollHeight: doc.scrollHeight,
        maxX: docMaxX,
        maxY: docMaxY,
        area: innerWidth * innerHeight
      });
    }

    const selector = "main,section,article,div,aside,nav,[role=main],[role=region],[role=dialog],table,ul,ol";
    for (const el of document.querySelectorAll(selector)) {
      if (!isRendered(el) || !intersectsViewport(el)) continue;
      const style = getComputedStyle(el);
      const yAllowed = ["auto", "scroll", "overlay"].includes(style.overflowY);
      const xAllowed = ["auto", "scroll", "overlay"].includes(style.overflowX);
      const maxY = yAllowed ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
      const maxX = xAllowed ? Math.max(0, el.scrollWidth - el.clientWidth) : 0;
      if (maxY <= 4 && maxX <= 4) continue;
      const rect = el.getBoundingClientRect();
      candidates.push({
        kind: "element",
        el,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
        maxX,
        maxY,
        area: Math.max(1, rect.width * rect.height)
      });
    }

    candidates.sort((a, b) => scrollableScore(b) - scrollableScore(a));
    return candidates;
  }

  function scrollableScore(x) {
    return x.area * Math.log2(2 + x.maxX + x.maxY);
  }

  function describeScrollable(item) {
    if (item.kind === "document") {
      return {
        target: "document",
        x: Math.round(scrollX),
        y: Math.round(scrollY),
        max_x: Math.round(item.maxX),
        max_y: Math.round(item.maxY)
      };
    }
    return {
      ref: ensureRef(item.el),
      role: explicitOrImplicitRole(item.el) || item.el.tagName.toLowerCase(),
      name: accessibleName(item.el).slice(0, 120),
      x: Math.round(item.el.scrollLeft),
      y: Math.round(item.el.scrollTop),
      max_x: Math.round(item.maxX),
      max_y: Math.round(item.maxY)
    };
  }

  function choosePrimaryScrollTarget(direction) {
    const horizontal = direction === "left" || direction === "right";
    const candidates = collectScrollableRegions().filter((item) => canScroll(item, direction));
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const aRemaining = remainingScroll(a, direction);
      const bRemaining = remainingScroll(b, direction);
      return (b.area * Math.log2(2 + bRemaining)) - (a.area * Math.log2(2 + aRemaining));
    });
    return candidates[0];
  }

  function explicitScrollTarget(ref, direction) {
    const el = resolveRef(ref);
    const style = getComputedStyle(el);
    const maxY = ["auto", "scroll", "overlay"].includes(style.overflowY) ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
    const maxX = ["auto", "scroll", "overlay"].includes(style.overflowX) ? Math.max(0, el.scrollWidth - el.clientWidth) : 0;
    const item = {
      kind: "element",
      el,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      maxX,
      maxY,
      area: Math.max(1, el.clientWidth * el.clientHeight)
    };
    if (!canScroll(item, direction)) throw new Error(`${ref} cannot scroll ${direction}`);
    return item;
  }

  function canScroll(item, direction) {
    if (direction === "down") return scrollPosition(item).y < item.maxY - 1;
    if (direction === "up") return scrollPosition(item).y > 1;
    if (direction === "right") return scrollPosition(item).x < item.maxX - 1;
    if (direction === "left") return scrollPosition(item).x > 1;
    return false;
  }

  function remainingScroll(item, direction) {
    const pos = scrollPosition(item);
    if (direction === "down") return item.maxY - pos.y;
    if (direction === "up") return pos.y;
    if (direction === "right") return item.maxX - pos.x;
    return pos.x;
  }

  function scrollPosition(item) {
    if (item.kind === "document") return { x: Math.round(scrollX), y: Math.round(scrollY) };
    return { x: Math.round(item.el.scrollLeft), y: Math.round(item.el.scrollTop) };
  }

  function describeScrollTarget(item) {
    return item.kind === "document"
      ? { target: "document", max_x: Math.round(item.maxX), max_y: Math.round(item.maxY) }
      : { ref: ensureRef(item.el), role: explicitOrImplicitRole(item.el) || item.el.tagName.toLowerCase(), name: accessibleName(item.el).slice(0, 120), max_x: Math.round(item.maxX), max_y: Math.round(item.maxY) };
  }

  function describeCompact(el) {
    const role = explicitOrImplicitRole(el) || el.tagName?.toLowerCase?.() || "element";
    const value = safeValue(el);
    const descriptor = {
      ref: ensureRef(el),
      role,
      name: accessibleName(el).slice(0, 160)
    };
    if (value !== null && value !== "") descriptor.value = value.slice(0, 180);
    if ("checked" in el) descriptor.checked = Boolean(el.checked);
    if ("disabled" in el && el.disabled) descriptor.disabled = true;
    if (el instanceof HTMLAnchorElement && el.getAttribute("href")) descriptor.href = el.getAttribute("href").slice(0, 240);
    return descriptor;
  }

  function describeSearchResult(el) {
    const compact = describeCompact(el);
    const text = cleanText(el.innerText || el.textContent || "");
    return {
      ...compact,
      tag: el.tagName?.toLowerCase?.() || "node",
      ...(text && text !== compact.name ? { text: text.slice(0, 260) } : {}),
      ...(el.getAttribute?.("placeholder") ? { placeholder: el.getAttribute("placeholder").slice(0, 160) } : {}),
      ...(el.getAttribute?.("title") ? { title: el.getAttribute("title").slice(0, 160) } : {}),
      viewport: intersectsViewport(el)
    };
  }

  function describeRegion(el) {
    const tag = el.tagName.toLowerCase();
    const kind = /^h[1-6]$/.test(tag) ? "heading" : (explicitOrImplicitRole(el) || tag);
    const controls = el.matches(INTERACTIVE_SELECTOR) ? 1 : el.querySelectorAll(INTERACTIVE_SELECTOR).length;
    const descriptor = {
      ref: ensureRef(el),
      kind,
      name: regionName(el).slice(0, 180),
      controls
    };
    if (tag === "form") descriptor.fields = el.querySelectorAll("input,textarea,select,[contenteditable=true]").length;
    if (tag === "table") descriptor.rows = el.querySelectorAll("tr").length;
    if (intersectsViewport(el)) descriptor.viewport = true;
    return descriptor;
  }

  function summarizeNode(el) {
    if (!(el instanceof Element)) return null;
    return {
      ref: ensureRef(el),
      tag: el.tagName.toLowerCase(),
      role: explicitOrImplicitRole(el),
      name: accessibleName(el).slice(0, 180),
      text: cleanText(el.innerText || el.textContent || "").slice(0, 500),
      value: safeValue(el)
    };
  }

  function meaningfulContainer(el) {
    if (!(el instanceof Element)) return document.body;
    return el.closest("form,section,article,main,nav,aside,dialog,table,fieldset,li") || el.parentElement || el;
  }

  function regionName(el) {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return cleanText(el.innerText || el.textContent || "");
    const aria = el.getAttribute?.("aria-label");
    if (aria) return cleanText(aria);
    const labelledBy = el.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      const labelled = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (cleanText(labelled)) return cleanText(labelled);
    }
    const directHeading = el.querySelector?.(":scope > h1,:scope > h2,:scope > h3,:scope > legend,:scope > caption");
    const headingText = cleanText(directHeading?.innerText || directHeading?.textContent || "");
    if (headingText) return headingText;
    if (el.id) return el.id;
    return tag;
  }

  function elementPriority(el, active) {
    let score = 0;
    if (el === active) score += 1200;
    if (el.closest("dialog[open],[role=dialog]")) score += 700;
    if (intersectsViewport(el)) score += 400;
    if (el.closest("form")) score += 130;
    const role = explicitOrImplicitRole(el);
    if (["textbox", "button", "combobox", "checkbox", "radio", "switch"].includes(role)) score += 90;
    if (accessibleName(el)) score += 30;
    return score;
  }

  function regionPriority(el, active) {
    let score = 0;
    if (active && el.contains(active)) score += 800;
    if (el.matches("dialog[open],[role=dialog]")) score += 700;
    if (intersectsViewport(el)) score += 300;
    if (el.matches("main,form,nav,table")) score += 120;
    return score + Math.min(100, el.querySelectorAll?.(INTERACTIVE_SELECTOR)?.length || 0);
  }

  function descriptorSignature(descriptor) {
    return JSON.stringify(descriptor);
  }

  function ensureRef(el) {
    if (!(el instanceof Element)) return null;
    const existing = elementToRef.get(el);
    if (existing) return existing;
    const ref = `@e${nextRef++}`;
    elementToRef.set(el, ref);
    refToElement.set(ref, el);
    return ref;
  }

  function resolveRef(ref) {
    if (typeof ref !== "string") throw new Error("ref is required");
    const el = refToElement.get(ref);
    if (!el || !el.isConnected) {
      refToElement.delete(ref);
      throw new Error(`stale_or_unknown_ref: ${ref}`);
    }
    return el;
  }

  function pruneRefs() {
    for (const [ref, el] of refToElement.entries()) {
      if (!el?.isConnected) refToElement.delete(ref);
    }
  }

  function isRendered(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rects = el.getClientRects();
    return rects.length > 0 || (el.scrollWidth > 0 && el.scrollHeight > 0);
  }

  function intersectsViewport(el) {
    if (!(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }

  function accessibleName(el) {
    if (!(el instanceof Element)) return "";
    const aria = el.getAttribute("aria-label");
    if (aria) return cleanText(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (text.trim()) return cleanText(text);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el.labels?.length) return cleanText([...el.labels].map((x) => x.innerText).join(" "));
      if (el.placeholder) return cleanText(el.placeholder);
      if (el.name) return cleanText(el.name);
    }
    if (el instanceof HTMLImageElement && el.alt) return cleanText(el.alt);
    return cleanText(el.innerText || el.textContent || "").slice(0, 160);
  }

  function explicitOrImplicitRole(el) {
    const explicit = el.getAttribute?.("role");
    if (explicit) return explicit;
    const tag = el.tagName?.toLowerCase?.();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset"].includes(type)) return "button";
      return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    return null;
  }

  function createMatcher(pattern, regex) {
    if (regex) {
      let rx;
      try { rx = new RegExp(pattern, "i"); }
      catch (error) { throw new Error(`Invalid regex: ${error.message}`); }
      return (text) => {
        const match = text.match(rx);
        return match ? match[0] : null;
      };
    }
    const needle = pattern.toLowerCase();
    return (text) => text.toLowerCase().includes(needle) ? pattern : null;
  }

  function setElementValue(el, value) {
    if (el instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter ? setter.call(el, value) : (el.value = value);
    } else if (el instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter ? setter.call(el, value) : (el.value = value);
    } else if (el.isContentEditable) {
      el.textContent = value;
    } else {
      throw new Error(`${ensureRef(el)} is not fillable`);
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function readValue(el) {
    if (!el) return null;
    if (el instanceof HTMLInputElement && el.type === "password") return "<redacted>";
    if ("value" in el && typeof el.value !== "undefined") return String(el.value);
    if (el.isContentEditable) return cleanText(el.textContent || "");
    return null;
  }

  function safeValue(el) {
    const value = readValue(el);
    return value === null ? null : String(value);
  }

  function describeActiveElement() {
    return document.activeElement instanceof Element ? summarizeNode(document.activeElement) : null;
  }

  function documentScrollState() {
    const doc = document.scrollingElement || document.documentElement;
    return {
      x: Math.round(scrollX),
      y: Math.round(scrollY),
      max_x: Math.max(0, Math.round(doc.scrollWidth - innerWidth)),
      max_y: Math.max(0, Math.round(doc.scrollHeight - innerHeight))
    };
  }

  function installDirtyTracking() {
    const markDirty = () => { dirty = true; };
    const startObserver = () => {
      if (!document.documentElement) return;
      const observer = new MutationObserver(markDirty);
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "disabled", "checked", "aria-expanded", "aria-selected", "aria-hidden", "value"]
      });
    };
    if (document.documentElement) startObserver();
    else document.addEventListener("DOMContentLoaded", startObserver, { once: true });
    document.addEventListener("input", markDirty, true);
    document.addEventListener("change", markDirty, true);
    document.addEventListener("focusin", markDirty, true);
    window.addEventListener("scroll", markDirty, true);
    window.addEventListener("hashchange", markDirty);
    window.addEventListener("popstate", markDirty);
  }

  function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function clampInt(value, min, max) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function settle(ms = 180) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
