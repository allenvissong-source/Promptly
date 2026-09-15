// ============================================================================
// 入口：默认 stdio，--http 切到 Streamable HTTP
//
// 传输选择的依据（现行规范 2026-07-28 只保留这两种官方传输）：
//
//   stdio           本地部署的推荐方式。客户端把本进程当子进程拉起，走标准输入
//                   输出，没有监听端口，也就没有网络攻击面。Claude Code / Codex
//                   等原生支持。默认走这条。
//
//   Streamable HTTP 给只能填 URL 的客户端用（例如豆包的自定义连接器）。代价是
//                   开了本地端口：恶意网页可以用 DNS rebinding 把域名解析到
//                   127.0.0.1 来访问它（TypeScript SDK 自身就中过 CVE-2025-66414）。
//                   所以这里只绑回环地址，并强制开启 Host / Origin 校验。
//
// 被废弃的是 HTTP+SSE 那个双端点传输（2025-03-26 起），不是 stdio。
// ============================================================================

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.ts';
import { openReadonlyDb, resolveDbPath, SchemaVersionError } from './db.ts';

const DEFAULT_PORT = 3721;
const MCP_PATH = '/mcp';

interface Options {
  http: boolean;
  port: number;
  host: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { http: false, port: DEFAULT_PORT, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--http') opts.http = true;
    else if (arg === '--port') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`--port 需要 1-65535 的整数，收到：${argv[i]}`);
      }
      opts.port = value;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}（用 --help 查看用法）`);
    }
  }
  return opts;
}

function printUsage() {
  console.log(`${SERVER_NAME} MCP server v${SERVER_VERSION}

用法:
  npm start                    以 stdio 启动（默认，推荐本地使用）
  npm start -- --http          以 Streamable HTTP 启动，监听 127.0.0.1:${DEFAULT_PORT}${MCP_PATH}
  npm start -- --http --port N 指定端口

环境变量:
  PROMPTLY_DB_PATH   覆盖数据库路径（默认取 Promptly 的 app data 目录）

HTTP 模式只绑回环地址，并开启 Host / Origin 校验以防 DNS rebinding。`);
}

// 启动前先确认数据库可读、schema 版本匹配。宁可启动即失败，也不要让客户端连上
// 之后每次调用都报错 —— 那种失败对用户来说更难定位。
function preflight() {
  const path = resolveDbPath();
  try {
    const db = openReadonlyDb(path);
    const version = db.schemaVersion;
    db.close();
    return { path, version };
  } catch (err) {
    if (err instanceof SchemaVersionError) throw err;
    throw new Error(
      `无法读取 Promptly 数据库：${path}\n` +
        `原因：${(err as Error).message}\n` +
        `若数据库不在默认位置，请用 PROMPTLY_DB_PATH 指定。`
    );
  }
}

async function runStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio 模式下 stdout 是协议通道，任何额外输出都会破坏 JSON-RPC 帧，
  // 所以日志一律走 stderr。
  console.error(`${SERVER_NAME} MCP server v${SERVER_VERSION} 已就绪（stdio）`);
}

async function runHttp(opts: Options) {
  // 允许的 Host / Origin：只有回环地址。恶意网页即使把域名指向 127.0.0.1，
  // 请求里的 Host 头仍是它自己的域名，会被这里拦掉。
  const allowed = [
    `127.0.0.1:${opts.port}`,
    `localhost:${opts.port}`,
    `[::1]:${opts.port}`,
  ];
  const allowedOrigins = [
    `http://127.0.0.1:${opts.port}`,
    `http://localhost:${opts.port}`,
    `http://[::1]:${opts.port}`,
  ];

  // 每个会话一个 server + transport。无状态模式（sessionIdGenerator: undefined）
  // 更简单，但豆包这类客户端会复用会话，保留 session 更稳。
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const http = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Not Found. MCP 端点是 ${MCP_PATH}`);
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: allowed,
      allowedOrigins,
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => resolve());
  });

  const endpoint = `http://${opts.host}:${opts.port}${MCP_PATH}`;
  console.log(`${SERVER_NAME} MCP server v${SERVER_VERSION} 已就绪`);
  console.log(`端点: ${endpoint}`);
  console.log(`传输: Streamable HTTP（仅回环，已开启 Host / Origin 校验）`);
  console.log(`\n在客户端的自定义连接器里填这个 URL：${endpoint}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { path, version } = preflight();
  const log = opts.http ? console.log : console.error;
  log(`数据库: ${path}（schema v${version}）`);

  if (opts.http) await runHttp(opts);
  else await runStdio();
}

main().catch((err: unknown) => {
  console.error(`启动失败: ${(err as Error).message}`);
  process.exit(1);
});
