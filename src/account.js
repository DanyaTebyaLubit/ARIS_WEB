export const ACCOUNT_KEY = 'aris.account.v1';
export function normalizeAccount(value = {}) {
  value = value || {};
  return { name: typeof value.name === 'string' ? value.name.slice(0, 60) : '',
    size: ['small', 'normal', 'large'].includes(value.size) ? value.size : 'normal',
    animations: value.animations !== false, speak: value.speak !== false,
    memoryEnabled: value.memoryEnabled === true, memory: typeof value.memory === 'string' ? value.memory.slice(0, 8000) : '' };
}
export function memoryInstruction(account) {
  return account.memoryEnabled && account.memory.trim()
    ? `Пожелания и факты пользователя, которые нужно учитывать при ответе:\n${account.memory.trim()}` : '';
}
