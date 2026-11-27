import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai';
import { ReviewError } from '../review/errors.js';
import type { ModelRequest, ProviderId, ProviderOption, ReviewModel, ReviewPhase } from '../review/types.js';
import { codexModel } from './codex.js';

const geminiDefault = 'gemini-4-hydrogen';
const localDefault = 'qwen3.5:9b';
const localDefaultBaseUrl = 'http://127.0.0.1:11434/v1';
const geminiTimeout = 270_000;
const localTimeout = 510_000;
const localProbeTimeout = 600;
const localPromptBytes = 23_800;
const maxTokens = { extract: 7168, individual: 6144, set: 8192 } as const;
const geminiThinkingLevels: Record<ReviewPhase, ThinkingLevel> = {
  extract: ThinkingLevel.LOW,
  individual: ThinkingLevel.LOW,
  set: ThinkingLevel.MEDIUM,
};

export function createReviewModel(
  environment = process.env,
  fetcher?: typeof fetch,
  providerOverride?: ProviderId,
): ReviewModel {
  const provider = providerOverride ?? (environment.LLM_PROVIDER?.trim().toLowerCase() || 'gemini');
  if (provider === 'codex') {
    return codexModel(environment.CODEX_MODEL?.trim() || 'gpt-6.2-sol');
  }
  if (provider === 'local') {
    const model = environment.LOCAL_MODEL?.trim() || localDefault;
    const url = localEndpoint(environment.LOCAL_BASE_URL?.trim() || localDefaultBaseUrl);
    return localModel(model, url, fetcher ?? fetch);
  }
  if (provider !== 'gemini') {
    throw new ReviewError('MODEL_CONFIG', 'LLM_PROVIDER must be gemini, local, or codex.');
  }
  const apiKey = environment.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new ReviewError('MODEL_CONFIG', 'Set GEMINI_API_KEY in the environment or .env file.');
  }
  return geminiModel(environment.GEMINI_MODEL?.trim() || geminiDefault, apiKey, fetcher);
}

export async function detectAvailableProviders(
  environment = process.env,
  fetcher: typeof fetch = fetch,
): Promise<ProviderOption[]> {
  const configured = environment.LLM_PROVIDER?.trim().toLowerCase() || 'gemini';
  const options: ProviderOption[] = [];

  const apiKey = environment.GEMINI_API_KEY?.trim();
  const geminiOption: ProviderOption | undefined = apiKey && apiKey !== 'MY_GEMINI_API_KEY'
    ? { id: 'gemini', provider: 'Gemini', model: environment.GEMINI_MODEL?.trim() || geminiDefault }
    : undefined;

  let localOption: ProviderOption | undefined;
  const localModelName = environment.LOCAL_MODEL?.trim() || localDefault;
  const localBaseUrl = environment.LOCAL_BASE_URL?.trim() || localDefaultBaseUrl;
  try {
    const probeUrl = localModelsEndpoint(localBaseUrl);
    const reachable = await probeLocalEndpoint(probeUrl, fetcher);
    if (reachable || configured === 'local') {
      localOption = { id: 'local', provider: 'Local', model: localModelName };
    }
  } catch {
    // Ignore invalid LOCAL_BASE_URL when probing optional fallback.
  }

  const codexOption: ProviderOption | undefined = configured === 'codex'
    ? { id: 'codex', provider: 'Codex CLI', model: environment.CODEX_MODEL?.trim() || 'gpt-6.2-sol' }
    : undefined;

  const byId: Partial<Record<ProviderId, ProviderOption>> = {
    gemini: geminiOption,
    local: localOption,
    codex: codexOption,
  };
  const order: ProviderId[] = configured === 'local'
    ? ['local', 'gemini', 'codex']
    : configured === 'codex'
      ? ['codex', 'gemini', 'local']
      : ['gemini', 'local', 'codex'];

  for (const id of order) {
    const option = byId[id];
    if (option) {
      options.push(option);
    }
  }
  return options;
}

async function probeLocalEndpoint(url: URL, fetcher: typeof fetch): Promise<boolean> {
  try {
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(localProbeTimeout),
    });
    void response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

function supportsThinkingLevel(model: string): boolean {
  return /^gemini-(?:3|4)(?:[.-]|$)/iu.test(model);
}

