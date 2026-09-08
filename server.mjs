import http from 'node:http';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { runChain, validatePayload } from './api.mjs';
import { readState, updateState, saveAttachment, readAttachment, loadAttachmentContent, pruneAttachments } from './store.mjs';
import { MAX_ATTACHMENTS_TOTAL } from './src/attachments.js';

const port = Number(process.env.PORT || 3000);
const chatLimit = 32 * 1024 * 1024; // base64 attachments inflate uploads well past the old 1 MB text cap
const stateLimit = 16 * 1024 * 1024;
const files = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/styles/ui.css', ['styles/ui.css', 'text/css']], ['/styles/main.css', ['styles/main.css', 'text/css']],
  ['/styles/app.css', ['styles/app.css', 'text/css']], ['/src/app.js', ['src/app.js', 'text/javascript']],
  ['/src/A.svg', ['src/A.svg', 'image/svg+xml']],
  ['/src/history.js', ['src/history.js', 'text/javascript']],
  ['/src/attachments.js', ['src/attachments.js', 'text/javascript']],
  ['/src/format.js', ['src/format.js', 'text/javascript']],
  ['/src/account.js', ['src/account.js', 'text/javascript']],
  ['/src/remix.svg', ['src/remix.svg', 'image/svg+xml']],
  ['/styles/account.css', ['styles/account.css', 'text/css']],
]);
// Local subnet only: localhost plus every LAN address of this machine. Strangers on the internet stay out.
function allowedHosts() {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) hosts.add(`${ni.address}:${port}`);
  }
  return hosts;
}
function sameOrigin(req) {
  if (!req.headers.origin) return false;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Слишком большой запрос.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const json = (res, code, payload) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
};
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (!allowedHosts().has(req.headers.host)) { res.writeHead(403).end(); return; }
  const route = req.url?.split('?')[0];
  try {
    if (route === '/api/health' && req.method === 'GET') {
      json(res, 200, { service: 'aris-api', version: 2 });
      return;
    }
    if (route === '/api/state' && req.method === 'GET') {
      const state = await readState();
      json(res, 200, state
        ? { initialized: true, account: state.account, providers: state.providers,
            chats: state.history.chats, currentId: state.history.currentId }
        : { initialized: false, account: null, providers: [], chats: [], currentId: null });
      return;
    }
    if (route === '/api/state' && req.method === 'PUT') {
      if (!sameOrigin(req) || !req.headers['content-type']?.startsWith('application/json')) { res.writeHead(403).end(); return; }
      const patch = JSON.parse((await readBody(req, stateLimit)).toString('utf8') || '{}');
      const allowed = ['account', 'providers', 'chats', 'currentId'].filter(key => key in patch);
      await updateState(Object.fromEntries(allowed.map(key => [key, patch[key]])));
      json(res, 200, { ok: true });
      return;
    }
    if (route === '/api/attachments' && req.method === 'POST') {
      if (!sameOrigin(req)) { res.writeHead(403).end(); return; }
      const body = await readBody(req, MAX_ATTACHMENTS_TOTAL);
      const name = (() => { try { return decodeURIComponent(req.headers['x-file-name'] || ''); } catch { return ''; } })();
      const meta = await saveAttachment(body, { name, type: req.headers['x-file-type'] });
      json(res, 200, meta);
      return;
    }
    const fileMatch = route?.match(/^\/api\/files\/([0-9a-f-]{36})$/);
    if (fileMatch && req.method === 'GET') {
      const found = await readAttachment(fileMatch[1]);
      if (!found) { res.writeHead(404).end(); return; }
      const inline = found.meta.type.startsWith('image/');
      res.writeHead(200, {
        'Content-Type': `${found.meta.type}; charset=utf-8`,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(found.meta.name)}`,
      });
      res.end(found.buffer);
      return;
    }
    if (route === '/api/chat' && req.method === 'POST') {
      if (!sameOrigin(req) || !req.headers['content-type']?.startsWith('application/json')) {
        res.writeHead(403).end(); return;
      }
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      try {
        const data = JSON.parse((await readBody(req, chatLimit)).toString('utf8'));
        validatePayload(data);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
        res.flushHeaders();
        await runChain(data, { signal: controller.signal, readAttachment: loadAttachmentContent, emit: event => {
          if (!res.destroyed) res.write(JSON.stringify(event) + '\n');
        } });
        res.end();
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!res.headersSent) {
          res.writeHead(error.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ message: error instanceof SyntaxError ? 'Некорректный JSON.' : error.message }));
        } else res.end(JSON.stringify({ type: 'error', message: 'Не удалось завершить запрос.' }) + '\n');
      }
      return;
    }
    const file = files.get(route);
    if (req.method !== 'GET' || !file) { res.writeHead(404).end(); return; }
    const content = await readFile(new URL(file[0], import.meta.url));
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
    res.end(content);
  } catch (error) {
    if (!res.headersSent) json(res, error.statusCode || 500, { message: error.message || 'Внутренняя ошибка сервера.' });
    else res.end();
  }
});
server.listen(port, () => {
  const addresses = [`http://localhost:${port}`];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) addresses.push(`http://${ni.address}:${port}`);
  }
  console.log(`ARIS: ${addresses[0]}`);
  if (addresses.length > 1) console.log(`ARIS в локальной сети: ${addresses.slice(1).join('  ')}`);
});
pruneAttachments().catch(() => {});
