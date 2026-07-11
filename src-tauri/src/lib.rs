use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool};
use serde_json::Value as JsonValue;

// Resolve the physical uploads bucket for a given scope. Common-scope materials
// live under uploads/common; project-scoped materials under uploads/<projectId>.
// Folders are logical (DB-only), so they never appear in the physical layout.
fn scope_dir(app: &AppHandle, scope: &str, project_id: Option<i64>) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let uploads = app_data_dir.join("uploads");
    let dir = if scope == "common" {
        uploads.join("common")
    } else {
        let pid = project_id.ok_or("project scope requires a project_id")?;
        uploads.join(pid.to_string())
    };
    Ok(dir)
}

// Copy `source_path` into the bucket for (scope, project_id), returning the new
// absolute path. Shared by import / move / copy so naming stays consistent.
fn copy_into_bucket(
    app: &AppHandle,
    scope: &str,
    project_id: Option<i64>,
    source_path: &str,
) -> Result<String, String> {
    let file_name = PathBuf::from(source_path)
        .file_name()
        .ok_or("invalid file path")?
        .to_string_lossy()
        .to_string();
    let dir = scope_dir(app, scope, project_id)?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let unique_name = format!(
        "{}_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        file_name
    );
    let dest_path = dir.join(&unique_name);
    std::fs::copy(source_path, &dest_path).map_err(|e| e.to_string())?;
    Ok(dest_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn import_file(
    app: AppHandle,
    scope: String,
    project_id: Option<i64>,
    source_path: String,
) -> Result<String, String> {
    copy_into_bucket(&app, &scope, project_id, &source_path)
}

// Move a stored file into a different scope's bucket (used when a material is
// dragged 项目<->通用). Copies into the target bucket, then removes the source.
#[tauri::command]
async fn move_media_file(
    app: AppHandle,
    scope: String,
    project_id: Option<i64>,
    source_path: String,
) -> Result<String, String> {
    let dest = copy_into_bucket(&app, &scope, project_id, &source_path)?;
    // Best-effort source cleanup; the DB row already points at `dest`.
    let _ = std::fs::remove_file(&source_path);
    Ok(dest)
}

// Copy a stored file into a target scope's bucket (Shift-drag 复制), leaving the
// source in place.
#[tauri::command]
async fn copy_media_file(
    app: AppHandle,
    scope: String,
    project_id: Option<i64>,
    source_path: String,
) -> Result<String, String> {
    copy_into_bucket(&app, &scope, project_id, &source_path)
}

#[tauri::command]
async fn delete_project(app: AppHandle, project_id: i64) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let project_dir = app_data_dir.join("uploads").join(project_id.to_string());
    if project_dir.exists() {
        std::fs::remove_dir_all(&project_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ============================================
// Bundle export / import (single .zip round-trip)
// ============================================

// Milliseconds since the Unix epoch, used to make extracted file names unique.
fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// Write a single .zip containing `manifest.json` (the caller-built manifest of
// the 生图 / 模板 / 分镜 areas) plus every referenced asset under `assets/`.
// `assets` is a list of (archive_name, source_abs_path) pairs; the frontend
// picks archive names that are unique within the bundle and stores them as the
// per-slot `assetRef` in the manifest, so import can wire files back to slots.
// Missing source files are skipped rather than aborting, so an export never
// fails just because one backing file was moved/deleted.
#[tauri::command]
async fn export_bundle(
    dest_path: String,
    manifest: String,
    assets: Vec<(String, String)>,
) -> Result<(), String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    let file = std::fs::File::create(&dest_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("manifest.json", opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(manifest.as_bytes())
        .map_err(|e| e.to_string())?;

    for (name, src) in &assets {
        // Skip a file that vanished since the manifest was built.
        let data = match std::fs::read(src) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let arc = format!("assets/{}", name);
        zip.start_file(arc, opts).map_err(|e| e.to_string())?;
        zip.write_all(&data).map_err(|e| e.to_string())?;
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

// Read a bundle .zip: extract `manifest.json` and unpack every `assets/*` file
// into a neutral STAGING directory (uploads/.import_staging/<stamp>), returning
// a JSON string:
//   { "manifest": <parsed manifest object>,
//     "assets": { "<archive_name>": "<staged absolute path>", ... } }
// Staging (rather than a final bucket) keeps import routing uniform: a single
// bundle can carry several projects plus common materials, and the frontend
// then materializes each staged file into its correct bucket via `import_file`
// (which also hash-dedups common). The staging dir can be cleaned afterwards.
// Archive base names preserve their sub-path (e.g. "0/12_foo.png") so distinct
// projects' assets never collide, and each is re-extracted under a unique name.
#[tauri::command]
async fn import_bundle(app: AppHandle, zip_path: String) -> Result<String, String> {
    use std::io::Read;
    let file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    // Manifest first so a malformed bundle fails before we touch the fs.
    let manifest_text = {
        let mut mf = archive
            .by_name("manifest.json")
            .map_err(|_| "manifest.json missing in bundle".to_string())?;
        let mut s = String::new();
        mf.read_to_string(&mut s).map_err(|e| e.to_string())?;
        s
    };
    let manifest_val: JsonValue = serde_json::from_str(&manifest_text)
        .map_err(|e| format!("invalid manifest: {e}"))?;

    let stamp = now_millis();
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = app_data_dir
        .join("uploads")
        .join(".import_staging")
        .join(stamp.to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut asset_map = serde_json::Map::new();
    let count = archive.len();
    for i in 0..count {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if !name.starts_with("assets/") || name.ends_with('/') {
            continue;
        }
        let base = name.trim_start_matches("assets/");
        // Guard against path traversal / nested dirs: keep the file name only,
        // but stage each under a unique per-index name so equal names from
        // different projects never clobber each other.
        let file_name = PathBuf::from(base)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        if file_name.is_empty() {
            continue;
        }
        let unique = format!("{}_{}", i, file_name);
        let dest = dir.join(&unique);
        let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        asset_map.insert(
            base.to_string(),
            JsonValue::String(dest.to_string_lossy().to_string()),
        );
    }

    let result = serde_json::json!({
        "manifest": manifest_val,
        "assets": JsonValue::Object(asset_map),
    });
    Ok(result.to_string())
}

// Remove an import-staging directory created by `import_bundle` once the
// frontend has materialized every staged file into its final bucket. Confined
// to uploads/.import_staging so it can never touch real project data. Missing
// dir is treated as success.
#[tauri::command]
async fn cleanup_import_staging(app: AppHandle, dir: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let staging_root = app_data_dir.join("uploads").join(".import_staging");
    let target = PathBuf::from(&dir);
    // Only delete inside the staging root.
    if !target.starts_with(&staging_root) {
        return Err("refusing to delete outside import staging".to_string());
    }
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// B3: media metadata (byte size + optional duration), extracted on import.
#[derive(serde::Serialize)]
struct MediaMeta {
    // Human-readable file size, e.g. "1.2 MB". Always available.
    size: Option<String>,
    // "mm:ss" duration for audio/video, or None when it cannot be probed
    // (image, or no ffprobe on the host — the frontend keeps its '00:00'
    // fallback in that case).
    duration: Option<String>,
}

// Format a byte count as a compact human-readable string.
fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if b < KB * KB {
        format!("{:.1} KB", b / KB)
    } else if b < KB * KB * KB {
        format!("{:.1} MB", b / (KB * KB))
    } else {
        format!("{:.2} GB", b / (KB * KB * KB))
    }
}

// Probe a media file's duration via `ffprobe` if it is available on PATH.
// Returns None when ffprobe is missing or the file has no readable duration,
// so the caller can fall back to the '00:00' placeholder. This is the plan's
// "优先用探测工具，无则降级" behavior: no heavy Rust A/V decoder is pulled in,
// and a host without ffprobe simply keeps the placeholder.
fn probe_duration(path: &str) -> Option<String> {
    let output = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let secs: f64 = text.trim().parse().ok()?;
    if !secs.is_finite() || secs < 0.0 {
        return None;
    }
    let total = secs.round() as u64;
    Some(format!("{:02}:{:02}", total / 60, total % 60))
}

// B3: extract file size (+ duration for non-image) for a stored media file.
#[tauri::command]
async fn probe_media_meta(path: String, kind: String) -> Result<MediaMeta, String> {
    let size = std::fs::metadata(&path).ok().map(|m| human_size(m.len()));
    let duration = if kind == "image" {
        None
    } else {
        probe_duration(&path)
    };
    Ok(MediaMeta { size, duration })
}

// B2: content hash of a file for import dedup. Streams the file through a
// std hasher (constant memory, safe for large video) and mixes in the byte
// length to further reduce collisions. Returns a stable hex string used to
// detect an already-imported identical file within the same scope/project.
#[tauri::command]
async fn file_hash(path: String) -> Result<String, String> {
    use std::hash::Hasher;
    use std::io::Read;
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut buf = [0u8; 65536];
    let mut total: u64 = 0;
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.write(&buf[..n]);
        total += n as u64;
    }
    hasher.write_u64(total);
    Ok(format!("{:016x}", hasher.finish()))
}

// Atomically apply an ordered list of (sql, params) statements inside a single
// SQLite transaction. Unlike the plugin's per-call `execute` (each call may run
// on a *different* pooled connection, so a manual BEGIN/COMMIT split across
// calls can wedge the pool), this borrows ONE connection from the plugin's own
// pool for the whole transaction: every statement runs on that connection and
// commit/rollback are guaranteed to pair. Any failure rolls the whole batch
// back, so a full-rewrite save (DELETE-all + re-INSERT) can never leave a
// partially-written project. `db` is the same URL passed to Database.load
// (e.g. "sqlite:data.db").
#[tauri::command]
async fn execute_batch(
    db_instances: tauri::State<'_, DbInstances>,
    db: String,
    statements: Vec<(String, Vec<JsonValue>)>,
) -> Result<(), String> {
    let instances = db_instances.0.read().await;
    let pool = instances
        .get(&db)
        .ok_or_else(|| format!("database not loaded: {db}"))?;
    match pool {
        DbPool::Sqlite(pool) => {
            let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
            for (query, values) in statements {
                let mut q = sqlx::query(&query);
                for value in values {
                    // Bind by concrete JSON type so we don't depend on sqlx's
                    // optional `json` feature. Covers every type our save
                    // statements use (null / string / bool / int / float);
                    // objects/arrays fall back to their JSON text.
                    if value.is_null() {
                        q = q.bind(None::<String>);
                    } else if let Some(s) = value.as_str() {
                        q = q.bind(s.to_owned());
                    } else if let Some(b) = value.as_bool() {
                        q = q.bind(b);
                    } else if let Some(i) = value.as_i64() {
                        q = q.bind(i);
                    } else if let Some(f) = value.as_f64() {
                        q = q.bind(f);
                    } else {
                        q = q.bind(value.to_string());
                    }
                }
                if let Err(e) = q.execute(&mut *tx).await {
                    // Drop tx (implicit rollback) by returning the error.
                    let _ = tx.rollback().await;
                    return Err(e.to_string());
                }
            }
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(())
        }
        #[allow(unreachable_patterns)]
        _ => Err("execute_batch requires a SQLite database".into()),
    }
}

// Physically delete a single stored material file. Safety-gated: the target
// must resolve inside the app's uploads directory, so a bad/rogue path cannot
// remove arbitrary files. A file that is already gone is a no-op (success), so
// deleting a DB row whose file was manually removed never errors.
#[tauri::command]
async fn delete_media_file(app: AppHandle, path: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let uploads = app_data_dir.join("uploads");
    let target = PathBuf::from(&path);
    if !target.exists() {
        // Already gone — nothing to do.
        return Ok(());
    }
    // Confine the delete to the uploads tree. Canonicalize both sides so a
    // sandbox redirect / `..` traversal cannot escape the bucket.
    let uploads_real = std::fs::canonicalize(&uploads).unwrap_or(uploads.clone());
    let target_real = std::fs::canonicalize(&target).map_err(|e| e.to_string())?;
    if !target_real.starts_with(&uploads_real) {
        return Err("refusing to delete a file outside the uploads directory".into());
    }
    std::fs::remove_file(&target_real).map_err(|e| e.to_string())?;
    Ok(())
}

// Reveal a file in the OS file manager with the file selected.
#[tauri::command]
async fn reveal_in_explorer(path: String) -> Result<(), String> {
    let real = PathBuf::from(&path);
    if !real.exists() {
        return Err("file does not exist".into());
    }
    #[cfg(windows)]
    {
        // explorer /select, needs backslashes and a real (de-virtualized) path.
        let p = real_path(&path).replace('/', "\\");
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", p))
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        // Linux: open the containing directory.
        let dir = real.parent().unwrap_or(&real);
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
}

// Open a file with the OS default application.
#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    let real = PathBuf::from(&path);
    if !real.exists() {
        return Err("file does not exist".into());
    }
    #[cfg(windows)]
    {
        let p = real_path(&path).replace('/', "\\");
        // `cmd /C start "" <path>` launches with the default handler; the empty
        // "" is the window title arg that `start` requires.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &p])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
}

// Copy a set of image files to the system clipboard so they can be pasted into
// *any* target: file managers, terminals (Claude Code), and rich-text message
// boxes / web editors (QQ, WeChat, ChatGPT). Different targets read different
// clipboard formats, so we write several at once, mirroring what QQ itself puts
// on the clipboard when it copies multiple images:
//   * CF_HDROP (FileList)  -> file managers, terminals, "paste as file" targets.
//   * "HTML Format"        -> rich-text inline paste of several <img> at once
//                             (QQ / WeChat message box, ChatGPT web editor). This
//                             is the format those apps actually read; writing
//                             only CF_HDROP is why they used to paste nothing.
//   * "Preferred DropEffect" = DROPEFFECT_COPY, so drop targets treat it as a
//                             copy (not a move).
// The browser clipboard API can only write a single bitmap, so this must go
// through the native layer. `paths` are absolute paths to the stored files.
#[tauri::command]
async fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("no files".into());
    }
    #[cfg(windows)]
    {
        use clipboard_win::{formats, raw, register_format, Clipboard, Setter};

        // Opening the clipboard does NOT empty it, and `RawData`'s setter uses
        // EmptyClipboard on every call. If we wrote HTML / DropEffect via RawData
        // each write would wipe the formats written before it, leaving only the
        // last one. So: empty ONCE here, then write every format through NoClear
        // paths (FileList, set_without_clear) so they accumulate into one atomic
        // snapshot instead of clobbering each other.
        let _clip =
            Clipboard::new_attempts(10).map_err(|e| format!("open clipboard: {e}"))?;
        raw::empty().map_err(|e| format!("empty clipboard: {e}"))?;

        // The app runs inside an MSIX / AppContainer sandbox (it is launched as a
        // child of the host desktop app). Writes to `%AppData%\Roaming\...` are
        // transparently redirected by Windows to
        // `...\AppData\Local\Packages\<host>\LocalCache\Roaming\...`, but the path
        // strings the frontend hands us are the *logical* (pre-redirect) ones.
        // Terminals in the same sandbox resolve them fine, but QQ / WeChat /
        // browsers run OUTSIDE the sandbox and see the real filesystem, where the
        // logical path does not exist — so paste finds nothing to embed.
        //
        // Resolve every path to its real backing-store location before it hits the
        // clipboard. `canonicalize` uses GetFinalPathNameByHandle, which returns
        // the true path (following the sandbox redirect); we strip the `\\?\`
        // verbatim prefix because QQ/WeChat reject it. If canonicalize fails
        // (e.g. file missing) we fall back to the original path so behavior never
        // regresses vs. before.
        let real_paths: Vec<String> = paths
            .iter()
            .map(|p| real_path(p))
            .collect();

        // CF_HDROP wants canonical Windows paths (backslashes).
        let hdrop: Vec<String> = real_paths.iter().map(|p| p.replace('/', "\\")).collect();

        // 1) CF_HDROP file list (NoClear) — file managers, terminals, file paste.
        formats::FileList
            .write_clipboard(&hdrop)
            .map_err(|e| format!("set file list: {e}"))?;

        // 2) HTML Format (NoClear via set_without_clear): one <img> per file so
        //    rich-text targets inline all images at once. This is the carrier QQ
        //    itself uses and the real reason WeChat/ChatGPT can paste multiple
        //    images. CF_HTML needs a header of byte offsets; build_cf_html builds it.
        if let Some(fmt) = register_format("HTML Format") {
            let html = build_cf_html(&real_paths);
            raw::set_without_clear(fmt.get(), &html)
                .map_err(|e| format!("set html: {e}"))?;
        }

        // 3) Preferred DropEffect = DROPEFFECT_COPY (1) (NoClear), so paste is a
        //    copy and the source files are never removed on paste.
        if let Some(fmt) = register_format("Preferred DropEffect") {
            let copy: [u8; 4] = 1u32.to_le_bytes();
            let _ = raw::set_without_clear(fmt.get(), &copy);
        }

        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = paths;
        Err("file-list clipboard copy is only supported on Windows".into())
    }
}

// De-virtualize a logical sandbox path to its real filesystem path. Uses
// std::fs::canonicalize (GetFinalPathNameByHandle on Windows) so an MSIX /
// AppContainer redirect is followed to the actual backing store, then strips the
// `\\?\` verbatim prefix that some apps (QQ/WeChat) refuse. Falls back to the
// input unchanged when the file cannot be resolved, so paste never gets worse
// than before.
#[cfg(windows)]
fn real_path(p: &str) -> String {
    match std::fs::canonicalize(p) {
        Ok(buf) => {
            let s = buf.to_string_lossy().into_owned();
            s.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(s)
        }
        Err(_) => p.to_string(),
    }
}

// Build a CF_HTML payload embedding every image as an <img src="file:///...">.
// CF_HTML starts with a text header whose StartHTML/EndHTML/StartFragment/
// EndFragment fields are *byte* offsets into the payload. We use fixed 10-digit
// zero-padded fields (as QQ does) so the header length is stable, then fill in
// the computed offsets. Non-ASCII file names are kept as UTF-8; String::len()
// already returns byte lengths, so the offsets line up.
#[cfg(windows)]
fn build_cf_html(paths: &[String]) -> Vec<u8> {
    let mut imgs = String::new();
    for p in paths {
        // Forward slashes are the safe form for a file: URI.
        let uri = p.replace('\\', "/");
        imgs.push_str(&format!("<img src=\"file:///{}\">", uri));
    }
    let pre = "<html>\r\n<body>\r\n<!--StartFragment-->";
    let post = "<!--EndFragment-->\r\n</body>\r\n</html>";

    // Header length is fixed because the offset fields are always 10 digits.
    let header_len = format!(
        "Version:0.9\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\nStartFragment:{:010}\r\nEndFragment:{:010}\r\n",
        0, 0, 0, 0
    )
    .len();
    let start_html = header_len;
    let start_fragment = start_html + pre.len();
    let end_fragment = start_fragment + imgs.len();
    let end_html = end_fragment + post.len();

    let header = format!(
        "Version:0.9\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\nStartFragment:{:010}\r\nEndFragment:{:010}\r\n",
        start_html, end_html, start_fragment, end_fragment
    );

    let mut out = String::with_capacity(end_html + 1);
    out.push_str(&header);
    out.push_str(pre);
    out.push_str(&imgs);
    out.push_str(post);

    let mut bytes = out.into_bytes();
    bytes.push(0); // NUL-terminate, as consumers expect for CF_HTML.
    bytes
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_sql::Builder::new().build())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      import_file,
      delete_project,
      delete_media_file,
      reveal_in_explorer,
      open_path,
      execute_batch,
      copy_files_to_clipboard,
      move_media_file,
      copy_media_file,
      probe_media_meta,
      file_hash,
            export_bundle,
            import_bundle,
            cleanup_import_staging
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
