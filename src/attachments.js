// Shared attachment rules for the browser: app.js, history.js, api.js and cloud.js.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/json'];
export const ATTACHMENT_TYPES = [...IMAGE_TYPES, ...TEXT_TYPES];
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_SIZE = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL = 16 * 1024 * 1024;
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Browsers leave the MIME type empty or exotic for plain-text sources; map common extensions onto allowed types.
const EXTENSION_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  csv: 'text/csv', tsv: 'text/csv', json: 'application/json',
  js: 'text/plain', mjs: 'text/plain', cjs: 'text/plain', ts: 'text/plain', py: 'text/plain',
  rb: 'text/plain', java: 'text/plain', c: 'text/plain', cpp: 'text/plain', h: 'text/plain',
  cs: 'text/plain', go: 'text/plain', rs: 'text/plain', sh: 'text/plain', yml: 'text/plain',
  yaml: 'text/plain', xml: 'text/plain', css: 'text/plain', ini: 'text/plain', sql: 'text/plain',
};

export function resolveAttachmentType(name, declaredType) {
  if (ATTACHMENT_TYPES.includes(declaredType)) return declaredType;
  const extension = String(name).split('.').pop()?.toLowerCase() || '';
  return EXTENSION_TYPES[extension] || '';
}

export const isImageType = type => IMAGE_TYPES.includes(type);

export function normalizeAttachmentList(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > MAX_ATTACHMENTS) throw new Error('Invalid attachments');
  const seen = new Set();
  let total = 0;
  const list = value.map(a => {
    if (!a || typeof a !== 'object' || !ATTACHMENT_ID.test(a.id || '') || seen.has(a.id) ||
        typeof a.name !== 'string' || !a.name.trim() || a.name.length > 120 ||
        !ATTACHMENT_TYPES.includes(a.type) ||
        !Number.isFinite(a.size) || a.size < 1 || a.size > MAX_ATTACHMENT_SIZE) {
      throw new Error('Invalid attachment');
    }
    seen.add(a.id);
    total += a.size;
    // path points at the object inside the Supabase Storage bucket: "<userId>/<attachmentId>".
    return { id: a.id, name: a.name, type: a.type, size: a.size,
      ...(typeof a.path === 'string' && a.path.length <= 200 ? { path: a.path } : {}) };
  });
  if (total > MAX_ATTACHMENTS_TOTAL) throw new Error('Attachments too large');
  return list;
}
