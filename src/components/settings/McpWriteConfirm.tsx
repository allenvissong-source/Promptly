import { AlertTriangle, Check, X } from 'lucide-react';
import type { PendingWrite } from '../../hooks/useMcpWriteExecutor';

// AI 写入的确认条。参照 Codex 的审批交互：说清「要改什么、会丢什么」，用户点允许
// 才执行。一次只展示队首那条，避免多个请求同时涌入时糊成一片。
//
// 删除类操作即使设置为「无需确认」也会走到这里 —— 不可逆操作不该由 AI 单方面决定。

export default function McpWriteConfirm({ pending }: { pending: PendingWrite[] }) {
  const current = pending[0];
  if (!current) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[60] w-[520px] max-w-[92vw] -translate-x-1/2">
      <div
        className={`rounded-xl border bg-[#2A2A2A] p-4 shadow-2xl ${
          current.destructive ? 'border-[#7A4040]' : 'border-[#3D3D3D]'
        }`}
      >
        <div className="flex items-start gap-3">
          <div
            className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
              current.destructive ? 'bg-[#7A4040]/25 text-[#E08A8A]' : 'bg-[#2EC4B6]/15 text-[#2EC4B6]'
            }`}
          >
            <AlertTriangle size={13} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[#E5E5E5]">
              AI 请求{current.destructive ? '删除' : '修改'}内容
            </div>
            <div className="mt-1 text-[12px] text-[#BDBDBD]">{current.summary}</div>

            {current.warnings.length > 0 ? (
              <ul className="mt-2 space-y-0.5">
                {current.warnings.map((w) => (
                  <li key={w} className="text-[11px] text-[#D9B26A]">
                    · {w}
                  </li>
                ))}
              </ul>
            ) : null}

            {current.preview ? (
              <pre className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[#1E1E1E] p-2 text-[11px] leading-relaxed text-[#8A8A8A] scrollbar-dark">
                {current.preview.length > 600
                  ? `${current.preview.slice(0, 600)}\n…（共 ${current.preview.length} 字）`
                  : current.preview}
              </pre>
            ) : null}

            {pending.length > 1 ? (
              <div className="mt-2 text-[11px] text-[#8A8A8A]">
                还有 {pending.length - 1} 个请求排队
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={() => current.resolve(false)}
            className="flex items-center gap-1 rounded-lg border border-[#3D3D3D] px-3 py-1.5 text-[12px] text-[#BDBDBD] transition-colors hover:bg-[#333333]"
          >
            <X size={12} />
            <span>拒绝</span>
          </button>
          <button
            onClick={() => current.resolve(true)}
            className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors ${
              current.destructive
                ? 'bg-[#7A4040] text-[#F5D6D6] hover:bg-[#8A4A4A]'
                : 'bg-[#2EC4B6] text-[#1E1E1E] hover:bg-[#35D6C7]'
            }`}
          >
            <Check size={12} />
            <span>允许</span>
          </button>
        </div>
      </div>
    </div>
  );
}
