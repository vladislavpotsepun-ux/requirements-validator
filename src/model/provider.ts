import { ApiError, GoogleGenAI } from '@google/genai';
import { ReviewError } from '../review/errors.js';
import type { ModelRequest, ReviewModel } from '../review/types.js';
import { codexModel } from './codex.js';

const geminiDefault = 'gemini-4-hydrogen';
const localDefault = 'qwen3.5:9b';
const geminiTimeout = 270_000;
const localTimeout = 510_000;
const localPromptBytes = 23_800;
const maxTokens = { extract: 7168, individual: 6144, set: 8192 } as const;

export function createReviewModel(environment = process.env, fetcher: typeof fetch = fetch): ReviewModel {
  const provider = environment.LLM_PROVIDER?.trim().toLowerCase() || 'gemini';
  if (provider === 'codex') {
    return codexModel(environment.CODEX_MODEL?.trim() || 'gpt-6.2-sol');
  }
  if (provider === 'local') {
    const model = environment.LOCAL_MODEL?.trim() || localDefault;
    const url = localEndpoint(environment.LOCAL_BASE_URL?.trim() || 'http://127.0.0.1:11434/v1');
    return localModel(model, url, fetcher);
  }
  if (provider !== 'gemini') {
    throw new ReviewError('MODEL_CONFIG', 'LLM_PROVIDER must be gemini, local, or codex.');
  }
  const apiKey = environment.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new ReviewError('MODEL_CONFIG', 'Set GEMINI_API_KEY in the environment or .env file.');
  }
  return geminiModel(environment.GEMINI_MODEL?.trim() || geminiDefault, apiKey, fetcher);
}

function geminiModel(model: string, apiKey: string, fetcher: typeof fetch): ReviewModel {
  const gemini = new GoogleGenAI({
    apiKey,
    vertexai: false,
    httpOptions: {
      fetch: fetcher,
      timeout: geminiTimeout,
      retryOptions: { attempts: 3, initialDelay: 2.5, maxDelay: 15 },
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
            maxOutputTokens: maxTokens[phase],
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

function localEndpoint(baseUrl: string): URL {
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
  base.pathname = base.pathname.replace(/\/+$/u, '') + '/chat/completions';
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
