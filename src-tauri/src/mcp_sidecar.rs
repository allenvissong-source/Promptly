// ============================================================================
// MCP server 的进程管理
//
// 只服务 HTTP 传输。stdio 模式不在这里管 —— 那种模式下是客户端（Claude Code /
// Codex 等）自己把 server 当子进程拉起，App 提前起一个没有意义：管道另一端没有
// 客户端，进程只会空转等输入。
//
// HTTP 模式不一样：豆包这类客户端只会去连一个 URL，不会启动进程，所以必须有人先
// 把它跑起来。这里让 App 负责，启动时拉起、退出时收掉。
//
// Node 依赖：mcp-server 是 TypeScript，需要 node 才能跑，而 macOS 不自带 node。
// 因此这里不假设它存在 —— 探测不到就返回明确的状态给前端，让设置界面告诉用户装
// Node 或改用 stdio，而不是静默失败或让 App 起不来。
// ============================================================================

use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub const DEFAULT_PORT: u16 = 3721;

// 探测 node 的位置。PATH 在 GUI 应用里通常只有 /usr/bin:/bin:/usr/sbin:/sbin，
// 拿不到用户 shell 里的 nvm / homebrew 路径，所以除了 PATH 还要查常见安装点。
fn find_node() -> Option<PathBuf> {
    if let Ok(output) = Command::new("/usr/bin/which").arg("node").output() {
        if output.status.success() {
            let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
            if path.is_file() {
                return Some(path);
            }
        }
    }

    let home = std::env::var("HOME").ok()?;
    let candidates = [
        PathBuf::from("/opt/homebrew/bin/node"), // Apple Silicon homebrew
        PathBuf::from("/usr/local/bin/node"),    // Intel homebrew / 官方安装包
        PathBuf::from(format!("{home}/.local/bin/node/bin/node")),
        PathBuf::from(format!("{home}/.volta/bin/node")),
    ];
    for p in candidates {
        if p.is_file() {
            return Some(p);
        }
    }

    // nvm 装的 node 在 versions/node/<版本>/bin 下，版本号不固定，取最新的一个。
    let nvm = PathBuf::from(format!("{home}/.nvm/versions/node"));
    if let Ok(entries) = std::fs::read_dir(&nvm) {
        let mut versions: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.join("bin/node").is_file())
            .collect();
        versions.sort();
        if let Some(latest) = versions.pop() {
            return Some(latest.join("bin/node"));
        }
    }
    None
}

// 打包好的 server 单文件。构建时由 mcp-server/build.mjs 生成，随 App 放进
// Resources。用打包产物而不是 src + node_modules：产物不到 1MB，运行时只需要
// node 本身，不必带 tsx / esbuild（那套装完 34MB），少一层出错环节。
fn server_script(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resource) = app.path().resource_dir() {
        let bundled = resource.join("mcp-server/server.mjs");
        if bundled.is_file() {
            return Some(bundled);
        }
    }
    #[cfg(debug_assertions)]
    {
        // tauri dev 不 stage 资源，回落到源码位置，保证 dev 与打包行为一致。
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()?
            .join("mcp-server/dist-bundle/server.mjs");
        if dev.is_file() {
            return Some(dev);
        }
    }
    None
}

#[derive(Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    /// 当前是否有正在运行的 server 进程。
    pub running: bool,
    /// HTTP 端点，running 为 true 时才有意义。
    pub endpoint: Option<String>,
    pub port: u16,
    /// 探测到的 node 路径；None 表示环境里没有 node，无法启动。
    pub node_path: Option<String>,
    /// mcp-server 目录是否就位。
    pub server_available: bool,
    /// 上一次启动失败的原因，供设置界面显示。
    pub last_error: Option<String>,
}

pub struct McpState {
    child: Mutex<Option<Child>>,
    port: Mutex<u16>,
    last_error: Mutex<Option<String>>,
}

impl Default for McpState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            port: Mutex::new(DEFAULT_PORT),
            last_error: Mutex::new(None),
        }
    }
}

impl McpState {
    pub fn status(&self, app: &AppHandle) -> McpStatus {
        let mut guard = self.child.lock().unwrap();
        // try_wait 顺手回收已经自己退出的进程，避免状态显示为「运行中」但实际已死。
        let running = match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(_)) => {
                    *guard = None;
                    false
                }
                Ok(None) => true,
                Err(_) => false,
            },
            None => false,
        };
        let port = *self.port.lock().unwrap();
        McpStatus {
            running,
            endpoint: running.then(|| format!("http://127.0.0.1:{port}/mcp")),
            port,
            node_path: find_node().map(|p| p.to_string_lossy().into_owned()),
            server_available: server_script(app).is_some(),
            last_error: self.last_error.lock().unwrap().clone(),
        }
    }

    pub fn start(&self, app: &AppHandle, port: u16) -> Result<McpStatus, String> {
        if self.status(app).running {
            return Ok(self.status(app));
        }

        let script = server_script(app)
            .ok_or_else(|| "找不到 MCP server 程序文件，安装包可能不完整".to_string())?;
        let node = find_node().ok_or_else(|| {
            "系统里没有 Node.js。MCP 服务需要它才能运行；请安装 Node 20 以上版本，\
             或改用 stdio 方式在 Claude Code / Codex 里配置。"
                .to_string()
        })?;

        let child = Command::new(&node)
            .arg(&script)
            .arg("--http")
            .arg("--port")
            .arg(port.to_string())
            // 不继承 stdio：父进程退出时子进程若还往管道写会拿到 SIGPIPE，
            // 而且这些输出对 GUI 应用没有去处。诊断信息通过 status 里的
            // last_error 暴露给设置界面。
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 MCP 服务失败：{e}"))?;

        *self.child.lock().unwrap() = Some(child);
        *self.port.lock().unwrap() = port;
        *self.last_error.lock().unwrap() = None;
        Ok(self.status(app))
    }

    pub fn stop(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            // 等一下再撒手，避免留下僵尸进程。
            let _ = child.wait();
        }
    }

    pub fn set_error(&self, message: String) {
        *self.last_error.lock().unwrap() = Some(message);
    }
}
