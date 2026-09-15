// ============================================================================
// 写入：把请求转交给运行中的 App
//
// 不直接改数据库。App 把前端内存态当作唯一写入权威，它的增量保存会把「库里有、
// 内存里没有」的容器行 DELETE 掉，停止输入约 1.5 秒即触发 —— 外部直接写库的行会
// 在用户下一次敲键盘后被静默回收。
//
// 所以链路是：本模块 ──HTTP──> App 的控制端口 ──> 前端 store ──autoSave──> SQLite。
// 控制端口与 token 由 App 在 spawn 本进程时通过环境变量给出；没有它们就说明不是由
// App 启动的（例如用户手动跑 stdio 模式），此时写工具不注册，只提供只读能力。
// ============================================================================

const CONTROL_PORT = process.env.PROMPTLY_CONTROL_PORT?.trim();
const CONTROL_TOKEN = process.env.PROMPTLY_CONTROL_TOKEN?.trim();

export function writeAvailable(): boolean {
  return !!CONTROL_PORT && !!CONTROL_TOKEN;
}

interface ControlReply {
  ok: boolean;
  message: string;
}

/**
 * 把一个写操作交给 App 执行，等它给出确定结果。
 *
 * 两种回法：
 *   - 「无需确认」模式：App 直接执行，这里拿到成功或失败。
 *   - 「每次询问」模式：App 立刻回一个「需要你去确认」的失败态，不阻塞在这里。
 *     这是有意的 —— MCP 客户端默认 60 秒请求超时，而用户可能几分钟后才回来点确认，
 *     阻塞等待会变成「客户端已超时、用户随后批准」的错位。
 */
export async function requestWrite(
  action: string,
  payload: Record<string, unknown>
): Promise<string> {
  if (!writeAvailable()) {
    throw new Error(
      '写入通道不可用。写入需要由 Promptly 自己启动本服务（设置 → 通用 → MCP 服务），' +
        '手动启动的进程拿不到写入权限。'
    );
  }

  let reply: Response;
  try {
    reply = await fetch(`http://127.0.0.1:${CONTROL_PORT}/write`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-promptly-token': CONTROL_TOKEN as string,
      },
      body: JSON.stringify({ action, payload }),
      // 略小于 Rust 侧的 25 秒上限，让那边先超时并清理队列。
      signal: AbortSignal.timeout(28_000),
    });
  } catch (err) {
    throw new Error(
      `无法连接 Promptly：${(err as Error).message}。请确认 App 正在运行。`
    );
  }

  if (!reply.ok) {
    throw new Error(`Promptly 控制端口返回 HTTP ${reply.status}`);
  }

  const result = (await reply.json()) as ControlReply;
  if (!result.ok) throw new Error(result.message);
  return result.message;
}
