import {
  createContext,
  useContext,
  useState,
  useEffect,
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
  createProject: (name?: string) => Promise<ProjectRecord | null>;
  renameProject: (id: number, name: string) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;
  refreshProjects: () => Promise<void>;
  // Monotonic counter bumped to force the three area stores to re-hydrate the
  // active project from the DB (e.g. after an import overwrites/refills it).
  reloadToken: number;
  reloadActiveProject: () => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [openTabs, setOpenTabs] = useState<number[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [view, setView] = useState<View>('home');
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const reloadActiveProject = useCallback(() => {
    setReloadToken((n) => n + 1);
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

  const openProject = useCallback((id: number) => {
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
  }, []);

  const closeTab = useCallback(
    (id: number) => {
      setOpenTabs((prev) => {
        const next = prev.filter((t) => t !== id);
        if (activeProjectId === id) {
          if (next.length > 0) {
            setActiveProjectId(next[next.length - 1]);
          } else {
            setActiveProjectId(null);
            setView('home');
          }
        }
        return next;
      });
    },
    [activeProjectId]
  );

  const createProject = useCallback(
    async (name?: string) => {
      try {
        const existing = projects.length + 1;
        const project = await dbCreateProject(name?.trim() || `项目 ${existing}`);
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
    [projects.length, refreshProjects]
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
