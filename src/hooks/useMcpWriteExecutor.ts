import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useProject } from '../context/ProjectContext';
import { useBlockStore } from '../context/BlockStoreContext';
import { useGenTemplateStore } from '../context/GenTemplateStoreContext';
import { textToContent, describeLossyWrite } from '../components/gen/textToContent';

// ============================================================================
// MCP 写请求的执行器
//
// 链路：MCP server ──HTTP──> Rust 控制端口 ──轮询──> 这里 ──> store 的写方法
//                                                              └─> autoSave 落库
//
// 关键设计：写入走 store 已有的 setContent / addBlock / deleteBlock 等方法，改的
// 是内存态，落库仍由 autoSave 负责。绝不绕过 autoSave 直接写库 —— 那样写进去的行
// 会被下一轮增量保存当成「内存里没有的行」删掉。
//
// 只处理当前打开项目的请求。跨项目写入需要先切项目，而切项目会触发 flush 与
// re-hydrate，把 AI 的一次调用变成一串副作用；宁可明确拒绝并让 AI 提示用户切换。
// ============================================================================

const POLL_INTERVAL_MS = 500;
const CONFIRM_KEY = 'promptly.mcpWriteConfirm';

export type WriteConfirmMode = 'ask' | 'auto';

export function readWriteConfirmMode(): WriteConfirmMode {
  return localStorage.getItem(CONFIRM_KEY) === 'auto' ? 'auto' : 'ask';
}

export function setWriteConfirmMode(mode: WriteConfirmMode) {
  localStorage.setItem(CONFIRM_KEY, mode);
}

interface WriteRequest {
  id: string;
  action: string;
  payload: Record<string, unknown>;
}

/** 待用户确认的请求，连带一份「这次会改什么」的人类可读说明。 */
export interface PendingWrite {
  id: string;
  action: string;
  /** 一句话说明改动目标，如「更新分镜卡片 BLOCK3」。 */
  summary: string;
  /** 会造成的信息损失，如「2 个素材引用会变成普通文字」。 */
  warnings: string[];
  /** 新内容预览（截断）。删除类操作为 null。 */
  preview: string | null;
  /** 是否为破坏性操作，UI 用它决定按钮配色。 */
  destructive: boolean;
  resolve: (approved: boolean) => void;
}

