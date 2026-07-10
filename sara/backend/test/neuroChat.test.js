const { test } = require('node:test');
const assert = require('node:assert/strict');

const neuroChat = require('../src/integrations/neuroChat');

test('availability uses the default NEURO base URL when only a PIN is supplied', () => {
  const a = neuroChat.getAvailability({ NEURO_PIN: '1234' });
  assert.equal(a.available, true);
  assert.equal(a.reason, null);
  assert.equal(a.detail, null);
  assert.equal(a.config.baseUrl, 'https://nuero.nickward.co.uk');
});

test('availability is honest when NEURO_PIN is missing', () => {
  const a = neuroChat.getAvailability({ NEURO_BASE_URL: 'http://example.test:3001' });
  assert.equal(a.available, false);
  assert.equal(a.reason, 'not-configured');
  assert.match(a.detail, /NEURO_PIN/);
});

test('buildUrl keeps the upstream path stable', () => {
  assert.equal(neuroChat.buildUrl('http://example.test:3001', '/api/chat'), 'http://example.test:3001/api/chat');
  assert.equal(neuroChat.buildUrl('http://example.test:3001/', 'api/nudges/stream'), 'http://example.test:3001/api/nudges/stream');
});

test('proxyChat forwards to the configured NEURO upstream with pin auth', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response('event: done\\ndata: ok\\n\\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  try {
    const res = await neuroChat.proxyChat(
      { message: 'Morning. What matters?' },
      { env: { NEURO_BASE_URL: 'http://example.test:3001', NEURO_PIN: '2468' } }
    );

    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://example.test:3001/api/chat');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['x-neuro-pin'], '2468');
    assert.equal(calls[0].options.headers.accept, 'text/event-stream, application/json');
    assert.equal(calls[0].options.body, JSON.stringify({ message: 'Morning. What matters?' }));
  } finally {
    global.fetch = originalFetch;
  }
});
