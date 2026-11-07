import { DEFAULT_LLM_PROVIDER, LLM_PROVIDERS } from '../apps/api/llm.js';

export function serverConfig(env = process.env) {
  const llmProvider = env.LLM_PROVIDER?.trim() || DEFAULT_LLM_PROVIDER;
  const provider = Object.hasOwn(LLM_PROVIDERS, llmProvider) ? LLM_PROVIDERS[llmProvider] : null;
  const port = Number(env.PORT ?? 3000);
  if (!env.SERPAPI_API_KEY?.trim()) throw new Error('SERPAPI_API_KEY is required');
  if (!provider) throw new Error('LLM_PROVIDER must be anthropic or openai');
  if (!env[provider.apiKeyEnv]?.trim()) throw new Error(`${provider.apiKeyEnv} is required`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  return {
    port,
    options: {
      apiKey: env.SERPAPI_API_KEY.trim(), llmProvider,
      anthropicApiKey: env.ANTHROPIC_API_KEY?.trim(),
      anthropicModel: env.ANTHROPIC_MODEL?.trim() || LLM_PROVIDERS.anthropic.defaultModel,
      openaiApiKey: env.OPENAI_API_KEY?.trim(),
      openaiModel: env.OPENAI_MODEL?.trim() || LLM_PROVIDERS.openai.defaultModel,
    },
  };
}
