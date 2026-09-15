import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from 'react';
import {
  initDb,
  listProjects,
  createProject as dbCreateProject,
  renameProject as dbRenameProject,
  deleteProject as dbDeleteProject,
  touchProject as dbTouchProject,
  type ProjectRecord,
} from '../lib/db';

type View = 'home' | 'project' | 'library';

interface ProjectContextValue {
  projects: ProjectRecord[];
  openTabs: number[];
  activeProjectId: number | null;
  view: View;
  loading: boolean;
  goHome: () => void;
  goLibrary: () => void;
  openProject: (id: number) => void;
  closeTab: (id: number) => void;
  createProject: (name?: string, storageSpaceId?: number) => Promise<ProjectRecord | null>;
  renameProject: (id: number, name: string) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;
  refreshProjects: () => Promise<void>;
  // Monotonic counter bumped to force the three area stores to re-hydrate the
  // active project from the DB (e.g. after an import overwrites/refills it).
  reloadToken: number;
  reloadActiveProject: () => void;
  // 切项目前的关卡：AutoSaveContext 在这里注册「flush 旧项目」。切换动作会先
  // await 这个回调（拿到的是「切走的那个」projectId），再改 activeProjectId ——
  // 所以 flush 用的一定是旧 projectId，新项目在自己 hydrate 完成前不会被写。
  // 只保留一个注册者（编排层唯一），重复注册以最后一个为准。
  registerBeforeProjectSwitch: (
    fn: (leavingProjectId: number) => Promise<void>
  ) => () => void;
  // 删除项目前的关卡：AutoSaveContext 在这里注册「丢弃该项目的脏内容与待写调度」。
  // 必须同步执行 —— 内容表没有外键约束，一次迟到的写入会把刚删掉的内容重新插回去
  // （projects.id 是 AUTOINCREMENT，不会被复用，所以只是孤儿行，但仍然是脏数据）。
  registerProjectDiscard: (fn: (projectId: number) => void) => () => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [openTabs, setOpenTabs] = useState<number[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [view, setView] = useState<View>('home');
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  // 切项目前要跑的 flush 回调（由 AutoSaveContext 注册）。用 ref 而不是 state：
  // 切换路径要同步读到最新的回调，且注册/注销不该触发重渲染。
  const beforeSwitchRef = useRef<((leavingProjectId: number) => Promise<void>) | null>(null);
  const registerBeforeProjectSwitch = useCallback(
    (fn: (leavingProjectId: number) => Promise<void>) => {
      beforeSwitchRef.current = fn;
      return () => {
        if (beforeSwitchRef.current === fn) beforeSwitchRef.current = null;
      };
    },
    []
  );

  // 离开某个项目前，先把它未保存的内容落库。失败只记日志：不能因为存不上就卡住
  // 用户切项目（此时脏位仍然保留，UI 上仍显示保存失败）。
  const runBeforeSwitch = useCallback(async (leavingProjectId: number | null) => {
    if (leavingProjectId == null) return;
    const fn = beforeSwitchRef.current;
    if (!fn) return;
    try {
      await fn(leavingProjectId);
    } catch (err) {
      console.error('Flush before project switch failed', err);
    }
  }, []);

  const reloadActiveProject = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  // 删除项目时要同步通知编排层丢弃脏内容（见接口注释）。
  const discardRef = useRef<((projectId: number) => void) | null>(null);
  const registerProjectDiscard = useCallback((fn: (projectId: number) => void) => {
    discardRef.current = fn;
    return () => {
      if (discardRef.current === fn) discardRef.current = null;
    };
  }, []);

  const refreshProjects = useCallback(async () => {
    const rows = await listProjects();
    setProjects(rows);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await initDb();
        await refreshProjects();
      } catch (err) {
        console.error('Failed to init projects', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshProjects]);

  const goHome = useCallback(() => {
    setView('home');
  }, []);

  const goLibrary = useCallback(() => {
    setView('library');
  }, []);

  // 切项目：不再静默丢弃未保存内容 —— 先 flush 旧项目（用旧 projectId），
  // flush 落地后才把 activeProjectId 指向新项目，触发三个 store 重新 hydrate。
  // 用 ref 读当前项目，保证回调身份稳定、且永远读到最新值。
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;

  const openProject = useCallback(
    (id: number) => {
      const leaving = activeProjectIdRef.current;
      // 点的是当前项目（只是从首页/素材库切回来）：没有换项目，不需要 flush。
      if (leaving === id) {
        setView('project');
        setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
        return;
      }
      void (async () => {
        await runBeforeSwitch(leaving);
        setActiveProjectId(id);
        setView('project');
        setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
        dbTouchProject(id)
          .then(() =>
            setProjects((prev) =>
              [...prev].sort((a, b) => (a.id === id ? -1 : b.id === id ? 1 : 0))
            )
          )
          .catch(() => {});
      })();
    },
    [runBeforeSwitch]
  );

  const closeTab = useCallback(
    (id: number) => {
      const leaving = activeProjectIdRef.current;
      // 关掉的是当前项目：activeProjectId 会换人（或变 null），内存里的内容会被
      // 丢弃，所以先 flush 再关。
      if (leaving === id) {
        void (async () => {
          await runBeforeSwitch(leaving);
          setOpenTabs((prev) => {
            const next = prev.filter((t) => t !== id);
            if (next.length > 0) {
              setActiveProjectId(next[next.length - 1]);
            } else {
              setActiveProjectId(null);
              setView('home');
            }
            return next;
          });
        })();
        return;
      }
      setOpenTabs((prev) => prev.filter((t) => t !== id));
    },
    [runBeforeSwitch]
  );

  const createProject = useCallback(
    async (name?: string, storageSpaceId?: number) => {
      try {
        if (storageSpaceId == null) throw new Error('Active storage space is not ready');
        // 新建也会切走当前项目：先 flush 旧项目。
        await runBeforeSwitch(activeProjectIdRef.current);
        const existing = projects.length + 1;
        const project = await dbCreateProject(name?.trim() || `项目 ${existing}`, storageSpaceId);
        await refreshProjects();
        setActiveProjectId(project.id);
        setView('project');
        setOpenTabs((prev) => (prev.includes(project.id) ? prev : [...prev, project.id]));
        return project;
      } catch (err) {
        console.error('Failed to create project', err);
        return null;
      }
    },
    [projects.length, refreshProjects, runBeforeSwitch]
  );

  const renameProject = useCallback(
    async (id: number, name: string) => {
      if (!name.trim()) return;
      await dbRenameProject(id, name.trim());
      await refreshProjects();
    },
    [refreshProjects]
  );

  const deleteProject = useCallback(
    async (id: number) => {
      // 先丢弃：删除是异步的，中间任何一次待写的自动保存都会把刚删掉的内容重新
      // 插回库里（内容表没有外键约束，写得进去）。
      discardRef.current?.(id);
      await dbDeleteProject(id);
      setOpenTabs((prev) => prev.filter((t) => t !== id));
      if (activeProjectId === id) {
        setActiveProjectId(null);
        setView('home');
      }
      await refreshProjects();
    },
    [activeProjectId, refreshProjects]
  );

  return (
    <ProjectContext.Provider
      value={{
        projects,
        openTabs,
        activeProjectId,
        view,
        loading,
        goHome,
        goLibrary,
        openProject,
        closeTab,
        createProject,
        renameProject,
        deleteProject,
        refreshProjects,
        reloadToken,
        reloadActiveProject,
        registerBeforeProjectSwitch,
        registerProjectDiscard,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used within ProjectProvider');
  return ctx;
}
