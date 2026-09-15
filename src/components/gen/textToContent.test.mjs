// textToContent 的往返与边界测试。
//
// 重点验证「文本 -> JSON -> 文本」的往返性质：AI 改完写回去、再读出来给 AI 看，
// 内容不能漂移。角色实体的 id 复用是另一个重点 —— 丢了 id 会让分镜区已有的引用失效。
//
// 这里用一个本地的最小序列化器做往返，而不是导入 serializePrompt：后者的导入链牵到
// React 与 Tauri 模块，node --test 解析不了（仓库既有测试都只测无外部依赖的纯模块）。
// 真实序列化器的行为由它自己的测试保证，这里只验证 textToContent 产物的结构正确。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textToContent, describeLossyWrite } from './textToContent.ts';

// 还原规则与 serializePromptContent 对齐：每个顶层 paragraph 一行，
// roleEntity 渲染为 `- 名字`（编辑器隐藏的那个短横线），text 原样输出。
function toText(doc) {
  return (doc.content ?? [])
    .map((para) =>
      (para.content ?? [])
        .map((node) => {
          if (node.type === 'roleEntity') return `- ${node.attrs.name}`;
          if (node.type === 'text') return node.text;
          return '';
        })
        .join('')
    )
    .join('\n');
}

const roundTrip = (text, opts) => toText(textToContent(text, opts));

test('单行文本往返一致', () => {
  assert.equal(roundTrip('一句提示词'), '一句提示词');
});

test('多行文本往返一致', () => {
  const t = '第一行\n第二行\n第三行';
  assert.equal(roundTrip(t), t);
});

test('空行被保留', () => {
  const t = '上段\n\n下段';
  assert.equal(roundTrip(t), t);
});

test('连续多个空行不被压缩', () => {
  const t = 'a\n\n\n\nb';
  assert.equal(roundTrip(t), t);
});

test('首尾空行保留', () => {
  const t = '\n中间\n';
  assert.equal(roundTrip(t), t);
});

test('Windows 换行被归一化', () => {
  const out = roundTrip('a\r\nb');
  assert.equal(out, 'a\nb');
  assert.ok(!out.includes('\r'), '不应残留 \\r');
});

test('空字符串产出一个空段落', () => {
  const content = textToContent('');
  assert.equal(content.content.length, 1);
  assert.equal(content.content[0].content, undefined);
});

test('parseRoles 关闭时角色行只是普通文字', () => {
  const content = textToContent('- 零: 白发少女', { parseRoles: false });
  const para = content.content[0];
  assert.equal(para.content[0].type, 'text');
  assert.equal(para.content[0].text, '- 零: 白发少女');
});

test('parseRoles 开启时识别成 roleEntity', () => {
  const content = textToContent('- 零: 白发少女', { parseRoles: true });
  const inline = content.content[0].content;
  assert.equal(inline[0].type, 'roleEntity');
  assert.equal(inline[0].attrs.name, '零');
  assert.ok(inline[0].attrs.id.startsWith('role-'));
});

test('角色行往返一致（中文冒号也认）', () => {
  const t = '- 零: 白发少女';
  assert.equal(roundTrip(t, { parseRoles: true }), t);
  // 输入用中文冒号，输出统一成 ': '，这与序列化器的行为一致
  assert.equal(roundTrip('- 零：白发少女', { parseRoles: true }), t);
});

test('同名角色复用旧 id（保住分镜区的引用）', () => {
  const before = textToContent('- 零: 旧描述', { parseRoles: true });
  const oldId = before.content[0].content[0].attrs.id;
  const after = textToContent('- 零: 新描述', { parseRoles: true, previous: before });
  assert.equal(after.content[0].content[0].attrs.id, oldId, 'id 必须复用');
});

test('新角色获得新 id，不与旧角色冲突', () => {
  const before = textToContent('- 零: a', { parseRoles: true });
  const oldId = before.content[0].content[0].attrs.id;
  const after = textToContent('- 零: a\n- 薄荷: b', { parseRoles: true, previous: before });
  const ids = after.content.map((p) => p.content[0].attrs.id);
  assert.equal(ids[0], oldId);
  assert.notEqual(ids[1], oldId);
});

test('角色名里的第二个冒号不被误判', () => {
  const t = '- 备注: a: b';
  const content = textToContent(t, { parseRoles: true });
  assert.equal(content.content[0].content[0].attrs.name, '备注');
  assert.equal(roundTrip(t, { parseRoles: true }), t);
});

test('不含冒号的短横线行不当作角色', () => {
  const t = '- 只是一个列表项';
  const content = textToContent(t, { parseRoles: true });
  assert.equal(content.content[0].content[0].type, 'text');
  assert.equal(roundTrip(t, { parseRoles: true }), t);
});

test('describeLossyWrite 报出会丢失的引用', () => {
  const withRefs = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { slotId: 's1', mediaId: 1, name: 'a.png' } },
          { type: 'mention', attrs: { slotId: 's2', mediaId: 2, name: 'b.png' } },
          { type: 'templateRef', attrs: { templateId: 't1', selectedRoleIds: [] } },
        ],
      },
    ],
  };
  const w = describeLossyWrite(withRefs);
  assert.equal(w.length, 2);
  assert.ok(w[0].includes('2 个素材引用'));
  assert.ok(w[1].includes('1 个模板引用'));
});

test('describeLossyWrite 对纯文字内容不报警告', () => {
  assert.deepEqual(describeLossyWrite(textToContent('纯文字')), []);
  assert.deepEqual(describeLossyWrite(null), []);
});
