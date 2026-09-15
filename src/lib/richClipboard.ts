import { invoke } from '@tauri-apps/api/core';

// 一条规则要么「着色」要么「查找替换」，二选一：
//  - 'style'  ：命中片段按 bold/italic/... 着色，文本本身不变（v4 及以前的唯一行为）
//  - 'replace'：导出/复制时把命中片段替换成 replacement，支持 $1 捕获组
export type ExportRuleMode = 'style' | 'replace';

export interface ExportFormatRule {
  id: number;
  name: string;
  pattern: string;
  enabled: boolean;
  sortOrder: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  textColor: string | null;
  // 省略时按 'style' 处理，保证老调用方与老数据行为完全不变。
  mode?: ExportRuleMode;
  replacement?: string;
}

export interface ExportFormatError {
  ruleId: number;
  ruleName: string;
  message: string;
}

export interface RichClipboardPayload {
  plainText: string;
  html: string;
}

export interface BuildRichClipboardOptions {
  // When true the copied HTML wraps the whole prompt in a single-cell table so
  // spreadsheet targets (Feishu Sheet / Excel) drop the entire text — newlines
  // included — into ONE cell instead of splitting each line into its own row.
  // Plain text stays byte-for-byte unchanged, so non-spreadsheet targets are
  // unaffected. Spreadsheets prefer text/html on paste, so the table wins there.
  tableCell?: boolean;
  // Initial per-character styles from rich text serialization. Length must match plainText.
  initialStyles?: readonly CharacterStyle[];
  // 是否执行 mode === 'replace' 规则（导出/复制时的自动查找替换）。默认执行；
  // 设置里的总开关关掉后传 false，此时行为与 v4 完全一致。
  applyReplace?: boolean;
}

export interface RichClipboardBuild extends RichClipboardPayload {
  errors: ExportFormatError[];
  // 本次实际生效的替换次数（所有 replace 规则命中总数），供调用方提示用户。
  replacements: number;
}

export type ClipboardCopyStatus = 'rich' | 'plain';

export interface ClipboardCopyResult extends RichClipboardBuild {
  status: ClipboardCopyStatus;
}

export interface CharacterStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  textColor: string | null;
  backgroundColor: string | null;
}

export const EMPTY_STYLE: CharacterStyle = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  textColor: null,
  backgroundColor: null,
};

// Kept here, rather than in a serializer or editor extension, so every copy
// entry point uses the same export-only defaults. Rules from settings replace
// this list as soon as GenSettingsContext exposes exportFormatRules.
export const DEFAULT_EXPORT_FORMAT_RULES: ExportFormatRule[] = [
  {
    id: 1,
    name: '默认媒体引用',
    pattern: '@(图|图片|视频|音频)\\d+',
    enabled: true,
    sortOrder: 0,
    bold: true,
    italic: false,
    underline: false,
    strike: false,
    textColor: '#ff0000',
  },
];

// Compatibility seam for the settings rollout: callers can pass today's
// context value without making its TypeScript interface depend on tomorrow's
// exportFormatRules field.
export function exportFormatRulesFromSettings(settings: unknown): ExportFormatRule[] {
  if (settings && typeof settings === 'object' && 'exportFormatRules' in settings) {
    const value = (settings as { exportFormatRules?: unknown }).exportFormatRules;
    if (Array.isArray(value)) return value as ExportFormatRule[];
  }
  return DEFAULT_EXPORT_FORMAT_RULES;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameStyle(a: CharacterStyle, b: CharacterStyle): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.textColor === b.textColor &&
    a.backgroundColor === b.backgroundColor
  );
}

