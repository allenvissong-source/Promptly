import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import type { GenImageItem } from '../../context/GenImagesContext';
import { baseName, ordinalOf } from '../../context/GenImagesContext';
import type { ChipMode } from '../../context/GenSettingsContext';

// A referenceable template candidate shown in the @ popup's 【模板】 tab. Only
// exists when combine mode is on (isCombine() === true). `roleCount` is a live
// hint of how many role checkboxes the inserted templateRef will render.
export interface TemplateCandidate {
  kind: 'template';
  id: string;
  name: string;
  roleCount: number;
}

export interface SuggestionDeps {
  // Live snapshot of the LEFT image list (order = ordinals). Chip labels and
  // serialization resolve against this list.
  getImages: () => GenImageItem[];
  // Current global display mode, so the popup labels match the chips.
  getChipMode: () => ChipMode;
  // Optional: the pool shown in the @ popup. Defaults to getImages (gen-area
  // behavior). Templates pass the whole project image library here so any image
  // can be @-referenced even if it is not yet in the left list.
  getCandidates?: () => GenImageItem[];
  // Optional: named image pools, each rendered as its own @ tab (e.g. 项目 /
  // 全局). When provided (non-empty) these REPLACE the single getCandidates pool
  // and the popup shows one tab per pool. When absent, the popup uses
  // getCandidates (or the left list) as a single, tab-less image pool (gen-area
  // behavior). All pools share the same onPick backfill.
  getImagePools?: () => {
    key: string;
    label: string;
    getItems: () => GenImageItem[];
  }[];
  // Optional: called when a candidate is picked, so the host can backfill the
  // left list (dedup is the host's job; ids are deterministic per scope). May
  // return the resolved left-list item, whose id is used for the chip's slotId
  // (the pool id often differs from the backfilled slot id). When it returns
  // nothing, the candidate's own id is used (gen-area behavior).
  onPick?: (item: GenImageItem) => GenImageItem | void;
  // Optional (Block area): live snapshot of referenceable template candidates
  // for the 【模板】 tab. Only consulted when isCombine() is true.
  getTemplateCandidates?: () => TemplateCandidate[];
  // Optional (Block area): whether combine mode is on for this container. When
  // true, the popup shows two tabs (【图片】/【模板】); otherwise images only.
  isCombine?: () => boolean;
}

// A candidate row shown in the @ popup. `ordinal` is the 1-based position in
// the LEFT list, or null if the image is in the global pool but NOT yet in this
// container's left list. We deliberately do NOT precompute a "predicted" number
// for not-yet-added images: identity in the popup is thumbnail + filename, and
// the number is a purely derived, per-container value that only exists once the
// image actually lands in the left list. See the "全局池 vs 每模板编号" decision.
interface ImageCandidate extends GenImageItem {
  kind: 'image';
  ordinal: number | null;
}

type Candidate = ImageCandidate | TemplateCandidate;

function filterImages(
  pool: GenImageItem[],
  leftList: GenImageItem[],
  query: string
): ImageCandidate[] {
  const q = query.trim().toLowerCase();
  return pool
    .map((img) => ({
      kind: 'image' as const,
      ...img,
      ordinal: ordinalOf(leftList, img.id),
    }))
    .filter((c) => {
      if (!q) return true;
      return (
        (c.ordinal != null && `image${c.ordinal}`.includes(q)) ||
        baseName(c.name).toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q)
      );
    });
}

function filterTemplates(
  pool: TemplateCandidate[],
  query: string
): TemplateCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return pool;
  return pool.filter((t) => t.name.toLowerCase().includes(q));
}

