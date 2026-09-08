import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeProviderList, validatePayload, buildRequest, runChain } from '../api.mjs';
import { normalizeAttachmentList, MAX_ATTACHMENT_SIZE } from '../src/attachments.js';
import { normalizeHistory } from '../src/history.js';

const uuid = '3f2b8c6a-1d4e-4f5a-9b8c-7d6e5f4a3b2c';
const attachment = { id: uuid, name: 'схема.png', type: 'image/png', size: 2048 };
const messages = [{ role: 'user', content: 'Что на картинке?', attachments: [attachment] }];

test('normalizeAttachmentList whitelists metadata and rejects injection', () => {
  assert.deepEqual(normalizeAttachmentList([attachment]), [attachment]);
  assert.equal(normalizeAttachmentList(undefined), undefined);
  assert.throws(() => normalizeAttachmentList([]), /Invalid attachments/);
  assert.throws(() => normalizeAttachmentList([{ ...attachment, id: 'not-a-uuid' }]));
  assert.throws(() => normalizeAttachmentList([{ ...attachment, type: 'image/svg+xml' }]));
  assert.throws(() => normalizeAttachmentList([{ ...attachment, size: MAX_ATTACHMENT_SIZE + 1 }]));
  assert.throws(() => normalizeAttachmentList([{ ...attachment, name: '' }]));
});

test('normalizeHistory keeps attachment metadata on user messages', () => {
  const history = normalizeHistory({ version: 1, currentId: 'one', chats: [
    { id: 'one', messages: [{ role: 'user', content: 'Смотри', attachments: [attachment] }] },
  ] });
  assert.deepEqual(history.chats[0].messages[0].attachments, [attachment]);
  assert.throws(() => normalizeHistory({ version: 1, chats: [
    { id: 'one', messages: [{ role: 'assistant', content: 'x', attachments: [attachment] }] },
  ] }));
});

test('provider list normalization whitelists fields for server storage', () => {
  const stored = normalizeProviderList([{ type: 'gemini', model: ' m1 ', keys: [' a ', 'a', ''], name: 'N', secret: 'x', enabled: false }]);
  assert.deepEqual(stored, [{ id: stored[0].id, type: 'gemini', name: 'N', model: 'm1', baseUrl: '', keys: ['a'], enabled: false }]);
  assert.throws(() => normalizeProviderList([{ type: 'custom', model: 'm', keys: ['k'], baseUrl: 'http://example.com' }]));
  assert.throws(() => normalizeProviderList('nope'));
});

test('chat payload accepts attachments only in valid shape', () => {
  const provider = { type: 'grok', keys: ['k'], model: 'm', name: 'g', enabled: true };
  assert.doesNotThrow(() => validatePayload({ providers: [provider], messages }));
  assert.throws(() => validatePayload({ providers: [provider], messages: [{ role: 'user', content: 'x', attachments: [{ id: 'bad', name: 'n', type: 'image/png', size: 1 }] }] }));
  assert.throws(() => validatePayload({ providers: [provider], messages: [{ role: 'user', content: 'x', attachments: [attachment, attachment] }] }));
});

test('Gemini receives images as inline_data and text files as text parts', () => {
  const provider = { type: 'gemini', keys: ['k'], model: 'm', name: 'g', enabled: true };
  const resolved = [{ ...messages[0], files: [{ name: 'схема.png', mime: 'image/png', base64: 'QUJD', text: null }] }];
  const body = JSON.parse(buildRequest(provider, 'k', resolved).body);
  assert.deepEqual(body.contents[0].parts[0], { text: 'Что на картинке?' });
  assert.deepEqual(body.contents[0].parts[1], { inline_data: { mime_type: 'image/png', data: 'QUJD' } });
});

test('OpenAI-compatible providers get image_url content and appended file text', () => {
  const provider = { type: 'grok', keys: ['k'], model: 'm', name: 'g', enabled: true };
  const resolved = [
    { role: 'user', content: 'Вот отчёт', files: [{ name: 'data.csv', mime: 'text/csv', text: 'a,b\n1,2', base64: null }] },
    { role: 'user', content: 'И фото', files: [{ name: 'p.png', mime: 'image/png', base64: 'QUJD', text: null }] },
  ];
  const body = JSON.parse(buildRequest(provider, 'k', resolved).body);
  assert.equal(body.messages[0].content, 'Вот отчёт\n\n--- Файл: data.csv ---\na,b\n1,2');
  assert.deepEqual(body.messages[1].content[0], { type: 'text', text: 'И фото' });
  assert.deepEqual(body.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
});

test('missing attachment files degrade to a note instead of failing the request', async () => {
  const events = [];
  const result = await runChain({ providers: [{ type: 'grok', keys: ['k'], model: 'm', name: 'g', enabled: true }], messages }, {
    emit: e => events.push(e),
    readAttachment: async () => null,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.match(body.messages[0].content, /недоступно/);
      return Response.json({ choices: [{ message: { content: 'Ответ' } }] });
    },
  });
  assert.equal(result.content, 'Ответ');
});

test('runChain resolves attachment ids once and reuses them across keys', async () => {
  let reads = 0;
  const provider = { type: 'grok', keys: ['bad', 'good'], model: 'm', name: 'g', enabled: true };
  let calls = 0;
  const result = await runChain({ providers: [provider], messages }, {
    readAttachment: async id => { assert.equal(id, uuid); reads++; return { text: 'содержимое', base64: null }; },
    fetchImpl: async (url, options) => {
      calls++;
      if (calls === 1) return new Response('', { status: 401 });
      const body = JSON.parse(options.body);
      assert.match(body.messages[0].content, /содержимое/);
      return Response.json({ choices: [{ message: { content: 'Ответ' } }] });
    },
  });
  assert.equal(result.content, 'Ответ'); assert.equal(reads, 1);
});
