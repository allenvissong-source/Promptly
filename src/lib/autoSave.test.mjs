import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_SAVE_ERROR_BACKOFF_MS,
  DEFAULT_AUTO_SAVE_CONFIG,
  DEFAULT_AUTO_SAVE_GUARDS,
  autoSaveStatus,
  createAutoSaveState,
  evaluateAutoSave,
  reduceAutoSave,
} from './autoSave.ts';

// ---- 测试脚手架 -------------------------------------------------------------
// 全部用显式时间戳，不碰真实时钟：状态机是纯函数，时间只是入参。
const T0 = 1_000_000;
const cfg = (patch = {}) => ({ ...DEFAULT_AUTO_SAVE_CONFIG, ...patch });
const guards = (patch = {}) => ({ ...DEFAULT_AUTO_SAVE_GUARDS, ready: true, ...patch });
const feed = (state, events) => events.reduce((s, e) => reduceAutoSave(s, e), state);
// 走完一次完整的保存流程（成功）。
const saveCycle = (state, startAt, doneAt) =>
  feed(state, [
    { type: 'save-start', at: startAt },
    { type: 'save-ok', at: doneAt },
  ]);

// ============================================================================
// 防抖 / 封顶
// ============================================================================

test('防抖：连续变更期间不保存，停手 1500ms 后才触发一次', () => {
  let state = createAutoSaveState();
  // 每 300ms 敲一下，连敲 5 次。
  for (let i = 0; i < 5; i += 1) {
    state = reduceAutoSave(state, { type: 'change', at: T0 + i * 300 });
    const mid = evaluateAutoSave(state, guards(), cfg(), T0 + i * 300);
    assert.equal(mid.action, 'wait', `第 ${i} 次变更当刻不该保存`);
    assert.equal(mid.reason, 'debounce');
  }
  const last = T0 + 4 * 300;
  // 停手 1499ms：仍在防抖窗口内。
  assert.equal(evaluateAutoSave(state, guards(), cfg(), last + 1499).action, 'wait');
  // 停手 1500ms：落库。
  const due = evaluateAutoSave(state, guards(), cfg(), last + 1500);
  assert.equal(due.action, 'save');
  assert.equal(due.reason, 'idle');

  // 且只触发一次：保存成功后回到 clean，同一时刻再问也不存。
  state = saveCycle(state, last + 1500, last + 1520);
  assert.equal(evaluateAutoSave(state, guards(), cfg(), last + 1520).action, 'none');
  assert.equal(evaluateAutoSave(state, guards(), cfg(), last + 1520).reason, 'clean');
});

test('防抖窗口内的每次变更都会把 due 往后推（真防抖，不是节流）', () => {
  let state = reduceAutoSave(createAutoSaveState(), { type: 'change', at: T0 });
  const first = evaluateAutoSave(state, guards(), cfg(), T0 + 1000);
  assert.equal(first.dueInMs, 500);
  // 1000ms 时又敲了一下 -> due 重新变成 1500ms 之后。
  state = reduceAutoSave(state, { type: 'change', at: T0 + 1000 });
  assert.equal(evaluateAutoSave(state, guards(), cfg(), T0 + 1000).dueInMs, 1500);
});

test('封顶：一直不停手，从第一次变脏起 30s 强制触发一次', () => {
  let state = createAutoSaveState();
  // 每 500ms 敲一次，敲满 30s：空闲防抖永远不满足。
  for (let t = 0; t < 30000; t += 500) {
    state = reduceAutoSave(state, { type: 'change', at: T0 + t });
    const d = evaluateAutoSave(state, guards(), cfg(), T0 + t);
    if (t < 30000) assert.equal(d.action, 'wait', `t=${t} 不该保存`);
  }
  // 第一次变脏是 T0，T0+30000 时封顶生效。
  state = reduceAutoSave(state, { type: 'change', at: T0 + 30000 });
  const capped = evaluateAutoSave(state, guards(), cfg(), T0 + 30000);
  assert.equal(capped.action, 'save');
  assert.equal(capped.reason, 'cap');
});

