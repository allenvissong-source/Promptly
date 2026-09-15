import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EXPORT_FORMAT_RULES,
  buildRichClipboard,
  exportFormatRulesFromSettings,
} from './richClipboard.ts';

const rule = (overrides = {}) => ({
  id: 1,
  name: 'test',
  pattern: 'x',
  enabled: true,
  sortOrder: 0,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  textColor: null,
  ...overrides,
});

test('settings adapter uses defaults until context supplies rules', () => {
  assert.equal(exportFormatRulesFromSettings({}), DEFAULT_EXPORT_FORMAT_RULES);
  const supplied = [rule({ id: 99 })];
  assert.equal(exportFormatRulesFromSettings({ exportFormatRules: supplied }), supplied);
});

test('default rule styles numbered media references and leaves text without numbers unmatched', () => {
  const matched = buildRichClipboard('使用 @图片12', DEFAULT_EXPORT_FORMAT_RULES);
  assert.match(matched.html, /<span style="font-weight:700;color:#ff0000">@图片12<\/span>/);
  const unmatched = buildRichClipboard('使用 @图片', DEFAULT_EXPORT_FORMAT_RULES);
  assert.doesNotMatch(unmatched.html, /<span/);
});

test('boolean styles accumulate across overlapping rules', () => {
  const result = buildRichClipboard('abcd', [
    rule({ id: 1, pattern: 'abc', bold: true }),
    rule({ id: 2, pattern: 'bcd', sortOrder: 1, italic: true, underline: true, strike: true }),
  ]);
  assert.match(result.html, /<span style="font-weight:700;font-style:italic;text-decoration:underline line-through">bc<\/span>/);
});

test('a later matching color overrides an earlier color only', () => {
  const result = buildRichClipboard('abc', [
    rule({ id: 1, pattern: 'abc', bold: true, textColor: 'red' }),
    rule({ id: 2, pattern: 'b', sortOrder: 10, italic: true, textColor: 'blue' }),
  ]);
  assert.match(result.html, /<span style="font-weight:700;font-style:italic;color:blue">b<\/span>/);
});

test('HTML and style values cannot inject markup or declarations', () => {
  const plainText = '<img src=x onerror=alert(1)> & "quoted"';
  const result = buildRichClipboard(plainText, [
    rule({ pattern: '<img', textColor: 'red;position:fixed"><script>' }),
  ]);
  assert.equal(result.plainText, plainText);
  assert.doesNotMatch(result.html, /<img|<script>/);
  assert.match(result.html, /&lt;img/);
  assert.doesNotMatch(result.html, /;position:fixed/);
});

test('zero-length matches are skipped without styling or looping', () => {
  const result = buildRichClipboard('abc', [rule({ pattern: '(?=.)', bold: true })]);
  assert.doesNotMatch(result.html, /<span/);
  assert.deepEqual(result.errors, []);
});

test('invalid rules are reported and do not block valid rules', () => {
  const result = buildRichClipboard('abc', [
    rule({ id: 1, name: 'broken', pattern: '[' }),
    rule({ id: 2, pattern: 'b', bold: true }),
  ]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].ruleName, 'broken');
  assert.match(result.html, /<span style="font-weight:700">b<\/span>/);
});

test('disabled rules are ignored', () => {
  const result = buildRichClipboard('abc', [rule({ pattern: 'abc', enabled: false, bold: true })]);
  assert.doesNotMatch(result.html, /<span/);
});

test('tableCell option wraps the body in a single-cell table so spreadsheets keep one cell', () => {
  const plainText = '1231123\n12312312';
  const wrapped = buildRichClipboard(plainText, [], { tableCell: true });
  assert.equal(wrapped.plainText, plainText);
  assert.match(wrapped.html, /<table style="border-collapse:collapse"><tbody><tr><td style="white-space:pre-wrap;padding:0">1231123<br>12312312<\/td><\/tr><\/tbody><\/table>/);
  const plain = buildRichClipboard(plainText, []);
  assert.doesNotMatch(plain.html, /<table>/);
});

test('newlines become safe HTML breaks while plain text remains byte-for-byte unchanged', () => {
  const plainText = 'first\r\nsecond\n第三行';
  const result = buildRichClipboard(plainText, []);
  assert.equal(result.plainText, plainText);
  assert.match(result.html, /first<br>second<br>第三行/);
  assert.equal((result.html.match(/<br>/g) ?? []).length, 2);
});

