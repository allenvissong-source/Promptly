import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

// 编辑器内查找 / 替换（Ctrl+F / Ctrl+H）。
//
// 设计要点：
//  - 查找参数放在 extension storage（每个编辑器实例一份），命中结果与装饰放在
//    ProseMirror 插件 state 里，doc 变化或参数变化时重算。
//  - 结果按「文本块」为单位计算：同一段落内的多个 text 节点（不同 mark 造成的
//    切分）先拼成一个字符串，所以跨样式边界的词也能命中。
//  - 段落里的原子节点（@图片 chip / 角色实体 / 模板引用）在拼接时用
//    \uFFFC（对象替换符）占 1 个字符，与其 nodeSize 一致，偏移量因此可线性映射
//    回文档位置，chip 不会被误当成文字匹配。
//  - 替换用 tr.insertText：ProseMirror 会继承命中片段起点的 marks，所以把一段
//    加粗文字替换掉之后仍然是加粗的。
//  - 「全部替换」合并成一个 transaction，Ctrl+Z 一次撤销。

export const searchReplacePluginKey = new PluginKey<SearchReplaceState>('promptlySearchReplace');

export interface SearchMatch {
  from: number;
  to: number;
  // 捕获组，供替换文本里的 $1 / $& 展开使用。
  groups: string[];
}

export interface SearchReplaceState {
  decorations: DecorationSet;
  matches: SearchMatch[];
}

export interface SearchReplaceStorage {
  searchTerm: string;
  caseSensitive: boolean;
  useRegex: boolean;
  // 当前定位到第几个结果（-1 = 未定位）。
  activeIndex: number;
  matches: SearchMatch[];
}

