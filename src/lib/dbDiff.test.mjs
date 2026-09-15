import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GEN_AREA_SPEC,
  TEMPLATE_AREA_SPEC,
  BLOCK_AREA_SPEC,
  buildFullWritePlan,
  buildIncrementalWritePlan,
  fieldsFingerprint,
  normalizeSqlValue,
  pickFields,
  encodeSnapshotPayload,
  decodeSnapshotPayload,
} from './dbDiff.ts';

// ---- 构造期望态（内存里的卡片） --------------------------------------------
const slot = (id, mediaId, extra = {}) => ({
  id,
  fields: { media_id: mediaId, name: `m${mediaId}`, thumb: null, path: null, meta: null, type: 'image', ...extra },
});
const cell = (id, note, slots = []) => ({ id, fields: { note }, slots });

// 把一份期望态当成「库里已经是这样」，生成对应的指纹。和 db.ts 的
// readAreaFingerprint 保持同构（position = 数组下标，字段只取 spec 里的列）。
const fingerprintOf = (spec, containers) => ({
  containers: containers.map((c, i) => ({
    id: c.id,
    position: i,
    fields: pickFields(spec.containerColumns, c.fields),
  })),
  slots: containers.flatMap((c) =>
    c.slots.map((s, si) => ({
      id: s.id,
      parentId: c.id,
      position: si,
      fields: pickFields(spec.slotColumns, s.fields),
    }))
  ),
});

const sqlOf = (plan) => plan.statements.map(([sql]) => sql);
// 三张卡片、每张一个槽位：全量计划固定 8 条语句，够增量比出优势。
const threeCells = () => [
  cell('c1', 'n1', [slot('s1', 11)]),
  cell('c2', 'n2', [slot('s2', 22)]),
  cell('c3', 'n3', [slot('s3', 33)]),
];

// ============================================================================
// 全量覆盖：必须逐字复刻改造前 saveGenCells / saveTemplates / saveBlocks 的语句
// ============================================================================

test('全量计划复刻改造前生图区的 DELETE-all + 重新 INSERT 语句', () => {
  const plan = buildFullWritePlan(GEN_AREA_SPEC, 7, [cell('c1', 'note-1', [slot('s1', 11)])]);
  assert.equal(plan.full, true);
  assert.deepEqual(plan.statements, [
    ['DELETE FROM gen_slots WHERE cell_id IN (SELECT id FROM gen_cells WHERE project_id = ?)', [7]],
    ['DELETE FROM gen_cells WHERE project_id = ?', [7]],
    ['INSERT INTO gen_cells (id, project_id, position, note) VALUES (?, ?, ?, ?)', ['c1', 7, 0, 'note-1']],
    [
      'INSERT INTO gen_slots (id, cell_id, media_id, name, thumb, path, meta, type, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['s1', 'c1', 11, 'm11', null, null, null, 'image', 0],
    ],
  ]);
});