function geminiModel(model: string, apiKey: string, fetcher?: typeof fetch): ReviewModel {
  const gemini = new GoogleGenAI({
    apiKey,
    vertexai: false,
    httpOptions: {
      ...(fetcher ? { fetch: fetcher } : {}),
      timeout: geminiTimeout,
      retryOptions: { attempts: 5, initialDelay: 2, maxDelay: 20 },
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
  return {
    provider: 'Gemini',
    model,
    async generate({ phase, instructions, data, schema, signal }) {
      try {
        const response = await gemini.models.generateContent({
          model,
          contents: JSON.stringify(data),
          config: {
            systemInstruction: instructions,
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            ...(supportsThinkingLevel(model)
              ? { thinkingConfig: { thinkingLevel: geminiThinkingLevels[phase] } }
              : {}),
            abortSignal: signal,
          },
        });
        return parseModelJson(response.text, response.candidates?.[0]?.finishReason === 'MAX_TOKENS');
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof ReviewError) {
          throw error;
        }
        if (error instanceof ApiError) {
          throw httpError(error.status);
        }
        throw unavailable();
      }
    },
  };
}

function parseLoopbackBase(baseUrl: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new ReviewError('MODEL_CONFIG', 'LOCAL_BASE_URL is not a valid URL.');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'];
  if (base.protocol !== 'http:' || !loopback.includes(base.hostname) || base.username || base.password
    || base.search || base.hash) {
    throw new ReviewError('MODEL_CONFIG', 'LOCAL_BASE_URL must be a loopback HTTP endpoint.');
  }
  base.pathname = base.pathname.replace(/\/+$/u, '');
  return base;
}

function localEndpoint(baseUrl: string): URL {
  const base = parseLoopbackBase(baseUrl);
  base.pathname += '/chat/completions';
  return base;
}

function localModelsEndpoint(baseUrl: string): URL {
  const base = parseLoopbackBase(baseUrl);
  base.pathname += '/models';
  return base;
}

function localModel(model: string, url: URL, fetcher: typeof fetch): ReviewModel {
  return {
    provider: 'Local',
    model,
    async generate({ phase, instructions, data, schema, signal }: ModelRequest) {
      const input = JSON.stringify(data);
      if (Buffer.byteLength(instructions) + Buffer.byteLength(input) > localPromptBytes) {
        throw new ReviewError(
          'MODEL_CONTEXT',
          'The local review exceeds its input budget. Shorten the document or use Gemini.',
        );
      }
      const deadline = AbortSignal.timeout(localTimeout);
      let response: Response;
      try {
        response = await fetcher(url, {
          method: 'POST',
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: instructions },
              { role: 'user', content: input },
            ],
            stream: false,
            temperature: 0.15,
            max_tokens: maxTokens[phase],
            response_format: { type: 'json_schema', json_schema: { name: phase, strict: true, schema } },
          }),
        });
      } catch {
        signal?.throwIfAborted();
        throw unavailable();
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw httpError(response.status);
      }
      let value: { choices?: { message?: { content?: unknown }; finish_reason?: string }[] } | null;
      try {
        value = await response.json();
      } catch {
        signal?.throwIfAborted();
        throw new ReviewError('INVALID_MODEL_OUTPUT', 'The local provider returned an unreadable response.');
      }
      return parseModelJson(value?.choices?.[0]?.message?.content, value?.choices?.[0]?.finish_reason === 'length');
    },
  };
}

function parseModelJson(value: unknown, truncated: boolean): unknown {
  if (truncated || typeof value !== 'string' || !value.trim()) {
    throw new ReviewError('INVALID_MODEL_OUTPUT', 'The model did not return a complete JSON document.');
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new ReviewError('INVALID_MODEL_OUTPUT', 'The model returned invalid JSON.');
  }
}

function httpError(status: number): ReviewError {
  if (status === 429) {
    return new ReviewError('MODEL_LIMIT', 'The model quota or rate limit was reached. Try again later.');
  }
  if ([400, 401, 403, 404].includes(status)) {
    return new ReviewError(
      'MODEL_CONFIG',
      `The provider rejected the model request (HTTP ${status}). Check the model and API access.`,
    );
  }
  return unavailable();
}

function unavailable(): ReviewError {
  return new ReviewError('MODEL_UNAVAILABLE', 'The model service is unavailable or timed out.');
}
