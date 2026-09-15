import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

// 「清除一行空行」：把当前卡片全文里每一组「连续空行」各减少 1 行。
//
// 设计要点：
//  - 本编辑器的 schema 只注册了 Document / Paragraph / Text + 行内原子节点
//    （mention / roleEntity / templateRef），既没有 HardBreak，也没有列表 /
//    表格 / blockquote。所以「空行」在文档模型里只有一种形态：顶层的空
//    paragraph（content.size === 0）。段落内不可能出现 <br> 造成的视觉空行。
//  - 判空取最严格的口径：content.size === 0。带 chip / 图片 / 任何文字（含
//    只有空格的文字）的段落都不算空行，绝不会误删原子节点或字符。
//  - 「连续 1 个空行 → 变 0 个」= 删掉那个空 paragraph 整节点（from..from+
//    nodeSize），上下两段成为相邻的两行，不会被 join 成同一段。
//  - 每一组连续空行只删组内「最后一个」空段落，各组互不影响；重复点击会不断
//    收敛，直到全文无空行时变成空操作。
//  - 计算与提交分离：planBlankLineRemoval 是纯函数（可单测），
//    collapseBlankLines 把所有删除塞进同一个 transaction（从后往前删，位置不
//    漂移）→ Ctrl+Z 一次回到点击前。

export interface BlankLineRange {
  from: number;
  to: number;
}

// 严格判空：顶层 paragraph 且内容长度为 0。
function isBlankParagraph(node: PMNode): boolean {
  return node.type.name === 'paragraph' && node.content.size === 0;
}

// 扫描全文，算出「每组连续空行各减 1」需要删除的节点范围（按位置升序，互不重叠）。
export function planBlankLineRemoval(doc: PMNode): BlankLineRange[] {
  const ranges: BlankLineRange[] = [];
  // 当前这组连续空行里最后一个空段落的范围（null = 当前不在空行组里）。
  let runLast: BlankLineRange | null = null;
  let pos = 0;
  for (let i = 0; i < doc.childCount; i += 1) {
    const child = doc.child(i);
    const from = pos;
    pos += child.nodeSize;
    if (isBlankParagraph(child)) {
      runLast = { from, to: from + child.nodeSize };
      continue;
    }
    // 组结束：该组贡献 1 个删除。
    if (runLast) {
      ranges.push(runLast);
      runLast = null;
    }
  }
  // 文档结尾的空行组。
  if (runLast) ranges.push(runLast);
  // doc 的 content 是 block+，至少要留一个块，否则文档非法。只有「整篇就一个
  // 空段落」时才会触发，此时按空操作处理。
  if (ranges.length >= doc.childCount) return [];
  return ranges;
}

// 对目标编辑器执行一次「清除一行空行」。返回是否真的改了文档。
// 无空行时不 dispatch 任何 transaction，也不动焦点/选区（完全的空操作）。
export function collapseBlankLines(editor: Editor): boolean {
  const { state, view } = editor;
  const ranges = planBlankLineRemoval(state.doc);
  if (!ranges.length) return false;
  const tr = state.tr;
  // 从后往前删：靠前的位置不会被前序删除挤偏。全部删除在同一个 transaction 里，
  // 所以 Ctrl+Z 一次撤销。选区由 Transaction 自动跟着 step 映射，不会越界。
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    tr.delete(ranges[i].from, ranges[i].to);
  }
  view.dispatch(tr);
  // 只补 DOM 焦点（不产生额外 transaction，也不改选区）。
  view.focus();
  return true;
}
