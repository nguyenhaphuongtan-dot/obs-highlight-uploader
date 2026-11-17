use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio_util::io::ReaderStream;

// Tên tiến trình game cần cảnh báo
const GAME_PROCESS: &str = "VALORANT-Win64-Shipping.exe";

// ---------- Cài đặt (lưu trong thư mục cấu hình của app) ----------

#[derive(Serialize, Deserialize, Default, Clone)]
struct Settings {
    worker_url: String,
    api_token: String,
}

#[derive(Serialize)]
struct PublicSettings {
    worker_url: String,
    has_token: bool,
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn load_settings(app: &tauri::AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> PublicSettings {
    let s = load_settings(&app);
    PublicSettings {
        worker_url: s.worker_url,
        has_token: !s.api_token.is_empty(),
    }
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    worker_url: String,
    api_token: String,
) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.worker_url = worker_url.trim().trim_end_matches('/').to_string();
    if !api_token.trim().is_empty() {
        s.api_token = api_token.trim().to_string();
    }
    let json = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(&app)?, json).map_err(|e| e.to_string())
}

// ---------- Windows: hạ ưu tiên FFmpeg, phát hiện game ----------

#[cfg(windows)]
fn set_below_normal_priority(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
        if handle as usize == 0 {
            return false;
        }
        let ok = SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS) != 0;
        CloseHandle(handle);
        ok
    }
}

#[cfg(not(windows))]
fn set_below_normal_priority(_pid: u32) -> bool {
    false
}

#[tauri::command]
fn is_game_running() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {}", GAME_PROCESS), "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
            return text.contains(&GAME_PROCESS.to_lowercase());
        }
    }
    false
}

// ---------- FFmpeg ----------

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

    let (mut rx, child) = app
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

    let pid = child.pid();
    if set_below_normal_priority(pid) {
        println!("FFmpeg (pid {pid}) đã đặt mức ưu tiên Below Normal");
    } else {
        println!("Không đặt được mức ưu tiên cho FFmpeg (pid {pid})");
    }

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

// ---------- Upload lên Cloud ----------

#[derive(Default)]
struct UploadState {
    cancel: Arc<AtomicBool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadTicket {
    upload_url: String,
    view_url: String,
}

#[tauri::command]
fn cancel_upload(state: State<'_, UploadState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn upload_video(
    app: tauri::AppHandle,
    state: State<'_, UploadState>,
    path: String,
    limit_kbps: u64, // 0 = không giới hạn
) -> Result<String, String> {
    let settings = load_settings(&app);
    if settings.worker_url.is_empty() || settings.api_token.is_empty() {
        return Err("Chưa cài đặt địa chỉ Worker hoặc mã bí mật.".into());
    }

    let cancel = state.cancel.clone();
    cancel.store(false, Ordering::Relaxed);

    let client = reqwest::Client::new();

    // 1. Xin link upload tạm từ Worker
    let ticket: UploadTicket = client
        .post(format!("{}/api/uploads", settings.worker_url))
        .bearer_auth(&settings.api_token)
        .send()
        .await
        .map_err(|e| format!("Không kết nối được Worker: {}", e.without_url()))?
        .error_for_status()
        .map_err(|e| format!("Worker từ chối yêu cầu (kiểm tra mã bí mật): {}", e.without_url()))?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    // 2. Mở file và tạo luồng dữ liệu có giới hạn tốc độ
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("Không mở được file: {e}"))?;
    let total = file.metadata().await.map_err(|e| e.to_string())?.len();
    let limit_bps = limit_kbps * 1024;
    let start = Instant::now();
    let sent = Arc::new(AtomicU64::new(0));

    let stream = ReaderStream::with_capacity(file, 512 * 1024).then({
        let app = app.clone();
        let sent = sent.clone();
        let cancel = cancel.clone();
        move |chunk| {
            let app = app.clone();
            let sent = sent.clone();
            let cancel = cancel.clone();
            async move {
                if cancel.load(Ordering::Relaxed) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "cancelled",
                    ));
                }
                let bytes = chunk?;
                let done = sent.fetch_add(bytes.len() as u64, Ordering::Relaxed)
                    + bytes.len() as u64;

                if limit_bps > 0 {
                    let expected = done as f64 / limit_bps as f64;
                    let elapsed = start.elapsed().as_secs_f64();
                    if expected > elapsed {
                        tokio::time::sleep(Duration::from_secs_f64(expected - elapsed)).await;
                    }
                }

                let _ = app.emit("upload-progress", (done, total));
                Ok::<_, std::io::Error>(bytes)
            }
        }
    });

    // 3. Đẩy file thẳng lên Backblaze bằng link tạm
    let response = client
        .put(&ticket.upload_url)
        .header(reqwest::header::CONTENT_TYPE, "video/mp4")
        .header(reqwest::header::CONTENT_LENGTH, total)
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .map_err(|e| {
            if cancel.load(Ordering::Relaxed) {
                "Đã hủy upload.".to_string()
            } else {
                format!("Upload lỗi: {}", e.without_url())
            }
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let short: String = body.chars().take(300).collect();
        return Err(format!("Backblaze trả về lỗi {status}: {short}"));
    }

    let _ = app.emit("upload-progress", (total, total));
    Ok(ticket.view_url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(UploadState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            probe_video,
            remux_video,
            is_game_running,
            get_settings,
            save_settings,
            upload_video,
            cancel_upload
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}