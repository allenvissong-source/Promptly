// ============================================================================
// 增量写入的纯计算层
//
// 「内存态 -> SQLite 写入语句」的全部判断都放在这里：没有 Database / invoke 依赖，
// 所以可以被 node 内置 test runner 直接跑（dbDiff.test.mjs），不需要 mock 整个
// SQLite。db.ts 只负责读指纹 + 把 statements 丢进同一个 execute_batch 事务。
//
// 三个区域（生图 gen_cells / 模板 gen_templates / 分镜 blocks）的表结构是同构的：
// 「容器表(project_id, position, 若干业务列) + 槽位子表(parentColumn, position,
// 若干业务列)」，所以用一份 AreaTableSpec 描述，diff 逻辑只写一遍。
// ============================================================================

export type SqlValue = string | number | null;

// 一条语句：SQL 文本 + 位置参数（与 db.ts 的 BatchStatement 同构）。
export type SqlStatement = [string, SqlValue[]];

export interface AreaTableSpec {
  containerTable: string;
  slotTable: string;
  // 子表里指回容器的列名。
  parentColumn: string;
  // 容器表除 id / project_id / position / created_at 之外要写的业务列，顺序即
  // INSERT 的列顺序（刻意与改造前的全量 INSERT 保持逐字一致）。
  containerColumns: string[];
  // 子表除 id / parentColumn / position 之外的业务列。
  slotColumns: string[];
}

export const GEN_AREA_SPEC: AreaTableSpec = {
  containerTable: 'gen_cells',
  slotTable: 'gen_slots',
  parentColumn: 'cell_id',
  containerColumns: ['note'],
  slotColumns: ['media_id', 'name', 'thumb', 'path', 'meta', 'type'],
};

export const TEMPLATE_AREA_SPEC: AreaTableSpec = {
  containerTable: 'gen_templates',
  slotTable: 'template_slots',
  parentColumn: 'template_id',
  containerColumns: ['name', 'content', 'referenceable', 'include_title'],
  slotColumns: ['media_id', 'name', 'thumb', 'path', 'meta', 'type'],
};

export const BLOCK_AREA_SPEC: AreaTableSpec = {
  containerTable: 'blocks',
  slotTable: 'block_slots',
  parentColumn: 'block_id',
  containerColumns: ['content', 'combine_enabled'],
  slotColumns: ['media_id', 'name', 'thumb', 'path', 'meta', 'type'],
};

// ---- 期望态（内存里的卡片） -------------------------------------------------
export interface DesiredSlot {
  id: string;
  fields: Record<string, SqlValue>;
}

export interface DesiredContainer {
  id: string;
  fields: Record<string, SqlValue>;
  // 顺序即 position（写库时用数组下标，和改造前一致）。
  slots: DesiredSlot[];
}

// ---- 现状指纹（库里已有的行） ----------------------------------------------
export interface ExistingContainerRow {
  id: string;
  position: number;
  fields: Record<string, SqlValue>;
}

export interface ExistingSlotRow {
  id: string;
  parentId: string;
  position: number;
  fields: Record<string, SqlValue>;
}

export interface AreaFingerprint {
  containers: ExistingContainerRow[];
  slots: ExistingSlotRow[];
}

// 计数单位是「语句数」而不是行数：全量计划里 containerDeletes / slotDeletes 恒为
// 1（各一条 DELETE 全部），增量计划里则等于实际删掉的容器 / 槽位条数。
export interface WritePlanStats {
  containerInserts: number;
  containerUpdates: number;
  containerDeletes: number;
  slotInserts: number;
  slotUpdates: number;
  slotDeletes: number;
}

// 退化成全量覆盖的原因（null = 走了增量）。
export type FullRewriteReason =
  | 'forced'
  | 'fingerprint-unavailable'
  | 'duplicate-id'
  | 'not-smaller-than-full';

export interface WritePlan {
  statements: SqlStatement[];
  stats: WritePlanStats;
  // true = 这份计划是「DELETE 全部 + 重新 INSERT」的全量覆盖。
  full: boolean;
  reason: FullRewriteReason | null;
}

function emptyStats(): WritePlanStats {
  return {
    containerInserts: 0,
    containerUpdates: 0,
    containerDeletes: 0,
    slotInserts: 0,
    slotUpdates: 0,
    slotDeletes: 0,
  };
}

