use serde_json::Value as JsonValue;
use sqlx::Row;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool};

#[cfg(target_os = "macos")]
mod mac_titlebar;

const DB_URL: &str = "sqlite:data.db";
const STORAGE_MARKER: &str = ".promptly-storage.json";

fn default_storage_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("uploads"))
}

fn reject_unsafe_components(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("storage root is empty".into());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("parent traversal is not allowed".into());
    }
    Ok(())
}

fn canonicalize_or_create(path: &Path) -> Result<PathBuf, String> {
    reject_unsafe_components(path)?;
    std::fs::create_dir_all(path).map_err(|e| format!("cannot create storage root: {e}"))?;
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("cannot resolve storage root: {e}"))?;
    let probe = canonical.join(format!(".promptly-write-test-{}", now_millis()));
    std::fs::write(&probe, b"ok").map_err(|e| format!("storage root is not writable: {e}"))?;
    std::fs::remove_file(probe).map_err(|e| format!("storage root cleanup failed: {e}"))?;
    Ok(canonical)
}

fn paths_overlap(a: &Path, b: &Path) -> bool {
    a == b || a.starts_with(b) || b.starts_with(a)
}

async fn sqlite_pool(
    db_instances: &tauri::State<'_, DbInstances>,
) -> Result<sqlx::SqlitePool, String> {
    let instances = db_instances.0.read().await;
    match instances
        .get(DB_URL)
        .ok_or_else(|| format!("database not loaded: {DB_URL}"))?
    {
        DbPool::Sqlite(pool) => Ok(pool.clone()),
        #[allow(unreachable_patterns)]
        _ => Err("storage registry requires SQLite".into()),
    }
}

async fn ensure_storage_table(pool: &sqlx::SqlitePool) -> Result<(), String> {
    sqlx::query("CREATE TABLE IF NOT EXISTS storage_spaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)")
        .execute(pool).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn registered_roots(pool: &sqlx::SqlitePool) -> Result<Vec<PathBuf>, String> {
    ensure_storage_table(pool).await?;
    let rows = sqlx::query("SELECT root_path FROM storage_spaces ORDER BY created_at, id")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| PathBuf::from(r.get::<String, _>(0)))
        .collect())
}

async fn bootstrap_default_root(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
) -> Result<PathBuf, String> {
    let root = canonicalize_or_create(&default_storage_root(app)?)?;
    ensure_storage_table(pool).await?;
    sqlx::query("INSERT OR IGNORE INTO storage_spaces (name, root_path) VALUES (?, ?)")
        .bind("默认空间")
        .bind(root.to_string_lossy().to_string())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(root)
}

async fn require_registered_root(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    storage_root: &str,
) -> Result<PathBuf, String> {
    bootstrap_default_root(app, pool).await?;
    let requested = std::fs::canonicalize(PathBuf::from(storage_root))
        .map_err(|e| format!("storage root does not exist: {e}"))?;
    let roots = registered_roots(pool).await?;
    if roots.iter().any(|r| r == &requested) {
        Ok(requested)
    } else {
        Err("unregistered storage root".into())
    }
}

fn safe_child(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("unsafe relative path".into());
    }
    let candidate = root.join(relative);
    let mut existing = candidate.as_path();
    while !existing.exists() {
        existing = existing.parent().ok_or("path has no existing ancestor")?;
    }
    let ancestor = std::fs::canonicalize(existing).map_err(|e| e.to_string())?;
    if !ancestor.starts_with(root) {
        return Err("path escapes storage root".into());
    }
    Ok(candidate)
}

fn scope_relative(scope: &str, project_id: Option<i64>) -> Result<PathBuf, String> {
    match scope {
        "common" => Ok(PathBuf::from("common")),
        "project" => {
            let pid = project_id.ok_or("project scope requires a project_id")?;
            if pid < 0 {
                return Err("invalid project_id".into());
            }
            Ok(PathBuf::from(pid.to_string()))
        }
        _ => Err("scope must be common or project".into()),
    }
}

async fn scope_dir(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    storage_root: &str,
    scope: &str,
    project_id: Option<i64>,
) -> Result<PathBuf, String> {
    let root = require_registered_root(app, pool, storage_root).await?;
    safe_child(&root, &scope_relative(scope, project_id)?)
}

fn validate_existing_source(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    reject_unsafe_components(path)?;
    let real = std::fs::canonicalize(path).map_err(|e| format!("source does not exist: {e}"))?;
    if !roots.iter().any(|root| real.starts_with(root)) {
        return Err("source file is outside registered storage spaces".into());
    }
    if !real.is_file() {
        return Err("source is not a file".into());
    }
    Ok(real)
}