// ============================================================================
// 导出/复制时的自动查找替换（rule_mode = 'replace'）
// ============================================================================

const replaceRule = (overrides = {}) => rule({ mode: 'replace', replacement: '', ...overrides });

test('replace rules rewrite the copied text while style rules keep it intact', () => {
  const result = buildRichClipboard('用 @图1 和 @图2 生成', [
    replaceRule({ id: 1, pattern: '@图(\\d+)', replacement: 'Image$1' }),
  ]);
  assert.equal(result.plainText, '用 Image1 和 Image2 生成');
  assert.equal(result.replacements, 2);
});

test('replace supports $&, $$ and \\n escapes', () => {
  const result = buildRichClipboard('a;b', [
    replaceRule({ pattern: ';', replacement: '\\n' }),
  ]);
  assert.equal(result.plainText, 'a\nb');
  const kept = buildRichClipboard('x', [replaceRule({ pattern: 'x', replacement: '[$&] $$' })]);
  assert.equal(kept.plainText, '[x] $');
});

test('replace with an empty replacement deletes the match', () => {
  const result = buildRichClipboard('前【噪音】后', [
    replaceRule({ pattern: '【.*?】', replacement: '' }),
  ]);
  assert.equal(result.plainText, '前后');
  assert.equal(result.replacements, 1);
});

test('replace rules run in sortOrder, later rules see earlier results', () => {
  const result = buildRichClipboard('a', [
    replaceRule({ id: 1, pattern: 'a', replacement: 'b', sortOrder: 0 }),
    replaceRule({ id: 2, pattern: 'b', replacement: 'c', sortOrder: 1 }),
  ]);
  assert.equal(result.plainText, 'c');
});

test('style rules match the post-replacement text and inherit styles carry over', () => {
  const result = buildRichClipboard('@图1', [
    replaceRule({ id: 1, pattern: '@图(\\d+)', replacement: 'Image$1', sortOrder: 0 }),
    rule({ id: 2, pattern: 'Image1', bold: true, sortOrder: 1 }),
  ]);
  assert.equal(result.plainText, 'Image1');
  assert.match(result.html, /<span style="font-weight:700">Image1<\/span>/);
});

test('replaced characters inherit the style of the match start', () => {
  const plainText = 'ab';
  const initialStyles = [
    { bold: true, italic: false, underline: false, strike: false, textColor: null, backgroundColor: null },
    { bold: false, italic: false, underline: false, strike: false, textColor: null, backgroundColor: null },
  ];
  const result = buildRichClipboard(plainText, [
    replaceRule({ pattern: 'a', replacement: 'XY' }),
  ], { initialStyles });
  assert.equal(result.plainText, 'XYb');
  assert.match(result.html, /<span style="font-weight:700">XY<\/span>b/);
});

test('applyReplace:false keeps the legacy behaviour (text untouched)', () => {
  const result = buildRichClipboard('@图1', [
    replaceRule({ pattern: '@图(\\d+)', replacement: 'Image$1' }),
  ], { applyReplace: false });
  assert.equal(result.plainText, '@图1');
  assert.equal(result.replacements, 0);
});

test('a broken replace pattern is reported and does not break other rules', () => {
  const result = buildRichClipboard('ab', [
    replaceRule({ id: 1, name: 'broken', pattern: '[', replacement: 'x' }),
    replaceRule({ id: 2, pattern: 'b', replacement: 'B', sortOrder: 1 }),
  ]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].ruleName, 'broken');
  assert.equal(result.plainText, 'aB');
});

test('replace rules use gm flags so ^ anchors每行', () => {
  const result = buildRichClipboard('x\nx', [
    replaceRule({ pattern: '^x', replacement: '- x' }),
  ]);
  assert.equal(result.plainText, '- x\n- x');
});

test('zero-length replace matches cannot loop forever', () => {
  const result = buildRichClipboard('abc', [
    replaceRule({ pattern: '(?=b)', replacement: 'Z' }),
  ]);
  assert.equal(result.plainText, 'abc');
  assert.equal(result.replacements, 0);
});
