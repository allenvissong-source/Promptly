// 卡片折叠状态的本地持久化。折叠是一种纯 UI 视图偏好（不属于项目数据），
// 因此不进 SQLite，用 localStorage 按卡片 id 记住即可。卡片 id
// （cell/tpl/blk 前缀 + 唯一后缀）在存库/重载后保持稳定，可安全作为 key。
const KEY = 'promptly.collapsedCards';

function readSet(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr as string[]) : new Set();
  } catch {
    return new Set();
  }
}

export function isCardCollapsed(id: string): boolean {
  return readSet().has(id);
}

export function setCardCollapsed(id: string, collapsed: boolean): void {
  const s = readSet();
  if (collapsed) s.add(id);
  else s.delete(id);
  try {
    localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    /* localStorage 不可用时静默降级：本次会话内折叠仍生效，只是不持久化 */
  }
}