test('封顶计时从「本轮第一次变脏」起算，保存成功后重新开始', () => {
  let state = reduceAutoSave(createAutoSaveState(), { type: 'change', at: T0 });
  state = saveCycle(state, T0 + 1500, T0 + 1600);
  assert.equal(state.dirtySince, null);
  // 新一轮：T0+20000 才变脏，那么封顶要等到 T0+50000。
  state = reduceAutoSave(state, { type: 'change', at: T0 + 20000 });
  assert.equal(evaluateAutoSave(state, guards(), cfg(), T0 + 40000).action, 'save'); // 已过防抖
  assert.equal(state.dirtySince, T0 + 20000);
});

// ============================================================================
// flush：跳过防抖
// ============================================================================

test('flush 事件跳过防抖立即触发（卡片增删 / 拖拽结束 / 切项目前 / 关窗前 / 失焦）', () => {
  let state = reduceAutoSave(createAutoSaveState(), { type: 'change', at: T0 });
  assert.equal(evaluateAutoSave(state, guards(), cfg(), T0).action, 'wait');
  state = reduceAutoSave(state, { type: 'flush', at: T0 });
  const d = evaluateAutoSave(state, guards(), cfg(), T0);
  assert.equal(d.action, 'save');
  assert.equal(d.reason, 'flush');
});

test('无脏不写：flush 也不例外，clean 状态下一个 DB 调用都不发', () => {
  const state = reduceAutoSave(createAutoSaveState(), { type: 'flush', at: T0 });
  const d = evaluateAutoSave(state, guards(), cfg(), T0);
  assert.equal(d.action, 'none');
  assert.equal(d.reason, 'clean');
});

test('无脏不写：hydrate 完成但用户没动过任何东西 -> 不保存', () => {
  const state = createAutoSaveState();
  assert.equal(evaluateAutoSave(state, guards(), cfg(), T0).reason, 'clean');
  assert.equal(evaluateAutoSave(state, guards(), cfg(), T0 + 60000).reason, 'clean');
});

// ============================================================================
// 单飞 + 尾随重跑
// ============================================================================

test('单飞：飞行中不重入，即使又脏了 / 又来了 flush', () => {
  let state = reduceAutoSave(createAutoSaveState(), { type: 'change', at: T0 });
  state = reduceAutoSave(state, { type: 'save-start', at: T0 + 1500 });
  state = reduceAutoSave(state, { type: 'change', at: T0 + 1600 });
  state = reduceAutoSave(state, { type: 'flush', at: T0 + 1700 });
  const d = evaluateAutoSave(state, guards(), cfg(), T0 + 1700);
  assert.equal(d.action, 'none');
  assert.equal(d.reason, 'in-flight');
});

test('尾随重跑：飞行中产生的新变更导致写完后立刻再跑一次', () => {
  let state = reduceAutoSave(createAutoSaveState(), { type: 'change', at: T0 });
  state = reduceAutoSave(state, { type: 'save-start', at: T0 + 1500 });
  state = reduceAutoSave(state, { type: 'change', at: T0 + 1600 });
  assert.equal(state.changedDuringSave, true);
  state = reduceAutoSave(state, { type: 'save-ok', at: T0 + 1700 });
  // 写完仍然脏，且不需要再等一个防抖周期。
  assert.equal(state.dirty, true);
  const rerun = evaluateAutoSave(state, guards(), cfg(), T0 + 1700);
  assert.equal(rerun.action, 'save');
  assert.equal(rerun.reason, 'flush');
  // 第二趟写完没有新变更 -> 收敛，不再无限重跑。
  state = saveCycle(state, T0 + 1700, T0 + 1800);
  assert.equal(state.dirty, false);
  assert.equal(evaluateAutoSave(state, guards(), cfg(), T0 + 1800).action, 'none');
});

