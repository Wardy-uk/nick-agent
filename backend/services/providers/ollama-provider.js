'use strict';

/**
 * Ollama Provider — local LLM calls via Ollama HTTP API.
 * Handles both generate (single-shot) and chat (multi-turn) modes.
 */

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';

/**
 * Single-shot generation (non-streaming).
 * @param {string} prompt - The full prompt
 * @param {object} options - { model, temperature, maxTokens, timeout }
 * @returns {string} The response text
 */
async function generate(prompt, options = {}) {
  const model = options.model || OLLAMA_MODEL;
  const timeout = options.timeout || 120000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.7,
          num_predict: options.maxTokens || 512,
          num_ctx: options.contextWindow || 4096,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama generate failed: HTTP ${res.status}`);
    }

    const data = await res.json();
    // Opt-in usage reporting. The return stays a plain string because every
    // caller reads it as one; a callback adds the token counts without
    // changing the contract. Ollama omits these on some paths, hence the ?? 0.
    if (typeof options.onUsage === 'function') {
      try {
        options.onUsage({
          prompt_tokens: data.prompt_eval_count ?? 0,
          completion_tokens: data.eval_count ?? 0,
        });
      } catch { /* telemetry must never break the answer */ }
    }
    return data.response || '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chat completion (non-streaming).
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} options
 * @returns {string} Assistant response text
 */
async function chat(systemPrompt, messages, options = {}) {
  const model = options.model || OLLAMA_MODEL;
  const timeout = options.timeout || 120000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const ollamaMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: ollamaMessages,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.7,
          num_predict: options.maxTokens || 512,
          num_ctx: options.contextWindow || 4096,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama chat failed: HTTP ${res.status}`);
    }

    const data = await res.json();
    if (typeof options.onUsage === 'function') {
      try {
        options.onUsage({
          prompt_tokens: data.prompt_eval_count ?? 0,
          completion_tokens: data.eval_count ?? 0,
        });
      } catch { /* telemetry must never break the answer */ }
    }
    return data.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streaming chat — writes SSE chunks to an Express response.
 * @param {string} systemPrompt
 * @param {Array} messages
 * @param {object} res - Express response (SSE)
 * @param {object} options
 * @returns {string} Full accumulated response text
 */
async function streamChat(systemPrompt, messages, res, options = {}) {
  const model = options.model || OLLAMA_MODEL;
  const timeout = options.timeout || 90000; // 90s max for streaming chat

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const ollamaMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: ollamaMessages,
        stream: true,
        options: {
          temperature: options.temperature ?? 0.7,
          num_predict: options.maxTokens || 1024,
          num_ctx: options.contextWindow || 4096,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama stream failed: HTTP ${response.status}`);
    }

    let fullResponse = '';
    const reader = response.body;
    const decoder = new TextDecoder();

    // Node fetch returns a ReadableStream with Uint8Array chunks
    for await (const chunk of reader) {
      const text = decoder.decode(chunk, { stream: true });
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) {
            fullResponse += parsed.message.content;
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: 'text', content: parsed.message.content })}\n\n`);
            }
          }
        } catch {}
      }
    }

    return fullResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check if Ollama is reachable.
 */
async function isAvailable() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function getModel() { return OLLAMA_MODEL; }
function getUrl() { return OLLAMA_URL; }

module.exports = { generate, chat, streamChat, isAvailable, getModel, getUrl };
