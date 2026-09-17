// AI provider abstraction: every provider takes a prompt + JSON schema and
// returns a parsed object. Keys are read from server env only.

export type AiProviderId = "lovable" | "openrouter" | "gemini";

export type AiProviderStatus = {
  id: AiProviderId;
  name: string;
  configured: boolean;
  defaultModel: string;
  detail: string;
};

export class AiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly kind: "config" | "auth" | "rate_limit" | "payment" | "upstream" | "invalid_response" = "upstream",
  ) {
    super(message);
    this.name = "AiError";
  }
}

// A JSON-schema object (OpenAI strict-compatible: all fields required, no additionalProperties).
export type JsonSchema = Record<string, unknown>;

export type GenerateJsonArgs = {
  provider: AiProviderId;
  model?: string | null;
  system: string;
  prompt: string;
  schemaName: string;
  schema: JsonSchema;
};

const DEFAULTS: Record<AiProviderId, { name: string; model: string; env?: string }> = {
  lovable: { name: "Lovable AI", model: "openai/gpt-6-astra" },
  openrouter: { name: "OpenRouter", model: "openai/gpt-4o-mini", env: "OPENROUTER_API_KEY" },
  gemini: { name: "Google Gemini", model: "gemini-2.5-flash", env: "GEMINI_API_KEY" },
};

export function listAiProviders(): AiProviderStatus[] {
  return (Object.keys(DEFAULTS) as AiProviderId[]).map((id) => {
    const d = DEFAULTS[id];
    const key = d.env ? process.env[d.env] : process.env["LOVABLE_API_KEY"];
    const configured = !!key;
    return {
      id,
      name: d.name,
      configured,
      defaultModel: d.model,
      detail: configured
        ? d.env
          ? `${d.env} is set.`
          : "Included with Lovable Cloud. No key needed."
        : d.env
          ? `Not configured. Add the ${d.env} secret to this project.`
          : "LOVABLE_API_KEY is missing.",
    };
  });
}

export function isProviderConfigured(id: AiProviderId): boolean {
  return listAiProviders().find((p) => p.id === id)?.configured ?? false;
}

export function defaultModelFor(id: AiProviderId): string {
  return DEFAULTS[id].model;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
    throw new AiError("The AI returned a response that was not valid JSON.", undefined, "invalid_response");
  }
}

async function readError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    return j?.error?.message ?? j?.message ?? text;
  } catch {
    return text;
  }
}

function mapHttpError(providerName: string, status: number, message: string): AiError {
  const short = message.slice(0, 300);
  if (status === 401 || status === 403) {
    return new AiError(`${providerName} rejected the API key (${status}). Check the configured secret. ${short}`, status, "auth");
  }
  if (status === 402) {
    return new AiError(`${providerName} requires more credits (402). ${short}`, status, "payment");
  }
  if (status === 429) {
    return new AiError(`${providerName} rate limit reached (429). Try again shortly.`, status, "rate_limit");
  }
  if (status === 400) {
    return new AiError(`${providerName} rejected the request (400): ${short}`, status, "upstream");
  }
  return new AiError(`${providerName} is unavailable (${status}): ${short}`, status, "upstream");
}

async function openAiCompatible(
  providerName: string,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new AiError(`${providerName} could not be reached: ${(e as Error).message}`, undefined, "upstream");
  }
  if (!res.ok) {
    const msg = await readError(res);
    console.error(`[ai] ${providerName} ${res.status}: ${msg}`);
    throw mapHttpError(providerName, res.status, msg);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }>; refusal?: string } }>;
  };
  const msg = json.choices?.[0]?.message;
  if (!msg) throw new AiError(`${providerName} returned no completion.`, undefined, "invalid_response");
  if (msg.refusal) throw new AiError(`${providerName} refused: ${msg.refusal}`, undefined, "invalid_response");
  const content = Array.isArray(msg.content)
    ? msg.content.map((c) => c.text ?? "").join("")
    : (msg.content ?? "");
  return extractJson(content);
}

// Gemini's responseSchema is an OpenAPI subset; strip unsupported keywords.
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (k === "additionalProperties" || k === "$schema") continue;
      out[k] = toGeminiSchema(v);
    }
    return out;
  }
  return schema;
}

export async function generateJson<T = unknown>(args: GenerateJsonArgs): Promise<T> {
  const { provider, system, prompt, schema, schemaName } = args;
  const model = args.model?.trim() || DEFAULTS[provider].model;
  const providerName = DEFAULTS[provider].name;

  if (provider === "lovable") {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new AiError("Lovable AI is not configured (LOVABLE_API_KEY missing).", undefined, "config");
    return (await openAiCompatible(
      providerName,
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      { Authorization: `Bearer ${key}` },
      {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        reasoning_effort: "low",
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, strict: true, schema },
        },
      },
    )) as T;
  }

  if (provider === "openrouter") {
    const key = process.env["OPENROUTER_API_KEY"];
    if (!key) throw new AiError("OpenRouter is not configured. Add the OPENROUTER_API_KEY secret.", undefined, "config");
    return (await openAiCompatible(
      providerName,
      "https://openrouter.ai/api/v1/chat/completions",
      {
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://lovable.dev",
        "X-Title": "Lead Generation OS",
      },
      {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, strict: true, schema },
        },
      },
    )) as T;
  }

  // Gemini native API
  const key = process.env["GEMINI_API_KEY"];
  if (!key) throw new AiError("Gemini is not configured. Add the GEMINI_API_KEY secret.", undefined, "config");
  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: toGeminiSchema(schema),
          },
        }),
      },
    );
  } catch (e) {
    throw new AiError(`Gemini could not be reached: ${(e as Error).message}`, undefined, "upstream");
  }
  if (!res.ok) {
    const msg = await readError(res);
    console.error(`[ai] Gemini ${res.status}: ${msg}`);
    throw mapHttpError(providerName, res.status, msg);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
  };
  if (json.promptFeedback?.blockReason) {
    throw new AiError(`Gemini blocked the request: ${json.promptFeedback.blockReason}`, undefined, "invalid_response");
  }
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new AiError("Gemini returned an empty response.", undefined, "invalid_response");
  return extractJson(text) as T;
}