// SQLite 是弱类型的，读回来的值可能是 number / string / boolean / null / undefined。
// 统一收敛成能写回去的三种，undefined（列缺失）当 null —— 缺列必然判定为「有变化」，
// 方向偏向多写一次。
export function normalizeSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  return JSON.stringify(value);
}

// 只挑出 spec 关心的列并归一化，避免 SELECT * 带回来的多余列干扰比较。
export function pickFields(columns: string[], row: Record<string, unknown>): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const column of columns) out[column] = normalizeSqlValue(row[column]);
  return out;
}

// 内容指纹：key 先排序再序列化，所以「同样内容两次序列化必然一致」且「key 顺序不
// 影响判定」。用 JSON.stringify 编码（而不是自己拼分隔符）是为了避免值里刚好含
// 分隔符时两组不同字段撞出同一个指纹。类型带标记（数字 1 与字符串 '1' 不同），
// 宁可判定为变化多写一次。
export function fieldsFingerprint(fields: Record<string, SqlValue>): string {
  return JSON.stringify(
    Object.keys(fields)
      .sort()
      .map((key) => {
        const value = fields[key];
        const tag = value === null ? 'N' : typeof value === 'number' ? 'n' : 's';
        return [key, tag, value];
      })
  );
}

function insertContainerSql(spec: AreaTableSpec, orReplace: boolean): string {
  const columns = ['id', 'project_id', 'position', ...spec.containerColumns];
  return `INSERT ${orReplace ? 'OR REPLACE ' : ''}INTO ${spec.containerTable} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
}

function insertSlotSql(spec: AreaTableSpec, orReplace: boolean): string {
  const columns = ['id', spec.parentColumn, ...spec.slotColumns, 'position'];
  return `INSERT ${orReplace ? 'OR REPLACE ' : ''}INTO ${spec.slotTable} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
}

function containerValues(spec: AreaTableSpec, container: DesiredContainer, projectId: number, position: number): SqlValue[] {
  return [
    container.id,
    projectId,
    position,
    ...spec.containerColumns.map((column) => normalizeSqlValue(container.fields[column])),
  ];
}

function slotValues(spec: AreaTableSpec, slot: DesiredSlot, parentId: string, position: number): SqlValue[] {
  return [
    slot.id,
    parentId,
    ...spec.slotColumns.map((column) => normalizeSqlValue(slot.fields[column])),
    position,
  ];
}

// 全量覆盖：先删掉该项目的全部子行与容器行，再按内存顺序重新 INSERT。逐字复刻
// 改造前 saveGenCells / saveTemplates / saveBlocks 的语句序列，用于首次保存、
// schema 变更后、diff 失败时的兜底，以及快照还原。
export function buildFullWritePlan(
  spec: AreaTableSpec,
  projectId: number,
  containers: DesiredContainer[],
  reason: FullRewriteReason | null = null
): WritePlan {
  const statements: SqlStatement[] = [
    [
      `DELETE FROM ${spec.slotTable} WHERE ${spec.parentColumn} IN (SELECT id FROM ${spec.containerTable} WHERE project_id = ?)`,
      [projectId],
    ],
    [`DELETE FROM ${spec.containerTable} WHERE project_id = ?`, [projectId]],
  ];
  const stats = emptyStats();
  stats.containerDeletes = 1;
  stats.slotDeletes = 1;
  containers.forEach((container, index) => {
    statements.push([insertContainerSql(spec, false), containerValues(spec, container, projectId, index)]);
    stats.containerInserts += 1;
    container.slots.forEach((slot, slotIndex) => {
      statements.push([insertSlotSql(spec, false), slotValues(spec, slot, container.id, slotIndex)]);
      stats.slotInserts += 1;
    });
  });
  return { statements, stats, full: true, reason };
}

function hasDuplicateIds(containers: DesiredContainer[]): boolean {
  const containerIds = new Set<string>();
  const slotIds = new Set<string>();
  for (const container of containers) {
    if (containerIds.has(container.id)) return true;
    containerIds.add(container.id);
    for (const slot of container.slots) {
      if (slotIds.has(slot.id)) return true;
      slotIds.add(slot.id);
    }
  }
  return false;
}

