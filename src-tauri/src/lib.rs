use tauri::Emitter;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

#[tauri::command]
async fn probe_video(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| e.to_string())?
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            path.as_str(),
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}

#[tauri::command]
async fn remux_video(
    app: tauri::AppHandle,
    input: String,
    output: String,
    copy_audio: bool,
) -> Result<(), String> {
    let audio_codec = if copy_audio { "copy" } else { "aac" };

    let (mut rx, _child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args([
            "-y",
            "-i", input.as_str(),
            "-map", "0:v:0",
            "-map", "0:a?",
            "-c:v", "copy",
            "-c:a", audio_codec,
            "-movflags", "+faststart",
            "-progress", "pipe:1",
            "-nostats",
            output.as_str(),
        ])
        .spawn()
        .map_err(|e| e.to_string())?;

    let mut last_error = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line);
                for l in text.lines() {
                    if let Some(v) = l.strip_prefix("out_time_us=") {
                        if let Ok(us) = v.trim().parse::<u64>() {
                            let _ = app.emit("remux-progress", us / 1000);
                        }
                    }
                }
            }
            CommandEvent::Stderr(line) => {
                last_error = String::from_utf8_lossy(&line).to_string();
            }
            CommandEvent::Terminated(p) => {
                return if p.code == Some(0) {
                    Ok(())
                } else {
                    Err(format!("FFmpeg lỗi (mã {:?}): {}", p.code, last_error))
                };
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![probe_video, remux_video])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}