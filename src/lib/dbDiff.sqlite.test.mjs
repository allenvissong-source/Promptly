import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  GEN_AREA_SPEC,
  buildFullWritePlan,
  buildIncrementalWritePlan,
  pickFields,
} from './dbDiff.ts';

// ============================================================================
// 等价性验证：把同一串编辑操作分别用「增量计划」和「改造前的全量覆盖计划」写进
// 两个真实的 SQLite 库，每一步都比对两边的最终行内容。用 node 内置的 node:sqlite
// 直连本地文件库，所以既不用 mock Tauri，也不用 mock SQLite。
//
// 覆盖不到的部分（在报告里说明）：Rust execute_batch 的事务/回滚行为、
// tauri-plugin-sql 的连接池、以及 UI/React 层的调用编排。
// ============================================================================

const SCHEMA = [
  `CREATE TABLE gen_cells (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0, note TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE gen_slots (id TEXT PRIMARY KEY, cell_id TEXT NOT NULL, media_id INTEGER NOT NULL, name TEXT NOT NULL, thumb TEXT, path TEXT, meta TEXT, type TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0)`,
];

const PID = 42;

const openDb = () => {
  const db = new DatabaseSync(':memory:');
  for (const sql of SCHEMA) db.exec(sql);
  return db;
};

// 一次 executeBatch 的 JS 侧等价物：所有语句跑在同一个事务里。
const applyPlan = (db, plan) => {
  db.exec('BEGIN');
  try {
    for (const [sql, params] of plan.statements) db.prepare(sql).run(...params);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return plan.statements.length;
};

// 与 db.ts 的 readAreaFingerprint 同一份 SQL。
const readFingerprint = (db, spec, projectId) => ({
  containers: db
    .prepare(`SELECT id, position, ${spec.containerColumns.join(', ')} FROM ${spec.containerTable} WHERE project_id = ?`)
    .all(projectId)
    .map((row) => ({ id: row.id, position: Number(row.position), fields: pickFields(spec.containerColumns, row) })),
  slots: db
    .prepare(
      `SELECT s.id AS id, s.${spec.parentColumn} AS parent_id, s.position AS position, ${spec.slotColumns
        .map((c) => `s.${c}`)
        .join(', ')} FROM ${spec.slotTable} s JOIN ${spec.containerTable} c ON c.id = s.${spec.parentColumn} WHERE c.project_id = ?`
    )
    .all(projectId)
    .map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      position: Number(row.position),
      fields: pickFields(spec.slotColumns, row),
    })),
});

// 只比对业务字段（created_at 不参与，改造前每次保存都会重置它，增量则保留原值 ——
// 这一列没有任何读取方）。
const readState = (db) => ({
  cells: db.prepare('SELECT id, project_id, position, note FROM gen_cells ORDER BY position, id').all(),
  slots: db
    .prepare('SELECT id, cell_id, media_id, name, thumb, path, meta, type, position FROM gen_slots ORDER BY cell_id, position, id')
    .all(),
});

const slot = (id, mediaId, extra = {}) => ({
  id,
  fields: { media_id: mediaId, name: `m${mediaId}`, thumb: null, path: null, meta: null, type: 'image', ...extra },
});
const cell = (id, note, slots = []) => ({ id, fields: { note }, slots });

