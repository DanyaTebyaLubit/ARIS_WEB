import { mkdir, readFile, writeFile, rename, readdir, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeHistory } from './src/history.js';
import { normalizeAccount } from './src/account.js';
import { normalizeProviderList } from './api.mjs';
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_SIZE, isImageType } from './src/attachments.js';

// Tests override ARIS_DATA_DIR to run against a throwaway directory.
const dataRoot = () => process.env.ARIS_DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url));
const statePath = () => path.join(dataRoot(), 'state.json');
const filesDir = () => path.join(dataRoot(), 'files');
const indexName = () => path.join(filesDir(), 'index.json');
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function ensureDirs() {
  await mkdir(filesDir(), { recursive: true });
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

const emptyHistory = () => normalizeHistory({ version: 1, chats: [], currentId: null });

export async function readState() {
  await ensureDirs();
  let raw;
  try { raw = await readFile(statePath(), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      account: normalizeAccount(parsed.account),
      providers: normalizeProviderList(parsed.providers ?? []),
      history: normalizeHistory({ version: 1, chats: parsed.history?.chats ?? [], currentId: parsed.history?.currentId ?? null }),
    };
  } catch (error) {
    // Keep the unreadable file for manual recovery instead of silently overwriting it.
    const backup = `${statePath()}.corrupt-${Date.now()}`;
    await rename(statePath(), backup).catch(() => {});
    console.warn(`ARIS: не удалось прочитать data/state.json (${error.message}). Копия сохранена как ${path.basename(backup)}.`);
    return null;
  }
}

export async function updateState(patch) {
  const current = await readState() || { account: normalizeAccount(), providers: [], history: emptyHistory() };
  const next = {
    account: patch.account !== undefined ? normalizeAccount({ ...current.account, ...patch.account }) : current.account,
    providers: patch.providers !== undefined ? normalizeProviderList(patch.providers) : current.providers,
    history: patch.chats !== undefined || patch.currentId !== undefined
      ? normalizeHistory({ version: 1, chats: patch.chats ?? current.history.chats, currentId: patch.currentId ?? current.history.currentId })
      : current.history,
  };
  await writeAtomic(statePath(), JSON.stringify(next, null, 2));
  return next;
}

async function readIndex() {
  try { return JSON.parse(await readFile(indexName(), 'utf8')); }
  catch { return {}; }
}

export async function saveAttachment(buffer, { name, type }) {
  await ensureDirs();
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Файл вложения пуст.');
  if (buffer.length > MAX_ATTACHMENT_SIZE) throw new Error('Файл вложения больше 8 МБ.');
  if (!ATTACHMENT_TYPES.includes(type)) throw new Error('Неподдерживаемый тип файла.');
  const cleanName = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) || 'файл';
  const id = crypto.randomUUID();
  await writeFile(path.join(filesDir(), id), buffer);
  const index = await readIndex();
  index[id] = { name: cleanName, type, size: buffer.length, createdAt: Date.now() };
  await writeAtomic(indexName(), JSON.stringify(index));
  return { id, name: cleanName, type, size: buffer.length };
}

export async function readAttachment(id) {
  if (typeof id !== 'string' || !ATTACHMENT_ID.test(id)) return null;
  const meta = (await readIndex())[id];
  if (!meta) return null;
  try {
    return { meta, buffer: await readFile(path.join(filesDir(), id)) };
  } catch {
    return null;
  }
}

// Resolved for api.mjs: images as base64, text files as truncated plain text.
export async function loadAttachmentContent(id) {
  const found = await readAttachment(id);
  if (!found) return null;
  const { meta, buffer } = found;
  return {
    name: meta.name,
    mime: meta.type,
    base64: isImageType(meta.type) ? buffer.toString('base64') : null,
    text: isImageType(meta.type) ? null : buffer.toString('utf8').slice(0, 150000),
  };
}

// Boot-time cleanup: attachment files no longer referenced by any chat and older than a day.
export async function pruneAttachments({ maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  await ensureDirs();
  const state = await readState();
  const referenced = new Set();
  for (const chat of state?.history.chats ?? []) {
    for (const message of chat.messages) for (const a of message.attachments ?? []) referenced.add(a.id);
  }
  const index = await readIndex();
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const [id, meta] of Object.entries(index)) {
    if (referenced.has(id) || (meta.createdAt || 0) > cutoff) continue;
    await unlink(path.join(filesDir(), id)).catch(() => {});
    delete index[id];
    removed++;
  }
  for (const entry of await readdir(filesDir())) {
    if (entry === 'index.json' || index[entry]) continue;
    const info = await stat(path.join(filesDir(), entry)).catch(() => null);
    if (!info || info.mtimeMs > cutoff) continue;
    await unlink(path.join(filesDir(), entry)).catch(() => {});
    removed++;
  }
  if (removed) await writeAtomic(indexName(), JSON.stringify(index));
  return removed;
}
