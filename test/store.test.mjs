import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Each test points ARIS_DATA_DIR at a throwaway directory (store.mjs reads it per call).
const store = await import('../store.mjs');
async function freshDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'aris-store-'));
  process.env.ARIS_DATA_DIR = dir;
  return dir;
}

test('state round-trips, merges patches and normalizes stored values', async () => {
  const dir = await freshDir();
  try {
    assert.equal(await store.readState(), null);
    await store.updateState({
      account: { name: 'Даня', memoryEnabled: true, memory: 'Отвечай кратко' },
      providers: [{ type: 'gemini', model: 'g', keys: ['k1'] }],
      chats: [{ id: 'one', messages: [{ role: 'user', content: 'Привет' }], title: 'Первый', draft: '', updatedAt: 5 }],
      currentId: 'one',
    });
    const state = await store.readState();
    assert.equal(state.account.name, 'Даня');
    assert.equal(state.account.memoryEnabled, true);
    assert.equal(state.providers[0].keys.join(), 'k1');
    assert.equal(state.history.chats[0].title, 'Первый');
    await store.updateState({ account: { name: 'Друг' }, chats: [], currentId: null });
    const merged = await store.readState();
    assert.equal(merged.account.name, 'Друг');
    assert.equal(merged.account.memory, 'Отвечай кратко'); // partial patch keeps other fields
    assert.equal(merged.providers.length, 1);
    assert.equal(merged.history.chats.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid state patches are rejected without writing', async () => {
  const dir = await freshDir();
  try {
    await store.updateState({ providers: [{ type: 'grok', model: 'm', keys: ['k'] }] });
    await assert.rejects(() => store.updateState({ providers: [{ type: 'nope', model: 'm', keys: ['k'] }] }));
    await assert.rejects(() => store.updateState({ chats: [{ id: 'one', messages: 'oops' }], currentId: null }));
    await assert.rejects(() => store.updateState({ chats: [{ id: 'one', messages: [{ role: 'user', content: 'x', attachments: [{ id: 'bad', name: 'n', type: 'image/png', size: 1 }] }] }], currentId: 'one' }));
    const state = await store.readState();
    assert.equal(state.providers[0].type, 'grok');
    assert.equal(state.history.chats.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt state file is backed up, not silently overwritten', async () => {
  const dir = await freshDir();
  try {
    await writeFile(path.join(dir, 'state.json'), '{broken');
    assert.equal(await store.readState(), null);
    assert.ok((await readdir(dir)).some(f => f.startsWith('state.json.corrupt-')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('attachments: save, read back, resolve content, prune unreferenced', async () => {
  const dir = await freshDir();
  try {
    const meta = await store.saveAttachment(Buffer.from('a,b\n1,2'), { name: '../../отчёт.csv', type: 'text/csv' });
    assert.match(meta.id, /^[0-9a-f-]{36}$/);
    assert.equal(meta.name, 'отчёт.csv'); // path separators stripped
    const found = await store.readAttachment(meta.id);
    assert.equal(found.buffer.toString(), 'a,b\n1,2');
    assert.equal(found.meta.type, 'text/csv');
    const content = await store.loadAttachmentContent(meta.id);
    assert.equal(content.text, 'a,b\n1,2'); assert.equal(content.base64, null);
    const image = await store.saveAttachment(Buffer.from([1, 2, 3]), { name: 'p.png', type: 'image/png' });
    const imageContent = await store.loadAttachmentContent(image.id);
    assert.equal(imageContent.base64, Buffer.from([1, 2, 3]).toString('base64'));
    await assert.rejects(() => store.saveAttachment(Buffer.alloc(10), { name: 'x', type: 'image/svg+xml' }));
    await assert.rejects(() => store.saveAttachment(Buffer.alloc(0), { name: 'x', type: 'image/png' }));
    assert.equal(await store.readAttachment('not-a-uuid'), null);
    // A chat references only the csv; the unreferenced png (older than max age) must be pruned.
    await store.updateState({ chats: [{ id: 'one', messages: [{ role: 'user', content: 'см', attachments: [meta] }], title: '', draft: '', updatedAt: 1 }], currentId: 'one' });
    const removed = await store.pruneAttachments({ maxAgeMs: 0 });
    assert.equal(removed, 1);
    assert.equal(await store.readAttachment(image.id), null);
    assert.ok(await store.readAttachment(meta.id));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
