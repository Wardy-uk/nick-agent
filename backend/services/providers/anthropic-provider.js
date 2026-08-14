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

/**
 * Stored history can start with an assistant turn or repeat a role (a failed turn
 * leaves a stray row). The plain text path tolerates that; the tool loop does not,
 * because a malformed history 400s and takes the whole turn with it.
 */
function _normaliseHistory(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = typeof m.content === 'string' ? m.content.trim() : m.content;
    if (!content) continue;
    if (!out.length && role === 'assistant') continue; // must open on a user turn
    const last = out[out.length - 1];
    if (last && last.role === role && typeof last.content === 'string' && typeof content === 'string') {
      last.content = `${last.content}\n\n${content}`;
      continue;
    }
    out.push({ role, content });
  }
  // Must also END on a user turn, or Claude just continues its own last message.
  while (out.length && out[out.length - 1].role === 'assistant') out.pop();
  return out;
}

/**
 * Chat with tool use — runs the full agentic loop and returns the final text.
 *
 * Each turn: send the conversation, run whatever tools Claude asks for, feed the
 * results back, repeat until it stops asking. Bounded by maxRounds so a model
 * that gets stuck calling the same tool can't spin forever or burn the budget.
 *
 * @param {function} runTool async (name, input) => any — the executor
 * @returns {{ text, usage, toolCalls }} toolCalls is what actually ran, in order
 */
async function chatWithTools(systemPrompt, messages, tools, runTool, options = {}) {
  if (!_key()) throw new Error('Anthropic API key not configured');

  const model = options.model || _model();
  const maxTokens = options.maxTokens || 1024;
  const maxRounds = options.maxRounds || 5;

  const convo = _normaliseHistory(messages);
  if (!convo.length) throw new Error('No user message to send');

  const toolCalls = [];
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let text = '';

  for (let round = 0; round < maxRounds; round++) {
    const response = await _getClient().messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt || undefined,
      messages: convo,
      tools,
    });

    usage.prompt_tokens += response.usage?.input_tokens || 0;
    usage.completion_tokens += response.usage?.output_tokens || 0;
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

    // Text blocks accumulate across rounds: Claude often narrates ("checking your
    // queue…") before a tool call, and that narration is part of the reply.
    const said = (response.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    if (said) text = text ? `${text}\n${said}` : said;

    const toolUses = (response.content || []).filter(b => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return { text, usage, toolCalls };
    }

    convo.push({ role: 'assistant', content: response.content });

    const results = [];
    for (const use of toolUses) {
      const result = await runTool(use.name, use.input);
      toolCalls.push({ name: use.name, input: use.input, result });
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(result),
        is_error: result && result.ok === false,
      });
    }
    convo.push({ role: 'user', content: results });
  }

  // Ran out of rounds mid-loop. Return what we have rather than nothing — the
  // tools that did run have already taken effect and Nick needs to know.
  console.warn(`[Anthropic] Tool loop hit maxRounds (${maxRounds}) — returning partial reply`);
  return { text, usage, toolCalls, truncated: true };
}

module.exports = { isConfigured, chat, generate, streamChat, chatWithTools, _normaliseHistory };
