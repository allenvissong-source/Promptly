# Promptly MCP Server

把 Promptly 的项目、素材与编排好的提示词以 MCP 暴露给 AI 客户端（Claude Code、Codex、豆包等）。**只读**。

提示词是经过完整加工的：`@模板引用`已展开为实际内容（含被勾选的角色），素材引用已解析为 `Image1` / `图2` / `音频1` 编号——与在 App 里点"复制全部"得到的结果一致。

## 快速开始

```bash
cd mcp-server
npm install
npm run smoke     # 验证能读到数据、序列化正确
```

### stdio（默认，推荐）

给 Claude Code / Codex 这类能拉起子进程的客户端。没有监听端口，无网络攻击面。

```bash
npm start
```

客户端配置示例：

```json
{
  "mcpServers": {
    "promptly": {
      "command": "npx",
      "args": ["tsx", "/Users/<你>/Promptly/mcp-server/src/index.ts"]
    }
  }
}
```

### Streamable HTTP

给只能填 URL 的客户端（如豆包的自定义连接器）。

```bash
npm run start:http              # 127.0.0.1:3721/mcp
npm run start:http -- --port N  # 换端口
```

启动后把打印出来的 `http://127.0.0.1:3721/mcp` 填进客户端即可。

## 工具

| 工具 | 用途 |
|---|---|
| `list_projects` | 列出全部项目，拿 projectId |
| `get_project` | 项目概况与各区域卡片数 |
| `list_media` | 素材列表，可按项目 / 类型 / 名称过滤 |
| `get_gen_cells` | 生图区的提示词与图片 |
| `get_templates` | 模板区，含角色列表 |
| `get_blocks` | 分镜区，模板引用已展开 |
| `get_full_prompt` | 整项目合并提示词（最常用） |
| `read_media_file` | 读取图片内容，供多模态客户端查看 |

多数工具支持 `chipMode`：`code`（默认，`Image1` 编号）或 `name`（文件名）。

## 设计约束

**为什么只读。** Promptly 运行时把前端内存态当作唯一写入权威：它的增量保存会把"库里有、内存里没有"的容器行 `DELETE` 掉，且停止输入约 1.5 秒即触发。所以外部进程写库在 App 开着时没有安全窗口，写入可能被静默回收。只读由连接层强制（SQLite `readOnly`），不依赖调用方自觉。

要支持写入，需要先给 App 加一条"作废内存态并重新 hydrate"的通道，复用现有快照还原那套失效逻辑，而不是绕过自动保存。

**为什么用 Node 而不是 Rust。** 提示词序列化（`serializePromptContent` / `expandTemplateRef`）是前端的纯函数，Node 能零改动复用；Rust 得重写一份，那会让"模板引用如何展开"存在两套实现，规则一改就漂移。

**不用 `immutable=1`。** 那样会忽略 `-wal`，读到未 checkpoint 的旧数据，用户刚编辑的内容看不见。

**HTTP 模式的安全。** 只绑回环地址，并开启 `Host` / `Origin` 校验，防 DNS rebinding（恶意网页把域名解析到 127.0.0.1 来访问本地服务；SDK 自身曾有此漏洞 CVE-2025-66414，已在 1.24.0 修复，本项目用 1.30.0）。

## 环境变量

- `PROMPTLY_DB_PATH` — 覆盖数据库路径。默认取 Promptly 的 app data 目录。

## 验证

```bash
npm run check   # 类型检查
npm run smoke   # 数据层：只读、写入阻断、序列化正确性
npm run e2e     # 协议层：两种传输的真实客户端往返 + 安全校验
```

`e2e` 会实际拉起 server、用官方 client SDK 完成握手与工具调用，并用 curl 伪造 `Host` / `Origin` 确认返回 403。

## 兼容性

启动时校验数据库 `user_version` 必须等于 `7`。App 升级 schema 后需同步更新本 server 的 `SUPPORTED_SCHEMA_VERSION`，不匹配会直接拒绝启动而不是返回可能错误的数据。
