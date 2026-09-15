// ============================================================================
// MCP 写入通道
//
// 写入必须经由「运行中的 App 的前端」执行，不能由外部进程直接改库。原因是 App
// 把前端内存态当作唯一写入权威：它的增量保存会把「库里有、内存里没有」的容器行
// DELETE 掉，停止输入约 1.5 秒即触发。外部直接写库的行会在用户下一次敲键盘后被
// 静默回收。
//
// 所以链路是：
//
//   MCP server ──HTTP──> Rust 控制端口(本模块) ──事件──> 前端 store ──autoSave──> SQLite
//
// 前端调用的是 BlockStore / GenTemplateStore 已有的 setContent / addBlock 等方法，
// 改的是内存态，落库仍由 autoSave 负责。这样不绕过任何现有机制，界面也会实时更新。
//
// 为什么要额外开一个端口：MCP server 是独立的 node 进程，拿不到 Rust 进程里的内存
// 队列。控制端口只绑 127.0.0.1，并校验一个启动时随机生成的 token —— 这样即使本机
// 别的程序扫到了端口，没有 token 也调不动。token 通过环境变量传给 MCP 子进程。
//
// 用标准库的 TcpListener 手写极简 HTTP，不引入 axum / hyper：这里只有一条 POST
// 路由、请求体是小 JSON，为它加一整套 web 框架不值得。
// ============================================================================

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// 前端必须在这个时间内给出结果，否则视为超时。
///
/// 取 25 秒是被 MCP 客户端的默认请求超时（多数实现是 60 秒）倒推出来的：这里必须
/// 明显小于客户端超时，否则客户端先断开、而 App 还在等用户点确认，最后用户点了
/// 「允许」也没人接收结果 —— 那是「改了但报错」或「报错了却改了」的根源。
///
/// 需要用户确认的场景因此不能靠「一直等」来实现：确认请求会立刻返回一个明确的
/// 「已提交待确认」结果，由用户在 App 里处理，AI 那侧不阻塞。见 submit 的注释。
const RESULT_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WriteRequest {
    /// 请求 id，前端回结果时带回来做匹配。
    pub id: String,
    /// 操作类型：update_block / create_block / update_template / delete_card。
    pub action: String,
    /// 操作参数，结构由前端解释。
    pub payload: JsonValue,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub id: String,
    pub ok: bool,
    /// 成功时的说明（如「已更新分镜卡片 blk-xxx」），失败时的原因。
    pub message: String,
}

#[derive(Default)]
struct Results {
    /// 前端已回结果、等着被调用方取走的。
    map: HashMap<String, WriteResult>,
}

pub struct WriteChannel {
    /// 等前端来取的请求。刻意与 results 分开成两把锁：submit 会长时间在 results
    /// 上等待，若共用一把锁，前端的 take_pending 就永远拿不到锁，请求取不走 ——
    /// 那正是「投递成功但一直超时」的成因。
    pending: Mutex<Vec<WriteRequest>>,
    results: Mutex<Results>,
    /// 结果到达时唤醒等待的线程，避免轮询空转。绑定在 results 这把锁上。
    ready: Condvar,
    /// 前端是否已注册监听。没有监听者就直接拒绝请求，而不是让调用方白等
    /// 25 秒 —— 这种情况通常是 App 没开或还没加载完。
    listening: Arc<Mutex<bool>>,
}

impl Default for WriteChannel {
    fn default() -> Self {
        Self {
            pending: Mutex::new(Vec::new()),
            results: Mutex::new(Results::default()),
            ready: Condvar::new(),
            listening: Arc::new(Mutex::new(false)),
        }
    }
}

impl WriteChannel {
    pub fn set_listening(&self, value: bool) {
        *self.listening.lock().unwrap() = value;
    }

    pub fn is_listening(&self) -> bool {
        *self.listening.lock().unwrap()
    }

    /// 投递一个写请求并等前端处理完。
    ///
    /// 「无需确认」模式下前端会直接执行并回结果；「每次询问」模式下前端会立刻回一个
    /// 「需要去 App 确认」的结果，不让调用方阻塞到用户回来（MCP 客户端默认 60 秒
    /// 就超时了，阻塞等待会变成「客户端已超时、用户随后批准」的错位）。
    pub fn submit(&self, action: &str, payload: JsonValue) -> Result<String, String> {
        if !self.is_listening() {
            return Err(
                "Promptly 没有在运行，或界面还没加载完。写入需要 App 打开着才能执行。"
                    .to_string(),
            );
        }

        let id = format!(
            "w{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        self.pending.lock().unwrap().push(WriteRequest {
            id: id.clone(),
            action: action.to_string(),
            payload,
        });