async fn copy_into_bucket(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    storage_root: &str,
    scope: &str,
    project_id: Option<i64>,
    source_path: &str,
    source_must_be_registered: bool,
) -> Result<String, String> {
    bootstrap_default_root(app, pool).await?;
    let roots = registered_roots(pool).await?;
    let source = if source_must_be_registered {
        validate_existing_source(Path::new(source_path), &roots)?
    } else {
        let p = std::fs::canonicalize(source_path)
            .map_err(|e| format!("source does not exist: {e}"))?;
        if !p.is_file() {
            return Err("source is not a file".into());
        }
        p
    };
    let file_name = source
        .file_name()
        .ok_or("invalid file path")?
        .to_string_lossy();
    let dir = scope_dir(app, pool, storage_root, scope, project_id).await?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dir_real = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    let unique_name = format!("{}_{}", now_millis(), file_name);
    let dest_path = safe_child(&dir_real, Path::new(&unique_name))?;
    std::fs::copy(source, &dest_path).map_err(|e| e.to_string())?;
    Ok(dest_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn get_default_storage_root(
    app: AppHandle,
    db_instances: tauri::State<'_, DbInstances>,
) -> Result<String, String> {
    let pool = sqlite_pool(&db_instances).await?;
    Ok(bootstrap_default_root(&app, &pool)
        .await?
        .to_string_lossy()
        .to_string())
}

#[derive(serde::Serialize)]
struct StorageValidation {
    normalized_root: String,
    recognizable: bool,
    writable: bool,
    registered: bool,
}

fn is_recognizable_storage(root: &Path) -> bool {
    root.join(STORAGE_MARKER).is_file()
        || root.join("common").is_dir()
        || std::fs::read_dir(root)
            .ok()
            .map(|it| {
                it.filter_map(Result::ok).any(|e| {
                    e.path().is_dir() && e.file_name().to_string_lossy().parse::<i64>().is_ok()
                })
            })
            .unwrap_or(false)
}

async fn validate_space_impl(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    storage_root: &str,
) -> Result<StorageValidation, String> {
    bootstrap_default_root(app, pool).await?;
    let input = PathBuf::from(storage_root);
    reject_unsafe_components(&input)?;
    let root =
        std::fs::canonicalize(&input).map_err(|e| format!("storage root does not exist: {e}"))?;
    let roots = registered_roots(pool).await?;
    if roots.iter().any(|r| r != &root && paths_overlap(r, &root)) {
        return Err("storage roots cannot be equal or nested".into());
    }
    let probe = root.join(format!(".promptly-write-test-{}", now_millis()));
    let writable = std::fs::write(&probe, b"ok")
        .and_then(|_| std::fs::remove_file(&probe))
        .is_ok();
    Ok(StorageValidation {
        normalized_root: root.to_string_lossy().to_string(),
        recognizable: is_recognizable_storage(&root),
        writable,
        registered: roots.contains(&root),
    })
}

#[tauri::command]
async fn validate_storage_space(
    app: AppHandle,
    db_instances: tauri::State<'_, DbInstances>,
    storage_root: String,
) -> Result<StorageValidation, String> {
    let pool = sqlite_pool(&db_instances).await?;
    validate_space_impl(&app, &pool, &storage_root).await
}

#[tauri::command]
async fn create_storage_space(
    app: AppHandle,
    db_instances: tauri::State<'_, DbInstances>,
    storage_root: String,
) -> Result<StorageValidation, String> {
    let pool = sqlite_pool(&db_instances).await?;
    bootstrap_default_root(&app, &pool).await?;
    let root = canonicalize_or_create(Path::new(&storage_root))?;
    let roots = registered_roots(&pool).await?;
    if roots.iter().any(|r| paths_overlap(r, &root)) {
        return Err("storage roots cannot be equal or nested".into());
    }
    std::fs::write(root.join(STORAGE_MARKER), br#"{"version":1}"#).map_err(|e| e.to_string())?;
    validate_space_impl(&app, &pool, root.to_string_lossy().as_ref()).await
}

#[tauri::command]
async fn add_storage_space(
    app: AppHandle,
    db_instances: tauri::State<'_, DbInstances>,
    storage_root: String,
) -> Result<StorageValidation, String> {
    let pool = sqlite_pool(&db_instances).await?;
    let validation = validate_space_impl(&app, &pool, &storage_root).await?;
    if !validation.recognizable {
        return Err("existing directory is not a recognizable Promptly storage space".into());
    }
    if !validation.writable {
        return Err("storage root is not writable".into());
    }
    validate_space_impl(&app, &pool, &validation.normalized_root).await
}

#[tauri::command]
async fn list_storage_spaces(
    app: AppHandle,
    db_instances: tauri::State<'_, DbInstances>,
) -> Result<Vec<String>, String> {
    let pool = sqlite_pool(&db_instances).await?;
    bootstrap_default_root(&app, &pool).await?;
    Ok(registered_roots(&pool)
        .await?
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
async fn import_file(
    app: AppHandle,
    db_instances: tauri::State<'_, DbInstances>,
    storage_root: String,
    scope: String,
    project_id: Option<i64>,
    source_path: String,
) -> Result<String, String> {
    let pool = sqlite_pool(&db_instances).await?;
    copy_into_bucket(
        &app,
        &pool,
        &storage_root,
        &scope,
        project_id,
        &source_path,
        false,
    )
    .await
}

#[tauri::command]
async fn move_media_file(
    app: AppHandle,
    db_instances: tauri::State<'_, DbInstances>,
    storage_root: String,
    scope: String,
    project_id: Option<i64>,
    source_path: String,
) -> Result<String, String> {
    let pool = sqlite_pool(&db_instances).await?;
    let source =
        validate_existing_source(Path::new(&source_path), &registered_roots(&pool).await?)?;
    let dest = copy_into_bucket(
        &app,
        &pool,
        &storage_root,
        &scope,
        project_id,
        source.to_string_lossy().as_ref(),
        true,
    )
    .await?;
    std::fs::remove_file(source).map_err(|e| format!("copied but failed to remove source: {e}"))?;
    Ok(dest)
}

#[tauri::command]
async fn copy_media_file(
    app: AppHandle,
    db_instances: tauri::State<'_, DbInstances>,
    storage_root: String,
    scope: String,
    project_id: Option<i64>,
    source_path: String,
) -> Result<String, String> {
    let pool = sqlite_pool(&db_instances).await?;
    copy_into_bucket(
        &app,
        &pool,
        &storage_root,
        &scope,
        project_id,
        &source_path,
        true,
    )
    .await
}

#[tauri::command]
async fn delete_project(
    app: AppHandle,
    db_instances: tauri::State<'_, DbInstances>,
    project_id: i64,
) -> Result<(), String> {
    if project_id < 0 {
        return Err("invalid project_id".into());
    }
    let pool = sqlite_pool(&db_instances).await?;
    bootstrap_default_root(&app, &pool).await?;
    for root in registered_roots(&pool).await? {
        let project_dir = safe_child(&root, Path::new(&project_id.to_string()))?;
        if project_dir.exists() {
            let real = std::fs::canonicalize(&project_dir).map_err(|e| e.to_string())?;
            if !real.starts_with(&root) {
                return Err("project directory escapes storage root".into());
            }
            std::fs::remove_dir_all(real).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct MigrationExpectation {
    relative_path: String,
    size: u64,
    hash: Option<String>,
}

#[derive(serde::Serialize)]
struct MigrationResult {
    phase: String,
    files_copied: u64,
    bytes_copied: u64,
    files_verified: u64,
}

fn stable_file_hash(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn collect_storage_files(root: &Path) -> Result<Vec<(PathBuf, PathBuf, u64)>, String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(PathBuf, PathBuf, u64)>) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let ty = entry.file_type().map_err(|e| e.to_string())?;
            if ty.is_symlink() {
                return Err("storage migration refuses symlinks".into());
            }
            let path = entry.path();
            if ty.is_dir() {
                walk(base, &path, out)?;
            } else if ty.is_file()
                && path.file_name().and_then(|n| n.to_str()) != Some(STORAGE_MARKER)
            {
                let rel = path
                    .strip_prefix(base)
                    .map_err(|_| "migration path escaped source")?
                    .to_path_buf();
                reject_unsafe_components(&rel)?;
                out.push((
                    path,
                    rel,
                    entry.metadata().map_err(|e| e.to_string())?.len(),
                ));
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(root, root, &mut files)?;
    Ok(files)
}

#[tauri::command]
async fn migrate_storage_space(
    app: AppHandle,
    db_instances: tauri::State<'_, DbInstances>,
    source_root: String,
    destination_root: String,
    expectations: Option<Vec<MigrationExpectation>>,
) -> Result<MigrationResult, String> {
    let pool = sqlite_pool(&db_instances).await?;
    let source = require_registered_root(&app, &pool, &source_root).await?;
    let destination = canonicalize_or_create(Path::new(&destination_root))?;
    let roots = registered_roots(&pool).await?;
    if roots.iter().any(|r| paths_overlap(r, &destination)) {
        return Err("destination overlaps a registered storage root".into());
    }
    if std::fs::read_dir(&destination)
        .map_err(|e| e.to_string())?
        .next()
        .is_some()
    {
        return Err("migration destination must be empty".into());
    }
    let files = collect_storage_files(&source)?;
    if let Some(expected) = expectations.as_ref() {
        if expected.len() != files.len() {
            return Err("migration file count does not match expectations".into());
        }
        for e in expected {
            let (_, _, size) = files
                .iter()
                .find(|(_, rel, _)| rel == Path::new(&e.relative_path))
                .ok_or("expected relative path is missing")?;
            if *size != e.size {
                return Err(format!("size mismatch for {}", e.relative_path));
            }
        }
    }
    let mut copied = 0u64;
    let mut bytes = 0u64;
    let copy_result: Result<(), String> = (|| {
        for (src, rel, size) in &files {
            let dest = safe_child(&destination, rel)?;
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
            if std::fs::metadata(&dest).map_err(|e| e.to_string())?.len() != *size {
                return Err(format!("copy size mismatch for {}", rel.display()));
            }
            copied += 1;
            bytes += size;
        }
        if let Some(expected) = expectations.as_ref() {
            for e in expected.iter().filter(|e| e.hash.is_some()) {
                let dest = safe_child(&destination, Path::new(&e.relative_path))?;
                if stable_file_hash(&dest)? != *e.hash.as_ref().unwrap() {
                    return Err(format!("hash mismatch for {}", e.relative_path));
                }
            }
        }
        std::fs::write(destination.join(STORAGE_MARKER), br#"{"version":1}"#)
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = copy_result {
        let _ = std::fs::remove_dir_all(&destination);
        return Err(format!("copy/verify failed; destination rolled back: {e}"));
    }

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let source_text = source.to_string_lossy().to_string();
    let destination_text = destination.to_string_lossy().to_string();
    if let Err(e) = async {
        sqlx::query("UPDATE storage_spaces SET root_path = ?, updated_at = CURRENT_TIMESTAMP WHERE root_path = ?")
            .bind(&destination_text)
            .bind(&source_text)
            .execute(&mut *tx)
            .await?;
        for table_col in [
            ("media", "path"),
            ("media", "thumb"),
            ("media", "preview_path"),
            ("gen_slots", "path"),
            ("template_slots", "path"),
            ("block_slots", "path"),
        ] {
            let sql = format!(
                "UPDATE {} SET {} = ? || substr({}, length(?) + 1) WHERE {} = ? OR {} LIKE ?",
                table_col.0, table_col.1, table_col.1, table_col.1, table_col.1
            );
            sqlx::query(&sql)
                .bind(&destination_text)
                .bind((source_text.len() + 1) as i64)
                .bind(&source_text)
                .bind(format!("{}{}%", source_text, std::path::MAIN_SEPARATOR))
                .execute(&mut *tx)
                .await?;
        }
        Ok::<(), sqlx::Error>(())
    }
    .await
    {
        let _ = tx.rollback().await;
        let _ = std::fs::remove_dir_all(&destination);
        return Err(format!(
            "database update failed; destination rolled back: {e}"
        ));
    }
    if let Err(e) = tx.commit().await {
        let _ = std::fs::remove_dir_all(&destination);
        return Err(format!(
            "database commit failed; destination rolled back: {e}"
        ));
    }
    Ok(MigrationResult {
        phase: "complete".into(),
        files_copied: copied,
        bytes_copied: bytes,
        files_verified: copied,
    })
}

#[tauri::command]
async fn read_media(
    app: AppHandle,
    db_instances: tauri::State<'_, DbInstances>,
    media_id: i64,
    variant: Option<String>,
) -> Result<Vec<u8>, String> {
    let pool = sqlite_pool(&db_instances).await?;
    bootstrap_default_root(&app, &pool).await?;
    let row = sqlx::query("SELECT path, thumb, preview_path FROM media WHERE id = ?")
        .bind(media_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("media not found")?;
    let path: String = row.get(0);
    let thumb: Option<String> = row.get(1);
    let preview_path: Option<String> = row.get(2);
    let stored = match variant.as_deref().unwrap_or("path") {
        "path" => path,
        "thumb" => thumb.unwrap_or(path),
        "preview" => preview_path.unwrap_or(path),
        _ => return Err("invalid media variant".into()),
    };
    let real = validate_existing_source(Path::new(&stored), &registered_roots(&pool).await?)?;
    std::fs::read(real).map_err(|e| e.to_string())
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
    app: AppHandle,
    db_instances: tauri::State<'_, DbInstances>,
    dest_path: String,
    manifest: String,
    assets: Vec<(String, String)>,
) -> Result<(), String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let pool = sqlite_pool(&db_instances).await?;
    bootstrap_default_root(&app, &pool).await?;
    let roots = registered_roots(&pool).await?;

    let file = std::fs::File::create(&dest_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("manifest.json", opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(manifest.as_bytes())
        .map_err(|e| e.to_string())?;

    for (name, src) in &assets {
        let real = match validate_existing_source(Path::new(src), &roots) {
            Ok(path) => path,
            Err(err) if err.starts_with("source does not exist:") => continue,
            Err(err) => return Err(err),
        };
        let data = match std::fs::read(real) {
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
    let manifest_val: JsonValue =
        serde_json::from_str(&manifest_text).map_err(|e| format!("invalid manifest: {e}"))?;

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
        "stagingDir": dir.to_string_lossy().to_string(),
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

// ---------------------------------------------------------------------------
// ffmpeg integration
//
// A single `ffmpeg` binary is the only external tool this app relies on. We
// prefer an app-managed copy under <app_data>/bin (downloaded on demand via
// the system `curl`, see `download_ffmpeg`) and fall back to any `ffmpeg` on
// PATH. Everything — duration, codec detection, thumbnails, HEVC->H.264
// preview transcode — is derived from that one binary; there is no separate
// ffprobe dependency (duration/codec are parsed from `ffmpeg -i` stderr).
// ---------------------------------------------------------------------------

// Location of the app-managed ffmpeg binary, if it has been downloaded.
fn ffmpeg_bin_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("bin");
    let name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let p = dir.join(name);
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

// The ffmpeg command to invoke: the managed binary if present, else "ffmpeg"
// from PATH.
fn resolve_ffmpeg(app: &AppHandle) -> String {
    if let Some(p) = ffmpeg_bin_path(app) {
        return p.to_string_lossy().to_string();
    }
    "ffmpeg".to_string()
}

// Parse "Duration: HH:MM:SS.xx" from `ffmpeg -i` stderr. ffmpeg exits non-zero
// when no output file is given, so we read stderr regardless of status. Returns
// "mm:ss" (minutes may exceed 59 for long clips, matching prior behavior) or
// None when the field is absent/unparseable.
fn probe_duration_ffmpeg(ffmpeg: &str, path: &str) -> Option<String> {
    let output = std::process::Command::new(ffmpeg)
        .args(["-i", path])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stderr);
    let idx = text.find("Duration:")?;
    let after = &text[idx + "Duration:".len()..];
    let dur = after.trim_start().split(',').next()?.trim();
    let parts: Vec<&str> = dur.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].trim().parse().ok()?;
    let m: f64 = parts[1].trim().parse().ok()?;
    let s: f64 = parts[2].trim().parse().ok()?;
    if !(h.is_finite() && m.is_finite() && s.is_finite()) {
        return None;
    }
    let total = (h * 3600.0 + m * 60.0 + s).round() as u64;
    Some(format!("{:02}:{:02}", total / 60, total % 60))
}

// Parse the primary video codec (lowercase, e.g. "hevc", "h264") from the first
// "Video:" stream line in `ffmpeg -i` stderr. None when there is no video track
// or ffmpeg is unavailable.
fn probe_video_codec(ffmpeg: &str, path: &str) -> Option<String> {
    let output = std::process::Command::new(ffmpeg)
        .args(["-i", path])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stderr);
    for line in text.lines() {
        if line.contains("Video:") {
            let after = line.split("Video:").nth(1)?;
            let codec = after
                .trim()
                .split(|c: char| c == ' ' || c == ',' || c == '(')
                .next()?
                .trim();
            if !codec.is_empty() {
                return Some(codec.to_lowercase());
            }
        }
    }
    None
}

// B3: extract file size (+ duration for non-image) for a stored media file.
#[tauri::command]
async fn probe_media_meta(app: AppHandle, path: String, kind: String) -> Result<MediaMeta, String> {
    let size = std::fs::metadata(&path).ok().map(|m| human_size(m.len()));
    let duration = if kind == "image" {
        None
    } else {
        let ffmpeg = resolve_ffmpeg(&app);
        probe_duration_ffmpeg(&ffmpeg, &path)
    };
    Ok(MediaMeta { size, duration })
}

// Reported availability of ffmpeg to the frontend so it can decide whether to
// offer the one-click download on first video import.
#[derive(serde::Serialize)]
struct FfmpegStatus {
    available: bool,
    path: Option<String>,
    // true when it is the app-managed copy under <app_data>/bin.
    managed: bool,
}

#[tauri::command]
async fn ffmpeg_status(app: AppHandle) -> Result<FfmpegStatus, String> {
    if let Some(p) = ffmpeg_bin_path(&app) {
        return Ok(FfmpegStatus {
            available: true,
            path: Some(p.to_string_lossy().to_string()),
            managed: true,
        });
    }
    // Fall back to PATH: confirm by actually running `ffmpeg -version`.
    let ok = std::process::Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    Ok(FfmpegStatus {
        available: ok,
        path: if ok { Some("ffmpeg".to_string()) } else { None },
        managed: false,
    })
}

// Download `url` to `dest` using the system curl (present on Win10+ and macOS).
// No new Rust HTTP dependency is pulled in. Fails on HTTP error or a
// suspiciously small result.
fn download_url_to(url: &str, dest: &std::path::Path) -> Result<(), String> {
    let status = std::process::Command::new("curl")
        .args(["-sSL", "--fail", "--max-time", "900", "-o"])
        .arg(dest)
        .arg(url)
        .status()
        .map_err(|e| format!("curl spawn failed: {e}"))?;
    if !status.success() {
        return Err(format!("curl failed for {url}"));
    }
    let big_enough = std::fs::metadata(dest)
        .map(|m| m.len() > 100_000)
        .unwrap_or(false);
    if !big_enough {
        return Err(format!("downloaded file too small from {url}"));
    }
    Ok(())
}

// Find the ffmpeg executable inside a downloaded zip (BtbN/gyan.dev nest it
// under <folder>/bin/ffmpeg.exe; the macOS builds ship a bare `ffmpeg`) and
// extract just that one file to `dest_bin`.
fn extract_ffmpeg_from_zip(
    zip_path: &std::path::Path,
    dest_bin: &std::path::Path,
) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let want = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let mut found: Option<usize> = None;
    for i in 0..archive.len() {
        let f = archive.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().replace('\\', "/");
        let base = name.rsplit('/').next().unwrap_or("");
        if base == want {
            found = Some(i);
            break;
        }
    }
    let idx = found.ok_or("ffmpeg binary not found in archive")?;
    let mut f = archive.by_index(idx).map_err(|e| e.to_string())?;
    if let Some(parent) = dest_bin.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut out = std::fs::File::create(dest_bin).map_err(|e| e.to_string())?;
    std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
    drop(out);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(dest_bin)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(dest_bin, perms).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// One-click ffmpeg install: download a platform build and extract the binary to
// <app_data>/bin. Tries a fallback chain of mirrors and returns the resolved
// path. If a managed binary already exists it is returned as-is.
#[tauri::command]
async fn download_ffmpeg(app: AppHandle) -> Result<String, String> {
    let bin_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
    let name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let dest_bin = bin_dir.join(name);
    if dest_bin.exists() {
        return Ok(dest_bin.to_string_lossy().to_string());
    }
    let urls: Vec<&str> = if cfg!(windows) {
        vec![
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
            "https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
            "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
        ]
    } else if cfg!(target_arch = "aarch64") {
        vec!["https://ffmpeg.martin-riedl.de/redirect/latest/darwin/arm64/release/ffmpeg.zip"]
    } else {
        vec!["https://evermeet.cx/ffmpeg/getrelease/zip"]
    };
    let tmp_zip = bin_dir.join("ffmpeg_download.zip");
    let mut last_err = String::from("no sources tried");
    for url in urls {
        let _ = std::fs::remove_file(&tmp_zip);
        match download_url_to(url, &tmp_zip) {
            Ok(()) => match extract_ffmpeg_from_zip(&tmp_zip, &dest_bin) {
                Ok(()) => {
                    let _ = std::fs::remove_file(&tmp_zip);
                    return Ok(dest_bin.to_string_lossy().to_string());
                }
                Err(e) => last_err = format!("extract from {url}: {e}"),
            },
            Err(e) => last_err = e,
        }
    }
    let _ = std::fs::remove_file(&tmp_zip);
    Err(format!("all ffmpeg sources failed. last error: {last_err}"))
}

// Extract the first frame of a video as a JPEG next to the source
// (<path>.thumb.jpg) so the library grid can show a real cover instead of a
// placeholder. Returns the thumbnail path.
#[tauri::command]
async fn generate_thumbnail(app: AppHandle, path: String) -> Result<String, String> {
    let ffmpeg = resolve_ffmpeg(&app);
    let out = format!("{path}.thumb.jpg");
    let status = std::process::Command::new(&ffmpeg)
        .args(["-y", "-ss", "0", "-i", &path, "-frames:v", "1", "-q:v", "3"])
        .arg(&out)
        .status()
        .map_err(|e| format!("ffmpeg spawn failed: {e}"))?;
    if !status.success() {
        return Err("ffmpeg failed to extract thumbnail".to_string());
    }
    if !std::path::Path::new(&out).exists() {
        return Err("thumbnail was not produced".to_string());
    }
    Ok(out)
}

// If (and only if) the video is HEVC/H.265 — which WebView2 cannot decode,
// causing "audio only, no picture" — produce an H.264 copy next to the source
// (<path>.preview.mp4) for in-app preview. The original file is untouched.
// Returns Some(preview_path) when a copy was made, None when the source is
// already WebView-compatible.
#[tauri::command]
async fn transcode_preview(app: AppHandle, path: String) -> Result<Option<String>, String> {
    let ffmpeg = resolve_ffmpeg(&app);
    let codec = probe_video_codec(&ffmpeg, &path).unwrap_or_default();
    if codec != "hevc" && codec != "h265" {
        return Ok(None);
    }
    let out = format!("{path}.preview.mp4");
    let status = std::process::Command::new(&ffmpeg)
        .args([
            "-y",
            "-i",
            &path,
            "-c:v",
            "libx264",
            "-crf",
            "23",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
        ])
        .arg(&out)
        .status()
        .map_err(|e| format!("ffmpeg spawn failed: {e}"))?;
    if !status.success() {
        return Err("ffmpeg failed to transcode preview".to_string());
    }
    Ok(Some(out))
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

// Physically delete a stored material only after the caller-selected root has
// been authenticated against storage_spaces and canonical containment checked.
#[tauri::command]
async fn delete_media_file(
    app: AppHandle,
    db_instances: tauri::State<'_, DbInstances>,
    storage_root: String,
    path: String,
) -> Result<(), String> {
    let pool = sqlite_pool(&db_instances).await?;
    let root = require_registered_root(&app, &pool, &storage_root).await?;
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Ok(());
    }
    let target_real = std::fs::canonicalize(&target).map_err(|e| e.to_string())?;
    if !target_real.starts_with(&root) || !target_real.is_file() {
        return Err("refusing to delete outside the selected storage root".into());
    }
    std::fs::remove_file(target_real).map_err(|e| e.to_string())
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
        let _clip = Clipboard::new_attempts(10).map_err(|e| format!("open clipboard: {e}"))?;
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
        let real_paths: Vec<String> = paths.iter().map(|p| real_path(p)).collect();

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
            let fragment = real_paths
                .iter()
                .map(|p| format!("<img src=\"file:///{}\">", p.replace('\\', "/")))
                .collect::<String>();
            let html = build_cf_html_fragment(&fragment);
            raw::set_without_clear(fmt.get(), &html).map_err(|e| format!("set html: {e}"))?;
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
fn build_cf_html_fragment(fragment: &str) -> Vec<u8> {
    let imgs = fragment;
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

#[tauri::command]
async fn copy_rich_text(plain_text: String, html: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use clipboard_win::{formats, raw, register_format, Clipboard, Setter};
        let _clip = Clipboard::new_attempts(10).map_err(|e| format!("open clipboard: {e}"))?;
        raw::empty().map_err(|e| format!("empty clipboard: {e}"))?;
        let mut wide: Vec<u16> = std::ffi::OsStr::new(&plain_text).encode_wide().collect();
        wide.push(0);
        let bytes =
            unsafe { std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2) };
        raw::set_without_clear(formats::Unicode.get(), bytes)
            .map_err(|e| format!("set unicode text: {e}"))?;
        let fmt = register_format("HTML Format").ok_or("cannot register HTML Format")?;
        raw::set_without_clear(fmt.get(), &build_cf_html_fragment(&html))
            .map_err(|e| format!("set html: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeHTML, NSPasteboardTypeString};
        use objc2_foundation::NSString;
        let board = NSPasteboard::generalPasteboard();
        board.clearContents();
        let plain = NSString::from_str(&plain_text);
        let rich = NSString::from_str(&html);
        if !board.setString_forType(&plain, unsafe { NSPasteboardTypeString })
            || !board.setString_forType(&rich, unsafe { NSPasteboardTypeHTML })
        {
            return Err("failed to write macOS pasteboard".into());
        }
        return Ok(());
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let _ = (plain_text, html);
        Err("unsupported platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_equal_and_nested_roots() {
        assert!(paths_overlap(Path::new("/a/store"), Path::new("/a/store")));
        assert!(paths_overlap(
            Path::new("/a/store"),
            Path::new("/a/store/nested")
        ));
        assert!(!paths_overlap(
            Path::new("/a/store"),
            Path::new("/a/store-two")
        ));
    }
    #[test]
    fn rejects_parent_traversal() {
        assert!(safe_child(Path::new("/tmp"), Path::new("../etc")).is_err());
    }
    #[test]
    fn cf_html_offsets_and_markers_are_correct() {
        let fragment = "<b>你好</b>";
        let bytes = build_cf_html_fragment(fragment);
        let payload = &bytes[..bytes.len() - 1];
        let text = std::str::from_utf8(payload).unwrap();
        fn field(text: &str, name: &str) -> usize {
            text.lines()
                .find(|l| l.starts_with(name))
                .unwrap()
                .split(':')
                .nth(1)
                .unwrap()
                .parse()
                .unwrap()
        }
        let sh = field(text, "StartHTML");
        let eh = field(text, "EndHTML");
        let sf = field(text, "StartFragment");
        let ef = field(text, "EndFragment");
        assert_eq!(&payload[sf..ef], fragment.as_bytes());
        assert_eq!(eh, payload.len());
        assert!(sf > sh);
        assert!(ef < eh);
        assert!(text.contains("<!--StartFragment-->"));
        assert!(text.contains("<!--EndFragment-->"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_default_storage_root,
            validate_storage_space,
            create_storage_space,
            add_storage_space,
            list_storage_spaces,
            migrate_storage_space,
            read_media,
            import_file,
            delete_project,
            delete_media_file,
            reveal_in_explorer,
            open_path,
            execute_batch,
            copy_files_to_clipboard,
            copy_rich_text,
            move_media_file,
            copy_media_file,
            probe_media_meta,
            file_hash,
            export_bundle,
            import_bundle,
            cleanup_import_staging,
            ffmpeg_status,
            download_ffmpeg,
            generate_thumbnail,
            transcode_preview
        ])
        .setup(|app| {
            // Window chrome strategy — the same "keep the native frame, draw your
            // own title bar inside it" approach CapCut / VS Code use:
            //
            // - macOS: tauri.conf.json keeps native decorations with
            //   `titleBarStyle: Overlay` + `hiddenTitle`, so the window gets
            //   system-rounded corners, the native shadow and the traffic-light
            //   buttons (vertically centered on the 48px toolbar via
            //   `trafficLightPosition`), while the web content extends full-size
            //   and draws its own toolbar. The in-webview window controls are
            //   hidden on macOS (the frontend detects the platform via userAgent).
            //   NOTE: the traffic-light position must come from the config — the
            //   programmatic `traffic_light_position` builder option is silently
            //   ignored because Tauri 2 attaches the webview as a child view.
            //
            // - Windows / Linux: the same window starts decorated (the macOS-only
            //   keys are ignored there), then we strip the decorations here before
            //   the window is shown, keeping the in-webview controls.
            //   `window-shadows` restores the DWM drop shadow and Win11's DWM
            //   rounds the corners automatically.
            let window = app
                .get_webview_window("main")
                .expect("main window must exist (declared in tauri.conf.json)");

            #[cfg(not(target_os = "macos"))]
            {
                window
                    .set_decorations(false)
                    .map_err(|e| format!("failed to remove window decorations: {e}"))?;

                #[cfg(windows)]
                {
                    // Re-apply the DWM drop shadow removed by the borderless style.
                    let _ = window_shadows::set_shadow(&window, true);
                }
            }
            #[cfg(target_os = "macos")]
            {
                use tauri::WindowEvent;

                // 初始复位:窗口创建后立即把标题栏样式位与交通灯摆到既定内嵌位置。
                // `ns_window()` 返回的裸指针不是 Send,先转成 usize 再送进主线程闭包。
                if let Ok(ptr) = window.ns_window() {
                    let ptr = ptr as usize;
                    let _ = window.run_on_main_thread(move || unsafe {
                        mac_titlebar::refresh(ptr as *mut std::ffi::c_void, "Setup");
                    });
                }

                // 几何变化(进入/退出全屏、双击缩放 zoom、最小化后恢复、拖拽 resize)后
                // macOS 会重排原生标题栏(见 tauri #13044),这里在相关窗口事件后于主线
                // 程重申样式位并复位交通灯。
                let win_for_events = window.clone();
                window.on_window_event(move |event| {
                    let evt_name = match event {
                        WindowEvent::Resized(_) => "Resized",
                        WindowEvent::Moved(_) => "Moved",
                        WindowEvent::ScaleFactorChanged { .. } => "ScaleFactorChanged",
                        WindowEvent::Focused(true) => "Focused",
                        _ => "",
                    };
                    if !evt_name.is_empty() {
                        if let Ok(ptr) = win_for_events.ns_window() {
                            let ptr = ptr as usize;
                            let _ = win_for_events.run_on_main_thread(move || unsafe {
                                mac_titlebar::refresh(ptr as *mut std::ffi::c_void, evt_name);
                            });
                        }
                    }
                });
            }
            let _ = &window;

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
