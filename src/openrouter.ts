// OpenRouter is OpenAI-API-compatible, so both the chat provider
// (OpenAICompatibleProvider) and the embedder talk to it by pointing at this
// base URL and attaching the attribution headers below — no bespoke client.
//
// The attribution headers are what make calls show up as "Thought Agent" on
// the OpenRouter activity/rankings dashboards instead of as an anonymous key.
// Header names follow OpenRouter's docs: HTTP-Referer for the site URL and
// X-OpenRouter-Title for the app name.
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_SITE_URL = "https://thought-agent.com";
export const OPENROUTER_APP_NAME = "Thought Agent";

export function openRouterHeaders(): Record<string, string> {
  return {
    "HTTP-Referer": OPENROUTER_SITE_URL,
    "X-OpenRouter-Title": OPENROUTER_APP_NAME,
  };
}
