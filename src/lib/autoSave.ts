// ============================================================================
// 自动保存调度器的纯状态机
//
// 「什么时候该落库」的全部判断都放在这里：没有 React / Database / 计时器依赖，
// 输入是「事件 + 时间戳 + 脏标记 + 守卫位」，输出是「现在存 / 等 N 毫秒再看 /
// 不用存」。所以可以被 node 内置 test runner 直接跑（autoSave.test.mjs）。
//
// 薄 hook（useAutoSave）只负责：把 React 世界的变更/守卫翻译成事件、按 decision
// 起计时器、真正调用三个 store 的 save()。任何「要不要写」的判断都不许写在 hook
// 里，否则就没法测了。
//
// ⚠️ 数据安全第一原则：guards.ready === false（项目还没 hydrate 完）时，无论多脏、
// 无论有没有 flush 请求，evaluateAutoSave 一律不返回 save。因为此刻内存里是「空的
// 初始态」，写下去等于一秒清空用户项目。这条守卫的优先级高于 flush。
// ============================================================================

export interface AutoSaveConfig {
  // 总开关（设置项，默认开）。关掉后调度器不再自发保存，Ctrl+S 手动保存不受影响。
  enabled: boolean;
  // 空闲防抖：停手多久后落库。
  idleMs: number;
  // 连续编辑封顶：一直不停手也至少每 maxWaitMs 落一次。
  maxWaitMs: number;
  // 保存失败后的冷却时间：避免「失败 -> 立刻重试 -> 又失败」打满 CPU / 日志。
  errorBackoffMs: number;
}

export const AUTO_SAVE_IDLE_MS_DEFAULT = 1500;
export const AUTO_SAVE_MAX_WAIT_MS = 30000;
export const AUTO_SAVE_ERROR_BACKOFF_MS = 5000;

export const DEFAULT_AUTO_SAVE_CONFIG: AutoSaveConfig = {
  enabled: true,
  idleMs: AUTO_SAVE_IDLE_MS_DEFAULT,
  maxWaitMs: AUTO_SAVE_MAX_WAIT_MS,
  errorBackoffMs: AUTO_SAVE_ERROR_BACKOFF_MS,
};

// 暂停位。全部为「瞬时状态」：解除时由 hook 主动重新 kick 一次，不需要轮询。
export interface AutoSaveGuards {
  // 三个 store 都已 hydrate 完成，且 hydrate 的就是当前项目。
  ready: boolean;
  // 拖拽进行中（卡片排序 / 素材拖入 / 槽位排序）。
  dragging: boolean;
  // 输入法组字中（compositionstart -> compositionend）。
  composing: boolean;
  // 快照还原进行中：内存里还是旧态，绝不能写回去。
  restoring: boolean;
}

export const DEFAULT_AUTO_SAVE_GUARDS: AutoSaveGuards = {
  ready: false,
  dragging: false,
  composing: false,
  restoring: false,
};

export interface AutoSaveState {
  // 内存比库新。三个 store 的 dirty 是各自独立的，这里是「或」之后的总脏位。
  dirty: boolean;
  // 本轮第一次变脏的时刻，用于 30s 封顶。保存成功后清空。
  dirtySince: number | null;
  // 最后一次变更的时刻，用于空闲防抖。
  lastChangeAt: number | null;
  // 有「跳过防抖立即存」的请求（卡片增删 / 拖拽结束 / 切项目前 / 关窗前 / 失焦）。
  flushRequested: boolean;
  // 单飞：有一次保存流程正在飞行中。
  saving: boolean;
  // 飞行期间又发生了变更 -> 写完要再跑一次（尾随重跑）。
  changedDuringSave: boolean;
  // 最近一次保存成功的时刻（UI 显示「已保存 HH:MM」）。
  lastSavedAt: number | null;
  // 最近一次保存是否失败（UI 显示「保存失败」；dirty 保持 true 等重试）。
  lastError: boolean;
  // 失败冷却截止时刻。
  retryNotBefore: number | null;
}

export function createAutoSaveState(): AutoSaveState {
  return {
    dirty: false,
    dirtySince: null,
    lastChangeAt: null,
    flushRequested: false,
    saving: false,
    changedDuringSave: false,
    lastSavedAt: null,
    lastError: false,
    retryNotBefore: null,
  };
}

export type AutoSaveEvent =
  // 内存发生了变更（已确认三个 store 里至少一个是脏的）。
  | { type: 'change'; at: number }
  // 要求跳过防抖立即保存。
  | { type: 'flush'; at: number }
  // 保存流程开始 / 结束。由 hook 在真正调用 save() 前后派发。
  | { type: 'save-start'; at: number }
  | { type: 'save-ok'; at: number }
  | { type: 'save-fail'; at: number }
  // 切项目 / 还原后重新 hydrate：脏位与计时全部清零（新项目的内存态还没被改过）。
  | { type: 'reset' };

