const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

export class GeminiInteractionsClient {
  constructor({ apiKey, model = "gemini-3.8-flash" }) {
    if (!apiKey) throw new Error("Gemini API key is required");
    this.apiKey = apiKey;
    this.model = model;
  }

  async createInteraction({ input, systemInstruction, tools, previousInteractionId = null, signal = null }) {
    const body = {
      model: this.model,
      input,
      system_instruction: systemInstruction,
      tools,
      generation_config: { temperature: 0.2 }
    };
    if (previousInteractionId) body.previous_interaction_id = previousInteractionId;

    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey
      },
      body: JSON.stringify(body),
      signal
    });

    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch (_) { throw new Error(`Gemini returned non-JSON response (${response.status}): ${text.slice(0, 500)}`); }

    if (!response.ok) {
      const message = data?.error?.message || data?.message || text || `HTTP ${response.status}`;
      throw new Error(`Gemini API error: ${message}`);
    }
    return data;
  }
}

export function interactionText(interaction) {
  const parts = [];
  for (const step of interaction?.steps ?? []) {
    if (step?.type !== "model_output") continue;
    for (const item of step.content ?? []) {
      if (item?.type === "text" && item.text) parts.push(item.text);
    }
  }
  return parts.join("\n").trim();
}

export function functionCalls(interaction) {
  return (interaction?.steps ?? []).filter((step) => step?.type === "function_call" && step?.name);
}


export function functionResult(call, value, media = null) {
  const parts = [{ type: "text", text: JSON.stringify(value) }];
  if (media?.base64 && media?.mimeType) parts.push({ type: "image", mime_type: media.mimeType, data: media.base64 });
  return {
    type: "function_result",
    call_id: call.id,
    name: call.name,
    result: parts
  };
}
