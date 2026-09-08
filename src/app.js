import { loadHistory, saveHistory, normalizeHistory } from './history.js';
import { formatAnswer } from './format.js';
import { ACCOUNT_KEY, normalizeAccount, memoryInstruction } from './account.js';
import { resolveAttachmentType, isImageType, MAX_ATTACHMENTS, MAX_ATTACHMENT_SIZE } from './attachments.js';
import { runChain } from './api.js';
import * as cloud from './cloud.js';

const $ = selector => document.querySelector(selector);
const PROVIDERS_KEY = 'aris.providers.v1';
const body = document.body;
const promptInput = $('#prompt');
const state = $('#assistantState');
const dialog = $('#settings');
const presets = {
  gemini: { name: 'Gemini', model: 'gemini-2.5-flash', baseUrl: '' },
  grok: { name: 'Grok', model: 'grok-4-fast', baseUrl: '' },
  openrouter: { name: 'OpenRouter', model: 'openrouter/auto', baseUrl: '' },
  custom: { name: 'Свой провайдер', model: '', baseUrl: '' },
};
let providers = [];
let draft = [];
let chats = [];
let current = { id: crypto.randomUUID(), messages: [] };
let activeRequest = null;
let recognition = null;
let toastTimer;
let pendingAttachments = [];
let account = normalizeAccount();
let user = null;
try { account = normalizeAccount(JSON.parse(localStorage.getItem(ACCOUNT_KEY) || '{}')); } catch {}

function icon(name) { return `<svg class="remix-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="src/remix.svg#ri-${name}"></use></svg>`; }
function applyIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
function applyAccount() {
  body.dataset.textSize = account.size; body.classList.toggle('no-motion', !account.animations);
  $('#accountName').textContent = account.name || user?.email || 'Аккаунт';
  $('#accountEmail').textContent = user?.email || '';
}
function toast(text) {
  $('#toast').textContent = text;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4200);
}

/* ================= синхронизация с Supabase ================= */
let profilePatch = null;
const dirtyChats = new Map();
let syncTimer = 0;
let syncFailureShown = false;

function mirrorLocally() {
  try { saveHistory(localStorage, chats, current.id); } catch {}
  try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account)); } catch {}
}
function queueProfile(patch) {
  if (!user) return;
  profilePatch = { ...profilePatch, ...patch };
  scheduleSync();
}
function queueChat(chat) {
  if (!user) return;
  dirtyChats.set(chat.id, chat);
  scheduleSync();
}
function scheduleSync(delay = 600) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(flushSync, delay);
}
async function flushSync() {
  if (!user) return;
  const patch = profilePatch; profilePatch = null;
  const pending = [...dirtyChats.values()]; dirtyChats.clear();
  try {
    if (patch) await cloud.saveProfile(user.id, patch);
    for (const chat of pending) await cloud.saveChat(user.id, chat);
    syncFailureShown = false;
    body.classList.remove('sync-error');
  } catch (error) {
    if (patch) profilePatch = { ...patch, ...profilePatch };
    for (const chat of pending) if (!dirtyChats.has(chat.id)) dirtyChats.set(chat.id, chat);
    body.classList.add('sync-error');
    if (!syncFailureShown) { syncFailureShown = true; toast(`Не удалось сохранить в облако: ${error.message}`); }
    scheduleSync(5000);
  }
}
window.addEventListener('beforeunload', () => { if (profilePatch || dirtyChats.size) flushSync(); });

function saveAccount() {
  applyAccount();
  mirrorLocally();
  queueProfile({ account });
  toast('Настройки сохранены');
}
function persistChats() {
  mirrorLocally();
  queueProfile({ currentId: current.id });
}
function rememberCurrent() {
  if (!chats.includes(current)) chats.unshift(current);
  current.updatedAt = Date.now();
  queueChat(current);
  persistChats();
}
function rememberDraft() {
  current.draft = promptInput.value;
  if (current.draft || chats.includes(current)) rememberCurrent();
}
promptInput.addEventListener('input', rememberDraft);

