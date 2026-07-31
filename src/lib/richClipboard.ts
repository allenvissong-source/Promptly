import { invoke } from '@tauri-apps/api/core';

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
}

export interface RichClipboardBuild extends RichClipboardPayload {
  errors: ExportFormatError[];
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

export function buildRichClipboard(
  plainText: string,
  rules: readonly ExportFormatRule[] = DEFAULT_EXPORT_FORMAT_RULES,
  options: BuildRichClipboardOptions = {}
): RichClipboardBuild {
  // Initialize styles: use provided initial styles if valid length, otherwise empty styles
  const styles: CharacterStyle[] = options.initialStyles && options.initialStyles.length === plainText.length
    ? options.initialStyles.map(s => ({ ...s }))
    : Array.from({ length: plainText.length }, () => ({ ...EMPTY_STYLE }));
  const errors: ExportFormatError[] = [];
  const orderedRules = rules
    .filter((rule) => rule.enabled)
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) =>
      a.rule.sortOrder - b.rule.sortOrder || a.index - b.index
    );

  for (const { rule } of orderedRules) {
    try {
      const regex = new RegExp(rule.pattern, 'g');
      let match: RegExpExecArray | null;
      while ((match = regex.exec(plainText)) !== null) {
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
  while (start < plainText.length) {
    if (plainText[start] === '\r' || plainText[start] === '\n') {
      if (plainText[start] === '\r' && plainText[start + 1] === '\n') start += 1;
      body += '<br>';
      start += 1;
      continue;
    }
    const style = styles[start];
    let end = start + 1;
    while (
      end < plainText.length &&
      plainText[end] !== '\r' &&
      plainText[end] !== '\n' &&
      sameStyle(style, styles[end])
    ) {
      end += 1;
    }
    const content = htmlText(plainText.slice(start, end));
    body += hasStyle(style)
      ? `<span style="${styleAttribute(style)}">${content}</span>`
      : content;
    start = end;
  }

  const inner = options.tableCell
    ? `<table style="border-collapse:collapse"><tbody><tr><td style="white-space:pre-wrap;padding:0">${body}</td></tr></tbody></table>`
    : body;

  return {
    plainText,
    html: `<!doctype html><html><head><meta charset="utf-8"></head><body>${inner}</body></html>`,
    errors,
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
