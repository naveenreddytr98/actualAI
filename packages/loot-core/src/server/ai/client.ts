// Minimal Anthropic Messages API client. We don't pull in @anthropic-ai/sdk
// because loot-core has to run in browser-worker, electron-main, and node API
// contexts; using globalThis.fetch keeps the bundle portable and avoids the
// SDK's node-only deps.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export type AnthropicTextBlock = { type: 'text'; text: string };
export type AnthropicCacheControl = { type: 'ephemeral' };

export type AnthropicMessageContent =
  | string
  | Array<{
      type: 'text';
      text: string;
      cache_control?: AnthropicCacheControl;
    }>;

export type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: AnthropicMessageContent;
};

type AnthropicSystemBlock = {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
};

type AnthropicRequest = {
  model: string;
  max_tokens: number;
  system?: AnthropicSystemBlock[] | string;
  messages: AnthropicMessage[];
  temperature?: number;
};

type AnthropicResponse = {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicTextBlock[];
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

export class AnthropicError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
  }
}

export async function callAnthropic(
  apiKey: string,
  request: AnthropicRequest,
): Promise<AnthropicResponse> {
  const response = await globalThis.fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      // Required when calling the API directly from a browser context.
      // Safe here: the user is the only consumer of their own key.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message || JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new AnthropicError(
      response.status,
      detail || `HTTP ${response.status}`,
    );
  }

  return (await response.json()) as AnthropicResponse;
}

export function extractText(response: AnthropicResponse): string {
  return response.content
    .filter((b): b is AnthropicTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');
}
