'use strict';

/**
 * Anthropic Provider — direct Claude API.
 * Priority 1 in the routing stack.
 */

const Anthropic = require('@anthropic-ai/sdk');

let _client = null;

function _key() { return process.env.ANTHROPIC_API_KEY || ''; }
function _model() { return process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001'; }

function isConfigured() {
  return !!_key();
}

function _getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: _key() });
  }
  return _client;
}

async function chat(systemPrompt, messages, options = {}) {
  if (!_key()) throw new Error('Anthropic API key not configured');

  const model = options.model || _model();
  const maxTokens = options.maxTokens || 512;

  const anthropicMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  const response = await _getClient().messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt || undefined,
    messages: anthropicMessages,
  });

  const text = response.content?.[0]?.text || '';
  const usage = {
    prompt_tokens: response.usage?.input_tokens || 0,
    completion_tokens: response.usage?.output_tokens || 0,
    total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
  };

  return { text, usage };
}

async function generate(prompt, options = {}) {
  return chat(
    'You are a helpful, concise assistant. Respond directly without preamble.',
    [{ role: 'user', content: prompt }],
    options
  );
}

async function streamChat(systemPrompt, messages, res, options = {}) {
  if (!_key()) throw new Error('Anthropic API key not configured');

  const model = options.model || _model();
  const maxTokens = options.maxTokens || 1024;

  const anthropicMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  let fullText = '';

  const stream = await _getClient().messages.stream({
    model,
    max_tokens: maxTokens,
    system: systemPrompt || undefined,
    messages: anthropicMessages,
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      const content = chunk.delta.text;
      fullText += content;
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'text', content })}\n\n`);
      }
    }
  }

  return { fullText, usage: { total_tokens: 0 } };
}

module.exports = { isConfigured, chat, generate, streamChat };