test('增量写入与全量覆盖在真实 SQLite 上逐步等价（新增/改内容/删卡片/改顺序/搬槽位/清空）', () => {
  const incremental = openDb();
  const full = openDb();

  // 一串模拟用户编辑的保存序列，每个元素就是「按下 Ctrl+S 时的内存态」。
  const timeline = [
    // 1. 首次保存：库里啥也没有。
    [cell('c1', '{"t":1}', [slot('s1', 11)]), cell('c2', '{"t":2}', [slot('s2', 22), slot('s3', 33)])],
    // 2. 只改一张卡片正文。
    [cell('c1', '{"t":"改过"}', [slot('s1', 11)]), cell('c2', '{"t":2}', [slot('s2', 22), slot('s3', 33)])],
    // 3. 新增一张卡片。
    [
      cell('c1', '{"t":"改过"}', [slot('s1', 11)]),
      cell('c2', '{"t":2}', [slot('s2', 22), slot('s3', 33)]),
      cell('c3', null, []),
    ],
    // 4. 卡片顺序变化（拖拽排序）。
    [
      cell('c2', '{"t":2}', [slot('s2', 22), slot('s3', 33)]),
      cell('c1', '{"t":"改过"}', [slot('s1', 11)]),
      cell('c3', null, []),
    ],
    // 5. 卡片内槽位顺序变化 + 槽位元数据变化。
    [
      cell('c2', '{"t":2}', [slot('s3', 33, { name: '改名.png' }), slot('s2', 22)]),
      cell('c1', '{"t":"改过"}', [slot('s1', 11)]),
      cell('c3', null, []),
    ],
    // 6. 槽位跨卡片搬家。
    [
      cell('c2', '{"t":2}', [slot('s3', 33, { name: '改名.png' })]),
      cell('c1', '{"t":"改过"}', [slot('s1', 11), slot('s2', 22)]),
      cell('c3', null, []),
    ],
    // 7. 删除一张带槽位的卡片（联带清理子记录）。
    [cell('c1', '{"t":"改过"}', [slot('s1', 11), slot('s2', 22)]), cell('c3', null, [])],
    // 8. 什么都没改（自动保存最常见的情形）。
    [cell('c1', '{"t":"改过"}', [slot('s1', 11), slot('s2', 22)]), cell('c3', null, [])],
    // 9. 清空整个区域。
    [],
    // 10. 清空后再建一张。
    [cell('c9', '{"t":9}', [slot('s9', 99)])],
  ];

  const counts = [];
  for (const desired of timeline) {
    const incPlan = buildIncrementalWritePlan(GEN_AREA_SPEC, PID, desired, readFingerprint(incremental, GEN_AREA_SPEC, PID));
    const fullPlan = buildFullWritePlan(GEN_AREA_SPEC, PID, desired);
    counts.push({ incremental: applyPlan(incremental, incPlan), full: applyPlan(full, fullPlan) });
    assert.deepEqual(readState(incremental), readState(full));
  }

  // 「什么都没改」那一步：增量 0 条语句，全量 6 条。
  assert.equal(counts[7].incremental, 0);
  assert.equal(counts[7].full, 6);
  // 只改一张卡片正文：1 条 vs 全量 7 条（2 条 DELETE + 2 卡片 + 3 槽位）。
  assert.equal(counts[1].incremental, 1);
  assert.equal(counts[1].full, 7);
  // 删除带槽位的卡片：删子行 + 删卡片 + 剩余卡片补 position。
  assert.ok(counts[6].incremental < counts[6].full);

  incremental.close();
  full.close();
});

test('删掉卡片后，它名下的槽位子记录在库里一条不剩（也不会误删别的卡片的）', () => {
  const db = openDb();
  const initial = [cell('c1', 'a', [slot('s1', 11), slot('s2', 22)]), cell('c2', 'b', [slot('s3', 33)])];
  applyPlan(db, buildFullWritePlan(GEN_AREA_SPEC, PID, initial));
  // 人为塞一条「残留」子行：它的 cell_id 指向 c1，但内存态里从来没有过。
  db.prepare(
    'INSERT INTO gen_slots (id, cell_id, media_id, name, thumb, path, meta, type, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('orphan', 'c1', 77, 'orphan.png', null, null, null, 'image', 9);

  const after = [cell('c2', 'b', [slot('s3', 33)])];
  applyPlan(db, buildIncrementalWritePlan(GEN_AREA_SPEC, PID, after, readFingerprint(db, GEN_AREA_SPEC, PID)));

  assert.deepEqual(db.prepare('SELECT id FROM gen_cells ORDER BY id').all().map((r) => r.id), ['c2']);
  assert.deepEqual(db.prepare('SELECT id FROM gen_slots ORDER BY id').all().map((r) => r.id), ['s3']);
  db.close();
});

test('事务内任一语句失败 → 整笔回滚，库停在上一次保存的状态', () => {
  const db = openDb();
  const initial = [cell('c1', 'a', [slot('s1', 11)])];
  applyPlan(db, buildFullWritePlan(GEN_AREA_SPEC, PID, initial));
  const before = readState(db);

  const plan = buildIncrementalWritePlan(GEN_AREA_SPEC, PID, [cell('c1', 'b', [slot('s1', 11)])], readFingerprint(db, GEN_AREA_SPEC, PID));
  // 在计划末尾塞一条必然失败的语句（主键冲突），模拟事务中途出错。
  plan.statements.push(['INSERT INTO gen_cells (id, project_id, position, note) VALUES (?, ?, ?, ?)', ['c1', PID, 0, 'x']]);
  assert.throws(() => applyPlan(db, plan));
  assert.deepEqual(readState(db), before);
  db.close();
});
