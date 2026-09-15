// ============================================================================
// 编译验证 / 冒烟测试
//
// 目的是证伪三件事，任何一条不成立就应当立刻放弃「独立 Node 进程」这个落点：
//
//   A. 能以只读方式打开正在被 App 使用的 WAL 库，且写入被硬阻断。
//   B. 能零改动复用前端序列化器，产出模板引用已展开、mention 已解析的文本。
//   C. 读到的是最新数据（未走 immutable，能看见 -wal 里的内容）。
//
// 断言失败即退出码非 0。刻意不捕获异常，让问题直接暴露。
// ============================================================================

import assert from 'node:assert/strict';
import { openReadonlyDb, resolveDbPath, SUPPORTED_SCHEMA_VERSION } from './db.ts';
import { makeTemplateResolver, serializeCard, type SlotRow } from './serialize.ts';

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}

const dbPath = resolveDbPath();
section('A. 只读连接');
console.log(`库路径: ${dbPath}`);

const db = openReadonlyDb(dbPath);
assert.equal(db.schemaVersion, SUPPORTED_SCHEMA_VERSION);
console.log(`schema 版本: ${db.schemaVersion} ✓`);

// 写入必须被阻断 —— 这是数据安全的底线，必须实测而不是相信参数。
let writeBlocked = false;
try {
  db.all('CREATE TABLE _mcp_probe_should_fail (x)');
} catch (err) {
  writeBlocked = /readonly/i.test(String(err));
}
assert.ok(writeBlocked, '写入未被阻断 —— 只读保证失效，必须停止');
console.log('写入被硬阻断 ✓');

section('B. 数据概览');
const counts = db.get<Record<string, number>>(
  `SELECT (SELECT count(*) FROM projects)       AS projects,
          (SELECT count(*) FROM media)          AS media,
          (SELECT count(*) FROM gen_cells)      AS cells,
          (SELECT count(*) FROM gen_templates)  AS templates,
          (SELECT count(*) FROM blocks)         AS blocks`
);
console.log(counts);
assert.ok((counts?.projects ?? 0) > 0, '库里没有项目，无法验证序列化');

section('C. 序列化复用（核心假设）');

// 挑一个含 @模板引用的分镜块 —— 它同时覆盖 templateRef 展开与 mention 解析，
// 是最能暴露问题的样本。
const block = db.get<{ id: string; project_id: number; content: string | null }>(
  `SELECT id, project_id, content FROM blocks
    WHERE content LIKE '%templateRef%' ORDER BY id LIMIT 1`
);

if (!block) {
  console.log('（库里没有含模板引用的分镜块，跳过展开验证）');
} else {
  const slots = db.all<SlotRow>(
    `SELECT id, media_id, name, thumb, path, meta, type FROM block_slots
      WHERE block_id = ? ORDER BY position`,
    block.id
  );
  const resolver = makeTemplateResolver(db, block.project_id);
  const out = serializeCard(block.content, slots, 'code', resolver);

  console.log(`项目 #${block.project_id} / 分镜块 ${block.id}`);
  console.log(`字符数 ${out.text.length}，styles ${out.styleCount}`);
  console.log('--- 输出前 400 字 ---');
  console.log(out.text.slice(0, 400));
  console.log('---');

  // styles 必须逐字符对齐，否则富文本复制会整体错位。
  assert.equal(out.text.length, out.styleCount, 'styles 与文本长度不一致');
  // 残留原始 id 说明引用没被解析，等于把内部结构泄漏给了模型。
  assert.ok(!/tpl-\d{10,}/.test(out.text), '输出里残留未解析的 templateId');
  assert.ok(!/\bslot-|tslot-/.test(out.text), '输出里残留未解析的 slotId');
  assert.ok(out.text.trim().length > 0, '序列化结果为空');
  console.log('模板引用已展开、mention 已解析、styles 对齐 ✓');
}

section('D. 读取新鲜度');
const latest = db.get<{ id: number; name: string; updated_at: string }>(
  'SELECT id, name, updated_at FROM projects ORDER BY updated_at DESC LIMIT 1'
);
console.log(`最近更新的项目: #${latest?.id} ${latest?.name} @ ${latest?.updated_at}`);
console.log('（在 App 里改点东西再跑一次，此时间应随之变化 → 证明没走 immutable）');

db.close();
console.log('\n全部断言通过：Node 落点可行。\n');
