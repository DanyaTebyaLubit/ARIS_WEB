import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAnswer } from '../src/format.js';
import { normalizeAccount, memoryInstruction } from '../src/account.js';
import { buildRequest } from '../api.mjs';
test('answers format headings, lists and code while escaping injected HTML', () => {
  const html = formatAnswer('# Заголовок\n\n**Текст**\n\n- Один\n- Два\n\n```js\n<script>alert(1)</script>\n```\n<img src=x onerror=alert(1)>');
  assert.match(html, /<h2>Заголовок<\/h2>/); assert.match(html, /<strong>Текст<\/strong>/);
  assert.match(html, /<ul><li>Один<\/li><li>Два<\/li><\/ul>/);
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;script&gt;/);
});
test('memory is off by default and only explicitly enabled notes are sent', () => {
  assert.equal(memoryInstruction(normalizeAccount({memory:'Private note'})), '');
  const instruction = memoryInstruction(normalizeAccount({memory:'Отвечай кратко',memoryEnabled:true}));
  const messages = [{ role: 'user', content: 'Привет' }];
  const gemini = JSON.parse(buildRequest({type:'gemini',model:'test'},'k',messages,instruction).body);
  assert.match(gemini.systemInstruction.parts[0].text, /Отвечай кратко/);
  const other = JSON.parse(buildRequest({type:'openrouter',model:'test'},'k',messages,instruction).body);
  assert.equal(other.messages[0].role, 'system'); assert.deepEqual(other.messages[1],messages[0]);
  assert.equal(JSON.parse(buildRequest({type:'gemini',model:'test'},'k',messages).body).systemInstruction,undefined);
});
