import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useProject } from './ProjectContext';
import { useGenSettings } from './GenSettingsContext';
import { useGenStore } from './GenStoreContext';
import { useGenTemplateStore } from './GenTemplateStoreContext';
import { useBlockStore } from './BlockStoreContext';
import { useDrag } from './DragContext';
import {
  AUTO_SAVE_ERROR_BACKOFF_MS,
  AUTO_SAVE_MAX_WAIT_MS,
  autoSaveStatus,
  createAutoSaveState,
  evaluateAutoSave,
  reduceAutoSave,
  type AutoSaveConfig,
  type AutoSaveEvent,
  type AutoSaveGuards,
  type AutoSaveState,
  type AutoSaveStatus,
} from '../lib/autoSave';
import {
  createProjectSnapshot,
  pruneProjectSnapshots,
  restoreProjectSnapshot,
  type ProjectSnapshotMeta,
} from '../lib/db';

// ============================================================================
// 自动保存编排层（薄 hook）
//
// 所有「要不要保存」的判断都在 lib/autoSave.ts 的纯状态机里，这里只做四件事：
//  1. 把 React 世界的信号翻译成事件：内容变更 / flush 触发源 / 守卫位变化；
//  2. 按 decision 起一个 setTimeout（参考 PanelLayoutContext 的手写防抖）；
//  3. 真正调用三个 store 的 save() —— 串行 await，绝不 Promise.all（并发写会让
//     指纹 SELECT 撞 SQLITE_BUSY，虽然会安全退化成全量但白写一遍）；
//  4. 打开项目时抓一份 reason='open' 的快照，并提供「还原到本次打开时的状态」。
//
// 事务粒度保持改造前的行为：3 个独立事务（每区域一个 execute_batch），区域内原子、
// 跨区域不原子，本次刻意不合并成一个大事务。
//
// ⚠️ 两条数据安全红线：
//  - hydrate 未完成绝不写：ready 门闸 = 三个 store 的 hydratedProjectId 都等于
//    当前 activeProjectId；状态机里 not-ready 的优先级高于 flush。
//  - 切项目不串项目：flush 在 activeProjectId 改变之前跑（ProjectContext 的
//    registerBeforeProjectSwitch 会 await），且 save(expectProjectId) 在 store
//    内部用「实际 hydrate 的项目 id」二次校验，不一致直接拒写。
// ============================================================================

interface AutoSaveContextValue {
  // UI 四态：未保存 / 保存中… / 已保存 HH:MM / 保存失败。
  status: AutoSaveStatus;
  lastSavedAt: number | null;
  // 立即保存（跳过防抖）。Ctrl+S / 关窗前都走它。
  // 返回值 = 「保存后已经没有未落库的改动」，由状态机的 ref 同步读出（不依赖
  // React 重渲染），所以关窗流程可以直接拿它决定要不要弹二次确认。
  saveNow: () => Promise<boolean>;
  // 本次打开该项目时抓的那份快照，供「还原到本次打开时的状态」使用。
  openSnapshot: ProjectSnapshotMeta | null;
  // 还原成功返回 droppedSlots（因素材已被删除而丢弃的图片槽位数）；没有可用快照
  // 时返回 null。
  restoreOpenSnapshot: () => Promise<{ droppedSlots: number } | null>;
  restoring: boolean;
}

const AutoSaveContext = createContext<AutoSaveContextValue | null>(null);

export function useAutoSave(): AutoSaveContextValue {
  const ctx = useContext(AutoSaveContext);
  if (!ctx) throw new Error('useAutoSave must be used within AutoSaveProvider');
  return ctx;
}