export function reduceAutoSave(
  state: AutoSaveState,
  event: AutoSaveEvent,
  config: AutoSaveConfig = DEFAULT_AUTO_SAVE_CONFIG
): AutoSaveState {
  switch (event.type) {
    case 'change': {
      if (state.saving) {
        // 飞行中的 save() 写的是它启动那一刻的内存快照，之后的改动它带不走，
        // 所以标记尾随重跑，dirty 保持 true。
        return {
          ...state,
          dirty: true,
          changedDuringSave: true,
          dirtySince: state.dirtySince ?? event.at,
          lastChangeAt: event.at,
        };
      }
      return {
        ...state,
        dirty: true,
        dirtySince: state.dirtySince ?? event.at,
        lastChangeAt: event.at,
      };
    }
    case 'flush':
      // 无脏不写：flush 也不例外（evaluateAutoSave 里判 dirty），这里只记请求。
      return { ...state, flushRequested: true };
    case 'save-start':
      // 请求已被这次保存消化掉；尾随标记重新开始计。
      return { ...state, saving: true, flushRequested: false, changedDuringSave: false };
    case 'save-ok': {
      if (state.changedDuringSave) {
        // 尾随重跑：立刻再存一次（置 flushRequested 而不是等 1500ms 防抖），
        // 否则用户停手后这批改动要多等一个防抖周期才落库。
        return {
          ...state,
          saving: false,
          changedDuringSave: false,
          dirty: true,
          flushRequested: true,
          dirtySince: event.at,
          lastChangeAt: event.at,
          lastSavedAt: event.at,
          lastError: false,
          retryNotBefore: null,
        };
      }
      return {
        ...state,
        saving: false,
        dirty: false,
        dirtySince: null,
        lastChangeAt: null,
        changedDuringSave: false,
        lastSavedAt: event.at,
        lastError: false,
        retryNotBefore: null,
      };
    }
    case 'save-fail':
      // 失败：dirty 保持 true（下一轮调度会重试），进入冷却避免热循环。
      return {
        ...state,
        saving: false,
        dirty: true,
        changedDuringSave: false,
        dirtySince: state.dirtySince ?? event.at,
        lastChangeAt: state.lastChangeAt ?? event.at,
        lastError: true,
        retryNotBefore: event.at + config.errorBackoffMs,
      };
    case 'reset':
      return { ...createAutoSaveState(), lastSavedAt: state.lastSavedAt };
    default:
      return state;
  }
}

export type AutoSaveBlockReason =
  | 'disabled'
  | 'not-ready'
  | 'in-flight'
  | 'clean'
  | 'restoring'
  | 'dragging'
  | 'composing'
  | 'error-backoff'
  | 'debounce';

export type AutoSaveDecision =
  // 现在就存。
  | { action: 'save'; reason: 'flush' | 'cap' | 'idle' }
  // 现在不存，dueInMs 毫秒后再来问一次（防抖 / 失败冷却）。
  | { action: 'wait'; dueInMs: number; reason: AutoSaveBlockReason }
  // 现在不存，也不用起计时器：等对应守卫解除时由 hook 重新 kick。
  | { action: 'none'; reason: AutoSaveBlockReason };

// 纯判断：给定状态 + 守卫 + 配置 + 当前时刻，要不要保存。
//
// 判断顺序即优先级，其中 not-ready 必须排在 dirty / flush 之前 —— 这是「hydrate
// 未完成绝不写库」的守卫点。
export function evaluateAutoSave(
  state: AutoSaveState,
  guards: AutoSaveGuards,
  config: AutoSaveConfig,
  now: number
): AutoSaveDecision {
  if (!config.enabled) return { action: 'none', reason: 'disabled' };
  // 单飞：飞行中一律不重入，写完由 save-ok / save-fail 触发下一轮。
  if (state.saving) return { action: 'none', reason: 'in-flight' };
  // ⚠️ 最高优先级：项目数据还没 hydrate 完（或 hydrate 的不是当前项目）。
  if (!guards.ready) return { action: 'none', reason: 'not-ready' };
  if (guards.restoring) return { action: 'none', reason: 'restoring' };
  // 无脏不写：一个 DB 调用都不发。
  if (!state.dirty) return { action: 'none', reason: 'clean' };
  if (guards.dragging) return { action: 'none', reason: 'dragging' };
  if (guards.composing) return { action: 'none', reason: 'composing' };
  if (state.retryNotBefore != null && now < state.retryNotBefore) {
    return { action: 'wait', dueInMs: state.retryNotBefore - now, reason: 'error-backoff' };
  }
  if (state.flushRequested) return { action: 'save', reason: 'flush' };
  // 连续编辑封顶：一直不停手也要落一次。
  const capDue = state.dirtySince == null ? Infinity : state.dirtySince + config.maxWaitMs;
  if (now >= capDue) return { action: 'save', reason: 'cap' };
  // 空闲防抖：停手 idleMs 之后落库。
  const idleDue = state.lastChangeAt == null ? now : state.lastChangeAt + config.idleMs;
  if (now >= idleDue) return { action: 'save', reason: 'idle' };
  return {
    action: 'wait',
    dueInMs: Math.max(0, Math.min(idleDue, capDue) - now),
    reason: 'debounce',
  };
}

// UI 四态：未保存 / 保存中… / 已保存 HH:MM / 保存失败。
export type AutoSaveStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'error';

export function autoSaveStatus(state: AutoSaveState): AutoSaveStatus {
  if (state.saving) return 'saving';
  if (state.lastError) return 'error';
  if (state.dirty) return 'dirty';
  if (state.lastSavedAt != null) return 'saved';
  return 'clean';
}
