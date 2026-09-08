import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHistory, saveHistory, HISTORY_KEY } from '../src/history.js';
const memory = () => { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }; };
test('restores chats, current selection, draft, errors and answer after reload', () => {
  const storage = memory();
  const chats = [{ id: 'one', title: 'Работа', draft: 'Продолжить', updatedAt: 42,
    messages: [{ role: 'user', content: 'Привет' }, { role: 'assistant', content: 'Ошибка', error: true }, { role: 'assistant', content: 'Ответ', provider: 'OpenRouter' }] },
    { id: 'two', messages: [], title: '', draft: '', updatedAt: 0 }];
  saveHistory(storage, chats, 'one');
  assert.deepEqual(loadHistory(storage), { version: 1, chats, currentId: 'one' });
  chats[0].title = 'Новое название'; saveHistory(storage, chats.slice(0, 1), 'one');
  assert.equal(loadHistory(storage).chats.length, 1);
  assert.equal(loadHistory(storage).chats[0].title, 'Новое название');
});
test('never serializes extra credentials or settings', () => {
  const storage = memory();
  saveHistory(storage, [{ id: 'one', keys: ['SECRET'], providers: [{ key: 'SECRET' }], messages: [{ role: 'user', content: 'Hi', apiKey: 'SECRET' }] }], 'one');
  assert.ok(!storage.getItem(HISTORY_KEY).includes('SECRET'));
});
test('corrupt history is not silently overwritten and storage errors propagate', () => {
  const storage = memory(); storage.setItem(HISTORY_KEY, 'broken');
  assert.throws(() => loadHistory(storage)); assert.equal(storage.getItem(HISTORY_KEY), 'broken');
  assert.throws(() => saveHistory({ setItem() { throw new Error('QuotaExceeded'); } }, [], null), /QuotaExceeded/);
});
