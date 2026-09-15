import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Copy, RefreshCw } from 'lucide-react';

// MCP 服务的设置面板。
//
// 只负责 HTTP 传输那条：豆包这类客户端只会去连一个 URL、不会自己启动进程，所以
// 需要 App 帮忙把 server 跑起来。stdio 那条不在这里——那种模式下是 Claude Code /
// Codex 自己把 server 当子进程拉起，App 插手反而是错的。
//
// 开关默认关：一个后台 HTTP 端口不该在用户没要求时就开着。

interface McpStatus {
  running: boolean;
  endpoint: string | null;
  port: number;
  nodePath: string | null;
  serverAvailable: boolean;
  lastError: string | null;
}

const ENABLED_KEY = 'promptly.mcpHttpEnabled';

export default function McpSettings() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<McpStatus>('mcp_status'));
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 打开设置面板时若开关是开的但进程没在跑（比如上次异常退出），顺手拉起来，
  // 免得用户看到「已开启」却连不上。
  useEffect(() => {
    if (!status || status.running) return;
    if (localStorage.getItem(ENABLED_KEY) !== 'true') return;
    if (!status.nodePath || !status.serverAvailable) return;
    void (async () => {
      try {
        setStatus(await invoke<McpStatus>('mcp_start', { port: status.port }));
      } catch {
        // 失败原因由 status.lastError 呈现，这里不再弹一次。
        void refresh();
      }
    })();
  }, [status, refresh]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem(ENABLED_KEY, String(next));
      setStatus(
        next
          ? await invoke<McpStatus>('mcp_start', { port: status?.port })
          : await invoke<McpStatus>('mcp_stop')
      );
    } catch (err) {
      setError(String(err));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const copyEndpoint = async () => {
    if (!status?.endpoint) return;
    await navigator.clipboard.writeText(status.endpoint);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const nodeMissing = status != null && !status.nodePath;
  const shown = error ?? status?.lastError ?? null;

  return (
    <div className="rounded-xl border border-[#3D3D3D] bg-[#2A2A2A] p-4">
      <label className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[14px] font-medium text-[#E5E5E5]">MCP 服务（HTTP）</div>
          <div className="mt-1 text-[12px] text-[#8A8A8A]">
            让豆包等 AI 客户端直接读取本机的项目、素材与编排好的提示词（只读）。开启后
            App 会在本地启动一个服务，关闭 App 时自动停止。
          </div>
        </div>
        <input
          type="checkbox"
          disabled={busy || nodeMissing || status?.serverAvailable === false}
          checked={!!status?.running}
          onChange={(event) => void toggle(event.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 accent-[#2EC4B6] disabled:opacity-40"
        />
      </label>

      {status?.running && status.endpoint ? (
        <div className="mt-3 rounded-lg border border-[#3D3D3D] bg-[#252525] p-3">
          <div className="mb-2 text-[12px] text-[#BDBDBD]">
            在客户端的「自定义连接器」里填这个地址，传输类型选 HTTP
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-[#1E1E1E] px-2 py-1.5 text-[12px] text-[#2EC4B6]">
              {status.endpoint}
            </code>
            <button
              onClick={() => void copyEndpoint()}
              className="flex shrink-0 items-center gap-1 rounded px-2 py-1.5 text-[11px] text-[#8A8A8A] transition-colors hover:bg-[#333333] hover:text-[#2EC4B6]"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
          </div>
        </div>
      ) : null}

      {nodeMissing ? (
        <div className="mt-3 rounded-lg border border-[#5A4A2A] bg-[#2E2718] p-3 text-[12px] leading-relaxed text-[#D9B26A]">
          未检测到 Node.js。MCP 服务需要它才能运行，请安装 Node 20 以上版本后重开设置。
          <div className="mt-1 text-[#8A8A8A]">
            也可以不装：在 Claude Code / Codex 里用 stdio 方式配置，那种方式由客户端自己
            启动服务，不走这里。
          </div>
        </div>
      ) : null}

      {status?.serverAvailable === false && !nodeMissing ? (
        <div className="mt-3 rounded-lg border border-[#5A3A3A] bg-[#2E1E1E] p-3 text-[12px] text-[#E08A8A]">
          找不到 MCP 服务程序文件，安装包可能不完整。重新安装可修复。
        </div>
      ) : null}

      {shown ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-[#5A3A3A] bg-[#2E1E1E] p-3">
          <div className="flex-1 text-[12px] leading-relaxed text-[#E08A8A]">{shown}</div>
          <button
            onClick={() => void refresh()}
            className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] text-[#8A8A8A] hover:text-[#E5E5E5]"
          >
            <RefreshCw size={11} />
            <span>重试</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