test('飞行期间没有新变更 -> 写完即 clean，不重跑', () => {
  let state = reduceAutoSave(createAutoSaveState(), { type: 'change', at: T0 });
  state = saveCycle(state, T0 + 1500, T0 + 1600);
  assert.equal(state.dirty, false);
  assert.equal(state.changedDuringSave, false);
  assert.equal(evaluateAutoSave(state, guards(), cfg(), T0 + 1600).reason, 'clean');
});

// ============================================================================
// 守卫位：hydrate 未完成 / 拖拽中 / 组字中 / 还原中 / 总开关
// ============================================================================

// 这条是整个改造里最重要的一条：hydrate 没完成时内存是「空的初始态」，
// 写下去等于一秒清空用户项目。
test('⚠️ hydrate 未完成 + 有脏 -> 绝不保存', () => {
  let state = reduceAutoSave(createAutoSaveState(), { type: 'change', at: T0 });
  const notReady = guards({ ready: false });
  // 防抖早就过了，封顶也过了，还带着 flush 请求 —— 依然不许保存。
  state = reduceAutoSave(state, { type: 'flush', at: T0 });
  for (const now of [T0, T0 + 1500, T0 + 30000, T0 + 600000]) {
    const d = evaluateAutoSave(state, notReady, cfg(), now);
    assert.equal(d.action, 'none', `now=${now} 竟然放行了保存`);
    assert.equal(d.reason, 'not-ready');
  }
  // hydrate 完成后（flush 请求仍在）才允许落库。
  assert.equal(evaluateAutoSave(state, guards(), cfg(), T0 + 1500).action, 'save');
});

test('ready 守卫优先于 flush：切项目瞬间的 flush 请求不会写进新项目', () => {
  // 新项目刚 setActiveProjectId、三个 store 还在 load 中：ready=false。
  const state = feed(createAutoSaveState(), [
    { type: 'change', at: T0 },
    { type: 'flush', at: T0 + 1 },
  ]);
  assert.equal(evaluateAutoSave(state, guards({ ready: false }), cfg(), T0 + 5).reason, 'not-ready');
});

test('拖拽中暂停保存，拖拽结束后（flush）才落库', () => {
  let state = reduceAutoSave(createAutoSaveState(), { type: 'change', at: T0 });
  const dragging = guards({ dragging: true });
  // 连防抖到期、封顶到期都压住。
  assert.equal(evaluateAutoSave(state, dragging, cfg(), T0 + 1500).reason, 'dragging');
  assert.equal(evaluateAutoSave(state, dragging, cfg(), T0 + 40000).reason, 'dragging');
  // drop：拖拽位解除 + flush -> 立即保存。
  state = reduceAutoSave(state, { type: 'flush', at: T0 + 2000 });
  assert.equal(evaluateAutoSave(state, guards(), cfg(), T0 + 2000).action, 'save');
});

test('输入法组字中暂停保存，组字结束后按正常防抖落库', () => {
  const state = reduceAutoSave(createAutoSaveState(), { type: 'change', at: T0 });
  const composing = guards({ composing: true });
  assert.equal(evaluateAutoSave(state, composing, cfg(), T0 + 1500).reason, 'composing');
  assert.equal(evaluateAutoSave(state, composing, cfg(), T0 + 40000).reason, 'composing');
  assert.equal(evaluateAutoSave(state, guards(), cfg(), T0 + 1500).action, 'save');
});

test('快照还原进行中暂停保存，避免把内存旧态写回去', () => {
  const state = reduceAutoSave(createAutoSaveState(), { type: 'change', at: T0 });
  assert.equal(
    evaluateAutoSave(state, guards({ restoring: true }), cfg(), T0 + 40000).reason,
    'restoring'
  );
});

test('总开关关闭：调度器完全不自发保存', () => {
  const state = feed(createAutoSaveState(), [
    { type: 'change', at: T0 },
    { type: 'flush', at: T0 },
  ]);
  const d = evaluateAutoSave(state, guards(), cfg({ enabled: false }), T0 + 40000);
  assert.equal(d.action, 'none');
  assert.equal(d.reason, 'disabled');
});

