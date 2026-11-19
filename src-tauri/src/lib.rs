use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};

use futures_util::StreamExt;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio_util::io::ReaderStream;

// Tên tiến trình game cần cảnh báo
const GAME_PROCESS: &str = "VALORANT-Win64-Shipping.exe";

// ---------- Cài đặt (lưu trong thư mục cấu hình của app) ----------

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
struct Settings {
    worker_url: String,
    api_token: String,
    watch_dir: String,
    auto_delete_mkv: bool,
}

#[derive(Serialize)]
struct PublicSettings {
    worker_url: String,
    has_token: bool,
    watch_dir: String,
    auto_delete_mkv: bool,
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

fn write_settings(app: &tauri::AppHandle, s: &Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(app)?, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> PublicSettings {
    let s = load_settings(&app);
    PublicSettings {
        worker_url: s.worker_url,
        has_token: !s.api_token.is_empty(),
        watch_dir: s.watch_dir,
        auto_delete_mkv: s.auto_delete_mkv,
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
    write_settings(&app, &s)
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

// ---------- Theo dõi thư mục clip ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClipInfo {
    path: String,
    name: String,
    size_bytes: u64,
    modified_ms: u64,
}

#[derive(Default)]
struct WatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    pending: Arc<Mutex<HashSet<PathBuf>>>,
}

fn is_mkv(path: &Path) -> bool {
    path.extension()
        .map(|e| e.eq_ignore_ascii_case("mkv"))
        .unwrap_or(false)
}

fn clip_info(path: &Path) -> Option<ClipInfo> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Some(ClipInfo {
        path: path.to_string_lossy().to_string(),
        name: path.file_name()?.to_string_lossy().to_string(),
        size_bytes: meta.len(),
        modified_ms,
    })
}

// Đợi tới khi OBS ghi xong (kích thước không đổi 3 giây liên tiếp)
async fn wait_until_stable(path: &Path) {
    let mut last = 0u64;
    let mut stable = 0;
    for _ in 0..600 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let Ok(meta) = std::fs::metadata(path) else {
            return; // file đã bị xóa hoặc đổi tên
        };
        let size = meta.len();
        if size > 0 && size == last {
            stable += 1;
            if stable >= 3 {
                return;
            }
        } else {
            stable = 0;
            last = size;
        }
    }
}

fn start_watch(app: &tauri::AppHandle, dir: &str, state: &WatchState) -> Result<(), String> {
    let mut guard = state.watcher.lock().map_err(|e| e.to_string())?;
    *guard = None; // dừng watcher cũ (nếu có)

    if dir.is_empty() {
        return Ok(());
    }
    let path = PathBuf::from(dir);
    if !path.is_dir() {
        return Err("Thư mục không tồn tại.".into());
    }

    let app_handle = app.clone();
    let pending = state.pending.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else { return };
        if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
            return;
        }

        for p in event.paths {
            if !is_mkv(&p) {
                continue;
            }
            {
                let mut set = pending.lock().unwrap();
                if !set.insert(p.clone()) {
                    continue; // đang chờ file này rồi
                }
            }

            let app = app_handle.clone();
            let pending = pending.clone();
            tauri::async_runtime::spawn(async move {
                wait_until_stable(&p).await;
                if let Some(info) = clip_info(&p) {
                    let _ = app.emit("clip-detected", info);
                }
                pending.lock().unwrap().remove(&p);
            });
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&path, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    *guard = Some(watcher);
    Ok(())
}

#[tauri::command]
fn set_watch_dir(
    app: tauri::AppHandle,
    state: State<'_, WatchState>,
    dir: String,
) -> Result<(), String> {
    start_watch(&app, &dir, &state)?;
    let mut s = load_settings(&app);
    s.watch_dir = dir;
    write_settings(&app, &s)
}

#[tauri::command]
fn list_clips(dir: String) -> Vec<ClipInfo> {
    let mut clips: Vec<ClipInfo> = std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let p = entry.path();
            if is_mkv(&p) {
                clip_info(&p)
            } else {
                None
            }
        })
        .collect();
    clips.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    clips
}

// ---------- Thư viện clip (trạng thái từng clip) ----------

fn library_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("library.json"))
}

#[tauri::command]
fn load_library(app: tauri::AppHandle) -> String {
    library_path(&app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| "{}".to_string())
}

