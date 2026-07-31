import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from 'react';
import type { JSONContent } from '@tiptap/react';
import type { GenImageItem } from './GenImagesContext';
import { useProject } from './ProjectContext';
import { useHistory } from './HistoryContext';
import { loadTemplates, saveTemplates } from '../lib/db';

// One template in the 模板区: a named Tiptap doc (角色/场景...) plus its own
// ordered image list. @ chips inside reference this template's images; ordinals
// (Image1/2/3) restart at 1 per template and follow the image list order. The
// @ candidate pool is the whole project library, but picking one backfills it
// into this template's list (deduped by media id).
export interface GenTemplateData {
  id: string;
  name: string;
  content: JSONContent | null;
  // Title-bar icons (both default on). referenceable: template shows up as an
  // @template candidate in the Block area. includeTitle: template's own copy
  // prepends `# name`.
  referenceable: boolean;
  includeTitle: boolean;
  images: GenImageItem[];
}

interface GenTemplateStoreValue {
  templates: GenTemplateData[];
  dirty: boolean;
  save: () => Promise<void>;
  addTemplate: () => void;
  deleteTemplate: (id: string) => void;
  // Duplicate a template (name + " 副本", copied content/flags/images with fresh
  // slot ids) and insert it right after the source.
  duplicateTemplate: (id: string) => void;
  renameTemplate: (id: string, name: string) => void;
  setContent: (id: string, content: JSONContent) => void;
  // Toggle the two title-bar flags.
  setReferenceable: (id: string, value: boolean) => void;
  setIncludeTitle: (id: string, value: boolean) => void;
  // Append an image to a template's list, deduped by media id (an image can
  // appear only once on the left). Used by both @-pick and drag-into-card.
  // Returns the resolved left-list item (with the deterministic slot id), so an
  // @-pick can use that id for its chip's slotId.
  addImageToTemplate: (templateId: string, item: GenImageItem) => GenImageItem;
  // Create a new template seeded with one image (drag onto blank area).
  // Returns the new template id so a multi-image drop can append the rest.
  newTemplateWithImage: (item: GenImageItem) => string;
  reorderInTemplate: (templateId: string, from: number, to: number) => void;
  // Reorder the templates themselves (card-level up/down drag).
  reorderTemplates: (from: number, to: number) => void;
  // Remove an image from a template's list (referencing chips turn "已删除").
  deleteImageFromTemplate: (templateId: string, slotId: string) => void;
  // Called when a material is renamed in the media library, so template rows
  // (and @ chips skinned by name) referencing it update live.
  renameMedia: (mediaId: number, name: string) => void;
}

const GenTemplateStoreContext = createContext<GenTemplateStoreValue | null>(null);

export function useGenTemplateStore(): GenTemplateStoreValue {
  const ctx = useContext(GenTemplateStoreContext);
  if (!ctx)
    throw new Error('useGenTemplateStore must be used within GenTemplateStoreProvider');
  return ctx;
}

const rid = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// Deterministic slot id per (template, media): keeps the @-inserted chip's
// slotId equal to the backfilled left-list slot's id, so dedup by media id and
// resolution across reload are both stable.
const tslotId = (templateId: string, mediaId: number) =>
  `tslot-${templateId}-${mediaId}`;