test('自定义间隔（设置里的 5 秒档）生效', () => {
  const state = reduceAutoSave(createAutoSaveState(), { type: 'change', at: T0 });
  assert.equal(evaluateAutoSave(state, guards(), cfg({ idleMs: 5000 }), T0 + 1500).action, 'wait');
  assert.equal(evaluateAutoSave(state, guards(), cfg({ idleMs: 5000 }), T0 + 5000).action, 'save');
});

// ============================================================================
// 失败处理：dirty 保持 + 冷却重试
// ============================================================================

test('保存失败：dirty 保持 true，冷却后自动重试', () => {
  let state = reduceAutoSave(createAutoSaveState(), { type: 'change', at: T0 });
  state = reduceAutoSave(state, { type: 'save-start', at: T0 + 1500 });
  state = reduceAutoSave(state, { type: 'save-fail', at: T0 + 1600 });
  assert.equal(state.dirty, true, '失败必须保持 dirty，否则用户改动就丢了');
  assert.equal(state.lastError, true);
  // 冷却期内不热重试。
  const cooling = evaluateAutoSave(state, guards(), cfg(), T0 + 1600);
  assert.equal(cooling.action, 'wait');
  assert.equal(cooling.reason, 'error-backoff');
  // 冷却结束后重试。
  const retry = evaluateAutoSave(state, guards(), cfg(), T0 + 1600 + AUTO_SAVE_ERROR_BACKOFF_MS);
  assert.equal(retry.action, 'save');
});

test('保存失败后再次成功：错误态清除', () => {
  let state = feed(createAutoSaveState(), [
    { type: 'change', at: T0 },
    { type: 'save-start', at: T0 + 1500 },
    { type: 'save-fail', at: T0 + 1600 },
  ]);
  assert.equal(autoSaveStatus(state), 'error');
  state = saveCycle(state, T0 + 7000, T0 + 7100);
  assert.equal(state.lastError, false);
  assert.equal(state.dirty, false);
  assert.equal(autoSaveStatus(state), 'saved');
});

// ============================================================================
// reset（切项目 / 还原后重新 hydrate）
// ============================================================================

test('reset：切项目后脏位与计时清零，不会把旧项目的脏位带到新项目', () => {
  let state = feed(createAutoSaveState(), [
    { type: 'change', at: T0 },
    { type: 'flush', at: T0 },
  ]);
  state = reduceAutoSave(state, { type: 'reset' });
  assert.equal(state.dirty, false);
  assert.equal(state.flushRequested, false);
  assert.equal(state.dirtySince, null);
  assert.equal(evaluateAutoSave(state, guards(), cfg(), T0 + 60000).reason, 'clean');
});

// ============================================================================
// UI 四态
// ============================================================================

test('UI 四态映射：未保存 / 保存中 / 已保存 / 保存失败', () => {
  let state = createAutoSaveState();
  assert.equal(autoSaveStatus(state), 'clean');
  state = reduceAutoSave(state, { type: 'change', at: T0 });
  assert.equal(autoSaveStatus(state), 'dirty');
  state = reduceAutoSave(state, { type: 'save-start', at: T0 + 1500 });
  assert.equal(autoSaveStatus(state), 'saving');
  state = reduceAutoSave(state, { type: 'save-ok', at: T0 + 1600 });
  assert.equal(autoSaveStatus(state), 'saved');
  assert.equal(state.lastSavedAt, T0 + 1600);
  state = reduceAutoSave(state, { type: 'change', at: T0 + 2000 });
  assert.equal(autoSaveStatus(state), 'dirty', '再次编辑回到未保存态');
});

test('保存中优先于错误态显示（重试的那一刻显示保存中）', () => {
  const state = feed(createAutoSaveState(), [
    { type: 'change', at: T0 },
    { type: 'save-start', at: T0 + 1500 },
    { type: 'save-fail', at: T0 + 1600 },
    { type: 'save-start', at: T0 + 7000 },
  ]);
  assert.equal(autoSaveStatus(state), 'saving');
});