#[tauri::command]
fn save_library(app: tauri::AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("Dữ liệu không hợp lệ: {e}"))?;
    std::fs::write(library_path(&app)?, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).is_file()
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
    start_ms: u64,
    duration_ms: u64, // 0 = lấy tới hết file
    precise: bool,
) -> Result<(), String> {
    let audio_codec = if copy_audio { "copy" } else { "aac" };

    let mut args: Vec<String> = vec!["-y".into()];
    if start_ms > 0 {
        args.push("-ss".into());
        args.push(format!("{:.3}", start_ms as f64 / 1000.0));
    }
    args.push("-i".into());
    args.push(input);
    if duration_ms > 0 {
        args.push("-t".into());
        args.push(format!("{:.3}", duration_ms as f64 / 1000.0));
    }
    for a in ["-map", "0:v:0", "-map", "0:a?"] {
        args.push(a.into());
    }
    if precise {
        for a in [
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        ] {
            args.push(a.into());
        }
    } else {
        for a in ["-c:v", "copy", "-avoid_negative_ts", "make_zero"] {
            args.push(a.into());
        }
    }
    args.push("-c:a".into());
    args.push(audio_codec.into());
    for a in ["-movflags", "+faststart", "-progress", "pipe:1", "-nostats"] {
        args.push(a.into());
    }
    args.push(output);

    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(args)
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
// ---------- Tự động xóa MKV sau khi chuyển ----------

#[tauri::command]
fn set_auto_delete_mkv(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.auto_delete_mkv = enabled;
    write_settings(&app, &s)
}

// Chỉ chuyển MKV vào Thùng rác khi MP4 đã được kiểm tra hợp lệ
#[tauri::command]
async fn trash_source_after_verify(
    app: tauri::AppHandle,
    source: String,
    mp4: String,
    expected_ms: u64,
) -> Result<(), String> {
    let source_path = Path::new(&source);
    let mp4_path = Path::new(&mp4);

    if !is_mkv(source_path) {
        return Err("File nguồn không phải .mkv nên không xóa.".into());
    }
    if !source_path.is_file() {
        return Err("Không tìm thấy file MKV nguồn.".into());
    }
    if source.to_lowercase() == mp4.to_lowercase() {
        return Err("File MP4 trùng với file nguồn.".into());
    }

    let meta = std::fs::metadata(mp4_path)
        .map_err(|_| "Không tìm thấy file MP4 vừa tạo.".to_string())?;
    if meta.len() == 0 {
        return Err("File MP4 bị rỗng.".into());
    }

    // Đọc lại file MP4 bằng ffprobe để chắc chắn nó hợp lệ
    let json = probe_video(app.clone(), mp4.clone())
        .await
        .map_err(|e| format!("Không đọc được file MP4 để kiểm tra: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;

    let has_video = v["streams"]
        .as_array()
        .map(|s| s.iter().any(|x| x["codec_type"] == "video"))
        .unwrap_or(false);
    if !has_video {
        return Err("File MP4 không có hình.".into());
    }

    let duration_ms = v["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .map(|d| (d * 1000.0) as u64)
        .unwrap_or(0);
    let tolerance = (expected_ms / 50).max(1000);
    if duration_ms + tolerance < expected_ms {
        return Err(format!(
            "File MP4 ngắn hơn bản gốc ({:.1} giây so với {:.1} giây).",
            duration_ms as f64 / 1000.0,
            expected_ms as f64 / 1000.0
        ));
    }

    trash::delete(source_path).map_err(|e| format!("Không chuyển được vào Thùng rác: {e}"))
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

enum UploadError {
    Cancelled,
    Retryable(String),
    Fatal(String),
}

const MAX_ATTEMPTS: u32 = 3;

#[tauri::command]
fn cancel_upload(state: State<'_, UploadState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

// Xin link upload tạm từ Worker
async fn request_ticket(
    client: &reqwest::Client,
    settings: &Settings,
) -> Result<UploadTicket, UploadError> {
    let res = client
        .post(format!("{}/api/uploads", settings.worker_url))
        .bearer_auth(&settings.api_token)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| {
            UploadError::Retryable(format!(
                "Không kết nối được Worker (kiểm tra mạng hoặc địa chỉ Worker): {}.",
                e.without_url()
            ))
        })?;

    let status = res.status();
    if status.as_u16() == 401 {
        return Err(UploadError::Fatal(
            "Mã bí mật không đúng. Hãy kiểm tra lại API_TOKEN trong Cài đặt Cloud.".into(),
        ));
    }
    if status.is_server_error() {
        return Err(UploadError::Retryable(format!("Worker đang lỗi ({status}).")));
    }
    if !status.is_success() {
        return Err(UploadError::Fatal(format!(
            "Worker từ chối yêu cầu ({status}). Kiểm tra địa chỉ Worker."
        )));
    }

    res.json::<UploadTicket>().await.map_err(|e| {
        UploadError::Fatal(format!("Phản hồi từ Worker không hợp lệ: {}.", e.without_url()))
    })
}

// Đẩy file lên Backblaze bằng link tạm, có giới hạn tốc độ
async fn put_file(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    upload_url: &str,
    path: &str,
    limit_kbps: u64,
    cancel: Arc<AtomicBool>,
) -> Result<(), UploadError> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| UploadError::Fatal(format!("Không mở được file: {e}")))?;
    let total = file
        .metadata()
        .await
        .map_err(|e| UploadError::Fatal(e.to_string()))?
        .len();

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

    // Thời gian chờ tối đa: gấp đôi thời gian dự kiến, tối thiểu 2 phút
    let assumed_bps: f64 = if limit_bps > 0 {
        limit_bps as f64
    } else {
        50.0 * 1024.0
    };
    let timeout_secs = ((total as f64 / assumed_bps) * 2.0).max(120.0) as u64;

    let result = client
        .put(upload_url)
        .header(reqwest::header::CONTENT_TYPE, "video/mp4")
        .header(reqwest::header::CONTENT_LENGTH, total)
        .timeout(Duration::from_secs(timeout_secs))
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await;

    if cancel.load(Ordering::Relaxed) {
        return Err(UploadError::Cancelled);
    }

    let response = result.map_err(|e| {
        UploadError::Retryable(format!("Mất kết nối khi upload: {}.", e.without_url()))
    })?;

    let status = response.status();
    if status.is_success() {
        let _ = app.emit("upload-progress", (total, total));
        return Ok(());
    }

    let body = response.text().await.unwrap_or_default();
    let short: String = body.chars().take(300).collect();
    if status.is_server_error() || status.as_u16() == 408 || status.as_u16() == 429 {
        Err(UploadError::Retryable(format!("Backblaze tạm thời lỗi ({status}).")))
    } else {
        Err(UploadError::Fatal(format!(
            "Backblaze từ chối upload ({status}): {short}"
        )))
    }
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

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let mut last_error = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        if attempt > 1 {
            // Chờ trước khi thử lại, vẫn cho phép hủy
            let wait = 5u64 * (attempt as u64 - 1);
            for remaining in (1..=wait).rev() {
                if cancel.load(Ordering::Relaxed) {
                    return Err("Đã hủy upload.".into());
                }
                let _ = app.emit(
                    "upload-status",
                    format!(
                        "{last_error} Thử lại lần {attempt}/{MAX_ATTEMPTS} sau {remaining} giây..."
                    ),
                );
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            let _ = app.emit("upload-progress", (0u64, 1u64));
        }

        let outcome = async {
            let ticket = request_ticket(&client, &settings).await?;
            put_file(
                &app,
                &client,
                &ticket.upload_url,
                &path,
                limit_kbps,
                cancel.clone(),
            )
            .await?;
            Ok::<String, UploadError>(ticket.view_url)
        }
        .await;

        match outcome {
            Ok(url) => return Ok(url),
            Err(UploadError::Cancelled) => return Err("Đã hủy upload.".into()),
            Err(UploadError::Fatal(m)) => return Err(m),
            Err(UploadError::Retryable(m)) => last_error = m,
        }
    }

    Err(format!(
        "{last_error} Đã thử {MAX_ATTEMPTS} lần nhưng không thành công. Hãy kiểm tra mạng rồi thử lại."
    ))
}

// ---------- Xóa video trên Cloud ----------

#[tauri::command]
async fn delete_video(app: tauri::AppHandle, view_url: String) -> Result<(), String> {
    let settings = load_settings(&app);
    if settings.worker_url.is_empty() || settings.api_token.is_empty() {
        return Err("Chưa cài đặt địa chỉ Worker hoặc mã bí mật.".into());
    }

    // view_url có dạng https://worker/v/ID, lấy phần ID cuối
    let id = view_url.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Link video không hợp lệ.".into());
    }

    let res = reqwest::Client::new()
        .delete(format!("{}/api/videos/{}", settings.worker_url, id))
        .bearer_auth(&settings.api_token)
        .send()
        .await
        .map_err(|e| format!("Không kết nối được Worker: {}", e.without_url()))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let short: String = body.chars().take(200).collect();
        return Err(format!("Xóa thất bại ({status}): {short}"));
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(UploadState::default())
        .manage(WatchState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Tự bật theo dõi thư mục đã lưu từ lần trước
            let handle = app.handle().clone();
            let settings = load_settings(&handle);
            if !settings.watch_dir.is_empty() {
                let state = app.state::<WatchState>();
                if let Err(e) = start_watch(&handle, &settings.watch_dir, &state) {
                    println!("Không bật được theo dõi thư mục: {e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_video,
            remux_video,
            is_game_running,
            get_settings,
            save_settings,
            set_watch_dir,
            list_clips,
            load_library,
            save_library,
            path_exists,
            upload_video,
            cancel_upload,
            delete_video,
            set_auto_delete_mkv,
            trash_source_after_verify
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}