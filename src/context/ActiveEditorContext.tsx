import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
} from 'react';
import type { ReactNode } from 'react';
import type { Editor } from '@tiptap/react';

// 追踪「当前聚焦的富文本编辑器」。分镜区顶部有一条全局格式工具条，而每张分镜
// 卡片各有一个 Tiptap editor 实例；工具条需要知道该对哪个 editor 施加加粗 /
// 颜色 / 对齐等操作。约定：
//  - 编辑器 focus 时把自身实例注册为 active；
//  - blur 时【不清空】，保留最后聚焦者，这样点击工具条按钮（会短暂夺走 DOM
//    焦点）时选区仍在，可用 editor.chain().focus() 复原后再执行命令；
//  - 编辑器卸载时若自己仍是 active 才清空，避免野指针。
interface ActiveEditorValue {
  activeEditor: Editor | null;
  // 版本号：随 active editor 的 transaction / selection 变化自增，供工具条
  // 订阅刷新按钮高亮态。
  version: number;
  setActiveEditor: (editor: Editor | null) => void;
  clearIfActive: (editor: Editor) => void;
  bumpVersion: () => void;
}

const ActiveEditorContext = createContext<ActiveEditorValue | null>(null);

export function useActiveEditor() {
  const ctx = useContext(ActiveEditorContext);
  if (!ctx)
    throw new Error('useActiveEditor must be used within ActiveEditorProvider');
  return ctx;
}

export function ActiveEditorProvider({ children }: { children: ReactNode }) {
  const [activeEditor, setActiveEditorState] = useState<Editor | null>(null);
  const [version, setVersion] = useState(0);
  const activeRef = useRef<Editor | null>(null);

  const setActiveEditor = useCallback((editor: Editor | null) => {
    activeRef.current = editor;
    setActiveEditorState(editor);
    setVersion((v) => v + 1);
  }, []);

  const clearIfActive = useCallback((editor: Editor) => {
    if (activeRef.current === editor) {
      activeRef.current = null;
      setActiveEditorState(null);
      setVersion((v) => v + 1);
    }
  }, []);

  const bumpVersion = useCallback(() => setVersion((v) => v + 1), []);

  return (
    <ActiveEditorContext.Provider
      value={{
        activeEditor,
        version,
        setActiveEditor,
        clearIfActive,
        bumpVersion,
      }}
    >
      {children}
    </ActiveEditorContext.Provider>
  );
}