function hasStyle(style: CharacterStyle): boolean {
  return (
    style.bold ||
    style.italic ||
    style.underline ||
    style.strike ||
    style.textColor !== null ||
    style.backgroundColor !== null
  );
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function htmlText(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');
}

function escapeCssValue(value: string): string {
  // Attribute escaping blocks markup injection; CSS escaping also prevents a
  // configured color from terminating the declaration or starting a new one.
  return value
    .replaceAll('\\', '\\5c ')
    .replaceAll('"', '\\22 ')
    .replaceAll("'", '\\27 ')
    .replaceAll(';', '\\3b ')
    .replaceAll('{', '\\7b ')
    .replaceAll('}', '\\7d ')
    .replaceAll('<', '\\3c ')
    .replaceAll('>', '\\3e ');
}

function styleAttribute(style: CharacterStyle): string {
  const declarations: string[] = [];
  if (style.bold) declarations.push('font-weight:700');
  if (style.italic) declarations.push('font-style:italic');
  const decorations: string[] = [];
  if (style.underline) decorations.push('underline');
  if (style.strike) decorations.push('line-through');
  if (decorations.length) declarations.push(`text-decoration:${decorations.join(' ')}`);
  if (style.textColor !== null) {
    declarations.push(`color:${escapeCssValue(style.textColor)}`);
  }
  if (style.backgroundColor !== null) {
    declarations.push(`background-color:${escapeCssValue(style.backgroundColor)}`);
  }
  return declarations.join(';');
}

function ruleMode(rule: ExportFormatRule): ExportRuleMode {
  return rule.mode === 'replace' ? 'replace' : 'style';
}

// enabled 规则按 sortOrder 排序（同序时保持原数组顺序），供替换 / 着色两趟复用。
function orderRules(rules: readonly ExportFormatRule[]): ExportFormatRule[] {
  return rules
    .filter((rule) => rule.enabled)
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => a.rule.sortOrder - b.rule.sortOrder || a.index - b.index)
    .map(({ rule }) => rule);
}

