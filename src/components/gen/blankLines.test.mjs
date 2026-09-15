import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { planBlankLineRemoval } from './blankLines.ts';

// 和 GenPromptEditor 结构等价的最小 schema：doc > paragraph > (text | 行内原子)。
// 真实编辑器没注册 HardBreak / 列表 / 表格，所以「空行」只有一种形态：顶层空
// paragraph。mention 就是 @图片 chip，nodeSize 恒为 1。
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    mention: { group: 'inline', inline: true, atom: true, toDOM: () => ['span'] },
  },
});

const p = (...content) => schema.node('paragraph', null, content);
const t = (text) => schema.text(text);
const chip = () => schema.node('mention');
const blank = () => p();
const doc = (...blocks) => schema.node('doc', null, blocks);

// 按计划把删除全部塞进「同一个」transaction（从后往前），返回新 doc + step 数。
const applyPlan = (input) => {
  const ranges = planBlankLineRemoval(input);
  const state = EditorState.create({ schema, doc: input });
  const tr = state.tr;
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    tr.delete(ranges[i].from, ranges[i].to);
  }
  return { ranges, doc: tr.doc, steps: tr.steps.length };
};

// 每个顶层块的形态快照：'' 表示空段落。
const shape = (node) => {
  const out = [];
  node.forEach((child) => out.push(child.textContent));
  return out;
};

test('连续 1 个空行 → 0 个：删掉空段落，上下两段变成相邻两行（不 join 成一段）', () => {
  const { ranges, doc: next, steps } = applyPlan(doc(p(t('a')), blank(), p(t('b'))));
  assert.equal(ranges.length, 1);
  assert.equal(steps, 1);
  assert.equal(next.childCount, 2);
  assert.deepEqual(shape(next), ['a', 'b']);
  assert.equal(next.child(0).type.name, 'paragraph');
  assert.equal(next.child(1).type.name, 'paragraph');
});

test('连续 2 个空行 → 1 个', () => {
  const { ranges, doc: next } = applyPlan(doc(p(t('a')), blank(), blank(), p(t('b'))));
  assert.equal(ranges.length, 1);
  assert.deepEqual(shape(next), ['a', '', 'b']);
});

test('连续 3 个空行 → 2 个', () => {
  const { ranges, doc: next } = applyPlan(
    doc(p(t('a')), blank(), blank(), blank(), p(t('b')))
  );
  assert.equal(ranges.length, 1);
  assert.deepEqual(shape(next), ['a', '', '', 'b']);
});

test('多组空行各自独立减 1（不是只处理第一组）', () => {
  const { ranges, doc: next, steps } = applyPlan(
    doc(
      p(t('a')),
      blank(),
      p(t('b')),
      blank(),
      blank(),
      p(t('c')),
      blank(),
      blank(),
      blank(),
      p(t('d'))
    )
  );
  assert.equal(ranges.length, 3, '三组空行 → 三处删除');
  assert.equal(steps, 3, '三处删除在同一个 transaction 里');
  assert.deepEqual(shape(next), ['a', 'b', '', 'c', '', '', 'd']);
});

test('删除范围按位置升序且互不重叠', () => {
  const { ranges } = applyPlan(doc(blank(), p(t('a')), blank(), blank(), p(t('b'))));
  for (let i = 1; i < ranges.length; i += 1) {
    assert.ok(ranges[i - 1].to <= ranges[i].from);
  }
});

test('重复执行直至空行清空（幂等收敛），且不动非空段落', () => {
  let current = doc(
    p(t('a')),
    blank(),
    blank(),
    blank(),
    p(t('b')),
    blank(),
    p(t('c'))
  );
  let rounds = 0;
  for (;;) {
    const { ranges, doc: next } = applyPlan(current);
    if (!ranges.length) break;
    current = next;
    rounds += 1;
    assert.ok(rounds < 10, '必须收敛');
  }
  assert.equal(rounds, 3, '最长的一组是 3 个空行 → 点 3 次清空');
  assert.deepEqual(shape(current), ['a', 'b', 'c']);
  assert.deepEqual(planBlankLineRemoval(current), []);
});

test('全文没有空行 → 返回空结果（空操作）', () => {
  assert.deepEqual(planBlankLineRemoval(doc(p(t('a')), p(t('b')))), []);
  assert.deepEqual(planBlankLineRemoval(doc(p(t('只有一行')))), []);
});

test('含 chip / 图片 / 文字 / 空格的段落不会被误判为空行', () => {
  // [chip] 单独成段、只有一个空格的段落、普通文字段落，三者都不是空行。
  const input = doc(p(chip()), p(t(' ')), p(t('x')));
  assert.deepEqual(planBlankLineRemoval(input), []);
  // 真空段落夹在 chip 段落之间时，只删那个真空段落，chip 完好。
  const { doc: next } = applyPlan(doc(p(chip()), blank(), p(t(' ')), p(t('x'))));
  assert.deepEqual(shape(next), ['', ' ', 'x']);
  assert.equal(next.child(0).child(0).type.name, 'mention');
});

test('文档开头的空行组', () => {
  const one = applyPlan(doc(blank(), p(t('a'))));
  assert.deepEqual(shape(one.doc), ['a']);
  const two = applyPlan(doc(blank(), blank(), p(t('a'))));
  assert.deepEqual(shape(two.doc), ['', 'a']);
});

test('文档结尾的空行组', () => {
  const one = applyPlan(doc(p(t('a')), blank()));
  assert.deepEqual(shape(one.doc), ['a']);
  const two = applyPlan(doc(p(t('a')), blank(), blank()));
  assert.deepEqual(shape(two.doc), ['a', '']);
});

test('整篇只剩一个空段落时不删（doc 的 block+ 至少要留一个块）', () => {
  assert.deepEqual(planBlankLineRemoval(doc(blank())), []);
  // 整篇都是空段落时仍然每次减 1，直到只剩一个空段落为止。
  let current = doc(blank(), blank(), blank());
  const rounds = [];
  for (;;) {
    const { ranges, doc: next } = applyPlan(current);
    if (!ranges.length) break;
    current = next;
    rounds.push(current.childCount);
    assert.ok(rounds.length < 10, '必须收敛');
  }
  assert.deepEqual(rounds, [2, 1]);
});
