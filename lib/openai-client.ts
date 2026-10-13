import OpenAI from "openai";

export function normalizeOpenAIBaseUrl(baseUrl: string) {
  const normalized = baseUrl.trim().replace(/\/+$/, "").replace(/\/responses$/i, "");
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

export function createOpenAIClient(baseUrl: string, apiKey: string, timeout = 120_000) {
  return new OpenAI({
    apiKey,
    baseURL: normalizeOpenAIBaseUrl(baseUrl),
    timeout,
    maxRetries: 0,
  });
}
