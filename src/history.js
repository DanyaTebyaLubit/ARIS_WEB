import { normalizeAttachmentList } from './attachments.js';

export const HISTORY_KEY = 'aris.history.v1';

export function normalizeHistory(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.chats)) throw new Error('Invalid history');
  const ids = new Set();
  const chats = value.chats.map(chat => {
    if (!chat || typeof chat.id !== 'string' || ids.has(chat.id) || !Array.isArray(chat.messages)) throw new Error('Invalid chat');
    ids.add(chat.id);
    const messages = chat.messages.map(m => {
      if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw new Error('Invalid message');
      if (m.role !== 'user' && m.attachments !== undefined) throw new Error('Invalid message');
      const attachments = m.role === 'user' ? normalizeAttachmentList(m.attachments) : undefined;
      return { role: m.role, content: m.content, ...(typeof m.provider === 'string' ? { provider: m.provider } : {}),
        ...(m.error === true ? { error: true } : {}), ...(attachments ? { attachments } : {}) };
    });
    return { id: chat.id, messages, title: typeof chat.title === 'string' ? chat.title.slice(0, 100) : '',
      draft: typeof chat.draft === 'string' ? chat.draft : '', updatedAt: Number.isFinite(chat.updatedAt) ? chat.updatedAt : 0 };
  });
  return { version: 1, chats, currentId: ids.has(value.currentId) ? value.currentId : chats[0]?.id || null };
}

// Offline mirror of the cloud history, kept per browser so a dropped connection never loses the chat.
export function loadHistory(storage) {
  const raw = storage.getItem(HISTORY_KEY);
  return raw === null ? { version: 1, chats: [], currentId: null } : normalizeHistory(JSON.parse(raw));
}

export function saveHistory(storage, chats, currentId) {
  storage.setItem(HISTORY_KEY, JSON.stringify(normalizeHistory({ version: 1, chats, currentId })));
}
