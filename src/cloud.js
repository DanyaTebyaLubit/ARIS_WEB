// Единственный слой доступа к Supabase: авторизация, настройки, история чатов и вложения.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, BUCKET, isConfigured } from './config.js';
import { normalizeAccount } from './account.js';
import { normalizeHistory } from './history.js';

export const configured = isConfigured();
export const supabase = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'aris.auth.v1' },
    })
  : null;

const need = () => { if (!supabase) throw new Error('Supabase не настроен: заполните src/config.js.'); return supabase; };
const friendly = error => {
  const text = error?.message || '';
  if (/Invalid login credentials/i.test(text)) return 'Неверная почта или пароль.';
  if (/Email not confirmed/i.test(text)) return 'Подтвердите почту по ссылке из письма.';
  if (/User already registered/i.test(text)) return 'Такой аккаунт уже есть — войдите.';
  if (/Password should be/i.test(text)) return 'Пароль слишком короткий: минимум 8 символов.';
  if (/rate limit|Too many/i.test(text)) return 'Слишком много попыток, подождите минуту.';
  if (/Failed to fetch/i.test(text)) return 'Нет связи с Supabase. Проверьте сеть и URL проекта.';
  return text || 'Не удалось выполнить запрос.';
};
const unwrap = ({ data, error }) => { if (error) throw new Error(friendly(error)); return data; };

/* ---------- авторизация ---------- */
export const getSession = async () => (await need().auth.getSession()).data.session;
export const onAuthChange = handler => need().auth.onAuthStateChange((_event, session) => handler(session));
export const signIn = (email, password) => need().auth.signInWithPassword({ email, password }).then(unwrap);
export const signUp = (email, password) =>
  need().auth.signUp({ email, password, options: { emailRedirectTo: location.origin } }).then(unwrap);
export const resetPassword = email =>
  need().auth.resetPasswordForEmail(email, { redirectTo: location.origin }).then(unwrap);
export const updatePassword = password => need().auth.updateUser({ password }).then(unwrap);
export const signOut = () => need().auth.signOut();

/* ---------- профиль: имя, внешний вид, память, подключения ---------- */
export async function loadProfile(userId) {
  const { data, error } = await need().from('profiles').select('account, providers, current_chat_id').eq('id', userId).maybeSingle();
  if (error) throw new Error(friendly(error));
  return {
    account: normalizeAccount(data?.account || {}),
    providers: Array.isArray(data?.providers) ? data.providers : [],
    currentId: data?.current_chat_id ?? null,
    exists: Boolean(data),
  };
}
export async function saveProfile(userId, patch) {
  const row = { id: userId, updated_at: new Date().toISOString() };
  if (patch.account !== undefined) row.account = normalizeAccount(patch.account);
  if (patch.providers !== undefined) row.providers = patch.providers;
  if (patch.currentId !== undefined) row.current_chat_id = patch.currentId;
  const { error } = await need().from('profiles').upsert(row, { onConflict: 'id' });
  if (error) throw new Error(friendly(error));
}

/* ---------- история чатов ---------- */
export async function loadChats(userId) {
  const { data, error } = await need().from('chats')
    .select('id, title, draft, messages, updated_at').eq('user_id', userId).order('updated_at', { ascending: false }).limit(500);
  if (error) throw new Error(friendly(error));
  const chats = (data ?? []).map(row => ({
    id: row.id, title: row.title || '', draft: row.draft || '',
    messages: Array.isArray(row.messages) ? row.messages : [],
    updatedAt: row.updated_at ? Date.parse(row.updated_at) : 0,
  }));
  // Чужие или повреждённые записи не должны ломать загрузку: пропускаем такой чат.
  return chats.filter(chat => {
    try { normalizeHistory({ version: 1, chats: [chat], currentId: chat.id }); return true; } catch { return false; }
  });
}
export async function saveChat(userId, chat) {
  const { error } = await need().from('chats').upsert({
    id: chat.id, user_id: userId, title: chat.title || '', draft: chat.draft || '',
    messages: chat.messages, updated_at: new Date(chat.updatedAt || Date.now()).toISOString(),
  }, { onConflict: 'id' });
  if (error) throw new Error(friendly(error));
}
export async function deleteChat(userId, id) {
  const { error } = await need().from('chats').delete().eq('user_id', userId).eq('id', id);
  if (error) throw new Error(friendly(error));
}

/* ---------- вложения в приватном бакете ---------- */
export async function uploadAttachment(userId, attachment) {
  const id = crypto.randomUUID();
  const path = `${userId}/${id}`;
  const { error } = await need().storage.from(BUCKET).upload(path, attachment.file, {
    contentType: attachment.type, cacheControl: '3600', upsert: false,
  });
  if (error) throw new Error(friendly(error));
  return { id, path, name: attachment.name, type: attachment.type, size: attachment.size };
}
const signedCache = new Map();
export async function attachmentUrl(attachment) {
  const path = attachment.path;
  if (!path) return '';
  const cached = signedCache.get(path);
  if (cached && cached.expires > Date.now()) return cached.url;
  const { data, error } = await need().storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error) return '';
  signedCache.set(path, { url: data.signedUrl, expires: Date.now() + 55 * 60 * 1000 });
  return data.signedUrl;
}
// Содержимое для отправки модели: изображения как base64, текст как строка.
export async function attachmentContent(attachment) {
  if (!attachment.path) return null;
  const { data, error } = await need().storage.from(BUCKET).download(attachment.path);
  if (error || !data) return null;
  if (attachment.type.startsWith('image/')) {
    const bytes = new Uint8Array(await data.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { name: attachment.name, mime: attachment.type, base64: btoa(binary), text: null };
  }
  return { name: attachment.name, mime: attachment.type, base64: null, text: (await data.text()).slice(0, 150000) };
}
export async function removeAttachments(paths) {
  if (!paths.length) return;
  await need().storage.from(BUCKET).remove(paths).catch(() => {});
}