export function useMcpWriteExecutor() {
  const { activeProjectId } = useProject();
  const blockStore = useBlockStore();
  const templateStore = useGenTemplateStore();
  const [pending, setPending] = useState<PendingWrite[]>([]);
  // 上一次轮询错误，用来去重日志。
  const lastPollError = useRef<string | null>(null);

  // store 与项目 id 放 ref：轮询回调只注册一次，但要读到最新值。
  const ctx = useRef({ activeProjectId, blockStore, templateStore });
  ctx.current = { activeProjectId, blockStore, templateStore };

  // 执行一个请求，返回给 Rust 的结果消息。抛错表示拒绝。
  const execute = useCallback(async (req: WriteRequest): Promise<string> => {
    const { activeProjectId: pid, blockStore: blocks, templateStore: templates } =
      ctx.current;
    const payload = req.payload;
    const wantProject = Number(payload.projectId);

    if (!pid) throw new Error('当前没有打开任何项目，无法写入。');
    if (Number.isFinite(wantProject) && wantProject !== pid) {
      throw new Error(
        `请求写入项目 ${wantProject}，但 Promptly 当前打开的是项目 ${pid}。` +
          `请先在 App 里切换到目标项目。`
      );
    }
    // hydrate 没完成时内存态还不是目标项目的数据，此时写入会被 autoSave 的
    // ready 守卫挡住，或更糟：写到半加载的状态上。直接拒绝。
    if (blocks.hydratedProjectId !== pid || templates.hydratedProjectId !== pid) {
      throw new Error('项目还在加载中，请稍后重试。');
    }

    switch (req.action) {
      case 'update_block': {
        const id = String(payload.blockId ?? '');
        const target = blocks.blocks.find((b) => b.id === id);
        if (!target) throw new Error(`找不到分镜卡片 ${id}`);
        blocks.setContent(id, textToContent(String(payload.text ?? '')));
        return `已更新分镜卡片 ${id}`;
      }

      case 'create_block': {
        const before = new Set(blocks.blocks.map((b) => b.id));
        blocks.addBlock();
        // addBlock 不返回 id（不改它的签名以免影响既有调用方）。新卡片一定追加在
        // 末尾，所以下一帧从列表里找出这个之前不存在的 id。
        const id = await new Promise<string>((resolve, reject) => {
          setTimeout(() => {
            const created = ctx.current.blockStore.blocks.find((b) => !before.has(b.id));
            created ? resolve(created.id) : reject(new Error('新建分镜卡片失败'));
          }, 0);
        });
        const text = String(payload.text ?? '');
        if (text) ctx.current.blockStore.setContent(id, textToContent(text));
        return `已新建分镜卡片 ${id}`;
      }

      case 'update_template': {
        const id = String(payload.templateId ?? '');
        const target = templates.templates.find((t) => t.id === id);
        if (!target) throw new Error(`找不到模板 ${id}`);
        // 模板区要认 `- 角色名:` 形态，并复用旧内容里同名角色的 id ——
        // 否则分镜区已勾选的角色会失效。
        templates.setContent(
          id,
          textToContent(String(payload.text ?? ''), {
            parseRoles: true,
            previous: target.content,
          })
        );
        return `已更新模板「${target.name}」`;
      }

      case 'delete_card': {
        const kind = String(payload.kind ?? '');
        const id = String(payload.cardId ?? '');
        if (kind === 'block') {
          if (!blocks.blocks.some((b) => b.id === id)) {
            throw new Error(`找不到分镜卡片 ${id}`);
          }
          blocks.deleteBlock(id);
          return `已删除分镜卡片 ${id}`;
        }
        if (kind === 'template') {
          const t = templates.templates.find((x) => x.id === id);
          if (!t) throw new Error(`找不到模板 ${id}`);
          templates.deleteTemplate(id);
          return `已删除模板「${t.name}」`;
        }
        throw new Error(`未知的删除目标类型：${kind}`);
      }

      default:
        throw new Error(`不支持的操作：${req.action}`);
    }
  }, []);

  // 生成给用户看的确认信息。刻意在这里算而不是执行时算：确认弹窗必须如实告诉
  // 用户会丢什么，不能等改完才发现 chip 没了。
  const describe = useCallback((req: WriteRequest) => {
    const { blockStore: blocks, templateStore: templates } = ctx.current;
    const payload = req.payload;
    const text = typeof payload.text === 'string' ? payload.text : null;
    switch (req.action) {
      case 'update_block': {
        const id = String(payload.blockId ?? '');
        const target = blocks.blocks.find((b) => b.id === id);
        return {
          summary: `更新分镜卡片 ${id}`,
          warnings: describeLossyWrite(target?.content),
          preview: text,
          destructive: false,
        };
      }
      case 'create_block':
        return {
          summary: '新建分镜卡片',
          warnings: [],
          preview: text,
          destructive: false,
        };
      case 'update_template': {
        const id = String(payload.templateId ?? '');
        const target = templates.templates.find((t) => t.id === id);
        return {
          summary: `更新模板「${target?.name ?? id}」`,
          warnings: describeLossyWrite(target?.content),
          preview: text,
          destructive: false,
        };
      }
      case 'delete_card': {
        const kind = String(payload.kind ?? '');
        const id = String(payload.cardId ?? '');
        const name =
          kind === 'template'
            ? templates.templates.find((t) => t.id === id)?.name ?? id
            : id;
        return {
          summary: kind === 'template' ? `删除模板「${name}」` : `删除分镜卡片 ${id}`,
          warnings: ['删除后可用 Ctrl+Z 撤销，或从快照还原'],
          preview: null,
          destructive: true,
        };
      }
      default:
        return { summary: req.action, warnings: [], preview: text, destructive: false };
    }
  }, []);

  const handle = useCallback(
    async (req: WriteRequest) => {
      const report = (ok: boolean, message: string) =>
        invoke('mcp_write_complete', { result: { id: req.id, ok, message } }).catch(
          (err) => console.error('回报 MCP 写入结果失败', err)
        );

      try {
        // 删除类操作无论设置如何都要确认 —— 它不可逆，且 AI 判断失误的代价最高。
        const info = describe(req);
        const needConfirm = readWriteConfirmMode() === 'ask' || info.destructive;

        if (needConfirm) {
          // 关键：不让 AI 那侧一直挂着等用户点确认。
          //
          // MCP 客户端默认 60 秒请求超时，而用户可能正在别的窗口、几分钟后才回来。
          // 若在这里阻塞，客户端会先超时断开，用户之后点「允许」就成了「AI 以为
          // 失败但其实改了」—— 那比直接拒绝更糟。
          //
          // 所以立刻回一个明确的「已提交，待你在 App 里确认」，让 AI 知道结果未定；
          // 用户的批准与执行在本地继续走完，界面会实时更新。
          await report(
            false,
            `这次改动需要你在 Promptly 里确认：${info.summary}。` +
              `请切到 App 点「允许」，或在设置 → 通用里把「AI 写入内容时」改为「无需确认」。`
          );
          const approved = await new Promise<boolean>((resolve) => {
            setPending((prev) => [...prev, { id: req.id, action: req.action, ...info, resolve }]);
          });
          setPending((prev) => prev.filter((p) => p.id !== req.id));
          if (approved) {
            // 结果已经回报过（上面那条），这里只做本地执行。执行失败要让用户看见，
            // 因为 AI 那侧已经收到「待确认」的答复，不会再来取结果。
            try {
              await execute(req);
            } catch (err) {
              console.error('AI 写入执行失败', err);
              window.alert(
                `执行 AI 的改动时出错：${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
          return;
        }

        await report(true, await execute(req));
      } catch (err) {
        await report(false, err instanceof Error ? err.message : String(err));
      }
    },
    [describe, execute]
  );

  // handle 放 ref：轮询的 effect 只能注册一次。若让 effect 依赖 handle，
  // 每次 setPending 引起的重渲染都会重建 handle、进而清掉并重建定时器 ——
  // 定时器永远等不到下一次触发，请求就永远取不走。
  const handleRef = useRef(handle);
  handleRef.current = handle;

  useEffect(() => {
    let alive = true;
    void invoke('mcp_write_listen', { listening: true }).catch(() => {});

    const timer = setInterval(() => {
      void (async () => {
        if (!alive) return;
        try {
          const requests = await invoke<WriteRequest[]>('mcp_write_poll');
          for (const req of requests) void handleRef.current(req);
        } catch (err) {
          // 轮询失败要看得见：静默会让「写入一直超时」变成无从下手的问题。
          // 只在错误变化时打一次，避免每 500ms 刷屏。
          const message = String(err);
          if (message !== lastPollError.current) {
            lastPollError.current = message;
            console.error('[mcp] 轮询写请求失败', err);
          }
        }
      })();
    }, POLL_INTERVAL_MS);

    return () => {
      alive = false;
      clearInterval(timer);
      void invoke('mcp_write_listen', { listening: false }).catch(() => {});
    };
  }, []);

  return { pending };
}