// 展开替换文本里的占位符：
//  - $&        整个命中片段
//  - $1..$99   捕获组（组不存在时先退化成单位数组，再退化成空串）
//  - $$        字面 $
//  - \n \r \t \\  转义字符（替换输入框是单行的，靠这个才能插入换行）
// 一次线性扫描，避免「先展开分组、再解转义」把分组内容里的 \n 也误解析。
export function expandReplacement(template: string, match: RegExpMatchArray): string {
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
      if (next === '&') { out += match[0]; i += 1; continue; }
      if (next >= '0' && next <= '9') {
        const two = template.slice(i + 1, i + 3);
        if (/^\d\d$/.test(two) && Number(two) < match.length) {
          out += match[Number(two)] ?? '';
          i += 2;
          continue;
        }
        const one = Number(next);
        if (one < match.length) {
          out += match[one] ?? '';
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

export interface ReplaceRulesResult {
  text: string;
  styles: CharacterStyle[];
  errors: ExportFormatError[];
  replacements: number;
}

// 导出/复制时的自动查找替换。文本与「每字符样式」数组同步重建，替换进来的字符
// 继承命中片段首字符的样式（所以把加粗的 @图1 换成别的词，还是加粗的），这样
// 后续着色规则与 HTML 构建拿到的 styles 长度始终与文本一致。
//
// 只处理 mode === 'replace' 的规则，按 sortOrder 依次作用（后一条规则看到的是
// 前一条替换后的文本），正则用 'gm' 标志，故 ^ / $ 按行匹配。
export function applyReplaceRules(
  plainText: string,
  styles: readonly CharacterStyle[],
  rules: readonly ExportFormatRule[]
): ReplaceRulesResult {
  let text = plainText;
  let current: CharacterStyle[] = styles.map((style) => ({ ...style }));
  const errors: ExportFormatError[] = [];
  let replacements = 0;

  for (const rule of orderRules(rules)) {
    if (ruleMode(rule) !== 'replace') continue;
    const template = rule.replacement ?? '';
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, 'gm');
    } catch (error) {
      errors.push({ ruleId: rule.id, ruleName: rule.name, message: errorMessage(error) });
      continue;
    }

    let outText = '';
    const outStyles: CharacterStyle[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const length = match[0].length;
      if (length === 0) {
        // 空匹配：与着色规则一致，前进一个 UTF-16 码元保证不死循环。
        regex.lastIndex += 1;
        continue;
      }
      outText += text.slice(cursor, match.index);
      for (let i = cursor; i < match.index; i += 1) outStyles.push(current[i] ?? { ...EMPTY_STYLE });
      const inherited = current[match.index] ?? { ...EMPTY_STYLE };
      const expanded = expandReplacement(template, match);
      outText += expanded;
      for (let i = 0; i < expanded.length; i += 1) outStyles.push({ ...inherited });
      cursor = match.index + length;
      replacements += 1;
    }
    if (cursor === 0) continue; // 该规则没有任何命中，保持原样
    outText += text.slice(cursor);
    for (let i = cursor; i < text.length; i += 1) outStyles.push(current[i] ?? { ...EMPTY_STYLE });
    text = outText;
    current = outStyles;
  }

  return { text, styles: current, errors, replacements };
}

export function buildRichClipboard(
  plainText: string,
  rules: readonly ExportFormatRule[] = DEFAULT_EXPORT_FORMAT_RULES,
  options: BuildRichClipboardOptions = {}
): RichClipboardBuild {
  // Initialize styles: use provided initial styles if valid length, otherwise empty styles
  const initialStyles: CharacterStyle[] = options.initialStyles && options.initialStyles.length === plainText.length
    ? options.initialStyles.map(s => ({ ...s }))
    : Array.from({ length: plainText.length }, () => ({ ...EMPTY_STYLE }));
  const errors: ExportFormatError[] = [];

  // 先替换、后着色：着色规则的命中位置必须基于替换后的最终文本，否则位置对不上。
  const replaced = options.applyReplace === false
    ? { text: plainText, styles: initialStyles, errors: [] as ExportFormatError[], replacements: 0 }
    : applyReplaceRules(plainText, initialStyles, rules);
  errors.push(...replaced.errors);
  const finalText = replaced.text;
  const styles = replaced.styles;

  for (const rule of orderRules(rules)) {
    if (ruleMode(rule) !== 'style') continue;
    try {
      const regex = new RegExp(rule.pattern, 'g');
      let match: RegExpExecArray | null;
      while ((match = regex.exec(finalText)) !== null) {
        const length = match[0].length;
        if (length === 0) {
          // The regex has no Unicode flag, so its indices and lastIndex are
          // UTF-16 code-unit offsets. Advance one code unit after an ignored
          // empty match to preserve that contract and guarantee progress.
          regex.lastIndex += 1;
          continue;
        }
        const end = match.index + length;
        for (let offset = match.index; offset < end; offset += 1) {
          const style = styles[offset];
          if (!style) continue;
          style.bold ||= rule.bold;
          style.italic ||= rule.italic;
          style.underline ||= rule.underline;
          style.strike ||= rule.strike;
          if (rule.textColor !== null) style.textColor = rule.textColor;
        }
      }
    } catch (error) {
      errors.push({
        ruleId: rule.id,
        ruleName: rule.name,
        message: errorMessage(error),
      });
    }
  }

  let body = '';
  let start = 0;
  while (start < finalText.length) {
    if (finalText[start] === '\r' || finalText[start] === '\n') {
      if (finalText[start] === '\r' && finalText[start + 1] === '\n') start += 1;
      body += '<br>';
      start += 1;
      continue;
    }
    const style = styles[start];
    let end = start + 1;
    while (
      end < finalText.length &&
      finalText[end] !== '\r' &&
      finalText[end] !== '\n' &&
      sameStyle(style, styles[end])
    ) {
      end += 1;
    }
    const content = htmlText(finalText.slice(start, end));
    body += hasStyle(style)
      ? `<span style="${styleAttribute(style)}">${content}</span>`
      : content;
    start = end;
  }

  const inner = options.tableCell
    ? `<table style="border-collapse:collapse"><tbody><tr><td style="white-space:pre-wrap;padding:0">${body}</td></tr></tbody></table>`
    : body;

  return {
    plainText: finalText,
    html: `<!doctype html><html><head><meta charset="utf-8"></head><body>${inner}</body></html>`,
    errors,
    replacements: replaced.replacements,
  };
}

function copyWithTextarea(plainText: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = plainText;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) throw new Error('execCommand copy failed');
}

export async function copyRichText(
  plainText: string,
  rules: readonly ExportFormatRule[] = DEFAULT_EXPORT_FORMAT_RULES,
  options: BuildRichClipboardOptions = {}
): Promise<ClipboardCopyResult> {
  const payload = buildRichClipboard(plainText, rules, options);
  try {
    await invoke('copy_rich_text', {
      plainText: payload.plainText,
      html: payload.html,
    });
    return { ...payload, status: 'rich' };
  } catch {
    try {
      await navigator.clipboard.writeText(payload.plainText);
    } catch {
      copyWithTextarea(payload.plainText);
    }
    return { ...payload, status: 'plain' };
  }
}