// 与 richClipboard.expandReplacement 保持一致的占位符规则：
// $& 整段、$1..$99 捕获组、$$ 字面 $、\n \r \t \\ 转义。
export function expandSearchReplacement(template: string, groups: string[]): string {
  let out = '';
  for (let i = 0; i < template.length; i += 1) {
    const ch = template[i];
    if (ch === '\\' && i + 1 < template.length) {
      const next = template[i + 1];
      if (next === 'n') { out += '\n'; i += 1; continue; }
      if (next === 'r') { out += '\r'; i += 1; continue; }
      if (next === 't') { out += '\t'; i += 1; continue; }
      if (next === '\\') { out += '\\'; i += 1; continue; }
      out += ch;
      continue;
    }
    if (ch === '$' && i + 1 < template.length) {
      const next = template[i + 1];
      if (next === '$') { out += '$'; i += 1; continue; }
      if (next === '&') { out += groups[0] ?? ''; i += 1; continue; }
      if (next >= '0' && next <= '9') {
        const two = template.slice(i + 1, i + 3);
        if (/^\d\d$/.test(two) && Number(two) < groups.length) {
          out += groups[Number(two)] ?? '';
          i += 2;
          continue;
        }
        const one = Number(next);
        if (one < groups.length) {
          out += groups[one] ?? '';
          i += 1;
          continue;
        }
      }
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 把一个文本块拼成字符串，并记录 offset -> 文档位置 的线性起点。
function blockText(node: PMNode): string {
  let text = '';
  node.forEach((child) => {
    if (child.isText) {
      text += child.text ?? '';
    } else {
      // 行内原子节点（chip 等）：nodeSize 恒为 1，用一个占位字符对齐偏移。
      text += '\uFFFC'.repeat(child.nodeSize);
    }
  });
  return text;
}

export function findMatches(
  doc: PMNode,
  searchTerm: string,
  caseSensitive: boolean,
  useRegex: boolean
): SearchMatch[] {
  if (!searchTerm) return [];
  let regex: RegExp;
  try {
    const source = useRegex ? searchTerm : escapeRegExp(searchTerm);
    regex = new RegExp(source, caseSensitive ? 'g' : 'gi');
  } catch {
    // 正则写坏了：当作没有命中，浮条上会提示（由调用方校验并展示）。
    return [];
  }

  const matches: SearchMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = blockText(node);
    if (!text) return false;
    // 文本块内容起点 = 块位置 + 1（跨过块的开标签）。
    const base = pos + 1;
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const length = match[0].length;
      if (length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      matches.push({
        from: base + match.index,
        to: base + match.index + length,
        groups: Array.from(match),
      });
      if (matches.length > 5000) return false; // 兜底：避免超大文档卡死
    }
    return false; // 文本块内部不再深入
  });
  return matches;
}

function buildDecorations(matches: SearchMatch[], activeIndex: number, doc: PMNode): DecorationSet {
  if (!matches.length) return DecorationSet.empty;
  const decorations = matches.map((match, index) =>
    Decoration.inline(match.from, match.to, {
      class: index === activeIndex ? 'pm-search-hit pm-search-hit-active' : 'pm-search-hit',
    })
  );
  return DecorationSet.create(doc, decorations);
}

declare module '@tiptap/core' {
  // 让 editor.storage.searchReplace 有类型（Tiptap v3 的 Storage 增强点）。
  interface Storage {
    searchReplace: SearchReplaceStorage;
  }

  interface Commands<ReturnType> {
    searchReplace: {
      // 设置查找条件（term 为空即清空高亮）。
      setSearchTerm: (params: {
        searchTerm: string;
        caseSensitive?: boolean;
        useRegex?: boolean;
        // 是否把定位重置到第一个结果（改查找词时为 true）。
        resetIndex?: boolean;
      }) => ReturnType;
      // 清空查找状态（关闭浮条时调用）。
      clearSearch: () => ReturnType;
      // 跳到下一个 / 上一个结果（循环）。
      goToNextMatch: () => ReturnType;
      goToPreviousMatch: () => ReturnType;
      // 替换当前定位的结果，并自动定位到下一个。
      replaceCurrentMatch: (replacement: string) => ReturnType;
      // 替换全部（单个 transaction，一次撤销）。
      replaceAllMatches: (replacement: string) => ReturnType;
    };
  }
}

export const SearchReplace = Extension.create<
  Record<string, never>,
  SearchReplaceStorage
>({
  name: 'searchReplace',

  addStorage() {
    return {
      searchTerm: '',
      caseSensitive: false,
      useRegex: false,
      activeIndex: -1,
      matches: [],
    };
  },

  addCommands() {
    const storage = () => this.editor.storage.searchReplace as SearchReplaceStorage;

    // 参数变化后强制插件重算：打一个不改文档的 meta transaction，并且不进 undo 栈。
    const refresh = (tr: Transaction) => {
      tr.setMeta(searchReplacePluginKey, true);
      tr.setMeta('addToHistory', false);
    };

    const currentMatch = (state: EditorState): SearchMatch | null => {
      const pluginState = searchReplacePluginKey.getState(state);
      const matches = pluginState?.matches ?? [];
      const index = storage().activeIndex;
      if (index < 0 || index >= matches.length) return null;
      return matches[index];
    };

    return {
      setSearchTerm:
        ({ searchTerm, caseSensitive, useRegex, resetIndex = true }) =>
        ({ tr, dispatch }) => {
          const store = storage();
          store.searchTerm = searchTerm;
          if (caseSensitive !== undefined) store.caseSensitive = caseSensitive;
          if (useRegex !== undefined) store.useRegex = useRegex;
          if (resetIndex) store.activeIndex = searchTerm ? 0 : -1;
          if (dispatch) refresh(tr);
          return true;
        },

      clearSearch:
        () =>
        ({ tr, dispatch }) => {
          const store = storage();
          store.searchTerm = '';
          store.activeIndex = -1;
          store.matches = [];
          if (dispatch) refresh(tr);
          return true;
        },

      goToNextMatch:
        () =>
        ({ tr, state, dispatch }) => {
          const matches = searchReplacePluginKey.getState(state)?.matches ?? [];
          if (!matches.length) return false;
          const store = storage();
          store.activeIndex = (store.activeIndex + 1 + matches.length) % matches.length;
          if (dispatch) {
            const target = matches[store.activeIndex];
            tr.setSelection(TextSelection.create(tr.doc, target.from, target.to));
            tr.scrollIntoView();
            refresh(tr);
          }
          return true;
        },

      goToPreviousMatch:
        () =>
        ({ tr, state, dispatch }) => {
          const matches = searchReplacePluginKey.getState(state)?.matches ?? [];
          if (!matches.length) return false;
          const store = storage();
          const next = store.activeIndex <= 0 ? matches.length - 1 : store.activeIndex - 1;
          store.activeIndex = next;
          if (dispatch) {
            const target = matches[next];
            tr.setSelection(TextSelection.create(tr.doc, target.from, target.to));
            tr.scrollIntoView();
            refresh(tr);
          }
          return true;
        },

      replaceCurrentMatch:
        (replacement) =>
        ({ tr, state, dispatch }) => {
          const match = currentMatch(state);
          if (!match) return false;
          if (dispatch) {
            const text = expandSearchReplacement(replacement, match.groups);
            if (text) {
              tr.insertText(text, match.from, match.to);
            } else {
              tr.delete(match.from, match.to);
            }
            tr.setMeta(searchReplacePluginKey, true);
            // 替换完让定位停在同一序号：命中列表会重算，序号自然指向下一个。
            const store = storage();
            if (store.activeIndex > 0) store.activeIndex -= 1;
          }
          return true;
        },

      replaceAllMatches:
        (replacement) =>
        ({ tr, state, dispatch }) => {
          const matches = searchReplacePluginKey.getState(state)?.matches ?? [];
          if (!matches.length) return false;
          if (dispatch) {
            // 从后往前替换，前面的位置不会被前序改动挤偏。
            for (let i = matches.length - 1; i >= 0; i -= 1) {
              const match = matches[i];
              const text = expandSearchReplacement(replacement, match.groups);
              if (text) {
                tr.insertText(text, match.from, match.to);
              } else {
                tr.delete(match.from, match.to);
              }
            }
            tr.setMeta(searchReplacePluginKey, true);
            storage().activeIndex = 0;
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const fallback: SearchReplaceStorage = {
      searchTerm: '',
      caseSensitive: false,
      useRegex: false,
      activeIndex: -1,
      matches: [],
    };
    // 插件 init 可能早于 storage 就绪，取不到时退化成空条件（无高亮）。
    const storage = (): SearchReplaceStorage =>
      (this.editor?.storage?.searchReplace as SearchReplaceStorage | undefined) ?? fallback;

    const compute = (doc: PMNode): SearchReplaceState => {
      const store = storage();
      const matches = findMatches(doc, store.searchTerm, store.caseSensitive, store.useRegex);
      store.matches = matches;
      if (!matches.length) {
        store.activeIndex = -1;
      } else if (store.activeIndex < 0 || store.activeIndex >= matches.length) {
        store.activeIndex = 0;
      }
      return {
        matches,
        decorations: buildDecorations(matches, store.activeIndex, doc),
      };
    };

    return [
      new Plugin<SearchReplaceState>({
        key: searchReplacePluginKey,
        state: {
          init: (_, state) => compute(state.doc),
          apply: (tr, value, _oldState, newState) => {
            if (!tr.docChanged && !tr.getMeta(searchReplacePluginKey)) {
              return value;
            }
            return compute(newState.doc);
          },
        },
        props: {
          decorations: (state) => searchReplacePluginKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ];
  },
});

export default SearchReplace;
