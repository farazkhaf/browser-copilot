const ENDPOINT = "https://api.openai.com/v1/responses";

export class OpenAIResponsesClient {
  constructor({ apiKey, model = "gpt-6-luna", reasoningEffort = "medium", fetchImpl = null }) {
    if (!apiKey) throw new Error("OpenAI API key is required");
    this.apiKey = apiKey;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.fetchImpl = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.provider = "openai";
  }

  async createInteraction({ input, systemInstruction, tools, previousInteractionId = null, signal = null }) {
    const body = {
      model: this.model,
      instructions: systemInstruction,
      input,
      tools,
      reasoning: { effort: this.reasoningEffort }
    };
    if (previousInteractionId) body.previous_response_id = previousInteractionId;

    const response = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    });

    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch (_) { throw new Error(`OpenAI returned non-JSON response (${response.status}): ${text.slice(0, 500)}`); }

    if (!response.ok) {
      const message = data?.error?.message || data?.message || text || `HTTP ${response.status}`;
      throw new Error(`OpenAI API error: ${message}`);
    }
    if (data?.status && data.status !== "completed") {
      const reason = data?.incomplete_details?.reason ? `: ${data.incomplete_details.reason}` : "";
      throw new Error(`OpenAI response ended with status ${data.status}${reason}`);
    }
    return data;
  }
}

export function interactionText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) return response.output_text.trim();
  const parts = [];
  for (const item of response?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content?.type === "output_text" && content.text) parts.push(content.text);
      else if (content?.type === "refusal" && content.refusal) parts.push(content.refusal);
    }
  }
  return parts.join("\n").trim();
}

export function functionCalls(response) {
  const calls = [];
  for (const item of response?.output ?? []) {
    if (item?.type !== "function_call" || !item.name) continue;
    let args = {};
    try { args = item.arguments ? JSON.parse(item.arguments) : {}; }
    catch (_) { args = {}; }
    calls.push({
      id: item.call_id || item.id,
      call_id: item.call_id || item.id,
      name: item.name,
      arguments: args,
      raw_arguments: item.arguments || "{}"
    });
  }
  return calls;
}

export function functionResult(call, value, media = null) {
  const output = [];
  output.push({ type: "input_text", text: JSON.stringify(value) });
  if (media?.base64 && media?.mimeType) {
    output.push({
      type: "input_image",
      image_url: `data:${media.mimeType};base64,${media.base64}`,
      detail: "low"
    });
  }
  return {
    type: "function_call_output",
    call_id: call.call_id || call.id,
    output: media ? output : JSON.stringify(value)
  };
}
