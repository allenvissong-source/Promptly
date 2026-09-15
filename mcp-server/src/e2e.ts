// ============================================================================
// 端到端验证：用真正的 MCP 客户端连接本 server，跑完整往返
//
// 不是「进程起来了」就算过 —— 必须验证协议层真的能用：
//   1. 客户端能连上并完成能力协商
//   2. tools/list 返回预期的工具集
//   3. tools/call 能拿到真实数据，且提示词已展开
//
// 两种传输各跑一遍。断言失败即非 0 退出。
// ============================================================================

import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'index.ts');

const EXPECTED_TOOLS = [
  'list_projects',
  'get_project',
  'list_media',
  'get_gen_cells',
  'get_templates',
  'get_blocks',
  'get_full_prompt',
  'read_media_file',
].sort();

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}`);
}

async function exercise(client: Client, label: string) {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`[${label}] tools/list → ${names.length} 个: ${names.join(', ')}`);
  assert.deepEqual(names, EXPECTED_TOOLS, '工具集与预期不符');

  // 每个工具都要有描述，否则模型不知道何时该用它。
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 10, `${t.name} 缺少有效描述`);
  }

  const projectsRes = await client.callTool({ name: 'list_projects', arguments: {} });
  const projects = JSON.parse((projectsRes.content as { text: string }[])[0].text) as {
    id: number;
    name: string;
  }[];
  console.log(`[${label}] list_projects → ${projects.length} 个项目`);
  assert.ok(projects.length > 0, '没有读到项目');

  // 挑一个真正有提示词内容的项目。只看卡片数量不够 —— 项目可能只有一张空白
  // 卡片（content 是个空文档骨架），那种情况下返回空文本是正确行为，验证不了展开。
  let target: { id: number; name: string } | undefined;
  let targetText = '';
  for (const p of projects) {
    const res = await client.callTool({
      name: 'get_full_prompt',
      arguments: { projectId: p.id },
    });
    const body = (res.content as { text: string }[])[0].text;
    if (body.trim().length > targetText.length) {
      target = p;
      targetText = body;
    }
  }
  assert.ok(target, '所有项目都没有内容，无法验证序列化');
  console.log(`[${label}] 内容最多的项目：#${target.id} ${target.name}`);

  console.log(`[${label}] get_full_prompt → ${targetText.length} 字符`);
  assert.ok(targetText.length > 0, '完整提示词为空');
  assert.ok(!/tpl-\d{10,}/.test(targetText), '提示词里残留未解析的 templateId');
  assert.ok(!/tslot-|bslot-/.test(targetText), '提示词里残留未解析的 slotId');

  // 分段结构也要能取到，且与纯文本一致。
  const segRes = await client.callTool({
    name: 'get_full_prompt',
    arguments: { projectId: target.id, format: 'segments' },
  });
  const seg = JSON.parse((segRes.content as { text: string }[])[0].text) as {
    segments: { area: string; text: string }[];
    text: string;
  };
  console.log(`[${label}] segments → ${seg.segments.length} 段`);
  assert.equal(seg.text, targetText, '分段模式与纯文本模式的合并结果不一致');

  // 三个区域的读取工具各跑一次，确认不抛错。
  for (const name of ['get_gen_cells', 'get_templates', 'get_blocks'] as const) {
    const res = await client.callTool({ name, arguments: { projectId: target.id } });
    assert.notEqual(res.isError, true, `${name} 返回错误`);
  }
  console.log(`[${label}] 三区域读取 → 均正常`);

  const mediaRes = await client.callTool({
    name: 'list_media',
    arguments: { projectId: target.id, type: 'image' },
  });
  const media = JSON.parse((mediaRes.content as { text: string }[])[0].text) as unknown[];
  console.log(`[${label}] list_media(image) → ${media.length} 个`);

  // 错误路径也要验：不存在的项目必须明确报错，不能返回空串蒙混过去。
  const bad = await client.callTool({
    name: 'get_project',
    arguments: { projectId: 999999 },
  });
  assert.equal(bad.isError, true, '不存在的项目应当返回错误');
  console.log(`[${label}] 错误路径 → 正确报错`);

  console.log(`[${label}] ✓ 全部往返通过`);
}

async function testStdio() {
  section('stdio 传输');
  const client = new Client({ name: 'smoke-client', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', entry],
  });
  await client.connect(transport);
  const info = client.getServerVersion();
  console.log(`已连接: ${info?.name} v${info?.version}`);
  await exercise(client, 'stdio');
  await client.close();
}

async function testHttp() {
  section('Streamable HTTP 传输');
  const port = 3799;
  let child: ChildProcess | undefined;
  try {
    child = spawn('npx', ['tsx', entry, '--http', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 等 server 打印就绪，而不是盲等固定秒数。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP server 启动超时')), 30000);
      child!.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('已就绪')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child!.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(`[server] ${chunk.toString()}`);
      });
      child!.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`HTTP server 提前退出，code=${code}`));
      });
    });

    const endpoint = `http://127.0.0.1:${port}/mcp`;
    const client = new Client({ name: 'smoke-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    console.log(`已连接: ${endpoint}`);
    await exercise(client, 'http');
    await client.close();

    // 安全校验必须真的生效：伪造 Host / Origin 模拟 DNS rebinding，都应被 403 拒绝。
    //
    // 这里用 curl 而不是 fetch —— fetch 把 Host 列为禁止修改的头部，JS 设了也不会
    // 发出去，测出来的会是「缺少 session」的 400，那等于没验证到安全逻辑。
    const probe = (header: string) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const args = [
          '-s',
          '-o',
          '-',
          '-w',
          '\n%{http_code}',
          '-X',
          'POST',
          endpoint,
          '-H',
          'content-type: application/json',
          '-H',
          'accept: application/json, text/event-stream',
          '-H',
          header,
          '-d',
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'probe', version: '0' },
            },
          }),
        ];
        const proc = spawn('curl', args, { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
        proc.once('close', () => {
          const idx = out.lastIndexOf('\n');
          resolve({ body: out.slice(0, idx), status: Number(out.slice(idx + 1)) });
        });
      });

    for (const [label, header, expect] of [
      ['Host', 'Host: evil.example.com', 'Invalid Host header'],
      ['Origin', 'Origin: http://evil.example.com', 'Invalid Origin header'],
    ] as const) {
      const res = await probe(header);
      console.log(`[http] 伪造 ${label} → HTTP ${res.status}`);
      assert.equal(res.status, 403, `伪造 ${label} 未被拒绝`);
      assert.ok(res.body.includes(expect), `拒绝原因不是 ${label} 校验：${res.body}`);
    }
    console.log('[http] ✓ DNS rebinding 防护生效（Host / Origin 均校验）');
  } finally {
    child?.kill('SIGTERM');
  }
}

await testStdio();
await testHttp();
console.log('\n两种传输均验证通过。\n');
