import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Replace, ReplaceAll, X } from 'lucide-react';
import { useActiveEditor } from '../../context/ActiveEditorContext';
import { searchReplacePluginKey, type SearchReplaceStorage } from './SearchReplace';

// 编辑器查找 / 替换浮条（Ctrl+F 查找、Ctrl+H 查找替换）。
//
// 作用对象是「当前活动编辑器」（ActiveEditorContext 里最后聚焦的那张卡片），
// 和顶部格式工具条完全一致的约定：点浮条上的按钮会短暂夺走 DOM 焦点，但
// activeEditor 不会被清空，所以命令依然作用在原来的卡片上。
//
// 键位：
//   Ctrl/Cmd+F 打开查找、Ctrl/Cmd+H 打开查找替换（都由本组件监听 window）
//   Enter / Shift+Enter 下一个 / 上一个
//   Esc 关闭并清除高亮
interface Props {
  // 只在项目视图里挂载；父组件负责条件渲染。
  className?: string;
}

export default function FindReplaceBar({ className }: Props) {
  const { activeEditor } = useActiveEditor();
  const [open, setOpen] = useState(false);
  const [replaceMode, setReplaceMode] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [tick, setTick] = useState(0);
  const queryRef = useRef<HTMLInputElement>(null);
  // 供 window 级键盘监听读取最新值，避免把监听器绑成随 state 变化重复注册。
  const openRef = useRef(open);
  openRef.current = open;
  const closeRef = useRef<() => void>(() => {});

  const regexError = useMemo(() => {
    if (!useRegex || !query) return null;
    try {
      new RegExp(query, 'g');
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, [useRegex, query]);

  // Ctrl+F / Ctrl+H：全局监听。preventDefault 拦掉 WebView 自带的查找栏。
  // Esc：浮条打开时无论焦点在哪都能关掉（清高亮）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key !== 'f' && key !== 'h') return;
      if (event.altKey) return;
      event.preventDefault();
      const wantReplace = key === 'h';
      setOpen(true);
      setReplaceMode((prev) => prev || wantReplace);
      // 打开时若编辑器里有选中文本，直接拿来当查找词（符合直觉）。
      const selected = (() => {
        const editor = activeEditor;
        if (!editor) return '';
        const { from, to } = editor.state.selection;
        if (from === to) return '';
        const text = editor.state.doc.textBetween(from, to, '\n', '\uFFFC');
        return text.includes('\n') ? '' : text;
      })();
      if (selected) setQuery(selected);
      queueMicrotask(() => {
        queryRef.current?.focus();
        queryRef.current?.select();
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeEditor]);

  // 查找条件变化 → 推给当前编辑器重算高亮。
  useEffect(() => {
    if (!activeEditor || activeEditor.isDestroyed) return;
    if (!open) return;
    activeEditor.commands.setSearchTerm({
      searchTerm: regexError ? '' : query,
      caseSensitive,
      useRegex,
      resetIndex: true,
    });
  }, [activeEditor, open, query, caseSensitive, useRegex, regexError]);

  // 订阅编辑器 transaction，刷新 x/y 计数。
  useEffect(() => {
    if (!activeEditor || activeEditor.isDestroyed) return;
    const bump = () => setTick((v) => v + 1);
    activeEditor.on('transaction', bump);
    return () => {
      activeEditor.off('transaction', bump);
    };
  }, [activeEditor]);

  const close = useCallback(() => {
    setOpen(false);
    setReplaceMode(false);
    if (activeEditor && !activeEditor.isDestroyed) {
      activeEditor.commands.clearSearch();
      activeEditor.commands.focus();
    }
  }, [activeEditor]);
  closeRef.current = close;

  // 切换到别的编辑器时，把上一个编辑器的高亮清掉。
  const prevEditorRef = useRef(activeEditor);
  useEffect(() => {
    const prev = prevEditorRef.current;
    prevEditorRef.current = activeEditor;
    if (prev && prev !== activeEditor && !prev.isDestroyed) {
      prev.commands.clearSearch();
    }
  }, [activeEditor]);

  // 关闭浮条后如果编辑器还留着高亮（例如切卡片），统一清一次。
  useEffect(() => {
    if (open) return;
    if (activeEditor && !activeEditor.isDestroyed) activeEditor.commands.clearSearch();
  }, [open, activeEditor]);

  const stats = useMemo(() => {
    void tick;
    if (!activeEditor || activeEditor.isDestroyed) return { total: 0, index: -1 };
    const pluginState = searchReplacePluginKey.getState(activeEditor.state);
    const storage = activeEditor.storage.searchReplace as SearchReplaceStorage | undefined;
    return {
      total: pluginState?.matches.length ?? 0,
      index: storage?.activeIndex ?? -1,
    };
  }, [activeEditor, tick]);

  if (!open) return null;

  const disabled = !activeEditor || activeEditor.isDestroyed;
  const goNext = () => activeEditor?.commands.goToNextMatch();
  const goPrev = () => activeEditor?.commands.goToPreviousMatch();
  const doReplace = () => activeEditor?.commands.replaceCurrentMatch(replacement);
  const doReplaceAll = () => activeEditor?.commands.replaceAllMatches(replacement);

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) goPrev();
      else goNext();
    }
  };

  return (
    <div
      className={`fixed right-5 top-14 z-[9000] w-[420px] rounded-xl border border-[#3D3D3D] bg-[#252525] p-3 shadow-2xl ${className ?? ''}`}
    >
      <div className="flex items-center gap-2">
        <input
          ref={queryRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={useRegex ? '查找（正则）' : '查找'}
          className={`h-8 min-w-0 flex-1 rounded-lg border bg-[#1E1E1E] px-2 text-[12px] text-[#E5E5E5] outline-none placeholder:text-[#6B6B6B] ${
            regexError ? 'border-[#FF8A80]' : 'border-[#3D3D3D] focus:border-[#2EC4B6]'
          }`}
        />
        <span className="w-[68px] shrink-0 text-right text-[11px] text-[#8A8A8A]">
          {stats.total ? `${stats.index + 1}/${stats.total}` : query ? '无结果' : '0/0'}
        </span>
        <button
          onClick={() => setCaseSensitive((v) => !v)}
          title="区分大小写"
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] transition-colors ${
            caseSensitive ? 'bg-[#2EC4B6]/20 text-[#2EC4B6]' : 'bg-[#2A2A2A] text-[#BDBDBD] hover:bg-[#333333]'
          }`}
        >
          Aa
        </button>
        <button
          onClick={() => setUseRegex((v) => !v)}
          title="使用正则表达式"
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] transition-colors ${
            useRegex ? 'bg-[#2EC4B6]/20 text-[#2EC4B6]' : 'bg-[#2A2A2A] text-[#BDBDBD] hover:bg-[#333333]'
          }`}
        >
          .*
        </button>
        <button
          onClick={goPrev}
          disabled={disabled || !stats.total}
          title="上一个（Shift+Enter）"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#2A2A2A] text-[#BDBDBD] transition-colors hover:bg-[#333333] disabled:opacity-40"
        >
          <ArrowUp size={13} />
        </button>
        <button
          onClick={goNext}
          disabled={disabled || !stats.total}
          title="下一个（Enter）"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#2A2A2A] text-[#BDBDBD] transition-colors hover:bg-[#333333] disabled:opacity-40"
        >
          <ArrowDown size={13} />
        </button>
        <button
          onClick={() => setReplaceMode((v) => !v)}
          title="展开 / 收起替换（Ctrl+H）"
          className={`flex h-7 shrink-0 items-center justify-center rounded-lg px-2 text-[11px] transition-colors ${
            replaceMode ? 'bg-[#2EC4B6]/20 text-[#2EC4B6]' : 'bg-[#2A2A2A] text-[#BDBDBD] hover:bg-[#333333]'
          }`}
        >
          替换
        </button>
        <button
          onClick={close}
          title="关闭（Esc）"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[#8A8A8A] transition-colors hover:bg-[#333333] hover:text-[#E5E5E5]"
        >
          <X size={13} />
        </button>
      </div>

      {replaceMode && (
        <div className="mt-2 flex items-center gap-2">
          <input
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
                return;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                if (event.ctrlKey || event.metaKey) doReplaceAll();
                else doReplace();
              }
            }}
            placeholder="替换为（支持 $1 捕获组、\n 换行）"
            className="h-8 min-w-0 flex-1 rounded-lg border border-[#3D3D3D] bg-[#1E1E1E] px-2 text-[12px] text-[#E5E5E5] outline-none placeholder:text-[#6B6B6B] focus:border-[#2EC4B6]"
          />
          <button
            onClick={doReplace}
            disabled={disabled || !stats.total}
            title="替换当前（Enter）"
            className="flex h-7 shrink-0 items-center gap-1 rounded-lg bg-[#2A2A2A] px-2 text-[11px] text-[#BDBDBD] transition-colors hover:bg-[#333333] disabled:opacity-40"
          >
            <Replace size={13} />替换
          </button>
          <button
            onClick={doReplaceAll}
            disabled={disabled || !stats.total}
            title="全部替换（Ctrl+Enter），可用 Ctrl+Z 一次撤销"
            className="flex h-7 shrink-0 items-center gap-1 rounded-lg bg-[#2A2A2A] px-2 text-[11px] text-[#BDBDBD] transition-colors hover:bg-[#333333] disabled:opacity-40"
          >
            <ReplaceAll size={13} />全部
          </button>
        </div>
      )}

      <div className="mt-2 text-[11px] text-[#8A8A8A]">
        {regexError
          ? `正则无效：${regexError}`
          : disabled
            ? '请先点进某张卡片的文本框，查找会作用在该卡片上。'
            : '作用范围：当前聚焦的卡片。Enter 下一个 / Shift+Enter 上一个 / Esc 关闭。'}
      </div>
    </div>
  );
}