// 增量写入：只对「新增 / 更新 / 删除」三组生成语句。
//
// 正确性优先，几处刻意「宁可多写」的地方：
//   1. 期望态里出现重复 id -> 直接退化全量（保持改造前由主键冲突报错的语义）；
//   2. 语句数不比全量少 -> 退化全量（例如清空整个区域）；
//   3. 新增用 INSERT OR REPLACE：指纹是事务外读的，万一读漏一行也不会因主键
//      冲突整笔失败；
//   4. 位置 / 任一业务列指纹不同就整行 UPDATE（不做列级 diff，少一层出错面）；
//   5. 删除容器时按 parentColumn 删子行（而不是按已知子行 id 删），连指纹里没
//      出现过的残留子行一起清掉。
export function buildIncrementalWritePlan(
  spec: AreaTableSpec,
  projectId: number,
  containers: DesiredContainer[],
  fingerprint: AreaFingerprint
): WritePlan {
  if (hasDuplicateIds(containers)) {
    return buildFullWritePlan(spec, projectId, containers, 'duplicate-id');
  }

  const existingContainers = new Map(fingerprint.containers.map((row) => [row.id, row]));
  const existingSlots = new Map(fingerprint.slots.map((row) => [row.id, row]));
  const desiredContainerIds = new Set(containers.map((container) => container.id));
  const desiredSlotIds = new Set<string>();
  for (const container of containers) for (const slot of container.slots) desiredSlotIds.add(slot.id);

  const stats = emptyStats();
  const deletes: SqlStatement[] = [];
  const writes: SqlStatement[] = [];

  // 1. 删掉不再存在的容器，并连带清理它名下的全部子行。
  for (const row of fingerprint.containers) {
    if (desiredContainerIds.has(row.id)) continue;
    deletes.push([`DELETE FROM ${spec.slotTable} WHERE ${spec.parentColumn} = ?`, [row.id]]);
    deletes.push([`DELETE FROM ${spec.containerTable} WHERE id = ? AND project_id = ?`, [row.id, projectId]]);
    stats.containerDeletes += 1;
    stats.slotDeletes += 1;
  }

  // 2. 删掉「容器还在、槽位被移除」的子行。容器已被删除的子行由上一步兜掉。
  for (const row of fingerprint.slots) {
    if (desiredSlotIds.has(row.id)) continue;
    if (!desiredContainerIds.has(row.parentId)) continue;
    deletes.push([`DELETE FROM ${spec.slotTable} WHERE id = ?`, [row.id]]);
    stats.slotDeletes += 1;
  }

  // 3. 新增 / 更新。position 用数组下标，所以顺序变化天然表现为 position 变化。
  containers.forEach((container, index) => {
    const previous = existingContainers.get(container.id);
    const fields = pickFields(spec.containerColumns, container.fields);
    if (!previous) {
      writes.push([insertContainerSql(spec, true), containerValues(spec, container, projectId, index)]);
      stats.containerInserts += 1;
    } else if (
      previous.position !== index ||
      fieldsFingerprint(previous.fields) !== fieldsFingerprint(fields)
    ) {
      writes.push([
        `UPDATE ${spec.containerTable} SET position = ?, ${spec.containerColumns.map((column) => `${column} = ?`).join(', ')} WHERE id = ? AND project_id = ?`,
        [index, ...spec.containerColumns.map((column) => fields[column]), container.id, projectId],
      ]);
      stats.containerUpdates += 1;
    }
    container.slots.forEach((slot, slotIndex) => {
      const previousSlot = existingSlots.get(slot.id);
      const slotFields = pickFields(spec.slotColumns, slot.fields);
      if (!previousSlot) {
        writes.push([insertSlotSql(spec, true), slotValues(spec, slot, container.id, slotIndex)]);
        stats.slotInserts += 1;
      } else if (
        previousSlot.parentId !== container.id ||
        previousSlot.position !== slotIndex ||
        fieldsFingerprint(previousSlot.fields) !== fieldsFingerprint(slotFields)
      ) {
        // parentColumn 一起写：槽位跨卡片搬家时是一次 UPDATE，不会漏掉归属变化。
        writes.push([
          `UPDATE ${spec.slotTable} SET ${spec.parentColumn} = ?, position = ?, ${spec.slotColumns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`,
          [container.id, slotIndex, ...spec.slotColumns.map((column) => slotFields[column]), slot.id],
        ]);
        stats.slotUpdates += 1;
      }
    });
  });

  // 删除必须排在写入之前：跨卡片搬家的槽位会先被「删除旧容器」的 parentColumn
  // 删掉，再由后面的 UPDATE/INSERT OR REPLACE 重新落地。
  const statements = [...deletes, ...writes];
  const fullPlan = buildFullWritePlan(spec, projectId, containers, 'not-smaller-than-full');
  if (statements.length >= fullPlan.statements.length) return fullPlan;
  return { statements, stats, full: false, reason: null };
}

