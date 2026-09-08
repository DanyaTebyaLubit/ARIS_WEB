// Цепочка провайдеров прямо из браузера: ключ уходит только на адрес своего провайдера.
import { ATTACHMENT_TYPES, MAX_ATTACHMENTS, MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS_TOTAL } from './attachments.js';

const endpoints = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  grok: 'https://api.x.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};
const providerTypes = ['gemini', 'grok', 'openrouter', 'custom'];
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function normalizeProviderList(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Некорректный список провайдеров.');
  return value.map((p, index) => {
    if (!p || !providerTypes.includes(p.type) || typeof p.model !== 'string' || p.model.length > 200 ||
        !Array.isArray(p.keys) || p.keys.length > 30 || p.keys.some(k => typeof k !== 'string' || k.length > 4096 || /[\r\n]/.test(k)) ||
        (p.baseUrl !== undefined && (typeof p.baseUrl !== 'string' || p.baseUrl.length > 2000))) {
      throw new Error(`Некорректное подключение №${index + 1}.`);
    }
    if (p.type === 'custom') checkCustomUrl(p.baseUrl);
    return {
      id: typeof p.id === 'string' && p.id.length <= 64 ? p.id : crypto.randomUUID(),
      type: p.type,
      name: typeof p.name === 'string' ? p.name.slice(0, 80) : p.type,
      model: p.model.trim(),
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '',
      keys: [...new Set(p.keys.map(k => k.trim()).filter(Boolean))].slice(0, 30),
      enabled: p.enabled !== false,
    };
  });
}

function checkCustomUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Проверьте URL своего провайдера.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('URL провайдера должен быть HTTPS без пароля, параметров и фрагмента.');
  }
}

function validateAttachments(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ATTACHMENTS) {
    throw new Error(`Можно приложить от 1 до ${MAX_ATTACHMENTS} вложений на сообщение.`);
  }
  let total = 0;
  const seen = new Set();
  for (const a of value) {
    if (!a || !ATTACHMENT_ID.test(a.id || '') || seen.has(a.id) || typeof a.name !== 'string' || !a.name.trim() || a.name.length > 120 ||
        !ATTACHMENT_TYPES.includes(a.type) || !Number.isFinite(a.size) || a.size < 1 || a.size > MAX_ATTACHMENT_SIZE) {
      throw new Error('Некорректное вложение.');
    }
    seen.add(a.id);
    total += a.size;
  }
  if (total > MAX_ATTACHMENTS_TOTAL) throw new Error('Суммарный размер вложений превышает 16 МБ.');
}

export function validatePayload(data) {
  if (!data || !Array.isArray(data.providers) || data.providers.length > 20 ||
      !Array.isArray(data.messages) || !data.messages.length || data.messages.length > 200) {
    throw new Error('Некорректная конфигурация или слишком длинный диалог.');
  }
  if (data.instruction !== undefined && (typeof data.instruction !== 'string' || data.instruction.length > 10000)) throw new Error('Слишком длинные заметки памяти.');
  for (const m of data.messages) {
    if (!['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 50000) {
      throw new Error('Некорректное сообщение.');
    }
    if (m.attachments !== undefined) validateAttachments(m.attachments);
  }
  const providers = data.providers.filter(p => p && p.enabled !== false);
  if (!providers.length) throw new Error('Добавьте и включите хотя бы одного провайдера.');
  for (const p of providers) {
    if (!providerTypes.includes(p.type) || typeof p.model !== 'string' || !p.model.trim() || p.model.length > 200 ||
        !Array.isArray(p.keys) || !p.keys.length || p.keys.length > 30 ||
        p.keys.some(k => typeof k !== 'string' || !k.trim() || k.length > 4096 || /[\r\n]/.test(k))) {
      throw new Error('Укажите модель и от 1 до 30 ключей для каждого включённого провайдера.');
    }
    if (p.type === 'custom') checkCustomUrl(p.baseUrl);
  }
  return providers;
}

// Вложения в диалоге хранятся метаданными; содержимое скачивается из Storage один раз на запрос.
async function resolveAttachments(messages, readAttachment) {
  if (!messages.some(m => m.attachments?.length)) return messages;
  const cache = new Map();
  return Promise.all(messages.map(async m => {
    if (!m.attachments?.length) return m;
    const files = [];
    for (const a of m.attachments) {
      if (!cache.has(a.id)) cache.set(a.id, await Promise.resolve(readAttachment ? readAttachment(a) : null).catch(() => null));
      const found = cache.get(a.id);
      files.push(found ? { name: a.name, mime: a.type, text: found.text ?? null, base64: found.base64 ?? null } : { name: a.name, missing: true });
    }
    return { ...m, files };
  }));
}

const geminiParts = m => {
  const parts = [{ text: m.content }];
  for (const f of m.files ?? []) {
    if (f.missing) parts.push({ text: `[Вложение «${f.name}» недоступно]` });
    else if (f.text != null) parts.push({ text: `\n\n--- Файл: ${f.name} ---\n${f.text}` });
    else parts.push({ inline_data: { mime_type: f.mime, data: f.base64 } });
  }
  return parts;
};

const openAiMessage = m => {
  const files = m.files ?? [];
  const notes = files.filter(f => f.missing).map(f => `\n\n[Вложение «${f.name}» недоступно]`);
  const text = [m.content, ...notes,
    ...files.filter(f => !f.missing && f.text != null).map(f => `\n\n--- Файл: ${f.name} ---\n${f.text}`)].join('');
  const images = files.filter(f => !f.missing && f.text == null)
    .map(f => ({ type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.base64}` } }));
  if (!images.length) return { role: m.role, content: text };
  return { role: m.role, content: [{ type: 'text', text }, ...images] };
};

export function buildRequest(provider, key, messages, instruction = '') {
  const base = (endpoints[provider.type] || provider.baseUrl).replace(/\/+$/, '');
  if (provider.type === 'gemini') {
    return {
      url: `${base}/models/${encodeURIComponent(provider.model)}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ ...(instruction ? { systemInstruction: { parts: [{ text: instruction }] } } : {}),
        contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: geminiParts(m) })) }),
    };
  }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (provider.type === 'openrouter') { headers['HTTP-Referer'] = location.origin; headers['X-Title'] = 'ARIS'; }
  return {
    url: `${base}/chat/completions`,
    headers,
    body: JSON.stringify({ model: provider.model,
      messages: instruction ? [{ role: 'system', content: instruction }, ...messages.map(openAiMessage)] : messages.map(openAiMessage),
      max_tokens: 2048,
      stream: false }),
  };
}