export function GenTemplateStoreProvider({ children }: { children: ReactNode }) {
  const { activeProjectId, reloadToken } = useProject();
  const { register, record } = useHistory();
  const [templates, setTemplates] = useState<GenTemplateData[]>([]);
  const [dirty, setDirty] = useState(false);

  // Manual save only, same rationale as GenStore: hydration gates dirty via
  // readyRef; templatesRef feeds the keyboard handler without stale closures.
  const readyRef = useRef(false);
  const templatesRef = useRef(templates);
  templatesRef.current = templates;

  // Register on the unified undo/redo timeline (structural changes only).
  useEffect(() => {
    register('tpl', {
      snapshot: () => JSON.parse(JSON.stringify(templatesRef.current)),
      restore: (data) => setTemplates(data as GenTemplateData[]),
    });
  }, [register]);

  // Hydrate on project switch. Unsaved changes in the outgoing project are
  // discarded — the trade-off of manual save.
  useEffect(() => {
    readyRef.current = false;
    setDirty(false);
    if (activeProjectId == null) {
      setTemplates([]);
      return;
    }
    const pid = activeProjectId;
    let cancelled = false;
    (async () => {
      try {
        const loaded = await loadTemplates(pid);
        if (cancelled) return;
        setTemplates(
          loaded.map((t) => ({
            id: t.id,
            name: t.name,
            content: t.content ? (JSON.parse(t.content) as JSONContent) : null,
            referenceable: t.referenceable,
            includeTitle: t.includeTitle,
            images: t.slots.map((s) => ({
              id: s.id,
              mediaId: s.media_id,
              name: s.name,
              thumb: s.thumb ?? '',
              path: s.path ?? '',
              meta: s.meta ?? '',
              type: s.type,
            })),
          }))
        );
      } catch (err) {
        console.error('Failed to load templates', err);
        if (!cancelled) setTemplates([]);
      } finally {
        if (!cancelled) readyRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, reloadToken]);

  // Any post-hydration change marks templates dirty (unsaved).
  useEffect(() => {
    if (!readyRef.current) return;
    setDirty(true);
  }, [templates]);

  const save = useCallback(async () => {
    if (activeProjectId == null) return;
    const pid = activeProjectId;
    try {
      await saveTemplates(
        pid,
        templatesRef.current.map((t) => ({
          id: t.id,
          name: t.name,
          content: t.content ? JSON.stringify(t.content) : null,
          referenceable: t.referenceable,
          includeTitle: t.includeTitle,
          slots: t.images.map((it) => ({
            id: it.id,
            media_id: it.mediaId,
            name: it.name,
            thumb: it.thumb || null,
            path: it.path || null,
            meta: it.meta || null,
            type: it.type,
          })),
        }))
      );
      setDirty(false);
    } catch (err) {
      console.error('Failed to save templates', err);
    }
  }, [activeProjectId]);

  // B7: Ctrl+S is handled by ONE global handler in App's top bar (which calls
  // the combined save across all stores). The per-store handler was removed so
  // the shortcut no longer fires once per store. `save` stays exported for that
  // central handler and the Save button.

  const addTemplate = useCallback(() => {
    record('tpl');
    setTemplates((prev) => [
      ...prev,
      {
        id: rid('tpl'),
        name: '未命名模板',
        content: null,
        referenceable: true,
        includeTitle: true,
        images: [],
      },
    ]);
  }, [record]);

  const deleteTemplate = useCallback((id: string) => {
    record('tpl');
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  }, [record]);

  // Duplicate a template: deep-copy its content/flags/images, mint a fresh tpl
  // id, and re-derive every slot id for the new template (slot ids are
  // deterministic per (template, media), so reusing the source's would collide).
  // The copy lands directly after the source.
  const duplicateTemplate = useCallback((id: string) => {
    record('tpl');
    setTemplates((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx < 0) return prev;
      const src = prev[idx];
      const newId = rid('tpl');
      const copy: GenTemplateData = {
        id: newId,
        name: `${src.name} 副本`,
        content: src.content ? JSON.parse(JSON.stringify(src.content)) : null,
        referenceable: src.referenceable,
        includeTitle: src.includeTitle,
        images: src.images.map((it) => ({
          ...it,
          id: tslotId(newId, it.mediaId),
        })),
      };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  }, [record]);

  const renameTemplate = useCallback((id: string, name: string) => {
    setTemplates((prev) =>
      prev.map((t) => (t.id === id ? { ...t, name } : t))
    );
  }, []);

  const setContent = useCallback((id: string, content: JSONContent) => {
    setTemplates((prev) =>
      prev.map((t) => (t.id === id ? { ...t, content } : t))
    );
  }, []);

  const setReferenceable = useCallback((id: string, value: boolean) => {
    record('tpl');
    setTemplates((prev) =>
      prev.map((t) => (t.id === id ? { ...t, referenceable: value } : t))
    );
  }, [record]);

  const setIncludeTitle = useCallback((id: string, value: boolean) => {
    record('tpl');
    setTemplates((prev) =>
      prev.map((t) => (t.id === id ? { ...t, includeTitle: value } : t))
    );
  }, [record]);

  // Append an image to a template's list, deduped by media id. The slot id is
  // derived from (template, media) so it matches the @-inserted chip's slotId.
  const addImageToTemplate = useCallback(
    (templateId: string, item: GenImageItem): GenImageItem => {
      const resolved = { ...item, id: tslotId(templateId, item.mediaId) };
      record('tpl');
      setTemplates((prev) =>
        prev.map((t) => {
          if (t.id !== templateId) return t;
          if (t.images.some((it) => it.mediaId === item.mediaId)) return t;
          return {
            ...t,
            images: [...t.images, resolved],
          };
        })
      );
      return resolved;
    },
    [record]
  );

  const newTemplateWithImage = useCallback((item: GenImageItem) => {
    record('tpl');
    const id = rid('tpl');
    setTemplates((prev) => [
      ...prev,
      {
        id,
        name: '未命名模板',
        content: null,
        referenceable: true,
        includeTitle: true,
        images: [{ ...item, id: tslotId(id, item.mediaId) }],
      },
    ]);
    return id;
  }, [record]);

  const reorderInTemplate = useCallback(
    (templateId: string, from: number, to: number) => {
      record('tpl');
      setTemplates((prev) =>
        prev.map((t) => {
          if (t.id !== templateId) return t;
          if (to < 0 || to >= t.images.length || from === to) return t;
          const next = [...t.images];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          return { ...t, images: next };
        })
      );
    },
    [record]
  );

  // Card-level reorder: move a whole template up/down within the list.
  const reorderTemplates = useCallback((from: number, to: number) => {
    record('tpl');
    setTemplates((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, [record]);

  // Remove an image from a template's list. Unlike gen cells, an empty template
  // is NOT auto-removed (templates are named containers the user manages).
  const deleteImageFromTemplate = useCallback(
    (templateId: string, slotId: string) => {
      record('tpl');
      setTemplates((prev) =>
        prev.map((t) =>
          t.id === templateId
            ? { ...t, images: t.images.filter((it) => it.id !== slotId) }
            : t
        )
      );
    },
    [record]
  );

  const renameMedia = useCallback((mediaId: number, name: string) => {
    setTemplates((prev) =>
      prev.map((t) => ({
        ...t,
        images: t.images.map((it) =>
          it.mediaId === mediaId ? { ...it, name } : it
        ),
      }))
    );
  }, []);

  return (
    <GenTemplateStoreContext.Provider
      value={{
        templates,
        dirty,
        save,
        addTemplate,
        deleteTemplate,
        duplicateTemplate,
        renameTemplate,
        setContent,
        setReferenceable,
        setIncludeTitle,
        addImageToTemplate,
        newTemplateWithImage,
        reorderInTemplate,
        reorderTemplates,
        deleteImageFromTemplate,
        renameMedia,
      }}
    >
      {children}
    </GenTemplateStoreContext.Provider>
  );
}
