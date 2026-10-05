import {
  GeminiInteractionsClient,
  functionCalls as geminiFunctionCalls,
  functionResult as geminiFunctionResult,
  interactionText as geminiInteractionText
} from "./gemini.js";
import {
  OpenAIResponsesClient,
  functionCalls as openaiFunctionCalls,
  functionResult as openaiFunctionResult,
  interactionText as openaiInteractionText
} from "./openai.js";

export const PROVIDERS = {
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-6-luna",
    keyPlaceholder: "sk-…"
  },
  gemini: {
    label: "Gemini",
    defaultModel: "gemini-3.8-flash",
    keyPlaceholder: "AIza…"
  }
};

export function createProviderClient({ provider = "openai", apiKey, model }) {
  if (provider === "openai") {
    return new NormalizedProvider({
      provider,
      client: new OpenAIResponsesClient({ apiKey, model: model || PROVIDERS.openai.defaultModel }),
      calls: openaiFunctionCalls,
      text: openaiInteractionText,
      result: openaiFunctionResult
    });
  }
  if (provider === "gemini") {
    return new NormalizedProvider({
      provider,
      client: new GeminiInteractionsClient({ apiKey, model: model || PROVIDERS.gemini.defaultModel }),
      calls: geminiFunctionCalls,
      text: geminiInteractionText,
      result: geminiFunctionResult
    });
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

class NormalizedProvider {
  constructor({ provider, client, calls, text, result }) {
    this.provider = provider;
    this.client = client;
    this.model = client.model;
    this._calls = calls;
    this._text = text;
    this._result = result;
  }

  createInteraction(args) { return this.client.createInteraction(args); }
  functionCalls(value) { return this._calls(value); }
  interactionText(value) { return this._text(value); }
  functionResult(call, value, media) { return this._result(call, value, media); }
}
