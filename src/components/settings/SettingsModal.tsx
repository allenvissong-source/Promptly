import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Check,
  ChevronDown,
  ChevronUp,
  FolderPlus,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { buildRichClipboard, type ExportRuleMode } from '../../lib/richClipboard';
import {
  createExportFormatRule,
  createStorageSpace,
  deleteExportFormatRule,
  deleteStorageSpace,
  listExportFormatRules,
  updateExportFormatRule,
  updateStorageSpace,
  type ExportFormatRule,
  type StorageSpace,
} from '../../lib/db';
import { useGenSettings, type ChipMode } from '../../context/GenSettingsContext';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type SectionKey = 'general' | 'storage' | 'copy';

type DraftRule = {
  id: number | null;
  name: string;
  pattern: string;
  enabled: boolean;
  sortOrder: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  textColor: string;
  // 'style' = 命中片段着色；'replace' = 复制/导出时把命中片段换成 replacement
  mode: ExportRuleMode;
  replacement: string;
};

const SECTION_ITEMS: { key: SectionKey; label: string }[] = [
  { key: 'general', label: '常规' },
  { key: 'storage', label: '素材库' },
  { key: 'copy', label: '复制格式' },
];

const DEFAULT_PATTERN = '@(图|图片|视频|音频)\\d+';
const SAMPLE_TEXT = '示例：@图1 @图片2 @视频3 @音频4 普通文本';

function toDraftRule(rule: ExportFormatRule): DraftRule {
  return {
    id: rule.id,
    name: rule.name,
    pattern: rule.pattern,
    enabled: rule.enabled !== 0,
    sortOrder: rule.sort_order,
    bold: rule.bold !== 0,
    italic: rule.italic !== 0,
    underline: rule.underline !== 0,
    strike: rule.strike !== 0,
    textColor: rule.text_color || '#ff0000',
    mode: rule.rule_mode === 'replace' ? 'replace' : 'style',
    replacement: rule.replacement ?? '',
  };
}

