'use strict';

/**
 * OpenRouter Provider — cloud AI escalation path.
 * OpenAI-compatible API with model routing across providers.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function _key() { return process.env.OPENROUTER_API_KEY || ''; }
function _model() { return process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4.5'; }

function isConfigured() {
  return !!_key();
}

async function chat(systemPrompt, messages, options = {}) {
  if (!_key()) throw new Error('OpenRouter API key not configured');

  const model = options.model || _model();
  const timeout = options.timeout || 30000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_key()}`,
        'HTTP-Referer': 'https://neuro.nurtur.tech',
        'X-Title': 'NEURO',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        temperature: options.temperature ?? 0.5,
        max_tokens: options.maxTokens || 512,
        // Returns the real charged cost on `usage.cost`, which beats anything
        // we could compute from a hand-maintained price table.
        usage: { include: true },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenRouter API error: HTTP ${res.status} — ${body.substring(0, 200)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    // Null rather than a zeroed object when the response carries no usage at
    // all: "we were not told" must not become "it cost nothing".
    const usage = data.usage || null;

    return { text, usage, model };
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
  if (!_key()) throw new Error('OpenRouter API key not configured');

  const model = options.model || _model();
  const timeout = options.timeout || 60000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_key()}`,
        'HTTP-Referer': 'https://neuro.nurtur.tech',
        'X-Title': 'NEURO',
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
        // A stream reports its usage in a final chunk, but ONLY if asked.
        // Without this the function returned hardcoded zeros, so streaming chat
        // — the biggest consumer, and OpenRouter-first by policy — recorded a
        // call costing nothing and was invisible to the daily token cap too.
        stream_options: { include_usage: true },
        // Ask for the real charged cost rather than pricing it ourselves.
        usage: { include: true },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenRouter stream error: HTTP ${response.status} — ${body.substring(0, 200)}`);
    }

    let fullText = '';
    let buffer = '';
    // Stays null until the stream actually tells us. Null and "zero tokens" are
    // different facts and the cost ledger depends on the difference.
    let streamUsage = null;
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
          // The usage chunk arrives at the END, with an empty `choices` array —
          // it is not attached to a delta, so it has to be picked up here.
          if (parsed.usage) streamUsage = parsed.usage;
        } catch {}
      }
    }

    return { fullText, usage: streamUsage, model };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chat with tool use — the OpenAI-compatible function-calling loop.
 *
 * Mirrors anthropic-provider.chatWithTools exactly: same arguments, same
 * `{ text, usage, toolCalls }` return, same bounded rounds. That symmetry is the
 * point — the caller picks a provider and otherwise does not care which one it
 * got, so chat tools keep working when the routing policy changes underneath.
 *
 * Note the model must actually support tools. The default
 * (anthropic/claude-haiku-4.5) does; a model that doesn't will simply never
 * return tool_calls, and the loop returns its prose on the first round.
 */
async function chatWithTools(systemPrompt, messages, tools, runTool, options = {}) {
  if (!_key()) throw new Error('OpenRouter API key not configured');

  const model = options.model || _model();
  const maxRounds = options.maxRounds || 5;
  const timeout = options.timeout || 60000;

  // OpenAI wraps each tool in a `function` envelope; Anthropic passes them flat.
  const openaiTools = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  const convo = [{ role: 'system', content: systemPrompt }, ...messages];
  const toolCalls = [];
  // A tools turn is several round-trips, so cost accumulates across them —
  // reporting only the last round would under-count a 5-round conversation
  // fivefold.
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 };
  let text = '';

  for (let round = 0; round < maxRounds; round++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let data;
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${_key()}`,
          'HTTP-Referer': 'https://neuro.nurtur.tech',
          'X-Title': 'NEURO',
        },
        body: JSON.stringify({
          model,
          messages: convo,
          tools: openaiTools,
          temperature: options.temperature ?? 0.5,
          max_tokens: options.maxTokens || 1024,
          usage: { include: true },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OpenRouter tool call failed: HTTP ${res.status} — ${body.substring(0, 200)}`);
      }
      data = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const message = data.choices?.[0]?.message;
    if (data.usage) {
      usage.prompt_tokens += data.usage.prompt_tokens || 0;
      usage.completion_tokens += data.usage.completion_tokens || 0;
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      usage.cost += Number(data.usage.cost) || 0;
    }

    if (message?.content) text = text ? `${text}\n${message.content}` : message.content;

    const calls = message?.tool_calls || [];
    if (!calls.length) return { text, usage, toolCalls };

    convo.push(message);

    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        // A model that emits unparseable arguments should be told so and given
        // the chance to correct itself, not crash the turn.
        convo.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: 'Arguments were not valid JSON' }),
        });
        continue;
      }

      const result = await runTool(call.function.name, args);
      toolCalls.push({ name: call.function.name, input: args, result });
      convo.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  console.warn(`[OpenRouter] Tool loop hit maxRounds (${maxRounds}) — returning partial reply`);
  return { text, usage, toolCalls, truncated: true };
}

module.exports = { isConfigured, chat, generate, streamChat, chatWithTools };
