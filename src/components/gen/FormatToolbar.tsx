import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Baseline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  RemoveFormatting,
  FoldVertical,
} from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { useActiveEditor } from '../../context/ActiveEditorContext';
import { PALETTE_ROWS, normalizeHex } from './palette';
import { collapseBlankLines } from './blankLines';

// 分镜区顶部常驻的富文本格式工具条。它本身不持有编辑器，而是通过
// ActiveEditorContext 找到「当前聚焦的分镜卡片编辑器」再施加命令。所有命令都先
// .focus() 复原选区（点击按钮会短暂夺走 DOM 焦点），再执行 toggle/setColor 等。
// 订阅 context 的 version：活动编辑器切换或选区变化时自增 → 触发本组件重渲染，
// 从而让按钮高亮态跟随光标。

// 一个工具条按钮。active 时高亮。
function TBtn({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      // 用 mousedown + preventDefault 避免点击时把焦点从编辑器夺走导致选区丢失。
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={
        'fmt-btn' + (active ? ' fmt-btn-active' : '')
      }
    >
      {children}
    </button>
  );
}

export default function FormatToolbar() {
  const { activeEditor, version } = useActiveEditor();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // version 只是用来触发重渲染；显式引用以避免 lint 未使用告警。
  void version;

  // 点击色板外部时关闭。
  useEffect(() => {
    if (!paletteOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setPaletteOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [paletteOpen]);

  const ed: Editor | null = activeEditor;
  const has = !!ed;

  const run = useCallback(
    (fn: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => {
      if (!ed) return;
      fn(ed.chain().focus()).run();
    },
    [ed]
  );

  const currentColor = ed ? normalizeHex(ed.getAttributes('textStyle').color) : null;

  const pickColor = (hex: string) => {
    if (!ed) return;
    const norm = normalizeHex(hex);
    // 再次点击同一色 → 取消着色。
    if (norm && currentColor === norm) {
      ed.chain().focus().unsetColor().run();
    } else {
      ed.chain().focus().setColor(hex).run();
    }
    setPaletteOpen(false);
  };

  return (
    <div
      ref={wrapRef}
      className="fmt-toolbar flex items-center gap-0.5 px-3 py-1.5 border-b border-[#3D3D3D] shrink-0"
    >
      <TBtn
        title="加粗"
        disabled={!has}
        active={!!ed?.isActive('bold')}
        onClick={() => run((c) => c.toggleBold())}
      >
        <Bold size={15} strokeWidth={2.5} />
      </TBtn>
      <TBtn
        title="删除线"
        disabled={!has}
        active={!!ed?.isActive('strike')}
        onClick={() => run((c) => c.toggleStrike())}
      >
        <Strikethrough size={15} strokeWidth={2.25} />
      </TBtn>
      <TBtn
        title="斜体"
        disabled={!has}
        active={!!ed?.isActive('italic')}
        onClick={() => run((c) => c.toggleItalic())}
      >
        <Italic size={15} strokeWidth={2.25} />
      </TBtn>
      <TBtn
        title="下划线"
        disabled={!has}
        active={!!ed?.isActive('underline')}
        onClick={() => run((c) => c.toggleUnderline())}
      >
        <Underline size={15} strokeWidth={2.25} />
      </TBtn>

      {/* 文字颜色：A + 下拉色板 */}
      <div className="relative">
        <TBtn
          title="文字颜色"
          disabled={!has}
          active={!!currentColor}
          onClick={() => setPaletteOpen((v) => !v)}
        >
          <span className="fmt-color-a">
            <Baseline size={15} strokeWidth={2.25} />
            <span
              className="fmt-color-bar"
              style={{ background: currentColor ?? '#E5E5E5' }}
            />
          </span>
        </TBtn>
        {paletteOpen && has && (
          <div ref={popRef} className="fmt-palette">
            {PALETTE_ROWS.map((row, ri) => (
              <div key={ri} className="fmt-palette-row">
                {row.map((hex) => {
                  const norm = normalizeHex(hex);
                  const sel = norm && norm === currentColor;
                  return (
                    <button
                      key={hex}
                      type="button"
                      title={hex}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickColor(hex)}
                      className={'fmt-swatch' + (sel ? ' fmt-swatch-sel' : '')}
                      style={{ background: hex }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <span className="fmt-sep" />

      <TBtn
        title="左对齐"
        disabled={!has}
        active={!!ed?.isActive({ textAlign: 'left' })}
        onClick={() => run((c) => c.setTextAlign('left'))}
      >
        <AlignLeft size={15} strokeWidth={2.25} />
      </TBtn>
      <TBtn
        title="居中对齐"
        disabled={!has}
        active={!!ed?.isActive({ textAlign: 'center' })}
        onClick={() => run((c) => c.setTextAlign('center'))}
      >
        <AlignCenter size={15} strokeWidth={2.25} />
      </TBtn>
      <TBtn
        title="右对齐"
        disabled={!has}
        active={!!ed?.isActive({ textAlign: 'right' })}
        onClick={() => run((c) => c.setTextAlign('right'))}
      >
        <AlignRight size={15} strokeWidth={2.25} />
      </TBtn>

      <span className="fmt-sep" />

      {/* 清除格式：unsetAllMarks 清掉选区内全部 mark（加粗/斜体/下划线/删除线，
          以及 TextStyle 上挂的 color / backgroundColor），再 unsetTextAlign 把
          段落对齐复位（TextAlign 是 paragraph 的属性，不是 mark）。两条命令在同
          一个 chain 里跑，所以 Ctrl+Z 一次就能整体撤销。刻意不用 clearNodes()：
          它会重置节点结构，可能影响 @图片 / 角色实体 / 模板引用这些原子节点。 */}
      <TBtn
        title="清除格式"
        disabled={!has}
        onClick={() => run((c) => c.unsetAllMarks().unsetTextAlign())}
      >
        <RemoveFormatting size={15} strokeWidth={2.25} />
      </TBtn>

      {/* 清除一行空行：作用于当前活动编辑器的全文（与选区无关），把每一组连续
          空行各减少 1 行（1→0 / 2→1 / 3→2…）。所有删除在同一个 transaction 里
          从后往前执行，Ctrl+Z 一次撤销；全文无空行时不 dispatch，纯空操作。 */}
      <TBtn
        title="清除一行空行"
        disabled={!has}
        onClick={() => {
          if (ed) collapseBlankLines(ed);
        }}
      >
        <FoldVertical size={15} strokeWidth={2.25} />
      </TBtn>
    </div>
  );
}