function validatePattern(pattern: string): string | null {
  if (!pattern.trim()) return '正则表达式不能为空';
  try {
    new RegExp(pattern, 'g');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function pickDirectory(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === 'string' ? selected : null;
}

// Where the ffmpeg in use came from, mirrored from the Rust `FfmpegStatus`.
type FfmpegSource = 'bundled' | 'manual' | 'downloaded' | 'path' | 'none';

interface FfmpegStatusInfo {
  available: boolean;
  path: string | null;
  managed: boolean;
  source: FfmpegSource;
  version: string | null;
}

const FFMPEG_SOURCE_LABEL: Record<FfmpegSource, string> = {
  bundled: '随应用内置',
  manual: '手动指定',
  downloaded: '早期版本下载',
  path: '系统 PATH',
  none: '未找到',
};

function ruleToDb(rule: DraftRule): Omit<ExportFormatRule, 'id' | 'created_at' | 'updated_at'> {
  return {
    name: rule.name.trim() || '未命名规则',
    pattern: rule.pattern,
    enabled: rule.enabled ? 1 : 0,
    sort_order: rule.sortOrder,
    bold: rule.bold ? 1 : 0,
    italic: rule.italic ? 1 : 0,
    underline: rule.underline ? 1 : 0,
    strike: rule.strike ? 1 : 0,
    text_color: rule.textColor || '#ff0000',
    rule_mode: rule.mode,
    replacement: rule.replacement,
  };
}

export default function SettingsModal({ open: isOpen, onClose }: SettingsModalProps) {
  const settings = useGenSettings();
  const {
    chipMode,
    setChipMode,
    showFormatToolbar,
    setShowFormatToolbar,
    copyAsTableCell,
    setCopyAsTableCell,
    applyReplaceOnExport,
    setApplyReplaceOnExport,
    storageSpaces,
    activeStorageSpaceId,
    activeStorageSpace,
    storageBusy,
    switchStorageSpace,
    refreshSettings,
  } = settings;
  const [section, setSection] = useState<SectionKey>('general');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newSpaceName, setNewSpaceName] = useState('新素材库');
  const [renameSpaceId, setRenameSpaceId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [rules, setRules] = useState<DraftRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatusInfo | null>(null);
  const [ffmpegLoading, setFfmpegLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    queueMicrotask(() => {
      setMessage(null);
      setError(null);
      setSection('general');
      void refreshRules();
      void refreshFfmpeg();
    });
  }, [isOpen]);

  async function refreshFfmpeg() {
    setFfmpegLoading(true);
    try {
      setFfmpeg(await invoke<FfmpegStatusInfo>('ffmpeg_status'));
    } catch (err) {
      setError(`读取 ffmpeg 状态失败：${err}`);
    } finally {
      setFfmpegLoading(false);
    }
  }

  // Escape hatch for a broken/absent bundled sidecar: let the user point at
  // their own ffmpeg. Rust validates it by running `-version` before saving.
  async function chooseFfmpeg() {
    const selected = await open({ directory: false, multiple: false });
    if (typeof selected !== 'string') return;
    await runAction('已更新 ffmpeg 路径', async () => {
      await invoke('set_ffmpeg_override', { path: selected });
      await refreshFfmpeg();
    });
  }

  async function clearFfmpegOverride() {
    await runAction('已恢复为内置 ffmpeg', async () => {
      await invoke('set_ffmpeg_override', { path: null });
      await refreshFfmpeg();
    });
  }

  async function refreshRules() {
    setRulesLoading(true);
    try {
      const dbRules = await listExportFormatRules();
      setRules(dbRules.map(toDraftRule));
    } catch (err) {
      setError(`读取复制格式规则失败：${err}`);
    } finally {
      setRulesLoading(false);
    }
  }

  async function runAction(label: string, action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(label);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function createEmptySpace() {
    const dir = await pickDirectory();
    if (!dir) return;
    await runAction('已创建并切换到新素材库', async () => {
      const validation = await invoke<{ normalized_root: string }>('create_storage_space', { storageRoot: dir });
      const space = await createStorageSpace(newSpaceName.trim() || '新素材库', validation.normalized_root || dir);
      await switchStorageSpace(space.id);
      await refreshSettings();
    });
  }

  async function addExistingSpace() {
    const dir = await pickDirectory();
    if (!dir) return;
    await runAction('已添加已有素材库', async () => {
      const validation = await invoke<{ normalized_root: string }>('add_storage_space', { storageRoot: dir });
      await createStorageSpace(newSpaceName.trim() || '已有素材库', validation.normalized_root || dir);
      await refreshSettings();
    });
  }

  async function migrateActiveSpace() {
    if (!activeStorageSpace) return;
    const dir = await pickDirectory();
    if (!dir) return;
    await runAction('已搬迁当前素材库', async () => {
      const result = await invoke<{ phase: string }>('migrate_storage_space', {
        sourceRoot: activeStorageSpace.root_path,
        destinationRoot: dir,
        expectations: null,
      });
      if (result.phase !== 'complete') throw new Error('搬迁未完成');
      await refreshSettings();
    });
  }

  async function saveRename(space: StorageSpace) {
    await runAction('已重命名素材空间', async () => {
      await updateStorageSpace(space.id, { name: renameValue.trim() || space.name, rootPath: space.root_path });
      setRenameSpaceId(null);
      await refreshSettings();
    });
  }

  async function removeSpace(space: StorageSpace) {
    if (space.id === activeStorageSpaceId) return;
    await runAction('已移除素材空间注册信息', async () => {
      await deleteStorageSpace(space.id);
      await refreshSettings();
    });
  }

  function patchRule(index: number, patch: Partial<DraftRule>) {
    setRules((prev) => prev.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  }

  async function addRule() {
    const nextOrder = rules.reduce((max, rule) => Math.max(max, rule.sortOrder), -1) + 1;
    setRules((prev) => [
      ...prev,
      {
        id: null,
        name: '新规则',
        pattern: DEFAULT_PATTERN,
        enabled: true,
        sortOrder: nextOrder,
        bold: true,
        italic: false,
        underline: false,
        strike: false,
        textColor: '#ff0000',
        mode: 'style',
        replacement: '',
      },
    ]);
  }

  async function saveRule(index: number) {
    const rule = { ...rules[index], sortOrder: index };
    const validation = validatePattern(rule.pattern);
    if (validation) {
      setError(`规则“${rule.name}”无效：${validation}`);
      return;
    }
    await runAction('已保存复制格式规则', async () => {
      if (rule.id == null) {
        await createExportFormatRule(ruleToDb(rule));
      } else {
        await updateExportFormatRule(rule.id, ruleToDb(rule));
      }
      await refreshRules();
      await refreshSettings();
    });
  }

  async function deleteRule(index: number) {
    const rule = rules[index];
    await runAction('已删除复制格式规则', async () => {
      if (rule.id != null) await deleteExportFormatRule(rule.id);
      setRules((prev) => prev.filter((_, i) => i !== index));
      await refreshRules();
      await refreshSettings();
    });
  }

  async function moveRule(index: number, direction: -1 | 1) {
    if (hasUnsavedRule) {
      setError('请先保存新增规则后再调整顺序');
      return;
    }
    const target = index + direction;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target], next[index]];
    const ordered = next.map((rule, i) => ({ ...rule, sortOrder: i }));
    setRules(ordered);
    await runAction('已更新规则顺序', async () => {
      await Promise.all(
        ordered
          .filter((rule) => rule.id != null)
          .map((rule) => updateExportFormatRule(rule.id!, { sort_order: rule.sortOrder }))
      );
      await refreshSettings();
    });
  }

  const hasUnsavedRule = rules.some((rule) => rule.id == null);

  const preview = useMemo(() => {
    return buildRichClipboard(
      SAMPLE_TEXT,
      rules.map((rule, index) => ({
        id: rule.id ?? -index - 1,
        name: rule.name,
        pattern: rule.pattern,
        enabled: rule.enabled,
        sortOrder: index,
        bold: rule.bold,
        italic: rule.italic,
        underline: rule.underline,
        strike: rule.strike,
        textColor: rule.textColor || null,
        mode: rule.mode,
        replacement: rule.replacement,
      }))
    );
  }, [rules]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 px-6 py-8">
      <div className="flex max-h-full w-full max-w-[980px] overflow-hidden rounded-2xl border border-[#3D3D3D] bg-[#252525] shadow-2xl">
        <aside className="w-44 shrink-0 border-r border-[#3D3D3D] bg-[#202020] p-3">
          <div className="mb-3 px-2 text-[13px] font-semibold text-[#E5E5E5]">设置</div>
          <div className="space-y-1">
            {SECTION_ITEMS.map((item) => (
              <button
                key={item.key}
                onClick={() => setSection(item.key)}
                className={`w-full rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${
                  section === item.key
                    ? 'bg-[#2EC4B6]/15 text-[#2EC4B6]'
                    : 'text-[#BDBDBD] hover:bg-[#303030] hover:text-[#E5E5E5]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </aside>

        <main className="flex min-h-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-[#3D3D3D] px-5 py-3">
            <div>
              <div className="text-[15px] font-semibold text-[#E5E5E5]">
                {SECTION_ITEMS.find((item) => item.key === section)?.label}
              </div>
              <div className="mt-0.5 text-[12px] text-[#8A8A8A]">应用级设置，修改后立即生效。</div>
            </div>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[#8A8A8A] hover:bg-[#333333] hover:text-[#E5E5E5]"
              title="关闭设置"
            >
              <X size={16} />
            </button>
          </header>

          {(message || error) && (
            <div className={`mx-5 mt-4 rounded-lg px-3 py-2 text-[12px] ${error ? 'bg-[#E53935]/15 text-[#FF8A80]' : 'bg-[#2EC4B6]/15 text-[#2EC4B6]'}`}>
              {error || message}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-dark">
            {section === 'general' && (
              <section className="space-y-5">
                <div className="rounded-xl border border-[#3D3D3D] bg-[#2A2A2A] p-4">
                  <div className="mb-3 text-[14px] font-medium text-[#E5E5E5]">引用显示</div>
                  <div className="grid grid-cols-2 gap-3">
                    {([
                      ['code', '编号', '显示为 Image1 / Image2'],
                      ['name', '文件名', '显示素材文件名'],
                    ] as [ChipMode, string, string][]).map(([value, title, desc]) => (
                      <button
                        key={value}
                        onClick={() => setChipMode(value)}
                        className={`rounded-lg border p-3 text-left transition-colors ${
                          chipMode === value
                            ? 'border-[#2EC4B6] bg-[#2EC4B6]/10 text-[#E5E5E5]'
                            : 'border-[#3D3D3D] bg-[#252525] text-[#BDBDBD] hover:bg-[#303030]'
                        }`}
                      >
                        <div className="flex items-center justify-between text-[13px] font-medium">
                          {title}
                          {chipMode === value && <Check size={14} className="text-[#2EC4B6]" />}
                        </div>
                        <div className="mt-1 text-[12px] text-[#8A8A8A]">{desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-center justify-between rounded-xl border border-[#3D3D3D] bg-[#2A2A2A] p-4">
                  <div>
                    <div className="text-[14px] font-medium text-[#E5E5E5]">显示格式工具栏</div>
                    <div className="mt-1 text-[12px] text-[#8A8A8A]">与“面板”菜单中的格式工具条开关共用同一状态。</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={showFormatToolbar}
                    onChange={(event) => setShowFormatToolbar(event.target.checked)}
                    className="h-4 w-4 accent-[#2EC4B6]"
                  />
                </label>

                <div className="rounded-xl border border-[#3D3D3D] bg-[#2A2A2A] p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-[14px] font-medium text-[#E5E5E5]">视频处理</div>
                      <div className="mt-1 text-[12px] text-[#8A8A8A]">
                        用于生成视频封面、读取时长，以及为 HEVC/H.265 视频生成可预览副本。ffmpeg 已随应用内置，无需联网下载。
                      </div>
                    </div>
                    <button onClick={() => void refreshFfmpeg()} disabled={ffmpegLoading} className="settings-action-btn shrink-0">
                      <RefreshCw size={13} />重新检测
                    </button>
                  </div>

                  <div className="mt-3 rounded-lg bg-[#1E1E1E] p-3 text-[12px]">
                    {ffmpegLoading && !ffmpeg ? (
                      <div className="text-[#8A8A8A]">检测中…</div>
                    ) : ffmpeg ? (
                      <>
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block h-2 w-2 shrink-0 rounded-full ${ffmpeg.available ? 'bg-[#2EC4B6]' : 'bg-[#E53935]'}`}
                          />
                          <span className={ffmpeg.available ? 'text-[#E5E5E5]' : 'text-[#FF8A80]'}>
                            {ffmpeg.available ? '可用' : '不可用'}
                          </span>
                          <span className="text-[#8A8A8A]">·</span>
                          <span className="text-[#BDBDBD]">{FFMPEG_SOURCE_LABEL[ffmpeg.source]}</span>
                        </div>
                        {ffmpeg.path && <div className="mt-1 break-all text-[#8A8A8A]">{ffmpeg.path}</div>}
                        {ffmpeg.version && <div className="mt-1 break-all text-[#6F6F6F]">{ffmpeg.version}</div>}
                        {!ffmpeg.available && (
                          <div className="mt-2 text-[11px] text-[#FBBF24]">
                            未找到可用的 ffmpeg，视频将缺少封面与 HEVC 预览（素材本身仍可正常导入）。可手动指定一个 ffmpeg 可执行文件，
                            macOS 也可先执行 brew install ffmpeg 后重新检测。
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-[#8A8A8A]">尚未检测</div>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button onClick={() => void chooseFfmpeg()} disabled={busy} className="settings-action-btn">
                      <FolderPlus size={13} />手动指定 ffmpeg
                    </button>
                    {ffmpeg?.source === 'manual' && (
                      <button onClick={() => void clearFfmpegOverride()} disabled={busy} className="settings-action-btn">
                        <RefreshCw size={13} />恢复内置
                      </button>
                    )}
                  </div>
                </div>
              </section>
            )}

            {section === 'storage' && (
              <section className="space-y-4">
                <div className="rounded-xl border border-[#3D3D3D] bg-[#2A2A2A] p-4">
                  <div className="text-[14px] font-medium text-[#E5E5E5]">当前空间</div>
                  <div className="mt-2 rounded-lg bg-[#1E1E1E] p-3 text-[12px] text-[#BDBDBD]">
                    <div>{activeStorageSpace?.name ?? '未选择'}</div>
                    <div className="mt-1 break-all text-[#8A8A8A]">{activeStorageSpace?.root_path ?? '素材空间尚未就绪'}</div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <input
                      value={newSpaceName}
                      onChange={(event) => setNewSpaceName(event.target.value)}
                      placeholder="空间名称"
                      className="h-8 w-48 rounded-lg bg-[#1E1E1E] px-3 text-[12px] text-[#E5E5E5] outline-none ring-1 ring-[#3D3D3D] focus:ring-[#2EC4B6]"
                    />
                    <button onClick={() => void createEmptySpace()} disabled={busy} className="settings-action-btn">
                      <FolderPlus size={13} />新建空素材库
                    </button>
                    <button onClick={() => void addExistingSpace()} disabled={busy} className="settings-action-btn">
                      <Plus size={13} />添加已有素材库
                    </button>
                    <button onClick={() => void migrateActiveSpace()} disabled={busy || !activeStorageSpace} className="settings-action-btn">
                      <RefreshCw size={13} />搬迁当前素材库
                    </button>
                  </div>
                </div>

                <div className="rounded-xl border border-[#3D3D3D] bg-[#2A2A2A] p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="text-[14px] font-medium text-[#E5E5E5]">已注册空间</div>
                    <span className="text-[12px] text-[#8A8A8A]">{storageSpaces.length} 个</span>
                  </div>
                  <div className="space-y-2">
                    {storageSpaces.map((space) => {
                      const current = space.id === activeStorageSpaceId;
                      const renaming = renameSpaceId === space.id;
                      return (
                        <div key={space.id} className="rounded-lg border border-[#3D3D3D] bg-[#252525] p-3">
                          <div className="flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                              {renaming ? (
                                <input
                                  value={renameValue}
                                  onChange={(event) => setRenameValue(event.target.value)}
                                  className="h-8 w-full rounded-lg bg-[#1E1E1E] px-3 text-[12px] text-[#E5E5E5] outline-none ring-1 ring-[#2EC4B6]"
                                />
                              ) : (
                                <div className="flex items-center gap-2 text-[13px] font-medium text-[#E5E5E5]">
                                  {space.name}
                                  {current && <span className="rounded bg-[#2EC4B6]/15 px-2 py-0.5 text-[11px] text-[#2EC4B6]">当前</span>}
                                </div>
                              )}
                              <div className="mt-1 break-all text-[12px] text-[#8A8A8A]">{space.root_path}</div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              {renaming ? (
                                <button onClick={() => void saveRename(space)} className="icon-btn" title="保存名称"><Save size={13} /></button>
                              ) : (
                                <button onClick={() => { setRenameSpaceId(space.id); setRenameValue(space.name); }} className="small-btn">重命名</button>
                              )}
                              <button onClick={() => void switchStorageSpace(space.id)} disabled={current || storageBusy} className="small-btn">切换</button>
                              <button onClick={() => void removeSpace(space)} disabled={current || storageSpaces.length <= 1} className="icon-btn" title="移除注册信息"><Trash2 size={13} /></button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>
            )}

            {section === 'copy' && (
              <section className="space-y-4">
                <label className="flex items-center justify-between rounded-xl border border-[#3D3D3D] bg-[#2A2A2A] p-4">
                  <div className="pr-4">
                    <div className="text-[14px] font-medium text-[#E5E5E5]">粘贴到表格时合并为单个单元格</div>
                    <div className="mt-1 text-[12px] text-[#8A8A8A]">开启后，复制的内容粘到飞书表格 / Excel 会把整段文本放进同一个单元格（单元格内保留换行），而不是每行拆成一格。粘到文档等非表格目标不受影响。</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={copyAsTableCell}
                    onChange={(event) => setCopyAsTableCell(event.target.checked)}
                    className="h-4 w-4 shrink-0 accent-[#2EC4B6]"
                  />
                </label>
                <label className="flex items-center justify-between rounded-xl border border-[#3D3D3D] bg-[#2A2A2A] p-4">
                  <div className="pr-4">
                    <div className="text-[14px] font-medium text-[#E5E5E5]">复制 / 导出时自动执行替换规则</div>
                    <div className="mt-1 text-[12px] text-[#8A8A8A]">开启后，下方「模式=查找替换」的规则会在复制文本（单卡复制 / 复制全部）时自动生效；编辑器里的原文不会被改动。关闭则只保留着色规则。</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={applyReplaceOnExport}
                    onChange={(event) => setApplyReplaceOnExport(event.target.checked)}
                    className="h-4 w-4 shrink-0 accent-[#2EC4B6]"
                  />
                </label>
                <div className="rounded-xl border border-[#3D3D3D] bg-[#2A2A2A] p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <div className="text-[14px] font-medium text-[#E5E5E5]">正则格式规则</div>
                      <div className="mt-1 text-[12px] text-[#8A8A8A]">仅影响复制结果，不改变编辑器内容、Tiptap JSON 或纯文本序列化。</div>
                    </div>
                    <button onClick={() => void addRule()} className="settings-action-btn"><Plus size={13} />新增规则</button>
                  </div>
                  {rulesLoading ? <div className="text-[12px] text-[#8A8A8A]">读取中…</div> : null}
                  {hasUnsavedRule && <div className="mb-3 rounded-lg bg-[#F59E0B]/10 px-3 py-2 text-[11px] text-[#FBBF24]">新增规则保存后才能调整顺序，避免临时顺序与数据库顺序不一致。</div>}
                  <div className="space-y-3">
                    {rules.map((rule, index) => {
                      const patternError = validatePattern(rule.pattern);
                      return (
                        <div key={rule.id ?? `new-${index}`} className="rounded-lg border border-[#3D3D3D] bg-[#252525] p-3">
                          <div className="grid grid-cols-[1fr_1.6fr_auto] gap-2">
                            <input value={rule.name} onChange={(e) => patchRule(index, { name: e.target.value })} placeholder="规则名称" className="settings-input" />
                            <input value={rule.pattern} onChange={(e) => patchRule(index, { pattern: e.target.value })} placeholder="正则表达式" className={`settings-input ${patternError ? 'settings-input-error' : ''}`} />
                            <div className="flex items-center gap-1">
                              <button onClick={() => void moveRule(index, -1)} disabled={hasUnsavedRule || index === 0} className="icon-btn" title={hasUnsavedRule ? '请先保存新增规则后再调整顺序' : '上移'}><ChevronUp size={13} /></button>
                              <button onClick={() => void moveRule(index, 1)} disabled={hasUnsavedRule || index === rules.length - 1} className="icon-btn" title={hasUnsavedRule ? '请先保存新增规则后再调整顺序' : '下移'}><ChevronDown size={13} /></button>
                              <button onClick={() => void saveRule(index)} className="icon-btn"><Save size={13} /></button>
                              <button onClick={() => void deleteRule(index)} className="icon-btn"><Trash2 size={13} /></button>
                            </div>
                          </div>
                          {patternError && <div className="mt-1 text-[11px] text-[#FF8A80]">{patternError}</div>}
                          <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-2">
                            <select
                              value={rule.mode}
                              onChange={(e) => patchRule(index, { mode: e.target.value as ExportRuleMode })}
                              className="settings-input"
                              title="着色：只给命中片段上样式；查找替换：复制时把命中片段换成右侧文本"
                            >
                              <option value="style">模式：着色</option>
                              <option value="replace">模式：查找替换</option>
                            </select>
                            {rule.mode === 'replace' ? (
                              <input
                                value={rule.replacement}
                                onChange={(e) => patchRule(index, { replacement: e.target.value })}
                                placeholder="替换为（支持 $1 捕获组、$& 整段、\n 换行）"
                                className="settings-input"
                              />
                            ) : (
                              <div className="text-[11px] text-[#8A8A8A]">着色模式不改变文本，只在复制的富文本里给命中片段加样式。</div>
                            )}
                          </div>
                          {rule.mode === 'replace' && (
                            <div className="mt-1 text-[11px] text-[#8A8A8A]">替换按规则顺序依次执行（后一条看到前一条的结果），正则以 gm 匹配，^ / $ 按行生效；替换为空即为「删除命中内容」。</div>
                          )}
                          <div className="mt-3 flex flex-wrap items-center gap-3 text-[12px] text-[#BDBDBD]">
                            <label className="rule-toggle"><input type="checkbox" checked={rule.enabled} onChange={(e) => patchRule(index, { enabled: e.target.checked })} />启用</label>
                            <label className={`rule-toggle ${rule.mode === 'replace' ? 'opacity-40' : ''}`}><input type="checkbox" disabled={rule.mode === 'replace'} checked={rule.bold} onChange={(e) => patchRule(index, { bold: e.target.checked })} />粗体</label>
                            <label className={`rule-toggle ${rule.mode === 'replace' ? 'opacity-40' : ''}`}><input type="checkbox" disabled={rule.mode === 'replace'} checked={rule.italic} onChange={(e) => patchRule(index, { italic: e.target.checked })} />斜体</label>
                            <label className={`rule-toggle ${rule.mode === 'replace' ? 'opacity-40' : ''}`}><input type="checkbox" disabled={rule.mode === 'replace'} checked={rule.underline} onChange={(e) => patchRule(index, { underline: e.target.checked })} />下划线</label>
                            <label className={`rule-toggle ${rule.mode === 'replace' ? 'opacity-40' : ''}`}><input type="checkbox" disabled={rule.mode === 'replace'} checked={rule.strike} onChange={(e) => patchRule(index, { strike: e.target.checked })} />删除线</label>
                            <label className={`flex items-center gap-2 ${rule.mode === 'replace' ? 'opacity-40' : ''}`}>文字颜色<input type="color" disabled={rule.mode === 'replace'} value={rule.textColor || '#ff0000'} onChange={(e) => patchRule(index, { textColor: e.target.value })} className="h-6 w-8 rounded border-0 bg-transparent" /></label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="rounded-xl border border-[#3D3D3D] bg-[#2A2A2A] p-4">
                  <div className="mb-2 text-[14px] font-medium text-[#E5E5E5]">示例预览</div>
                  <div className="mb-2 text-[11px] text-[#8A8A8A]">原文：{SAMPLE_TEXT}{preview.replacements > 0 ? ` · 已应用 ${preview.replacements} 处替换` : ''}</div>
                  <div className="rounded-lg bg-[#1E1E1E] p-3 text-[13px] text-[#E5E5E5]" dangerouslySetInnerHTML={{ __html: preview.html.replace(/^<!doctype html><html><head><meta charset="utf-8"><\/head><body>|<\/body><\/html>$/g, '') }} />
                  {preview.errors.length > 0 && (
                    <div className="mt-2 text-[11px] text-[#FF8A80]">
                      {preview.errors.map((item) => `${item.ruleName}: ${item.message}`).join('；')}
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
