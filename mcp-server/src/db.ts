// ============================================================================
// 只读数据访问层
//
// 关键约束（均为实测结论，不是推断）：
//
//  1. 必须以 readOnly 打开。Promptly 运行时把「前端内存态」当作唯一写入权威：
//     它的增量保存会把「库里有、内存里没有」的容器行 DELETE 掉，且停止输入
//     1.5 秒即触发。所以任何外部进程写库都可能被静默回收 —— 只读是硬要求，
//     由连接层强制，而不是靠调用方自觉。
//  2. 不能用 immutable=1。那样会忽略 -wal，读到的是未 checkpoint 前的旧数据，
//     用户刚编辑的内容在这里看不见。
//  3. node:sqlite 的 readOnly 能正常打开 WAL 库（sqlite3 CLI 在 -shm 不存在时
//     会报 error 14，那是 CLI 自身的行为差异，与本模块无关）。
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Promptly 的 Tauri identifier，决定 app_data_dir 的位置。
const APP_IDENTIFIER = 'com.videopromptengine.app';

// 本模块支持的 schema 版本。低于它说明库还没被新版 App 迁移过，高于它说明
// App 已经引入了本 server 不认识的结构 —— 两种情况都拒绝服务，不猜。
export const SUPPORTED_SCHEMA_VERSION = 7;

export function defaultDbPath(): string {
  // macOS: ~/Library/Application Support/<identifier>/data.db
  return join(homedir(), 'Library', 'Application Support', APP_IDENTIFIER, 'data.db');
}

export function resolveDbPath(): string {
  const override = process.env.PROMPTLY_DB_PATH?.trim();
  return override ? override : defaultDbPath();
}

export class SchemaVersionError extends Error {
  constructor(readonly found: number) {
    super(
      `Promptly 数据库 schema 版本为 ${found}，本 server 仅支持 ${SUPPORTED_SCHEMA_VERSION}。` +
        '请确认 App 版本与本 server 匹配。'
    );
    this.name = 'SchemaVersionError';
  }
}

export interface ReadonlyDb {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined;
  close(): void;
  readonly path: string;
  readonly schemaVersion: number;
}

export function openReadonlyDb(path = resolveDbPath()): ReadonlyDb {
  const db = new DatabaseSync(path, { readOnly: true });

  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const schemaVersion = Number(row?.user_version ?? 0);
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    db.close();
    throw new SchemaVersionError(schemaVersion);
  }

  return {
    path,
    schemaVersion,
    all<T>(sql: string, ...params: unknown[]): T[] {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    get<T>(sql: string, ...params: unknown[]): T | undefined {
      return db.prepare(sql).get(...(params as never[])) as T | undefined;
    },
    close() {
      db.close();
    },
  };
}