        // 只锁 results 等待，pending 那把锁全程空闲，前端随时能取件。
        let mut guard = self.results.lock().unwrap();
        let deadline = std::time::Instant::now() + RESULT_TIMEOUT;
        loop {
            if let Some(result) = guard.map.remove(&id) {
                return if result.ok {
                    Ok(result.message)
                } else {
                    Err(result.message)
                };
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                drop(guard);
                // 超时了要把请求从队列里摘掉，否则前端过一会儿又执行一次，
                // 而调用方已经收到失败 —— 那会造成「报错了但其实改了」。
                self.pending.lock().unwrap().retain(|r| r.id != id);
                return Err(
                    "等待 Promptly 处理超时。请确认 App 正在运行且已打开目标项目。"
                        .to_string(),
                );
            }
            let (next, _) = self.ready.wait_timeout(guard, remaining).unwrap();
            guard = next;
        }
    }

    /// 前端来取待处理请求（取走即从队列移除）。
    pub fn take_pending(&self) -> Vec<WriteRequest> {
        std::mem::take(&mut *self.pending.lock().unwrap())
    }

    /// 前端回报结果。
    pub fn complete(&self, result: WriteResult) {
        self.results
            .lock()
            .unwrap()
            .map
            .insert(result.id.clone(), result);
        self.ready.notify_all();
    }
}

// ---- 控制端口 -------------------------------------------------------------

#[derive(Deserialize)]
struct ControlRequest {
    action: String,
    payload: JsonValue,
}

/// 启动控制端口。返回实际监听的端口号与随机 token，供 spawn MCP server 时传进去。
///
/// 端口取 0 让系统分配，避免与用户其它程序抢固定端口；token 每次启动重新生成，
/// 不落盘。
pub fn start_control_server(channel: Arc<WriteChannel>) -> Result<(u16, String), String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    // 随机 token：用系统时间纳秒 + 进程 id 做种，够用于本机防误连，不用引入
    // rand crate。它防的是「本机别的程序偶然扫到端口」，不是密码学场景。
    let token = format!(
        "{:x}{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        std::process::id()
    );

    let token_for_thread = token.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let channel = Arc::clone(&channel);
            let token = token_for_thread.clone();
            // 每个连接一个线程。并发量极低（只有 AI 写入时才有请求），
            // 不值得为它引入线程池。
            std::thread::spawn(move || {
                let _ = handle_connection(stream, channel, &token);
            });
        }
    });

    Ok((port, token))
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    let payload = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.as_bytes().len()
    );
    stream.write_all(payload.as_bytes())
}

fn handle_connection(
    mut stream: TcpStream,
    channel: Arc<WriteChannel>,
    token: &str,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);

    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    if !request_line.starts_with("POST /write") {
        return respond(&mut stream, "404 Not Found", r#"{"error":"not found"}"#);
    }

    // 读头部，拿 Content-Length 与 token。
    let mut content_length = 0usize;
    let mut provided_token = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            content_length = v.trim().parse().unwrap_or(0);
        } else if lower.starts_with("x-promptly-token:") {
            provided_token = trimmed
                .splitn(2, ':')
                .nth(1)
                .unwrap_or("")
                .trim()
                .to_string();
        }
    }

    if provided_token != token {
        return respond(&mut stream, "403 Forbidden", r#"{"error":"bad token"}"#);
    }

    // 限制请求体大小：正常的写请求是几 KB 的文本，给到 4MB 足够，
    // 同时避免恶意的超大 body 把内存吃光。
    if content_length > 4 * 1024 * 1024 {
        return respond(&mut stream, "413 Payload Too Large", r#"{"error":"too large"}"#);
    }

    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;

    let parsed: Result<ControlRequest, _> = serde_json::from_slice(&body);
    let Ok(request) = parsed else {
        return respond(&mut stream, "400 Bad Request", r#"{"error":"bad json"}"#);
    };

    // submit 会阻塞到前端处理完，所以这个连接会挂一会儿 —— 这是有意的，
    // MCP 工具调用需要拿到确定结果。
    match channel.submit(&request.action, request.payload) {
        Ok(message) => {
            let body = serde_json::json!({ "ok": true, "message": message }).to_string();
            respond(&mut stream, "200 OK", &body)
        }
        Err(message) => {
            let body = serde_json::json!({ "ok": false, "message": message }).to_string();
            // 用 200 承载业务失败，让调用方统一从 body.ok 判断，
            // 不用区分「HTTP 层错」和「业务层拒绝」。
            respond(&mut stream, "200 OK", &body)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 验证 submit 与 take_pending 不互相阻塞 —— 这正是之前「投递成功但一直超时」
    // 的根因所在：两者若共用一把锁，前端就永远取不走请求。
    #[test]
    fn submit_does_not_block_take_pending() {
        let channel = Arc::new(WriteChannel::default());
        channel.set_listening(true);

        let c = Arc::clone(&channel);
        let submitter = std::thread::spawn(move || c.submit("update_block", serde_json::json!({})));

        // 给 submit 一点时间进入等待状态。
        std::thread::sleep(Duration::from_millis(200));

        // 关键断言：此刻必须能取到请求。取不到就说明 submit 把锁占住了。
        let taken = channel.take_pending();
        assert_eq!(taken.len(), 1, "submit 阻塞了 take_pending");

        channel.complete(WriteResult {
            id: taken[0].id.clone(),
            ok: true,
            message: "ok".into(),
        });
        assert_eq!(submitter.join().unwrap().unwrap(), "ok");
    }

    #[test]
    fn rejects_when_no_listener() {
        let channel = WriteChannel::default();
        let err = channel.submit("update_block", serde_json::json!({})).unwrap_err();
        assert!(err.contains("没有在运行"), "实际: {err}");
    }
}
