const CHAT_COMPLETIONS_SUFFIX = '/chat/completions';

const normalizeChatUrl = (baseUrl) => {
  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.endsWith(CHAT_COMPLETIONS_SUFFIX) ? trimmed : `${trimmed}${CHAT_COMPLETIONS_SUFFIX}`;
};

export const createLlmAdapter = ({
  baseUrl = process.env.LLM_BASE_URL,
  apiKey = process.env.LLM_API_KEY,
  model = process.env.LLM_MODEL,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const chatUrl = normalizeChatUrl(baseUrl);

  return {
    configured: Boolean(chatUrl),
    model: model || null,

    async chat({messages, tools, temperature, signal} = {}) {
      if (!chatUrl) throw new Error('LLM_BASE_URL is not configured on the local server.');
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('messages must be a non-empty array.');
      }
      const payload = {messages};
      if (model) payload.model = model;
      if (Array.isArray(tools) && tools.length) payload.tools = tools;
      if (typeof temperature === 'number') payload.temperature = temperature;

      const response = await fetchImpl(chatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? {Authorization: `Bearer ${apiKey}`} : {}),
        },
        body: JSON.stringify(payload),
        signal,
      });
      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = {raw: text};
      }
      if (!response.ok) {
        const detail = data?.error?.message || data?.detail || data?.message || data?.error || text || response.statusText;
        throw new Error(`llm request failed (${response.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
      }
      return data;
    },
  };
};
