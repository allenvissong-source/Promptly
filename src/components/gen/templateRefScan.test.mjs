import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHasTemplateRef } from './templateRefScan.ts';

const doc = (...content) => ({ type: 'doc', content });
const p = (...content) => ({ type: 'paragraph', content });
const text = (t) => ({ type: 'text', text: t });
const tref = (templateId = 't1') => ({
  type: 'templateRef',
  attrs: { templateId, selectedRoleIds: [] },
});

test('顶层段落里有 templateRef -> true', () => {
  assert.equal(contentHasTemplateRef(doc(p(text('前'), tref(), text('后')))), true);
});

test('深层嵌套里有 templateRef -> true', () => {
  const nested = doc(p(text('a')), {
    type: 'blockquote',
    content: [
      { type: 'paragraph', content: [{ type: 'wrap', content: [tref()] }] },
    ],
  });
  assert.equal(contentHasTemplateRef(nested), true);
});

test('完全没有 templateRef -> false', () => {
  assert.equal(contentHasTemplateRef(doc(p(text('只有文字')), p())), false);
});

test('空文档 / null / undefined -> false', () => {
  assert.equal(contentHasTemplateRef(doc()), false);
  assert.equal(contentHasTemplateRef({ type: 'doc' }), false);
  assert.equal(contentHasTemplateRef(null), false);
  assert.equal(contentHasTemplateRef(undefined), false);
});

test('只有 mention / roleEntity 等其他原子节点 -> false', () => {
  const d = doc(
    p({ type: 'mention', attrs: { slotId: 's1', name: 'a.png' } }),
    p({ type: 'roleEntity', attrs: { id: 'r1', name: '角色' } }, text('：描述'))
  );
  assert.equal(contentHasTemplateRef(d), false);
});

test('templateRef 作为根节点本身 -> true', () => {
  assert.equal(contentHasTemplateRef(tref()), true);
});
