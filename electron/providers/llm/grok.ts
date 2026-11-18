import type { LLMGenerateArgs, LLMProvider, ProviderDeps, ProviderTestArgs } from '../../shared';
import { fetchJson, httpError, type HttpError } from '../shared/http';
import { readEvents } from '../shared/sse';

const XAI_BASE = 'https://api.x.ai/v1';

function headers(apiKey: string) {
  return { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' };
}

function friendlyError(thrown: unknown) {
  const err = thrown as HttpError;
  if (err.status === 429) {
    const wrapped: HttpError = new Error(
      `xAI rate limit (${err.status}). Try again shortly or switch models. (${err.message})`
    );
    wrapped.status = err.status;
    return wrapped;
  }
  if (err.status === 401 || err.status === 403) {
    const wrapped: HttpError = new Error(
      `xAI authentication failed (${err.status}). Check your API key. (${err.message})`
    );
    wrapped.status = err.status;
    return wrapped;
  }
  return thrown;
}

/** The fields of a chat-completion stream event that are read here. */
interface GrokStreamEvent {
  error?: { message?: string; type?: string; status?: number };
  choices?: Array<{ delta?: { content?: string } }>;
}

/** Stream a chat completion, passing each content delta to `onText`, and return the full text. */
async function streamCompletion(
  apiKey: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  onText?: (delta: string) => void
) {
  const res = await fetchImpl(`${XAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) throw httpError(res, await res.text(), 'xAI');

  let text = '';
  for await (const event of readEvents<GrokStreamEvent>(res.body!)) {
    if (event.error) {
      const err: HttpError = new Error(`xAI error (stream): ${event.error.message || event.error.type || 'unknown'}`);
      if (Number.isInteger(event.error.status)) err.status = event.error.status;
      throw err;
    }
    const delta = event.choices?.[0]?.delta?.content || '';
    text += delta;
    if (delta) onText?.(delta);
  }
  return text;
}

async function generate({ systemPrompt, userPrompt, model, config, json, onText }: LLMGenerateArgs, deps: ProviderDeps = {}) {
  const apiKey = config.xaiApiKey;
  if (!apiKey || !apiKey.trim()) throw new Error('xAI API key is required');
  const fetchImpl = deps.fetchImpl || globalThis.fetch;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
  };
  if (json) body.response_format = { type: 'json_object' };

  try {
    let text: string;
    try {
      text = await streamCompletion(apiKey, body, fetchImpl, onText);
    } catch (thrown) {
      const err = thrown as HttpError;
      if (!(json && err.status === 400 && /stream/i.test(err.message))) throw err;
      const data = (await fetchJson(
        `${XAI_BASE}/chat/completions`,
        { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body) },
        { label: 'xAI', fetchImpl }
      )) as { choices?: Array<{ message?: { content?: string } }> } | null;
      text = data?.choices?.[0]?.message?.content || '';
    }
    if (!text) throw new Error('No response from xAI API');
    return String(text).trim();
  } catch (err) {
    throw friendlyError(err);
  }
}

async function test({ config, model }: ProviderTestArgs, deps: ProviderDeps = {}) {
  const apiKey = config.xaiApiKey;
  if (!apiKey || !apiKey.trim()) throw new Error('xAI API key is required');
  try {
    await fetchJson(
      `${XAI_BASE}/chat/completions`,
      {
        method: 'POST',
        headers: headers(apiKey),
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with "OK" only.' }],
          max_tokens: 8,
        }),
      },
      { label: 'xAI', fetchImpl: deps.fetchImpl || globalThis.fetch }
    );
  } catch (err) {
    throw friendlyError(err);
  }
}

const provider: LLMProvider = {
  id: 'grok',
  name: 'Grok (xAI)',
  badge: 'Reasoning',
  icon: 'grok',
  pricing: 'Pay-per-token (see x.ai/api)',
  description:
    'xAI Grok models. Strong reasoning and long-context performance. OpenAI-compatible API at api.x.ai.',
  credentials: [
    {
      configKey: 'xaiApiKey',
      label: 'xAI API key',
      type: 'password',
      placeholder: 'xai-...',
      hint: 'Get a key from the xAI console.',
      link: { href: 'https://console.x.ai/', label: 'xAI console' },
      required: true,
    },
  ],
  guide: [
    { text: 'Go to the xAI Console', url: 'https://console.x.ai/' },
    { text: 'Create an account / log in and generate an API key' },
    { text: 'Paste the key into the xAI API key field' },
  ],
  models: [
    { id: 'grok-4', name: 'Grok 4', badge: 'Default', description: 'Flagship reasoning model.' },
    { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast Reasoning', badge: 'Fast', description: 'Faster reasoning variant with large context.' },
    { id: 'grok-3', name: 'Grok 3', badge: 'Balanced', description: 'Previous flagship, still very capable.' },
    { id: 'grok-3-mini', name: 'Grok 3 Mini', badge: 'Lite', description: 'Lower cost, good for shorter meetings.' },
  ],
  defaultModel: 'grok-4',
  allowCustomModel: true,
  generate,
  test,
};

export default provider;