export function AutoSaveProvider({ children }: { children: ReactNode }) {
  const {
    activeProjectId,
    registerBeforeProjectSwitch,
    registerProjectDiscard,
    reloadActiveProject,
    refreshProjects,
  } = useProject();
  const { autoSaveEnabled, autoSaveIntervalMs } = useGenSettings();
  const {
    cells,
    dirty: genDirty,
    hydratedProjectId: genHydrated,
    save: saveGen,
    markSaved: markGenSaved,
  } = useGenStore();
  const {
    templates,
    dirty: tplDirty,
    hydratedProjectId: tplHydrated,
    save: saveTpl,
    markSaved: markTplSaved,
  } = useGenTemplateStore();
  const {
    blocks,
    dirty: blkDirty,
    hydratedProjectId: blkHydrated,
    save: saveBlk,
    markSaved: markBlkSaved,
  } = useBlockStore();
  const { dragPayload } = useDrag();

  // 状态机的状态放 ref（调度本身不需要重渲染），只把 UI 关心的部分同步到 state。
  const stateRef = useRef<AutoSaveState>(createAutoSaveState());
  const [status, setStatus] = useState<AutoSaveStatus>('clean');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const timerRef = useRef<number | null>(null);
  // 飞行中的那次保存（单飞）。saveNow / 切项目 flush 需要 await 它。
  const inFlightRef = useRef<Promise<void> | null>(null);

  // 三个 store 的 dirty 各自独立，这里取「或」当总脏位。
  const anyDirty = genDirty || tplDirty || blkDirty;

  // ---- ready 门闸 ---------------------------------------------------------
  // 三个 store 各自独立 hydrate，必须「全部完成、且 hydrate 的都是当前项目」才算
  // ready。任一没对上 -> 状态机一律拒绝保存。
  const ready =
    activeProjectId != null &&
    genHydrated === activeProjectId &&
    tplHydrated === activeProjectId &&
    blkHydrated === activeProjectId;

  // ---- 暂停位 -------------------------------------------------------------
  // 拖拽：素材拖入用 DragContext 的 dragPayload；卡片/槽位排序走 useCardReorder
  // （铁律禁止改动），所以额外在 window 上用「按下后移动超过 5px」识别拖拽手势
  // （与 DragContext 的阈值一致）。纯点击不算拖拽，不会误触发 flush。
  const [pointerDragging, setPointerDragging] = useState(false);
  const [composing, setComposing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // 还原的同步副本：还原一开始就要挡住任何 kick，等不到 setState 生效。
  const restoringRef = useRef(false);

  const guardsRef = useRef<AutoSaveGuards>({
    ready: false,
    dragging: false,
    composing: false,
    restoring: false,
  });
  guardsRef.current = {
    ready,
    dragging: dragPayload != null || pointerDragging,
    composing,
    restoring: restoring || restoringRef.current,
  };

  const configRef = useRef<AutoSaveConfig>({
    enabled: autoSaveEnabled,
    idleMs: autoSaveIntervalMs,
    maxWaitMs: AUTO_SAVE_MAX_WAIT_MS,
    errorBackoffMs: AUTO_SAVE_ERROR_BACKOFF_MS,
  });
  configRef.current = {
    enabled: autoSaveEnabled,
    idleMs: autoSaveIntervalMs,
    maxWaitMs: AUTO_SAVE_MAX_WAIT_MS,
    errorBackoffMs: AUTO_SAVE_ERROR_BACKOFF_MS,
  };

  // store 的 save / markSaved 用 ref 拿，避免调度闭包过期。
  const savesRef = useRef({ saveGen, saveTpl, saveBlk });
  savesRef.current = { saveGen, saveTpl, saveBlk };
  const marksRef = useRef({ markGenSaved, markTplSaved, markBlkSaved });
  marksRef.current = { markGenSaved, markTplSaved, markBlkSaved };

  const syncUi = useCallback(() => {
    setStatus(autoSaveStatus(stateRef.current));
    setLastSavedAt(stateRef.current.lastSavedAt);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // kick 与 dispatch 互相引用，用 ref 打破环。
  const kickRef = useRef<() => void>(() => {});

  const dispatch = useCallback(
    (event: AutoSaveEvent) => {
      stateRef.current = reduceAutoSave(stateRef.current, event, configRef.current);
      syncUi();
      kickRef.current();
    },
    [syncUi]
  );

  // ---- 真正的写库：串行 await 三个区域，把 projectId 一路传下去校验 --------
  // 已删除的项目集合：删掉之后绝不能再写它（详见 registerProjectDiscard）。
  const discardedRef = useRef<Set<number>>(new Set());

  const performSave = useCallback(
    (projectId: number): Promise<void> => {
      const run = (async () => {
        dispatch({ type: 'save-start', at: Date.now() });
        try {
          const { saveGen: g, saveTpl: t, saveBlk: b } = savesRef.current;
          await g(projectId);
          await t(projectId);
          await b(projectId);
          dispatch({ type: 'save-ok', at: Date.now() });
        } catch (err) {
          // 三个 store 的 save() 已各自 console.error 过；这里只推进状态机，
          // dirty 保持 true，UI 显示「保存失败」，冷却后自动重试。
          console.error('Save failed', err);
          dispatch({ type: 'save-fail', at: Date.now() });
        } finally {
          inFlightRef.current = null;
        }
      })();
      inFlightRef.current = run;
      return run;
    },
    [dispatch]
  );

  // 调度一轮：问状态机要不要存，然后照做。
  const kick = useCallback(() => {
    clearTimer();
    const decision = evaluateAutoSave(
      stateRef.current,
      guardsRef.current,
      configRef.current,
      Date.now()
    );
    if (decision.action === 'wait') {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        kickRef.current();
      }, Math.max(0, decision.dueInMs));
      return;
    }
    if (decision.action !== 'save') return;
    // ready 已保证 activeProjectId 与三个 store hydrate 的项目一致。
    if (activeProjectId == null) return;
    if (discardedRef.current.has(activeProjectId)) return;
    void performSave(activeProjectId);
  }, [activeProjectId, clearTimer, performSave]);
  kickRef.current = kick;

  // ---- 变更信号 -----------------------------------------------------------
  // Tiptap 的 onUpdate 每次按键都会更新 state，所以三个数组的身份变化即「变更」。
  // hydrate 阶段的 setState 也会走到这里，但那时 anyDirty=false（store 在 hydrate
  // 时把 dirty 清了），所以不会被误当成用户改动。
  useEffect(() => {
    if (!ready || !anyDirty) return;
    dispatch({ type: 'change', at: Date.now() });
  }, [cells, templates, blocks, ready, anyDirty, dispatch]);

  // 结构性变更（卡片增删 / 图片槽位增删）跳过防抖立即落库。用「容器数 + 槽位数」
  // 签名识别：增删一定改变计数；纯排序不改计数，由拖拽结束的 flush 覆盖。
  const structureKey = useMemo(() => {
    const slots = (arr: { images: unknown[] }[]) =>
      arr.reduce((sum, item) => sum + item.images.length, 0);
    return [
      cells.length,
      slots(cells),
      templates.length,
      slots(templates),
      blocks.length,
      slots(blocks),
    ].join(':');
  }, [cells, templates, blocks]);
  const lastStructureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) {
      lastStructureRef.current = null;
      return;
    }
    if (lastStructureRef.current == null) {
      // hydrate 后的第一帧：只记基线，不算变更。
      lastStructureRef.current = structureKey;
      return;
    }
    if (lastStructureRef.current === structureKey) return;
    lastStructureRef.current = structureKey;
    if (!anyDirty) return;
    dispatch({ type: 'flush', at: Date.now() });
  }, [structureKey, ready, anyDirty, dispatch]);

  // 守卫位 / 配置变化（含 ready 翻转、拖拽结束、组字结束）后重问一次：
  // 暂停解除时要立刻接上，不用轮询。
  useEffect(() => {
    kickRef.current();
  }, [
    ready,
    pointerDragging,
    composing,
    restoring,
    dragPayload,
    autoSaveEnabled,
    autoSaveIntervalMs,
  ]);

  // 切项目：脏位与计时清零（新项目的内存态还没被用户改过）。
  useEffect(() => {
    clearTimer();
    stateRef.current = reduceAutoSave(stateRef.current, { type: 'reset' }, configRef.current);
    syncUi();
  }, [activeProjectId, clearTimer, syncUi]);

  // ---- flush 触发源：拖拽结束 / 窗口失焦；以及组字暂停位 -----------------
  const flush = useCallback(() => {
    dispatch({ type: 'flush', at: Date.now() });
  }, [dispatch]);

  useEffect(() => {
    let down: { x: number; y: number } | null = null;
    let moved = false;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
      moved = false;
    };
    const onMove = (e: PointerEvent) => {
      if (!down || moved) return;
      if (Math.abs(e.clientX - down.x) > 5 || Math.abs(e.clientY - down.y) > 5) {
        moved = true;
        setPointerDragging(true);
      }
    };
    const onUp = () => {
      down = null;
      if (!moved) return;
      moved = false;
      setPointerDragging(false);
      // drop：拖拽结束立即落库，排序结果不等防抖。
      flush();
    };
    const onCompositionStart = () => setComposing(true);
    const onCompositionEnd = () => setComposing(false);
    // 窗口失焦：用户切走了，先存一手。
    const onBlur = () => flush();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('compositionstart', onCompositionStart);
    window.addEventListener('compositionend', onCompositionEnd);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('compositionstart', onCompositionStart);
      window.removeEventListener('compositionend', onCompositionEnd);
      window.removeEventListener('blur', onBlur);
    };
  }, [flush]);

  // ---- 立即保存并等它写完（Ctrl+S / 切项目前 / 关窗前） -------------------
  // 不走 wait 分支：直接落库并 await，调用方（onCloseRequested / 切项目）能等到
  // 结果。仍然守 hydrate 门闸；拖拽 / 组字这些「软暂停位」不挡 flush。
  const saveNowFor = useCallback(
    async (projectId: number | null): Promise<boolean> => {
      if (projectId == null) return !stateRef.current.dirty;
      // 项目已被删除：脏内容作废，不写。
      if (discardedRef.current.has(projectId)) return true;
      clearTimer();
      // 单飞：先等飞行中的那次写完，再看还脏不脏。
      const pending = inFlightRef.current;
      if (pending) await pending;
      if (!guardsRef.current.ready || guardsRef.current.restoring) return !stateRef.current.dirty;
      // 无脏不写。
      if (!stateRef.current.dirty) return true;
      await performSave(projectId);
      // stateRef 是同步的：save-ok 会清脏位，save-fail 会保持脏位。
      return !stateRef.current.dirty;
    },
    [clearTimer, performSave]
  );

  const saveNow = useCallback(async () => {
    return saveNowFor(activeProjectId);
  }, [activeProjectId, saveNowFor]);

  // 切项目前：ProjectContext 会 await 这个回调，且此刻 activeProjectId 仍是旧项目，
  // 参数 leavingProjectId 就是要切走的那个 —— 一路传给 save 做串项目校验。
  useEffect(() => {
    return registerBeforeProjectSwitch(async (leavingProjectId: number) => {
      // 自动保存被关掉时不替用户写库：沿用改造前的手动保存语义（切项目丢弃未保存
      // 内容）。Ctrl+S 走的是 saveNow，不受这里影响。
      if (!configRef.current.enabled) return;
      await saveNowFor(leavingProjectId);
    });
  }, [registerBeforeProjectSwitch, saveNowFor]);

  // 项目被删除：立刻作废它的脏内容与待写调度。内容表没有外键约束，一次迟到的写入
  // 会把刚删掉的卡片/模板/分镜重新插回库里（变成孤儿行）。
  useEffect(() => {
    return registerProjectDiscard((projectId: number) => {
      discardedRef.current.add(projectId);
      if (projectId !== activeProjectId) return;
      clearTimer();
      // 删的是当前项目：三个 store 的脏位一起清掉，别让后续 flush（关窗 / 切项目）
      // 再去写它。
      marksRef.current.markGenSaved();
      marksRef.current.markTplSaved();
      marksRef.current.markBlkSaved();
      stateRef.current = reduceAutoSave(stateRef.current, { type: 'reset' }, configRef.current);
      syncUi();
    });
  }, [registerProjectDiscard, activeProjectId, clearTimer, syncUi]);

  // ---- 快照：打开 / 切到某项目、hydrate 完成后抓一份 reason='open' --------
  // 每次打开只抓一次；异步不阻塞 UI；失败只记日志不打扰用户。
  const snapshotForRef = useRef<number | null>(null);
  const [openSnapshot, setOpenSnapshot] = useState<ProjectSnapshotMeta | null>(null);

  // 切项目时清掉「本次打开」的记录，让新项目重新抓。
  useEffect(() => {
    snapshotForRef.current = null;
    setOpenSnapshot(null);
  }, [activeProjectId]);

  useEffect(() => {
    if (!ready || activeProjectId == null) return;
    if (snapshotForRef.current === activeProjectId) return;
    snapshotForRef.current = activeProjectId;
    const pid = activeProjectId;
    // 空项目（新建后还什么都没有）跳过：快照 payload 是整项目 JSON，没必要为
    // 「空」写一份，也没什么可还原的。此时不提供还原入口 —— 绝不能把上一次打开
    // 留下的旧快照冒充「本次打开时的状态」，那会把用户已经清空的内容又搬回来。
    const isEmpty = cells.length === 0 && templates.length === 0 && blocks.length === 0;
    if (isEmpty) return;
    let cancelled = false;
    (async () => {
      try {
        const meta = await createProjectSnapshot(pid, 'open');
        if (!cancelled) setOpenSnapshot(meta);
        await pruneProjectSnapshots(pid, 5);
      } catch (err) {
        console.error('Failed to snapshot project on open', err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // cells/templates/blocks 只用来判空，刻意不进依赖：hydrate 完成那一刻它们已
    // 就绪，之后用户编辑不该重新抓快照。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeProjectId]);

  // ---- 还原到本次打开时的状态 --------------------------------------------
  const restoreOpenSnapshot = useCallback(async (): Promise<{ droppedSlots: number } | null> => {
    const snapshot = openSnapshot;
    if (snapshot == null) return null;
    // 全程暂停自动保存：内存里还是「本次打开后改过」的旧态，写回去就白还原了。
    restoringRef.current = true;
    guardsRef.current.restoring = true;
    setRestoring(true);
    clearTimer();
    try {
      // 先等飞行中的保存落地，避免它和还原的写入交叉。
      const pending = inFlightRef.current;
      if (pending) await pending;
      const result = await restoreProjectSnapshot(snapshot.id, { restoreName: true });
      // 三个 store 的内存仍是旧数据：先各自清 dirty（它们彼此独立），再 bump
      // reloadToken 强制重新 hydrate，否则旧数据会被下一轮自动保存写回去。
      marksRef.current.markGenSaved();
      marksRef.current.markTplSaved();
      marksRef.current.markBlkSaved();
      stateRef.current = reduceAutoSave(stateRef.current, { type: 'reset' }, configRef.current);
      syncUi();
      reloadActiveProject();
      // restoreName: true 会把项目名也还原，标签栏需要跟着刷新。
      await refreshProjects();
      return { droppedSlots: result.droppedSlots };
    } finally {
      restoringRef.current = false;
      setRestoring(false);
    }
  }, [openSnapshot, clearTimer, reloadActiveProject, refreshProjects, syncUi]);

  // 卸载时清计时器。
  useEffect(() => () => clearTimer(), [clearTimer]);

  return (
    <AutoSaveContext.Provider
      value={{
        status,
        lastSavedAt,
        saveNow,
        openSnapshot,
        restoreOpenSnapshot,
        restoring,
      }}
    >
      {children}
    </AutoSaveContext.Provider>
  );
}