// Build the @-mention suggestion config. In the gen area (no combine) the popup
// only lists images. In a Block card with combine mode on, the popup adds a
// 【模板】 tab whose picks insert a `templateRef` node.
export function createMentionSuggestion(
  deps: SuggestionDeps
): Omit<SuggestionOptions, 'editor'> {
  return {
    char: '@',
    // Allow triggering at start of line and after whitespace.
    allowSpaces: false,

    // We render all tabs ourselves; `items` just returns an image list so the
    // suggestion plugin keeps non-empty state. Per-tab lists are computed live
    // in render() from the active tab's pool / getTemplateCandidates().
    items: ({ query }) => {
      const pools = deps.getImagePools?.();
      const pool =
        pools && pools.length > 0
          ? pools.flatMap((p) => p.getItems())
          : (deps.getCandidates ?? deps.getImages)();
      return filterImages(pool, deps.getImages(), query);
    },

    command: ({ editor, range, props }) => {
      const c = props as Candidate;
      if (c.kind === 'template') {
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            {
              type: 'templateRef',
              attrs: { templateId: c.id, selectedRoleIds: [] },
            },
            { type: 'text', text: ' ' },
          ])
          .run();
        return;
      }
      // Backfill the left list first (host dedups by id/mediaId), so the chip's
      // slotId already resolves to a real left-list slot on the next render.
      const resolved = deps.onPick?.(c);
      // Use the resolved slot's id when the host remapped it (e.g. templates
      // rewrite pool ids to deterministic per-template slot ids).
      const slotId = resolved?.id ?? c.id;
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: 'mention',
            attrs: { slotId, mediaId: c.mediaId, name: c.name },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    },

    render: () => {
      let popup: HTMLDivElement | null = null;
      let query = '';
      // Index into the live tab list (see buildTabs). Reset to 0 whenever the
      // popup opens or the active tab may have gone out of range.
      let activeTab = 0;
      let selectedIndex = 0;
      let cmd: ((item: Candidate) => void) | null = null;

      type Tab =
        | { kind: 'image'; label: string; getItems: () => GenImageItem[] }
        | { kind: 'template'; label: string };

      const combineOn = () => deps.isCombine?.() === true;

      // Build the live tab list each render: one tab per named image pool (or a
      // single implicit image pool when none are provided), plus a 模板 tab when
      // combine mode is on.
      const buildTabs = (): Tab[] => {
        const tabs: Tab[] = [];
        const pools = deps.getImagePools?.();
        if (pools && pools.length > 0) {
          for (const p of pools) {
            tabs.push({ kind: 'image', label: p.label, getItems: p.getItems });
          }
        } else {
          const single = deps.getCandidates ?? deps.getImages;
          tabs.push({ kind: 'image', label: '图片', getItems: single });
        }
        if (combineOn()) tabs.push({ kind: 'template', label: '模板' });
        return tabs;
      };

      const listForTab = (tab: Tab): Candidate[] =>
        tab.kind === 'template'
          ? filterTemplates(deps.getTemplateCandidates?.() ?? [], query)
          : filterImages(tab.getItems(), deps.getImages(), query);

      const renderTabBar = (tabs: Tab[]) => {
        if (!popup || tabs.length <= 1) return;
        const bar = document.createElement('div');
        bar.className =
          'flex items-center gap-1 px-2 pt-1 pb-1.5 border-b border-[#3D3D3D]';
        tabs.forEach((tab, idx) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className =
            'px-2 py-0.5 text-[11px] rounded transition-colors ' +
            (idx === activeTab
              ? 'bg-[#2EC4B6]/20 text-[#2EC4B6]'
              : 'text-[#8A8A8A] hover:text-[#E5E5E5]');
          btn.textContent = tab.label;
          btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            activeTab = idx;
            selectedIndex = 0;
            renderList();
          });
          bar.appendChild(btn);
        });
        popup.appendChild(bar);
      };

      const renderList = () => {
        if (!popup) return;
        popup.innerHTML = '';
        const tabs = buildTabs();
        if (activeTab >= tabs.length) activeTab = 0;
        renderTabBar(tabs);
        const active = tabs[activeTab];
        const list = active ? listForTab(active) : [];
        if (list.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'px-3 py-2 text-[12px] text-[#8A8A8A]';
          empty.textContent =
            active?.kind === 'template' ? '暂无可引用模板' : '暂无图片';
          popup.appendChild(empty);
          return;
        }
        list.forEach((item, i) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className =
            'flex items-center gap-2 w-full px-2 py-1.5 text-left transition-colors ' +
            (i === selectedIndex ? 'bg-[#2EC4B6]/15' : 'hover:bg-[#333333]');

          if (item.kind === 'template') {
            const badge = document.createElement('div');
            badge.className =
              'w-7 h-7 rounded shrink-0 flex items-center justify-center bg-[#2EC4B6]/15 text-[#2EC4B6] text-[13px]';
            badge.textContent = '#';
            row.appendChild(badge);
            const text = document.createElement('div');
            text.className = 'min-w-0 flex-1';
            const primary = document.createElement('div');
            primary.className = 'text-[12px] text-[#E5E5E5] truncate';
            primary.textContent = item.name || '未命名模板';
            const secondary = document.createElement('div');
            secondary.className = 'text-[11px] text-[#8A8A8A] truncate';
            secondary.textContent = `${item.roleCount} 个角色`;
            text.appendChild(primary);
            text.appendChild(secondary);
            row.appendChild(text);
          } else {
            if (item.thumb) {
              const img = document.createElement('img');
              img.src = item.thumb;
              img.className = 'w-7 h-7 rounded object-cover shrink-0';
              row.appendChild(img);
            }
            const text = document.createElement('div');
            text.className = 'min-w-0 flex-1';
            const primary = document.createElement('div');
            primary.className = 'text-[12px] text-[#E5E5E5] truncate';
            const secondary = document.createElement('div');
            secondary.className = 'text-[11px] text-[#8A8A8A] truncate';
            if (item.ordinal != null) {
              primary.textContent = baseName(item.name);
              secondary.textContent = `已在本列表 · Image${item.ordinal}`;
            } else {
              primary.textContent = baseName(item.name);
              secondary.textContent = '未加入 · 选择后加入本列表';
            }
            text.appendChild(primary);
            text.appendChild(secondary);
            row.appendChild(text);
          }

          row.addEventListener('mousedown', (e) => {
            e.preventDefault();
            cmd?.(item);
          });
          popup!.appendChild(row);
        });
      };

      const positionPopup = (props: SuggestionProps) => {
        if (!popup) return;
        const rect = props.clientRect?.();
        if (!rect) return;
        popup.style.left = `${rect.left}px`;
        popup.style.top = `${rect.bottom + 6}px`;
      };

      return {
        onStart: (props: SuggestionProps) => {
          query = props.query;
          activeTab = 0;
          selectedIndex = 0;
          cmd = (item) => props.command(item);
          popup = document.createElement('div');
          popup.className =
            'scrollbar-dark fixed z-[10000] w-[240px] max-h-[280px] overflow-y-auto rounded-md border border-[#3D3D3D] bg-[#252525] py-1 shadow-xl';
          document.body.appendChild(popup);
          renderList();
          positionPopup(props);
        },
        onUpdate: (props: SuggestionProps) => {
          query = props.query;
          cmd = (item) => props.command(item);
          const tabs = buildTabs();
          if (activeTab >= tabs.length) activeTab = 0;
          const active = tabs[activeTab];
          const list = active ? listForTab(active) : [];
          if (selectedIndex >= list.length) selectedIndex = 0;
          renderList();
          positionPopup(props);
        },
        onKeyDown: (props: { event: KeyboardEvent }) => {
          const { event } = props;
          const tabs = buildTabs();
          if (activeTab >= tabs.length) activeTab = 0;
          if (
            tabs.length > 1 &&
            (event.key === 'ArrowRight' || event.key === 'ArrowLeft')
          ) {
            const dir = event.key === 'ArrowRight' ? 1 : -1;
            activeTab = (activeTab + dir + tabs.length) % tabs.length;
            selectedIndex = 0;
            renderList();
            return true;
          }
          const active = tabs[activeTab];
          const list = active ? listForTab(active) : [];
          if (event.key === 'ArrowDown') {
            selectedIndex = (selectedIndex + 1) % Math.max(list.length, 1);
            renderList();
            return true;
          }
          if (event.key === 'ArrowUp') {
            selectedIndex =
              (selectedIndex - 1 + list.length) % Math.max(list.length, 1);
            renderList();
            return true;
          }
          if (event.key === 'Enter') {
            if (list[selectedIndex]) cmd?.(list[selectedIndex]);
            return true;
          }
          if (event.key === 'Escape') {
            popup?.remove();
            popup = null;
            return true;
          }
          return false;
        },
        onExit: () => {
          popup?.remove();
          popup = null;
        },
      };
    },
  };
}
