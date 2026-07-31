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
  assert.match(wrapped.html, /<table><tbody><tr><td style="white-space:pre-wrap">1231123<br>\n12312312<\/td><\/tr><\/tbody><\/table>/);
  const plain = buildRichClipboard(plainText, []);
  assert.doesNotMatch(plain.html, /<table>/);
});

test('newlines become safe HTML breaks while plain text remains byte-for-byte unchanged', () => {
  const plainText = 'first\r\nsecond\n第三行';
  const result = buildRichClipboard(plainText, []);
  assert.equal(result.plainText, plainText);
  assert.match(result.html, /first<br>\nsecond<br>\n第三行/);
  assert.equal((result.html.match(/<br>/g) ?? []).length, 2);
});
