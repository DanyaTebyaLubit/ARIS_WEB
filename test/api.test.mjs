import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, runChain, validatePayload, explainFailure } from '../api.mjs';
const provider = (type, keys = ['key-one']) => ({ type, keys, model: 'test-model', name: type, enabled: true });
const messages = [{ role: 'user', content: 'Привет' }, { role: 'assistant', content: 'Здравствуйте' }, { role: 'user', content: 'Ещё' }];
const ok = () => Response.json({ choices: [{ message: { content: 'Ответ' } }] });
test('HTTP 400 invalid Gemini key continues to the next key', async () => {
  let calls = 0;
  const result = await runChain({ providers: [provider('gemini', ['invalid-key', 'valid-key'])], messages }, {
    fetchImpl: async () => ++calls === 1
      ? Response.json({ error: { message: 'API key not valid. Please pass a valid API key.' } }, { status: 400 })
      : Response.json({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }),
  });
  assert.equal(calls, 2); assert.equal(result.content, 'OK');
});
test('final error preserves actionable details and masks every configured key', async () => {
  const events = [];
  await runChain({ providers: [provider('grok', ['secret-one', 'secret-two'])], messages }, {
    emit: event => events.push(event),
    fetchImpl: async () => Response.json({ error: { message: 'Rejected secret-one and secret-two' } }, { status: 401 }),
  });
  assert.equal(events.at(-1).failures.length, 2);
  assert.match(events.at(-1).message, /HTTP 401/);
  assert.match(events.at(-1).message, /ключ 2/);
  assert.ok(!JSON.stringify(events).includes('secret-one'));
  assert.ok(!JSON.stringify(events).includes('secret-two'));
});
test('distinguishes model, billing and quota errors', () => {
  assert.match(explainFailure(404, null).reason, /Модель/);
  assert.match(explainFailure(402, null).reason, /средств/);
  assert.match(explainFailure(429, null).reason, /квота/);
  assert.equal(explainFailure(400, { error: { message: 'Unsupported parameter' } }).skipKeys, true);
});
test('keys and providers are tried in order; success stops the chain', async () => {
  const calls = [], events = [];
  const result = await runChain({ providers: [provider('grok', ['a', 'b']), provider('openrouter', ['c', 'd'])], messages }, {
    emit: e => events.push(e), fetchImpl: async (url, options) => {
      calls.push([url, options.headers.Authorization]);
      return calls.length < 3 ? new Response('', { status: calls.length === 1 ? 401 : 429 }) : ok();
    },
  });
  assert.deepEqual(calls.map(c => c[1]), ['Bearer a', 'Bearer b', 'Bearer c']);
  assert.equal(result.content, 'Ответ'); assert.equal(events.at(-1).type, 'done');
  assert.ok(!JSON.stringify(events).includes('Bearer'));
});
test('Gemini converts roles and uses key header', async () => {
  const req = buildRequest(provider('gemini'), 'secret', messages);
  assert.equal(req.headers['x-goog-api-key'], 'secret'); assert.ok(!req.url.includes('secret'));
  assert.equal(JSON.parse(req.body).contents[1].role, 'model');
  const result = await runChain({ providers: [provider('gemini')], messages }, {
    fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'Visible' }] } }] }),
  });
  assert.equal(result.content, 'Visible');
});
test('bad model skips remaining keys; custom URL is normalized', async () => {
  const calls = [];
  await runChain({ providers: [provider('grok', ['a', 'b']), { ...provider('custom'), baseUrl: 'https://example.com/v1/' }], messages }, {
    fetchImpl: async url => { calls.push(url); return calls.length === 1 ? new Response('', { status: 404 }) : ok(); },
  });
  assert.equal(calls.length, 2); assert.equal(calls[1], 'https://example.com/v1/chat/completions');
});
test('abort never triggers fallback', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(runChain({ providers: [provider('grok', ['a', 'b'])], messages }, {
    signal: controller.signal, fetchImpl: async () => { calls++; controller.abort(); throw new Error(); },
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
test('network and timeout failures advance and exhausted chain returns error', async () => {
  const events = []; let calls = 0;
  const result = await runChain({ providers: [provider('grok', ['a', 'b'])], messages }, {
    emit: e => events.push(e), fetchImpl: async () => { calls++; throw new Error('secret upstream error'); },
  });
  assert.equal(calls, 2); assert.equal(result, null); assert.equal(events.at(-1).type, 'error');
  assert.ok(!JSON.stringify(events).includes('secret upstream'));
});
test('reject invalid configurations and skip disabled provider', () => {
  assert.throws(() => validatePayload({ providers: [provider('custom')], messages }));
  assert.throws(() => validatePayload({ providers: [{ ...provider('custom'), baseUrl: 'http://example.com' }], messages }));
  assert.throws(() => validatePayload({ providers: [provider('grok', [])], messages }));
  assert.equal(validatePayload({ providers: [{ ...provider('grok'), enabled: false }, provider('gemini')], messages }).length, 1);
});
test('actual attempt deadline advances to next key', async () => {
  let calls = 0;
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const result = await runChain({ providers: [provider('grok', ['a', 'b'])], messages }, {
      timeoutMs: 15,
      fetchImpl: async (_, { signal }) => {
        calls++;
        if (calls === 2) return ok();
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    });
    assert.equal(calls, 2); assert.equal(result.content, 'Ответ');
  } finally { clearInterval(keepAlive); }
});
