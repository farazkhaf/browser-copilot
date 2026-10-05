import { createProviderClient } from "./provider.js";
import { MUTATING_TOOLS, SYSTEM_INSTRUCTION, TOOL_DECLARATIONS } from "./tool-contract.js";

export class BrowserAgent {
  constructor({ provider = "openai", apiKey, model, browserSession, client = null, onEvent = () => {}, onTrace = () => {} }) {
    this.client = client || createProviderClient({ provider, apiKey, model });
    this.browser = browserSession;
    this.onEvent = onEvent;
    this.onTrace = onTrace;
    this.abortController = null;
    this.previousInteractionId = null;
    this.sessionStarted = false;
    this.sessionMessageCount = 0;
  }

  stop() {
    this.abortController?.abort();
  }

  resetSession() {
    this.stop();
    this.abortController = null;
    this.previousInteractionId = null;
    this.sessionStarted = false;
    this.sessionMessageCount = 0;
    this.browser.reset();
  }

  async send(message, { maxTurns = 40 } = {}) {
    if (!message?.trim()) throw new Error("Message is required");
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const firstMessage = !this.sessionStarted;
    if (firstMessage) {
      this.browser.reset();
      this.sessionStarted = true;
    }
    this.sessionMessageCount += 1;

    let input = firstMessage
      ? `User message:\n${message.trim()}\n\nThis is the first message in a new browser session. Begin by inspecting the available browser tabs before taking page-specific actions.`
      : `User message:\n${message.trim()}`;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      if (signal.aborted) throw new DOMException("Session turn stopped", "AbortError");
      const requestView = {
        turn,
        session_message: this.sessionMessageCount,
        provider: this.client.provider,
        model: this.client.model,
        previous_interaction_id: this.previousInteractionId,
        system_instruction: SYSTEM_INSTRUCTION,
        tools: TOOL_DECLARATIONS,
        input: sanitizeForTrace(input)
      };
      this.onTrace({ type: "model_request", at: Date.now(), value: requestView });
      this.onEvent({ type: "model", message: turn === 1 ? "Thinking" : "Continuing", at: Date.now() });

      const interaction = await this.client.createInteraction({
        input,
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: TOOL_DECLARATIONS,
        previousInteractionId: this.previousInteractionId,
        signal
      });
      this.onTrace({ type: "model_response", at: Date.now(), value: interaction });
      this.previousInteractionId = interaction.id || this.previousInteractionId;

      const calls = this.client.functionCalls(interaction);
      if (!calls.length) {
        const text = this.client.interactionText(interaction);
        if (!text) throw new Error(`Model returned no function call and no text (status: ${interaction.status || "unknown"})`);
        this.onEvent({ type: "assistant", message: "Ready", at: Date.now() });
        return { text, interactionId: this.previousInteractionId, turns: turn };
      }

      const results = [];
      let mutationSeen = false;
      for (const call of calls) {
        const name = call.name;
        const args = call.arguments || call.args || {};
        if (mutationSeen) {
          const skipped = { skipped: true, reason: "A preceding state-changing browser action requires re-observation before another action." };
          results.push(this.client.functionResult(call, skipped));
          this.onTrace({ type: "tool_result", at: Date.now(), value: { name, args, result: skipped } });
          continue;
        }

        this.onTrace({ type: "tool_call", at: Date.now(), value: { id: call.id, name, args } });
        this.onEvent({ type: "tool", tool: name, args, message: activityLabel(name, args), at: Date.now() });
        try {
          const executed = await this.browser.call(name, args, { settle: true });
          results.push(this.client.functionResult(call, executed.modelResult, executed.media));
          this.onTrace({
            type: "tool_result",
            at: Date.now(),
            value: {
              name,
              args,
              result: executed.modelResult,
              media: executed.media ? { mime_type: executed.media.mimeType, bytes: executed.media.base64.length } : null
            }
          });
        } catch (error) {
          const failure = { error: error?.message || String(error) };
          results.push(this.client.functionResult(call, failure));
          this.onTrace({ type: "tool_result", at: Date.now(), value: { name, args, result: failure } });
        }
        if (MUTATING_TOOLS.has(name)) mutationSeen = true;
      }
      input = results;
    }

    throw new Error(`Message exceeded ${maxTurns} model turns`);
  }
}

function activityLabel(name, args) {
  const tab = args?.tab || extractTab(args?.ref) || "";
  if (name === "tabs_list") return "Inspecting open tabs";
  if (name === "page_state") return `Inspecting ${tab}`;
  if (name === "page_search") return `Searching ${tab} for “${truncate(args.pattern || "", 34)}”`;
  if (name === "page_find") return `Querying ${tab} structure`;
  if (name === "page_read") return `Reading ${tab}`;
  if (name === "page_screenshot") return `Looking at ${tab} visually`;
  if (name === "click") return `Clicking ${args.ref}`;
  if (name === "fill") return `Typing in ${args.ref}`;
  if (name === "select") return `Selecting ${args.ref}`;
  if (name === "scroll") return `Scrolling ${tab}`;
  if (name === "navigate") return `Navigating ${tab}`;
  if (name === "wait") return `Waiting on ${tab}`;
  if (name === "tabs_open") return "Opening a tab";
  if (name === "tabs_focus") return `Showing ${tab}`;
  if (name === "tabs_close") return `Closing ${tab}`;
  return name;
}

function extractTab(ref) {
  const match = /^([A-Z]\d+):/.exec(ref || "");
  return match?.[1] || "";
}

function truncate(value, n) { return value.length <= n ? value : `${value.slice(0, n - 1)}…`; }

function sanitizeForTrace(value) {
  if (Array.isArray(value)) return value.map(sanitizeForTrace);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "data" && typeof item === "string" && item.length > 1000) out[key] = `<base64 ${item.length} chars>`;
      else out[key] = sanitizeForTrace(item);
    }
    return out;
  }
  return value;
}
