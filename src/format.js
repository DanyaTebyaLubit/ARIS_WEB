const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function inline(text) {
  return text.split(/(`[^`]+`)/g).map(part => part.startsWith('`')
    ? `<code>${escape(part.slice(1, -1))}</code>`
    : escape(part).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>')).join('');
}
export function formatAnswer(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n'); const out = [];
  let paragraph = [], list = null, code = null;
  const flush = () => { if (paragraph.length) { out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    if (line.startsWith('```')) {
      flush(); closeList();
      if (code !== null) { out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`); code = null; }
      else code = [];
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    const item = line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)$/);
    if (item) {
      flush(); const type = item[1] ? 'ul' : 'ol';
      if (list !== type) { closeList(); out.push(`<${type}>`); list = type; }
      out.push(`<li>${inline(item[2])}</li>`); continue;
    }
    closeList();
    if (heading) { flush(); const level = Number(heading[1].length) + 1; out.push(`<h${level}>${inline(heading[2])}</h${level}>`); }
    else if (/^>\s?/.test(line)) { flush(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); }
    else if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush(); closeList();
  if (code !== null) out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
  return out.join('');
}
