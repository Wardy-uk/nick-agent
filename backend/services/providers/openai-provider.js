'use strict';

/**
 * OpenAI Provider — ChatGPT API.
 * Priority 2 in the routing stack.
 */

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function _key() { return process.env.OPENAI_API_KEY || ''; }
function _model() { return process.env.OPENAI_MODEL || 'gpt-4o-mini'; }

function isConfigured() {
  return !!_key();
}

async function chat(systemPrompt, messages, options = {}) {
  if (!_key()) throw new Error('OpenAI API key not configured');

  const model = options.model || _model();
  const timeout = options.timeout || 30000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_key()}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        temperature: options.temperature ?? 0.5,
        max_tokens: options.maxTokens || 512,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI API error: HTTP ${res.status} — ${body.substring(0, 200)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    return { text, usage };
  } finally {
    clearTimeout(timer);
  }
}

async function generate(prompt, options = {}) {
  return chat(
    'You are a helpful, concise assistant. Respond directly without preamble.',
    [{ role: 'user', content: prompt }],
    options
  );
}

async function streamChat(systemPrompt, messages, res, options = {}) {
  if (!_key()) throw new Error('OpenAI API key not configured');

  const model = options.model || _model();
  const timeout = options.timeout || 60000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_key()}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        temperature: options.temperature ?? 0.5,
        max_tokens: options.maxTokens || 1024,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenAI stream error: HTTP ${response.status} — ${body.substring(0, 200)}`);
    }

    let fullText = '';
    let buffer = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            fullText += content;
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: 'text', content })}\n\n`);
            }
          }
        } catch {}
      }
    }

    return { fullText, usage: { total_tokens: 0 } };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isConfigured, chat, generate, streamChat };