export function explainFailure(status, payload, secrets = []) {
  const raw = typeof payload?.error === 'string' ? payload.error : payload?.error?.message || payload?.message || '';
  let detail = typeof raw === 'string' ? raw : '';
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) detail = detail.split(secret).join('[ключ скрыт]');
  detail = detail.replace(/Bearer\s+\S+|AIza[\w-]+|sk-[\w-]+/gi, '[ключ скрыт]').replace(/[\r\n\t]+/g, ' ').slice(0, 450);
  const keyError = /api.?key|credential|unauthenticated|authentication|invalid.*token/i.test(raw);
  const hints = {
    400: keyError ? 'API-ключ отклонён' : 'Провайдер отклонил параметры запроса',
    401: 'API-ключ недействителен или отозван',
    402: 'Недостаточно средств на API-балансе',
    403: 'Нет доступа: проверьте разрешения ключа, модель и регион',
    404: 'Модель или адрес API не найдены',
    405: 'Неверный адрес API или неподдерживаемый метод',
    429: 'Превышен лимит запросов или исчерпана квота',
  };
  return {
    reason: `HTTP ${status}: ${hints[status] || (status >= 500 ? 'Сбой на стороне провайдера' : 'Запрос отклонён')}${detail ? `. ${detail}` : ''}`,
    skipKeys: [404, 405, 422].includes(status) || (status === 400 && !keyError),
  };
}

export async function runChain(data, { signal, emit = () => {}, fetchImpl = fetch, timeoutMs = 45000, readAttachment = null } = {}) {
  const providers = validatePayload(data);
  const messages = await resolveAttachments(data.messages, readAttachment);
  const failures = [];
  const secrets = providers.flatMap(p => p.keys.map(k => k.trim()));
  const report = event => { failures.push(event); emit(event); };
  for (const [index, p] of providers.entries()) {
    const keys = [...new Set(p.keys.map(k => k.trim()))];
    for (const [keyIndex, key] of keys.entries()) {
      signal?.throwIfAborted();
      const label = typeof p.name === 'string' ? p.name.slice(0, 80) : p.type;
      emit({ type: 'attempt', provider: label, key: keyIndex + 1, position: index + 1 });
      try {
        const request = buildRequest(p, key, messages, data.instruction || '');
        const attemptSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
        const response = await fetchImpl(request.url, {
          method: 'POST', headers: request.headers, body: request.body, signal: attemptSignal, redirect: 'error', mode: 'cors',
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          const failure = explainFailure(response.status, payload, secrets);
          report({ type: 'failure', provider: label, model: p.model, key: keyIndex + 1, reason: failure.reason });
          if (failure.skipKeys) break;
          continue;
        }
        const result = await response.json();
        const content = p.type === 'gemini'
          ? result.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('')
          : result.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          report({ type: 'failure', provider: label, model: p.model, key: keyIndex + 1,
            reason: 'Провайдер вернул пустой ответ. Возможны ограничение содержимого или неподдерживаемый формат ответа.' });
          break;
        }
        const done = { type: 'done', content, provider: label, model: p.model };
        emit(done);
        return done;
      } catch (error) {
        signal?.throwIfAborted();
        // В браузере сетевой отказ и блокировка CORS выглядят одинаково: TypeError без деталей.
        const reason = error?.name === 'TimeoutError' ? `Истекло время ожидания ответа (${Math.round(timeoutMs / 1000)} секунд)`
          : error instanceof SyntaxError ? 'API вернул некорректный JSON'
          : error?.name === 'TypeError' ? 'Браузер не смог отправить запрос: провайдер не разрешает обращения со страницы (CORS) либо нет сети. Такой провайдер требует своего прокси.'
          : 'Не удалось связаться с API. Проверьте сеть и доступность адреса.';
        report({ type: 'failure', provider: label, model: p.model, key: keyIndex + 1, reason });
      }
    }
  }
  const summary = failures.slice(-4).map(f => `${f.provider} · ${f.model} · ключ ${f.key}: ${f.reason}`).join('\n');
  emit({ type: 'error', message: `Не удалось получить ответ.\n${summary}`, failures });
  return null;
}
