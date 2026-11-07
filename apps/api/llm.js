export const DEFAULT_LLM_PROVIDER = 'anthropic';
export const LLM_PROVIDERS = {
  anthropic: { defaultModel: 'claude-opus-5-5', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  openai: { defaultModel: 'gpt-6.1-sol', apiKeyEnv: 'OPENAI_API_KEY' },
};

export class QueryGenerationError extends Error {
  constructor() {
    super('LLM query generation failed');
  }
}

const INSTRUCTIONS = [
  'Generate exactly count distinct Google search queries using the supplied original query and reinterpretation direction.',
  'Each query must be a single word or a compact noun phrase, typically 1-4 words. Use only the minimum keywords needed to identify the concept.',
  'Do not write full sentences, questions, descriptions, relative clauses, or a rationale inside a query. Compress each idea into its established name or a few search keywords.',
  'Your priority is bold, surprising discovery: find ideas the user would be unlikely to encounter by searching the original query directly.',
  'Use the direction as a launch point for exploration, not a boundary that keeps every query in the original topic.',
  'Design the entire sequence to progressively increase conceptual distance from the original query.',
  'The first query should be relatively close to the original, but already introduce an unexpected angle rather than a paraphrase.',
  'Each subsequent query should make a noticeable further leap, not merely replace words or repeat the same theme.',
  'For the middle queries, cross disciplines, mechanisms, materials, scales, eras, or assumptions through unexpected analogies and inversions.',
  'The final query should look almost entirely unrelated at first glance, retaining only a thin, surprising associative thread to the starting idea.',
  'Later queries do not need to contain the original words or entities, answer the original intent, or stay in the original field.',
  'Prefer concrete, searchable concepts, phenomena, materials, methods, and examples over abstract wordplay or slogans.',
  'Use established, real-world terms. Do not invent words or generate nonsensical or contrived phrases that are unlikely to yield meaningful search results.',
  'Order the queries by decreasing semantic similarity to the original, closest first, deliberately spanning from a related tangent to an almost unrelated endpoint.',
  'If count is 1, prioritize one bold, unexpected leap rather than a safe rewording.',
  'Do not return the original query, empty strings, or duplicate queries.',
  'Return only the queries in the required JSON structure, without explanations or similarity scores.',
].join(' ');

function querySchema(count, provider) {
  return {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        description: 'Exactly ' + count + ' distinct short keywords or noun phrases with increasing conceptual distance: a related tangent first and an almost unrelated endpoint last. For one query, choose a bold leap.',
        items: {
          type: 'string',
          description: 'A single word or compact noun phrase, typically 1-4 words; no sentence, question, or explanation.',
        },
        // Claude supports minItems of 0/1 and no maxItems; validate the exact count below.
        ...(provider === 'openai' ? { minItems: count, maxItems: count } : { minItems: 1 }),
      },
    },
    required: ['queries'],
    additionalProperties: false,
  };
}

async function generateOpenAI({ apiKey, model, input, schema, fetchImpl, signal }) {
  const response = await fetchImpl(new URL('https://api.openai.com/v1/responses'), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      store: false,
      instructions: INSTRUCTIONS,
      input,
      text: { format: { type: 'json_schema', name: 'awesome_queries', strict: true, schema } },
    }),
  });
  if (!response.ok) throw new Error('OpenAI HTTP error');
  const data = await response.json();
  if (data?.status !== 'completed' || data.error || !Array.isArray(data.output)) {
    throw new Error('Invalid OpenAI response');
  }
  const content = data.output.filter((item) => item?.type === 'message')
    .flatMap((item) => Array.isArray(item.content) ? item.content : []);
  if (content.some((item) => item?.type === 'refusal')) throw new Error('OpenAI refusal');
  return content.filter((item) => item?.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text).join('');
}

async function generateAnthropic({ apiKey, model, input, schema, fetchImpl, signal }) {
  const response = await fetchImpl(new URL('https://api.anthropic.com/v1/messages'), {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: INSTRUCTIONS,
      messages: [{ role: 'user', content: input }],
      output_config: { format: { type: 'json_schema', schema } },
    }),
  });
  if (!response.ok) throw new Error('Anthropic HTTP error');
  const data = await response.json();
  if (data?.type !== 'message' || data.stop_reason !== 'end_turn'
    || data.error || !Array.isArray(data.content)) {
    throw new Error('Invalid Anthropic response');
  }
  return data.content.filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text).join('');
}

export async function generateQueries(query, {
  llmProvider = DEFAULT_LLM_PROVIDER,
  anthropicApiKey, anthropicModel,
  openaiApiKey, openaiModel,
  awesomeDirection, awesomeQueryCount, fetchImpl, signal,
}) {
  try {
    if (!Object.hasOwn(LLM_PROVIDERS, llmProvider)) throw new Error('Unsupported LLM provider');
    const config = LLM_PROVIDERS[llmProvider];
    const apiKey = llmProvider === 'anthropic' ? anthropicApiKey : openaiApiKey;
    const model = (llmProvider === 'anthropic' ? anthropicModel : openaiModel) || config.defaultModel;
    if (!apiKey) throw new Error('Missing LLM API key');
    const generate = llmProvider === 'anthropic' ? generateAnthropic : generateOpenAI;
    const text = await generate({
      apiKey, model, fetchImpl, signal,
      input: JSON.stringify({ query, direction: awesomeDirection, count: awesomeQueryCount }),
      schema: querySchema(awesomeQueryCount, llmProvider),
    });
    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || Object.keys(parsed).length !== 1
      || !Array.isArray(parsed.queries) || parsed.queries.length !== awesomeQueryCount
      || parsed.queries.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error('Invalid generated queries');
    }
    const queries = parsed.queries.map((value) => value.trim());
    if (new Set(queries).size !== queries.length || queries.includes(query.trim())) {
      throw new Error('Duplicate or original queries');
    }
    return queries;
  } catch {
    // Keep provider errors and credentials out of public error messages.
    throw new QueryGenerationError();
  }
}