test('全量计划复刻改造前模板区 / 分镜区的语句与列顺序', () => {
  const tpl = buildFullWritePlan(TEMPLATE_AREA_SPEC, 3, [
    { id: 't1', fields: { name: '模板', content: '{}', referenceable: 1, include_title: 0 }, slots: [slot('ts1', 5)] },
  ]);
  assert.deepEqual(sqlOf(tpl), [
    'DELETE FROM template_slots WHERE template_id IN (SELECT id FROM gen_templates WHERE project_id = ?)',
    'DELETE FROM gen_templates WHERE project_id = ?',
    'INSERT INTO gen_templates (id, project_id, position, name, content, referenceable, include_title) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'INSERT INTO template_slots (id, template_id, media_id, name, thumb, path, meta, type, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ]);
  assert.deepEqual(tpl.statements[2][1], ['t1', 3, 0, '模板', '{}', 1, 0]);

  const blk = buildFullWritePlan(BLOCK_AREA_SPEC, 3, [
    { id: 'b1', fields: { content: null, combine_enabled: 1 }, slots: [] },
  ]);
  assert.deepEqual(sqlOf(blk), [
    'DELETE FROM block_slots WHERE block_id IN (SELECT id FROM blocks WHERE project_id = ?)',
    'DELETE FROM blocks WHERE project_id = ?',
    'INSERT INTO blocks (id, project_id, position, content, combine_enabled) VALUES (?, ?, ?, ?, ?)',
  ]);
  assert.deepEqual(blk.statements[2][1], ['b1', 3, 0, null, 1]);
});

// ============================================================================
// 增量 diff
// ============================================================================

test('无变化 → 一条语句都不产出', () => {
  const desired = threeCells();
  const plan = buildIncrementalWritePlan(GEN_AREA_SPEC, 1, desired, fingerprintOf(GEN_AREA_SPEC, desired));
  assert.equal(plan.full, false);
  assert.equal(plan.statements.length, 0);
  assert.deepEqual(plan.stats, {
    containerInserts: 0,
    containerUpdates: 0,
    containerDeletes: 0,
    slotInserts: 0,
    slotUpdates: 0,
    slotDeletes: 0,
  });
});

test('只改一张卡片正文 → 只产出 1 条 UPDATE，且不碰其它卡片与槽位', () => {
  const before = threeCells();
  const after = threeCells();
  after[1] = cell('c2', '改过的正文', [slot('s2', 22)]);
  const plan = buildIncrementalWritePlan(GEN_AREA_SPEC, 9, after, fingerprintOf(GEN_AREA_SPEC, before));
  assert.equal(plan.full, false);
  assert.deepEqual(plan.statements, [
    ['UPDATE gen_cells SET position = ?, note = ? WHERE id = ? AND project_id = ?', [1, '改过的正文', 'c2', 9]],
  ]);
  assert.equal(plan.stats.containerUpdates, 1);
  assert.equal(plan.stats.slotUpdates, 0);
});

test('新增一张卡片 → 只产出该卡片 + 其槽位的 INSERT OR REPLACE', () => {
  const before = threeCells();
  const after = [...threeCells(), cell('c4', 'n4', [slot('s4', 44)])];
  const plan = buildIncrementalWritePlan(GEN_AREA_SPEC, 2, after, fingerprintOf(GEN_AREA_SPEC, before));
  assert.equal(plan.full, false);
  assert.deepEqual(sqlOf(plan), [
    'INSERT OR REPLACE INTO gen_cells (id, project_id, position, note) VALUES (?, ?, ?, ?)',
    'INSERT OR REPLACE INTO gen_slots (id, cell_id, media_id, name, thumb, path, meta, type, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ]);
  assert.deepEqual(plan.statements[0][1], ['c4', 2, 3, 'n4']);
  assert.equal(plan.stats.containerInserts, 1);
  assert.equal(plan.stats.slotInserts, 1);
});

test('删除中间一张卡片 → 子记录按 cell_id 联带清理，后面卡片补一条 position UPDATE', () => {
  const before = threeCells();
  const after = [before[0], before[2]].map((c) => cell(c.id, c.fields.note, c.slots));
  const plan = buildIncrementalWritePlan(GEN_AREA_SPEC, 5, after, fingerprintOf(GEN_AREA_SPEC, before));
  assert.equal(plan.full, false);
  assert.deepEqual(plan.statements, [
    // 先按 cell_id 删子行：连指纹里没出现过的残留槽位也一起清掉。
    ['DELETE FROM gen_slots WHERE cell_id = ?', ['c2']],
    ['DELETE FROM gen_cells WHERE id = ? AND project_id = ?', ['c2', 5]],
    // c3 从 position 2 挪到 1。槽位在卡片内的下标没变，所以槽位一条语句都不发。
    ['UPDATE gen_cells SET position = ?, note = ? WHERE id = ? AND project_id = ?', [1, 'n3', 'c3', 5]],
  ]);
  assert.equal(plan.stats.containerDeletes, 1);
  assert.equal(plan.stats.slotDeletes, 1);
});

test('删除卡片时即使指纹里没有它的槽位，也照样发一条按 cell_id 的 DELETE', () => {
  const before = threeCells();
  const fingerprint = fingerprintOf(GEN_AREA_SPEC, before);
  // 模拟「库里这张卡片的槽位我们读不到 / 本来就是空卡片」的情况。
  fingerprint.slots = fingerprint.slots.filter((s) => s.parentId !== 'c3');
  const after = [before[0], before[1]];
  const plan = buildIncrementalWritePlan(GEN_AREA_SPEC, 5, after, fingerprint);
  assert.ok(plan.statements.some(([sql, params]) => sql === 'DELETE FROM gen_slots WHERE cell_id = ?' && params[0] === 'c3'));
});

test('只删一个槽位（卡片还在）→ 按槽位 id 删 + 后续槽位补 position', () => {
  const before = [cell('c1', 'n1', [slot('s1', 11), slot('s2', 22), slot('s3', 33)])];
  const after = [cell('c1', 'n1', [slot('s1', 11), slot('s3', 33)])];
  const plan = buildIncrementalWritePlan(GEN_AREA_SPEC, 4, after, fingerprintOf(GEN_AREA_SPEC, before));
  assert.equal(plan.full, false);
  assert.deepEqual(plan.statements[0], ['DELETE FROM gen_slots WHERE id = ?', ['s2']]);
  assert.equal(plan.statements.length, 2);
  assert.match(plan.statements[1][0], /^UPDATE gen_slots SET cell_id = \?, position = \?/);
  assert.equal(plan.stats.slotDeletes, 1);
  assert.equal(plan.stats.slotUpdates, 1);
});

test('卡片顺序变化 → 只产出受影响卡片的 position UPDATE，槽位不动', () => {
  const before = threeCells();
  const after = [before[1], before[0], before[2]];
  const plan = buildIncrementalWritePlan(GEN_AREA_SPEC, 6, after, fingerprintOf(GEN_AREA_SPEC, before));
  assert.equal(plan.full, false);
  assert.deepEqual(plan.statements, [
    ['UPDATE gen_cells SET position = ?, note = ? WHERE id = ? AND project_id = ?', [0, 'n2', 'c2', 6]],
    ['UPDATE gen_cells SET position = ?, note = ? WHERE id = ? AND project_id = ?', [1, 'n1', 'c1', 6]],
  ]);
  assert.equal(plan.stats.containerUpdates, 2);
});

test('槽位跨卡片搬家 → 一条 UPDATE 同时改 cell_id 与 position', () => {
  const before = [cell('c1', 'n1', [slot('s1', 11)]), cell('c2', 'n2', [])];
  const after = [cell('c1', 'n1', []), cell('c2', 'n2', [slot('s1', 11)])];
  const plan = buildIncrementalWritePlan(GEN_AREA_SPEC, 8, after, fingerprintOf(GEN_AREA_SPEC, before));
  assert.equal(plan.full, false);
  assert.deepEqual(plan.statements, [
    ['UPDATE gen_slots SET cell_id = ?, position = ?, media_id = ?, name = ?, thumb = ?, path = ?, meta = ?, type = ? WHERE id = ?',
      ['c2', 0, 11, 'm11', null, null, null, 'image', 's1']],
  ]);
});

test('模板区改一个开关 → 1 条 UPDATE gen_templates（同一套 diff 逻辑复用）', () => {
  const tpl = (includeTitle) => [
    { id: 't1', fields: { name: 'A', content: '{}', referenceable: 1, include_title: includeTitle }, slots: [slot('ts1', 5)] },
    { id: 't2', fields: { name: 'B', content: null, referenceable: 0, include_title: 1 }, slots: [] },
  ];
  const plan = buildIncrementalWritePlan(TEMPLATE_AREA_SPEC, 1, tpl(0), fingerprintOf(TEMPLATE_AREA_SPEC, tpl(1)));
  assert.deepEqual(plan.statements, [
    ['UPDATE gen_templates SET position = ?, name = ?, content = ?, referenceable = ?, include_title = ? WHERE id = ? AND project_id = ?',
      [0, 'A', '{}', 1, 0, 't1', 1]],
  ]);
});

test('增量不比全量省时退化成全量：清空整个区域', () => {
  const before = threeCells();
  const plan = buildIncrementalWritePlan(GEN_AREA_SPEC, 1, [], fingerprintOf(GEN_AREA_SPEC, before));
  assert.equal(plan.full, true);
  assert.equal(plan.reason, 'not-smaller-than-full');
  assert.deepEqual(sqlOf(plan), [
    'DELETE FROM gen_slots WHERE cell_id IN (SELECT id FROM gen_cells WHERE project_id = ?)',
    'DELETE FROM gen_cells WHERE project_id = ?',
  ]);
});

test('期望态里出现重复 id → 退化全量（保持改造前由主键冲突报错的语义）', () => {
  const dupContainer = [cell('c1', 'n1', []), cell('c1', 'n2', [])];
  assert.equal(buildIncrementalWritePlan(GEN_AREA_SPEC, 1, dupContainer, { containers: [], slots: [] }).reason, 'duplicate-id');
  const dupSlot = [cell('c1', 'n1', [slot('s1', 1)]), cell('c2', 'n2', [slot('s1', 2)])];
  const plan = buildIncrementalWritePlan(GEN_AREA_SPEC, 1, dupSlot, { containers: [], slots: [] });
  assert.equal(plan.full, true);
  assert.equal(plan.reason, 'duplicate-id');
});

test('库里是空的（首次保存）→ 纯 INSERT OR REPLACE，不发多余 DELETE', () => {
  const plan = buildIncrementalWritePlan(GEN_AREA_SPEC, 1, threeCells(), { containers: [], slots: [] });
  assert.equal(plan.full, false);
  assert.equal(plan.statements.length, 6);
  assert.ok(plan.statements.every(([sql]) => sql.startsWith('INSERT OR REPLACE')));
});

// ============================================================================
// 指纹 / 归一化的稳定性
// ============================================================================

test('同样内容两次指纹一致，key 顺序不影响判定', () => {
  const a = { note: '{"type":"doc"}', name: 'x', flag: 1 };
  const b = { flag: 1, name: 'x', note: '{"type":"doc"}' };
  assert.equal(fieldsFingerprint(a), fieldsFingerprint(a));
  assert.equal(fieldsFingerprint(a), fieldsFingerprint(b));
});

test('指纹区分 null / 空串 / 数字与同形字符串（宁可判定为变化多写一次）', () => {
  assert.notEqual(fieldsFingerprint({ v: null }), fieldsFingerprint({ v: '' }));
  assert.notEqual(fieldsFingerprint({ v: 1 }), fieldsFingerprint({ v: '1' }));
  assert.notEqual(fieldsFingerprint({ v: 'a' }), fieldsFingerprint({ v: 'b' }));
  // 值里带分隔符也不会撞车。
  assert.notEqual(fieldsFingerprint({ a: 'x', b: 'y' }), fieldsFingerprint({ a: 'x\u0002b\u0001sy' }));
});

test('缺列 / 布尔 / undefined 归一化到可写回的三种类型', () => {
  assert.equal(normalizeSqlValue(undefined), null);
  assert.equal(normalizeSqlValue(null), null);
  assert.equal(normalizeSqlValue(true), 1);
  assert.equal(normalizeSqlValue(false), 0);
  assert.equal(normalizeSqlValue(12), 12);
  assert.equal(normalizeSqlValue('s'), 's');
  // 列缺失 → null → 与库里的真实值指纹不同 → 触发一次多余写入，而不是漏写。
  assert.deepEqual(pickFields(['note', 'missing'], { note: 'n' }), { note: 'n', missing: null });
});

test('缺列的一行被判定为有变化（宁可多写一次，绝不漏写）', () => {
  const before = [cell('c1', 'n1', [])];
  const fingerprint = fingerprintOf(GEN_AREA_SPEC, before);
  fingerprint.containers[0].fields = { note: null };
  const plan = buildIncrementalWritePlan(GEN_AREA_SPEC, 1, before, fingerprint);
  assert.equal(plan.stats.containerUpdates, 1);
});

// ============================================================================
// 快照 payload 编解码
// ============================================================================

test('快照 payload 编解码往返，且两次编码同一内容结果一致', () => {
  const project = { name: 'p', panelLayout: null, genCells: [], templates: [], blocks: [], media: [], folders: [] };
  const text = encodeSnapshotPayload({ schemaVersion: 7, project, capturedAt: 123 });
  assert.equal(text, encodeSnapshotPayload({ schemaVersion: 7, project, capturedAt: 123 }));
  const decoded = decodeSnapshotPayload(text);
  assert.equal(decoded.snapshotVersion, 1);
  assert.equal(decoded.schemaVersion, 7);
  assert.equal(decoded.capturedAt, 123);
  assert.deepEqual(decoded.project, project);
});

test('坏 JSON / 版本不认识 / 缺 project → decode 返回 null（当快照不可用）', () => {
  assert.equal(decodeSnapshotPayload('{not json'), null);
  assert.equal(decodeSnapshotPayload('null'), null);
  assert.equal(decodeSnapshotPayload(JSON.stringify({ snapshotVersion: 99, project: {} })), null);
  assert.equal(decodeSnapshotPayload(JSON.stringify({ snapshotVersion: 1 })), null);
});
