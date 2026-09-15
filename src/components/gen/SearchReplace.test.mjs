import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { findMatches, expandSearchReplacement } from './SearchReplace.ts';

// 一个和 GenPromptEditor 结构等价的最小 schema：doc > paragraph > (text | 行内原子节点)。
// mention 就是编辑器里的 @图片 chip，nodeSize 恒为 1。
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    mention: { group: 'inline', inline: true, atom: true, toDOM: () => ['span'] },
  },
  marks: {
    bold: { toDOM: () => ['strong', 0] },
  },
});

const p = (...content) => schema.node('paragraph', null, content);
const t = (text, marks = []) => schema.text(text, marks);
const chip = () => schema.node('mention');
const bold = schema.marks.bold.create();

test('plain-text search maps offsets back to document positions', () => {
  // doc: <p>hello world</p> —— 段落内容起点是 1
  const doc = schema.node('doc', null, [p(t('hello world'))]);
  const matches = findMatches(doc, 'world', false, false);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].from, 7);
  assert.equal(matches[0].to, 12);
  assert.equal(doc.textBetween(matches[0].from, matches[0].to), 'world');
});

test('a match spanning mark boundaries is still found (block-level text join)', () => {
  // <p>粗体<b>文字</b></p>：两个 text 节点，跨样式边界的词必须能命中
  const doc = schema.node('doc', null, [p(t('粗体'), t('文字', [bold]))]);
  const matches = findMatches(doc, '体文', false, false);
  assert.equal(matches.length, 1);
  assert.equal(doc.textBetween(matches[0].from, matches[0].to), '体文');
});

test('inline atoms (chips)占位 1 个字符，不会被当成文字命中，且后续偏移不漂移', () => {
  // <p>前 [chip] 后abc</p>
  const doc = schema.node('doc', null, [p(t('前'), chip(), t('后abc'))]);
  const chipHit = findMatches(doc, '\uFFFC', false, false);
  assert.equal(chipHit.length, 1, 'chip 以对象替换符占位');
  const matches = findMatches(doc, 'abc', false, false);
  assert.equal(matches.length, 1);
  assert.equal(doc.textBetween(matches[0].from, matches[0].to), 'abc');
});

test('multiple paragraphs get independent offsets', () => {
  const doc = schema.node('doc', null, [p(t('aXa')), p(t('bXb'))]);
  const matches = findMatches(doc, 'X', false, false);
  assert.equal(matches.length, 2);
  assert.equal(doc.textBetween(matches[0].from, matches[0].to), 'X');
  assert.equal(doc.textBetween(matches[1].from, matches[1].to), 'X');
  assert.notEqual(matches[0].from, matches[1].from);
});

test('case sensitivity toggles as expected', () => {
  const doc = schema.node('doc', null, [p(t('Foo foo FOO'))]);
  assert.equal(findMatches(doc, 'foo', false, false).length, 3);
  assert.equal(findMatches(doc, 'foo', true, false).length, 1);
});

test('literal mode escapes regex metacharacters', () => {
  const doc = schema.node('doc', null, [p(t('a.b axb'))]);
  // 非正则模式下 "a.b" 只应命中字面 "a.b"
  assert.equal(findMatches(doc, 'a.b', false, false).length, 1);
  // 正则模式下 "." 是通配，两处都命中
  assert.equal(findMatches(doc, 'a.b', false, true).length, 2);
});

test('regex mode exposes capture groups for $1 replacement', () => {
  const doc = schema.node('doc', null, [p(t('@图12'))]);
  const matches = findMatches(doc, '@图(\\d+)', false, true);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].groups[1], '12');
  assert.equal(expandSearchReplacement('Image$1', matches[0].groups), 'Image12');
});

test('an invalid regex yields no matches instead of throwing', () => {
  const doc = schema.node('doc', null, [p(t('abc'))]);
  assert.deepEqual(findMatches(doc, '[', false, true), []);
});

test('zero-length regex matches cannot loop forever', () => {
  const doc = schema.node('doc', null, [p(t('abc'))]);
  assert.deepEqual(findMatches(doc, '(?=b)', false, true), []);
});

test('empty search term matches nothing', () => {
  const doc = schema.node('doc', null, [p(t('abc'))]);
  assert.deepEqual(findMatches(doc, '', false, false), []);
});

test('replacement placeholders: $&, $$, \\n and unknown groups stay literal', () => {
  assert.equal(expandSearchReplacement('[$&]', ['hit']), '[hit]');
  assert.equal(expandSearchReplacement('$$', ['hit']), '$');
  assert.equal(expandSearchReplacement('a\\nb', ['hit']), 'a\nb');
  assert.equal(expandSearchReplacement('$9', ['hit']), '$9');
  assert.equal(expandSearchReplacement('$1', ['hit', 'g1']), 'g1');
});