/* ================= экран входа ================= */
const authScreen = $('#authScreen');
let authMode = 'signin';
function setAuthMode(mode) {
  authMode = mode;
  const recovery = mode === 'recovery';
  $('#authTitle').textContent = recovery ? 'Новый пароль' : mode === 'signup' ? 'Создать аккаунт' : 'Вход в ARIS';
  $('#authSubmit').textContent = recovery ? 'Сохранить пароль' : mode === 'signup' ? 'Зарегистрироваться' : 'Войти';
  $('#authSwitch').textContent = mode === 'signup' ? 'Уже есть аккаунт — войти' : 'Нет аккаунта — зарегистрироваться';
  $('#authSwitch').hidden = recovery;
  $('#authForgot').hidden = mode !== 'signin';
  $('#authEmailField').hidden = recovery;
  $('#authError').textContent = '';
  $('#authHint').textContent = recovery ? 'Придумайте пароль не короче 8 символов.' : '';
}
function showAuth(show) {
  authScreen.hidden = !show;
  body.classList.toggle('signed-in', !show);
  if (show) $('#authEmail').focus();
}
$('#authSwitch').onclick = () => setAuthMode(authMode === 'signup' ? 'signin' : 'signup');
$('#authForgot').onclick = async () => {
  const email = $('#authEmail').value.trim();
  if (!email) { $('#authError').textContent = 'Введите почту, на неё придёт ссылка.'; return; }
  try { await cloud.resetPassword(email); $('#authHint').textContent = 'Письмо со ссылкой отправлено.'; $('#authError').textContent = ''; }
  catch (error) { $('#authError').textContent = error.message; }
};
$('#authForm').onsubmit = async event => {
  event.preventDefault();
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const button = $('#authSubmit');
  button.disabled = true;
  $('#authError').textContent = '';
  try {
    if (authMode === 'recovery') {
      await cloud.updatePassword(password);
      history.replaceState(null, '', location.pathname);
      setAuthMode('signin');
      if (user) showAuth(false);
      toast('Пароль обновлён');
    } else if (authMode === 'signup') {
      const data = await cloud.signUp(email, password);
      if (!data.session) { $('#authHint').textContent = 'Проверьте почту и подтвердите адрес, затем войдите.'; setAuthMode('signin'); }
    } else {
      await cloud.signIn(email, password);
    }
    $('#authPassword').value = '';
  } catch (error) {
    $('#authError').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$('#signOut').onclick = async () => {
  await flushSync();
  await cloud.signOut();
};

/* ================= панель чатов и настройки ================= */
function setChats(open) {
  body.classList.toggle('chats-open', open);
  $('#chatPanel').inert = !open;
  $('#chatPanel').setAttribute('aria-hidden', String(!open));
  $('#openChats').setAttribute('aria-expanded', String(open));
  $('.workspace').inert = open;
  $('.topbar').inert = open;
  (open ? $('#closeChats') : $('#openChats')).focus();
}
$('#openChats').onclick = () => setChats(true);
$('#closeChats').onclick = $('#backdrop').onclick = () => setChats(false);
document.addEventListener('keydown', event => {
  if (!body.classList.contains('chats-open')) return;
  if (event.key === 'Escape') setChats(false);
  if (event.key === 'Tab') {
    const buttons = [...$('#chatPanel').querySelectorAll('button')];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

function makeProvider(type = 'custom') {
  return { id: crypto.randomUUID(), type, ...presets[type], keys: [], enabled: true };
}
function openSettings() {
  if (body.classList.contains('chats-open')) setChats(false);
  draft = structuredClone(providers.length ? providers : ['gemini', 'grok', 'openrouter'].map(makeProvider));
  $('#settingsError').textContent = '';
  renderProviders();
  $('#displayName').value = account.name; $('#textSize').value = account.size;
  $('#animations').checked = account.animations; $('#speakAnswers').checked = account.speak;
  $('#memoryEnabled').checked = account.memoryEnabled; $('#memoryNotes').value = account.memory;
  selectAccountTab('connections');
  dialog.showModal();
}
function selectAccountTab(name) {
  document.querySelectorAll('[data-tab]').forEach(el => {
    el.setAttribute('aria-selected', String(el.dataset.tab === name)); el.tabIndex = el.dataset.tab === name ? 0 : -1;
  });
  document.querySelectorAll('[data-pane]').forEach(el => { el.hidden = el.dataset.pane !== name; });
}
document.querySelectorAll('[data-tab]').forEach((el, index, tabs) => {
  el.onclick = () => selectAccountTab(el.dataset.tab);
  el.onkeydown = e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault(); const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.click(); next.focus();
  };
});
$('#appearanceForm').onsubmit = e => {
  e.preventDefault(); Object.assign(account, { name: $('#displayName').value.trim(), size: $('#textSize').value,
    animations: $('#animations').checked, speak: $('#speakAnswers').checked });
  if (!account.speak) window.speechSynthesis?.cancel();
  saveAccount();
};
$('#memoryForm').onsubmit = e => {
  e.preventDefault(); account.memory = $('#memoryNotes').value; account.memoryEnabled = $('#memoryEnabled').checked; saveAccount();
};
$('#openSettings').onclick = openSettings;
$('#closeSettings').onclick = () => dialog.close();
dialog.addEventListener('click', event => { if (event.target === dialog) {
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
} });
dialog.addEventListener('close', () => { draft = []; $('#providerList').replaceChildren(); $('#openChats').focus(); });
$('#addProvider').onclick = () => {
  if (draft.length >= 20) return toast('Можно добавить до 20 провайдеров');
  draft.push(makeProvider()); renderProviders();
  $('#providerList').lastElementChild.querySelector('select').focus();
};
function renderProviders() {
  $('#providerList').replaceChildren();
  draft.forEach((p, index) => {
    const card = document.createElement('section');
    card.className = 'provider-card';
    card.innerHTML = `<div class="provider-heading"><span class="provider-number"></span><select aria-label="Тип провайдера"><option value="gemini">Gemini</option><option value="grok">Grok / xAI</option><option value="openrouter">OpenRouter</option><option value="custom">Свой провайдер</option></select><label class="enable-label"><input type="checkbox" class="enabled"> Вкл.</label><div class="order-actions"><button type="button" data-action="up" aria-label="Переместить вверх">↑</button><button type="button" data-action="down" aria-label="Переместить вниз">↓</button><button type="button" data-action="remove" aria-label="Удалить провайдера">×</button></div></div><div class="provider-fields"><label>Название<input class="provider-name" maxlength="80" required></label><label>Модель<input class="provider-model" placeholder="ID модели из кабинета провайдера" maxlength="200"></label><label class="endpoint-field">Базовый URL API<input class="provider-url" type="url" placeholder="https://api.example.com/v1"><small>Совместимый с OpenAI Chat Completions API. Адрес должен разрешать запросы из браузера (CORS).</small></label></div><label class="keys-label">API-ключи <span class="key-count"></span><textarea class="provider-keys" rows="2" spellcheck="false" autocomplete="off" placeholder="Один ключ на строку"></textarea></label><label class="reveal-label"><input type="checkbox" class="reveal-keys"> Показать ключи</label>`;
    const find = selector => card.querySelector(selector);
    find('.provider-number').textContent = String(index + 1).padStart(2, '0');
    find('select').value = p.type;
    find('select').onchange = event => {
      const type = event.target.value;
      Object.assign(p, presets[type], { type, keys: [] }); renderProviders();
    };
    find('.enabled').checked = p.enabled;
    find('.enabled').onchange = event => { p.enabled = event.target.checked; };
    for (const [selector, field] of [['.provider-name', 'name'], ['.provider-model', 'model'], ['.provider-url', 'baseUrl']]) {
      find(selector).value = p[field];
      find(selector).oninput = event => { p[field] = event.target.value; };
    }
    find('.endpoint-field').hidden = p.type !== 'custom';
    find('.provider-keys').value = p.keys.join('\n');
    const updateKeys = () => {
      p.keys = [...new Set(find('.provider-keys').value.split(/\r?\n/).map(k => k.trim()).filter(Boolean))];
      find('.key-count').textContent = `${p.keys.length} / 30`;
    };
    updateKeys();
    find('.provider-keys').oninput = updateKeys;
    find('.reveal-keys').onchange = event => find('.provider-keys').classList.toggle('revealed', event.target.checked);
    find('[data-action="up"]').disabled = index === 0;
    find('[data-action="down"]').disabled = index === draft.length - 1;
    find('[data-action="up"]').innerHTML = icon('arrow-up-line');
    find('[data-action="down"]').innerHTML = icon('arrow-down-line');
    find('[data-action="remove"]').innerHTML = icon('close-line');
    card.querySelectorAll('[data-action]').forEach(button => { button.onclick = () => {
      const action = button.dataset.action;
      if (action === 'remove') draft.splice(index, 1);
      else { const other = index + (action === 'up' ? -1 : 1); [draft[index], draft[other]] = [draft[other], draft[index]]; }
      renderProviders();
    }; });
    $('#providerList').append(card);
  });
  $('#connectionCount').textContent = `${draft.length} подключений · сверху вниз`;
}
function updateConnectedBadge() {
  const count = providers.filter(p => p.enabled && p.keys.length).length;
  $('#openSettings').classList.toggle('connected', count > 0);
}
$('#settingsForm').onsubmit = event => {
  event.preventDefault();
  for (const p of draft) {
    if (!p.enabled || !p.keys.length) continue;
    if (!p.model.trim() || p.keys.length > 30) { $('#settingsError').textContent = 'Укажите модель и не больше 30 ключей на провайдера.'; return; }
    if (p.type === 'custom') {
      try {
        const url = new URL(p.baseUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
      } catch { $('#settingsError').textContent = 'Укажите HTTPS URL своего API без параметров и пароля.'; return; }
    }
    p.model = p.model.trim(); p.baseUrl = p.baseUrl.trim();
  }
  providers = structuredClone(draft);
  dialog.close();
  try { localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers)); } catch {}
  queueProfile({ providers });
  scheduleSync(0);
  updateConnectedBadge();
  const count = providers.filter(p => p.enabled && p.keys.length).length;
  toast(count ? `Подключения сохранены: ${count}` : 'Добавьте ключи, чтобы начать диалог');
};

/* ================= чаты и сообщения ================= */
function renderChats() {
  $('#chatList').replaceChildren();
  chats.forEach(chat => {
    const button = document.createElement('button');
    button.className = `chat-item${chat === current ? ' selected' : ''}`;
    button.textContent = chat.title || chat.messages.find(m => m.role === 'user')?.content.slice(0, 65) || 'Новый чат';
    button.title = button.textContent;
    button.setAttribute('aria-current', String(chat === current));
    button.onclick = () => {
      stopRequest(); rememberDraft(); current = chat; renderMessages(); promptInput.value = chat.draft || ''; persistChats(); setChats(false); state.textContent = 'ARIS ГОТОВ';
    };
    const row = document.createElement('div'); row.className = 'chat-row';
    const rename = document.createElement('button'); rename.className = 'chat-action'; rename.setAttribute('aria-label', 'Переименовать чат');
    rename.innerHTML = icon('edit-line');
    rename.onclick = () => {
      const name = window.prompt('Название чата', button.textContent);
      if (name === null || !name.trim()) return;
      chat.title = name.trim().slice(0, 100); chat.updatedAt = Date.now(); queueChat(chat); persistChats(); renderChats();
    };
    const remove = document.createElement('button'); remove.className = 'chat-action'; remove.setAttribute('aria-label', 'Удалить чат');
    remove.innerHTML = icon('delete-bin-line');
    remove.onclick = async () => {
      if (!window.confirm(`Удалить чат «${button.textContent}» из истории?`)) return;
      if (current === chat) {
        stopRequest(); current = { id: crypto.randomUUID(), messages: [], draft: '' }; promptInput.value = '';
      }
      chats = chats.filter(item => item !== chat);
      dirtyChats.delete(chat.id);
      const paths = chat.messages.flatMap(m => (m.attachments ?? []).map(a => a.path).filter(Boolean));
      renderMessages(); persistChats();
      if (user) {
        try { await cloud.deleteChat(user.id, chat.id); await cloud.removeAttachments(paths); }
        catch (error) { toast(`Чат не удалён в облаке: ${error.message}`); }
      }
    };
    row.append(button, rename, remove); $('#chatList').append(row);
  });
}
function formatSize(size) {
  if (!Number.isFinite(size)) return '';
  if (size < 1024) return `${size} Б`;
  if (size < 1048576) return `${(size / 1024).toFixed(1)} КБ`;
  return `${(size / 1048576).toFixed(1)} МБ`;
}
function addAttachmentLinks(message) {
  if (!message.attachments?.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'message-attachments';
  for (const a of message.attachments) {
    const link = document.createElement('a');
    link.className = `attachment ${isImageType(a.type) ? 'image' : 'file'}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    // Бакет приватный: ссылка подписывается на час и обновляется при отрисовке.
    cloud.attachmentUrl(a).then(url => { if (url) { link.href = url; const img = link.querySelector('img'); if (img) img.src = url; } });
    if (isImageType(a.type)) {
      const img = document.createElement('img');
      img.alt = a.name; img.loading = 'lazy';
      link.append(img);
    } else {
      link.setAttribute('download', a.name);
      const fileIcon = document.createElement('span'); fileIcon.className = 'attachment-icon'; fileIcon.innerHTML = icon('file-line');
      const label = document.createElement('span'); label.className = 'attachment-name'; label.textContent = a.name;
      const size = document.createElement('small'); size.textContent = formatSize(a.size);
      link.append(fileIcon, label, size);
    }
    wrap.append(link);
  }
  return wrap;
}
function addBubble(message) {
  const el = document.createElement('article');
  el.className = `message ${message.role === 'assistant' ? 'assistant-message' : 'user-message'}`;
  if (message.role === 'assistant') {
    const label = document.createElement('span'); label.className = 'message-label';
    label.textContent = 'ARIS'; el.append(label);
  }
  const attachmentsNode = addAttachmentLinks(message);
  if (attachmentsNode) el.append(attachmentsNode);
  const content = document.createElement('div'); content.className = 'answer-content';
  if (message.role === 'assistant' && !message.error) content.innerHTML = formatAnswer(message.content);
  else content.textContent = message.content;
  el.append(content);
  if (message.role === 'assistant' && !message.error && message.content) {
    const copy = document.createElement('button'); copy.className = 'copy-answer'; copy.innerHTML = icon('file-copy-line'); copy.setAttribute('aria-label', 'Скопировать ответ');
    copy.onclick = async () => { try { await navigator.clipboard.writeText(message.content); toast('Ответ скопирован'); } catch { toast('Браузер не разрешил копирование'); } };
    el.append(copy);
  }
  if (message.error) {
    el.classList.add('error-message'); el.querySelector('.message-label').textContent = 'ОШИБКИ ПОДКЛЮЧЕНИЯ';
    const settingsButton = document.createElement('button'); settingsButton.className = 'primary-button';
    settingsButton.textContent = 'Настроить подключения'; settingsButton.onclick = openSettings; el.append(settingsButton);
  }
  $('#messages').append(el);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return el;
}
function renderMessages() {
  $('#messages').replaceChildren();
  current.messages.forEach(addBubble);
  body.classList.toggle('conversation-started', current.messages.length > 0);
  renderChats();
}
function setBusy(busy) {
  body.classList.toggle('requesting', busy);
  $('.send-button').setAttribute('aria-label', busy ? 'Остановить ответ' : 'Отправить сообщение');
  $('.send-button').title = busy ? 'Остановить ответ' : 'Отправить сообщение';
  $('#messages').setAttribute('aria-busy', String(busy));
}
function stopRequest() { activeRequest?.abort(); activeRequest = null; const session = recognition; recognition = null; session?.abort(); setBusy(false); window.speechSynthesis?.cancel(); body.classList.remove('speaking', 'listening'); }
function newChat() {
  rememberDraft();
  stopRequest(); recognition?.stop(); current = { id: crypto.randomUUID(), messages: [] };
  rememberCurrent();
  renderMessages(); promptInput.value = ''; state.textContent = 'ARIS ГОТОВ';
  if (body.classList.contains('chats-open')) setChats(false);
  promptInput.focus();
}
$('.new-chat').onclick = $('.add-button').onclick = newChat;
$('.wordmark').onclick = event => { event.preventDefault(); newChat(); };

/* ================= вложения ================= */
const fileInput = $('#fileInput');
const attachmentTray = $('#attachmentTray');
$('#attachButton').onclick = () => fileInput.click();
fileInput.onchange = () => { addAttachments([...fileInput.files]); fileInput.value = ''; };
function addAttachments(list) {
  for (const file of list) {
    const type = resolveAttachmentType(file.name, file.type);
    if (!type) { toast(`«${file.name}»: поддерживаются изображения и текстовые файлы.`); continue; }
    if (file.size > MAX_ATTACHMENT_SIZE) { toast(`«${file.name}» больше 8 МБ.`); continue; }
    if (pendingAttachments.length >= MAX_ATTACHMENTS) { toast('Не больше 4 вложений на сообщение.'); break; }
    if (pendingAttachments.some(a => a.name === file.name && a.size === file.size)) continue;
    pendingAttachments.push({ file, name: file.name, type, size: file.size,
      preview: isImageType(type) ? URL.createObjectURL(file) : null });
  }
  renderAttachmentTray();
}
function removeAttachment(index) {
  const [removed] = pendingAttachments.splice(index, 1);
  if (removed?.preview) URL.revokeObjectURL(removed.preview);
  renderAttachmentTray();
}
function clearAttachments() {
  for (const a of pendingAttachments) if (a.preview) URL.revokeObjectURL(a.preview);
  pendingAttachments = [];
  renderAttachmentTray();
}
function renderAttachmentTray() {
  attachmentTray.replaceChildren();
  attachmentTray.hidden = !pendingAttachments.length;
  pendingAttachments.forEach((a, index) => {
    const chip = document.createElement('span'); chip.className = 'attachment-chip';
    if (a.preview) {
      const img = document.createElement('img'); img.src = a.preview; img.alt = '';
      chip.append(img);
    } else {
      const fileIcon = document.createElement('span'); fileIcon.className = 'attachment-icon'; fileIcon.innerHTML = icon('file-line');
      chip.append(fileIcon);
    }
    const name = document.createElement('span'); name.className = 'chip-name'; name.textContent = a.name;
    const remove = document.createElement('button'); remove.type = 'button';
    remove.setAttribute('aria-label', `Убрать файл ${a.name}`); remove.innerHTML = icon('close-line');
    remove.onclick = () => removeAttachment(index);
    chip.append(name, remove);
    attachmentTray.append(chip);
  });
}
// Перетаскивание файлов прямо в окно.
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); body.classList.add('dropping'); } });
document.addEventListener('dragleave', event => { if (!event.relatedTarget) body.classList.remove('dropping'); });
document.addEventListener('drop', event => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault(); body.classList.remove('dropping');
  addAttachments([...event.dataTransfer.files]);
});

/* ================= отправка сообщения ================= */
$('#composer').onsubmit = async event => {
  event.preventDefault();
  if (activeRequest) { stopRequest(); state.textContent = 'Запрос остановлен'; return; }
  const text = promptInput.value.trim();
  if (!text) return promptInput.focus();
  if (!user) { showAuth(true); return; }
  const configured = providers.filter(p => p.enabled && p.keys.length);
  if (!configured.length) { openSettings(); return; }
  recognition?.stop();
  let uploaded = [];
  if (pendingAttachments.length) {
    state.textContent = 'Загружаю вложения…';
    try { uploaded = await Promise.all(pendingAttachments.map(a => cloud.uploadAttachment(user.id, a))); }
    catch (error) {
      state.textContent = 'ARIS ГОТОВ';
      toast(`Не удалось загрузить вложения: ${error.message}`);
      return;
    }
    clearAttachments();
  }
  const lastTurn = current.messages.filter(m => !m.error).at(-1);
  if (lastTurn?.role !== 'user' || lastTurn.content !== text) {
    current.messages.push(uploaded.length ? { role: 'user', content: text, attachments: uploaded } : { role: 'user', content: text });
  }
  current.draft = ''; rememberCurrent();
  renderMessages(); promptInput.value = '';
  const pending = addBubble({ role: 'assistant', content: '' });
  pending.classList.add('pending');
  pending.lastElementChild.innerHTML = '<span class="thinking-dots" aria-label="Ожидание ответа"><i></i><i></i><i></i></span>';
  const controller = new AbortController(); activeRequest = controller; setBusy(true);
  let completed = false;
  let failure = '';
  const attemptFailures = [];
  const processEvent = item => {
    if (controller.signal.aborted) return;
    if (item.type === 'attempt') { state.textContent = 'ARIS думает…'; $('#voiceStatus').textContent = 'Обдумываю ответ…'; }
    if (item.type === 'failure') { attemptFailures.push(item); state.textContent = 'Пробую другое подключение…'; }
    if (item.type === 'error') failure = item.message;
    if (item.type === 'done') {
      completed = true; pending.remove();
      const message = { role: 'assistant', content: item.content, provider: item.provider };
      current.messages.push(message); addBubble(message);
      rememberCurrent(); renderChats();
      scheduleSync(0);
      state.textContent = 'ARIS ГОТОВ';
      if (body.classList.contains('voice-mode')) speakReply(item.content);
    }
  };
  try {
    await runChain({
      providers: configured,
      instruction: memoryInstruction(account),
      messages: current.messages.filter(m => !m.error).map(({ role, content, attachments }) => ({ role, content, ...(attachments ? { attachments } : {}) })),
    }, { signal: controller.signal, emit: processEvent, readAttachment: a => cloud.attachmentContent(a) });
    if (!completed) throw new Error(failure || 'Ответ не получен. Попробуйте ещё раз.');
  } catch (error) {
    if (!controller.signal.aborted) {
      state.textContent = error.message;
      toast(state.textContent);
      const diagnosticMessage = { role: 'assistant', error: true, content: attemptFailures.length
        ? attemptFailures.map(f => `${f.provider} · ${f.model || ''} · ключ ${f.key}\n${f.reason}`).join('\n\n')
        : state.textContent };
      current.messages.push(diagnosticMessage); addBubble(diagnosticMessage);
      state.textContent = 'Ответ не получен — подробности в чате';
      $('#voiceStatus').textContent = 'Не удалось получить ответ. Подробности — в текстовом чате.';
      if (!promptInput.value) promptInput.value = text;
      rememberDraft();
    }
  } finally {
    pending.remove();
    if (activeRequest === controller) { activeRequest = null; setBusy(false); }
  }
};

/* ================= голосовой режим ================= */
function setMode(voice) {
  const session = recognition; recognition = null; session?.abort(); window.speechSynthesis?.cancel();
  body.classList.remove('listening', 'speaking');
  body.classList.toggle('voice-mode', voice);
  document.querySelectorAll('.mode').forEach(item => {
    const active = (item.dataset.mode === 'voice') === voice;
    item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active));
  });
  $('.voice-stage').hidden = !voice; $('.assistant').inert = voice;
  $('#voiceStatus').textContent = activeRequest ? 'Обдумываю ответ…' : 'Нажмите на микрофон, чтобы начать';
  if (!activeRequest) state.textContent = 'ARIS ГОТОВ';
}
function speakReply(text) {
  $('#voiceTranscript').textContent = text;
  $('#voiceStatus').textContent = 'Ответ готов. Нажмите микрофон, чтобы продолжить';
  if (!account.speak || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.replace(/```[\s\S]*?```/g, ' Блок кода доступен в чате. ').replace(/[*#`]/g, ''));
  utterance.lang = 'ru-RU';
  utterance.onstart = () => { body.classList.add('speaking'); $('#voiceStatus').textContent = 'ARIS говорит…'; };
  utterance.onend = () => { body.classList.remove('speaking'); $('#voiceStatus').textContent = 'Слушаю вас — нажмите микрофон'; };
  utterance.onerror = () => { body.classList.remove('speaking'); $('#voiceStatus').textContent = 'Озвучивание недоступно. Ответ показан на экране'; };
  window.speechSynthesis.speak(utterance);
}
function startListening() {
  if (recognition) { recognition.stop(); return; }
  if (activeRequest) return toast('Дождитесь ответа или остановите запрос');
  if (!providers.some(p => p.enabled && p.keys.length)) { openSettings(); return; }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $('#voiceStatus').textContent = 'Голосовой ввод недоступен в этом браузере. Откройте ARIS в Chrome или Edge либо вернитесь к тексту.';
    return;
  }
  window.speechSynthesis?.cancel(); body.classList.remove('speaking');
  const session = new SpeechRecognition(); recognition = session;
  session.lang = 'ru-RU'; session.interimResults = true;
  let finalText = '';
  session.onstart = () => {
    body.classList.add('listening'); $('#voiceStatus').textContent = 'Говорите, я слушаю…';
    $('#voiceListen').setAttribute('aria-label', 'Завершить голосовой ввод');
  };
  session.onresult = event => {
    let preview = '';
    for (let i = 0; i < event.results.length; i++) {
      preview += event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText = preview;
    }
    $('#voiceTranscript').textContent = preview;
  };
  session.onerror = event => {
    finalText = '';
    $('#voiceStatus').textContent = event.error === 'not-allowed' ? 'Разрешите доступ к микрофону в браузере' : 'Не удалось распознать речь. Попробуйте ещё раз';
  };
  session.onend = () => {
    if (recognition !== session) return;
    recognition = null; body.classList.remove('listening');
    $('#voiceListen').setAttribute('aria-label', 'Начать голосовой ввод');
    if (finalText.trim() && body.classList.contains('voice-mode')) {
      promptInput.value = finalText.trim(); rememberDraft(); $('#composer').requestSubmit();
    }
  };
  try { session.start(); } catch { recognition = null; $('#voiceStatus').textContent = 'Микрофон недоступен'; }
}
document.querySelectorAll('.mode').forEach(button => {
  button.setAttribute('aria-pressed', String(button.classList.contains('active')));
  button.onclick = () => setMode(button.dataset.mode === 'voice');
});
$('#micButton').onclick = () => { setMode(true); startListening(); };
$('#voiceListen').onclick = startListening;
$('#voiceCancel').onclick = () => {
  const session = recognition; recognition = null; session?.abort(); stopRequest();
  body.classList.remove('listening'); $('#voiceStatus').textContent = 'Разговор остановлен. Можно начать снова';
};
$('#backToText').onclick = () => setMode(false);
function syncViewport() {
  document.documentElement.style.setProperty('--viewport-height', `${window.visualViewport?.height || window.innerHeight}px`);
}
window.visualViewport?.addEventListener('resize', syncViewport);
window.addEventListener('resize', syncViewport); syncViewport();

/* ================= загрузка данных ================= */
function localSnapshot() {
  try {
    const local = loadHistory(localStorage);
    const localProviders = JSON.parse(localStorage.getItem(PROVIDERS_KEY) || '[]');
    return { chats: local.chats, currentId: local.currentId, providers: Array.isArray(localProviders) ? localProviders : [],
      account: normalizeAccount(JSON.parse(localStorage.getItem(ACCOUNT_KEY) || '{}')) };
  } catch { return { chats: [], currentId: null, providers: [], account: normalizeAccount() }; }
}
function adopt(data) {
  const saved = normalizeHistory({ version: 1, chats: data.chats ?? [], currentId: data.currentId ?? null });
  chats = saved.chats;
  current = chats.find(chat => chat.id === saved.currentId) || chats[0] || { id: crypto.randomUUID(), messages: [] };
  promptInput.value = current.draft || '';
}
async function loadUserData() {
  const [profile, cloudChats] = await Promise.all([cloud.loadProfile(user.id), cloud.loadChats(user.id)]);
  account = profile.account;
  providers = profile.providers;
  adopt({ chats: cloudChats, currentId: profile.currentId });
  // Первый вход на новом аккаунте: забираем то, что осталось в этом браузере.
  if (!profile.exists && !cloudChats.length) {
    const local = localSnapshot();
    if (local.chats.length || local.providers.length) {
      account = local.account; providers = local.providers;
      adopt(local);
      for (const chat of chats) queueChat(chat);
      queueProfile({ account, providers, currentId: current.id });
      scheduleSync(0);
      toast('Локальные данные перенесены в облако');
    } else {
      queueProfile({ account, providers, currentId: current.id });
    }
  }
  renderMessages(); applyAccount(); updateConnectedBadge();
  state.textContent = 'ARIS ГОТОВ';
}
function resetToGuest() {
  chats = []; providers = []; current = { id: crypto.randomUUID(), messages: [] };
  account = normalizeAccount(); promptInput.value = '';
  renderMessages(); applyAccount(); updateConnectedBadge();
}
async function boot() {
  if (!cloud.configured) {
    showAuth(true);
    $('#authError').textContent = 'Не заданы параметры Supabase: заполните src/config.js (SUPABASE_URL и SUPABASE_ANON_KEY).';
    $('#authForm').querySelectorAll('input, button').forEach(el => { el.disabled = true; });
    return;
  }
  if (location.hash.includes('type=recovery')) setAuthMode('recovery'); else setAuthMode('signin');
  cloud.onAuthChange(async session => {
    const nextUser = session?.user ?? null;
    if (nextUser?.id === user?.id) return;
    user = nextUser;
    if (!user) { resetToGuest(); showAuth(true); setAuthMode('signin'); return; }
    // После перехода по ссылке восстановления сначала просим задать новый пароль.
    showAuth(authMode === 'recovery');
    state.textContent = 'Загружаю ваши данные…';
    try { await loadUserData(); }
    catch (error) { toast(`Не удалось загрузить данные: ${error.message}`); adopt(localSnapshot()); renderMessages(); }
  });
  const session = await cloud.getSession();
  if (!session) showAuth(true);
}

applyAccount(); applyIcons();
for (const [selector, name] of [['#openChats','chat-3-line'],['.add-button','add-line'],['#attachButton','attachment-line'],['#micButton','mic-line'],['.send-button','arrow-up-line'],['#closeChats','close-line']]) {
  const button = $(selector); const svg = button.querySelector('svg');
  if (svg) svg.outerHTML = icon(name); else button.innerHTML = icon(name);
}
$('.new-chat').innerHTML = icon('add-line') + ' Новый чат';
$('#addProvider').innerHTML = icon('add-line') + ' Добавить провайдера';
boot();
