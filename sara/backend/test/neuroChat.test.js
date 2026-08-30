const { test } = require('node:test');
const assert = require('node:assert/strict');

const neuroChat = require('../src/integrations/neuroChat');

// ⚠ NEGATIVE, and it replaces a test that asserted the opposite. There used to be a
// hardcoded default base URL (`https://nuero.nickward.co.uk`) in this module and in
// neuroSnapshot, so a SARA with nothing but a PIN reported itself AVAILABLE and
// silently reached a public host over the open internet. A PIN alone is not a
// destination, and an implicit remote dependency is not configuration.
test('a PIN with no base URL is NOT available — there is no default host any more', () => {
  const a = neuroChat.getAvailability({ NEURO_PIN: '1234' });
  assert.equal(a.available, false);
  assert.equal(a.reason, 'not-configured');
  assert.match(a.detail, /NEURO_BASE_URL/);
  assert.equal(a.config.baseUrl, '');
});

test('availability is honest when no credential is set', () => {
  const a = neuroChat.getAvailability({ NEURO_BASE_URL: 'http://example.test:3001' });
  assert.equal(a.available, false);
  assert.equal(a.reason, 'not-configured');
  assert.match(a.detail, /NEURO_PIN/);
});

test('a base URL and a credential together are available', () => {
  const a = neuroChat.getAvailability({ NEURO_BASE_URL: 'http://example.test:3001', NEURO_PIN: '1234' });
  assert.equal(a.available, true);
  assert.equal(a.reason, null);
  assert.equal(a.config.baseUrl, 'http://example.test:3001');
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
