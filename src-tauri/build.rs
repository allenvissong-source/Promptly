fn main() {
    // The ffmpeg sidecar file is named `ffmpeg-<target-triple>` (a Tauri
    // externalBin requirement). `tauri dev` doesn't stage it next to the debug
    // binary, so a debug build resolves it straight from src-tauri/binaries and
    // needs to know the triple at compile time. TARGET is only available to
    // build scripts, hence re-exporting it here.
    println!(
        "cargo:rustc-env=FFMPEG_TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap_or_default()
    );
    tauri_build::build()
}
