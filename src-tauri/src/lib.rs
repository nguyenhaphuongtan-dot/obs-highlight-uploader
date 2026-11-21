use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::hash::{Hash, Hasher};
use futures_util::StreamExt;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio_util::io::ReaderStream;

// ---------- Cài đặt (lưu trong thư mục cấu hình của app) ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct Settings {
    worker_url: String,
    api_token: String,
    watch_dir: String,
    auto_delete_mkv: bool,
    pause_while_game: bool,
    performance_profile: String,
    encoder: String,
    optimization_applied: bool,
    auto_delete_after_upload: bool,
    simple_mode: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            worker_url: String::new(),
            api_token: String::new(),
            watch_dir: String::new(),
            auto_delete_mkv: false,
            pause_while_game: true,
            performance_profile: "balanced".into(),
            encoder: "auto".into(),
            optimization_applied: false,
            auto_delete_after_upload: false,
            simple_mode: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QueueJob {
    id: String,
    kind: String,
    payload: serde_json::Value,
    status: String,
    retry_count: u32,
    error: Option<String>,
    created_at: u64,
    updated_at: u64,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct JobQueue {
    #[serde(default)]
    paused: bool,
    #[serde(default)]
    jobs: Vec<QueueJob>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BenchmarkSample {
    stage: String,
    fps: f64,
    ping: u32,
    created_at: u64,
}

#[derive(Serialize)]
struct PublicSettings {
    worker_url: String,
    has_token: bool,
    watch_dir: String,
    auto_delete_mkv: bool,
    pause_while_game: bool,
    performance_profile: String,
    encoder: String,
    auto_delete_after_upload: bool,
    simple_mode: bool,
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn load_settings(app: &tauri::AppHandle) -> Settings {
    let mut s: Settings = settings_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_default();
    if s.worker_url == "https://nghapiti-highlight.hl-clips.workers.dev"
        || s.worker_url == "https://nghapiti-highlight.nghapiti.workers.dev"
        || s.worker_url == "https://nhapiti-highlight.hl-clips.workers.dev"
    {
        s.worker_url = "https://highlight.nghapiti.workers.dev".into();
        let _ = write_settings(app, &s);
    }
    s
}

fn write_settings(app: &tauri::AppHandle, s: &Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(app)?, json).map_err(|e| e.to_string())
}

fn queue_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("queue.json"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_queue(app: &tauri::AppHandle) -> JobQueue {
    queue_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_default()
}

fn write_queue(app: &tauri::AppHandle, queue: &JobQueue) -> Result<(), String> {
    let json = serde_json::to_string_pretty(queue).map_err(|e| e.to_string())?;
    std::fs::write(queue_path(app)?, json).map_err(|e| e.to_string())
}

fn benchmark_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("benchmarks.json"))
}

fn load_benchmarks(app: &tauri::AppHandle) -> Vec<BenchmarkSample> {
    benchmark_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_queue(app: tauri::AppHandle) -> JobQueue {
    let mut queue = load_queue(&app);
    let mut changed = false;
    for job in &mut queue.jobs {
        if job.status == "running" {
            job.status = "queued".into();
            job.updated_at = now_ms();
            changed = true;
        }
    }
    if changed {
        let _ = write_queue(&app, &queue);
    }
    queue
}

#[tauri::command]
fn add_queue_job(
    app: tauri::AppHandle,
    kind: String,
    payload: serde_json::Value,
) -> Result<QueueJob, String> {
    let mut queue = load_queue(&app);
    let now = now_ms();
    let id = format!("{}-{}", now, queue.jobs.len() + 1);
    let job = QueueJob {
        id,
        kind,
        payload,
        status: "queued".into(),
        retry_count: 0,
        error: None,
        created_at: now,
        updated_at: now,
    };
    queue.jobs.push(job.clone());
    write_queue(&app, &queue)?;
    Ok(job)
}

#[tauri::command]
fn update_queue_job(
    app: tauri::AppHandle,
    id: String,
    status: String,
    error: Option<String>,
) -> Result<(), String> {
    let mut queue = load_queue(&app);
    let now = now_ms();
    let Some(job) = queue.jobs.iter_mut().find(|job| job.id == id) else {
        return Err("Không tìm thấy tác vụ trong hàng đợi.".into());
    };
    job.status = status;
    job.error = error;
    job.updated_at = now;
    write_queue(&app, &queue)
}

#[tauri::command]
fn pause_queue(app: tauri::AppHandle) -> Result<(), String> {
    let mut queue = load_queue(&app);
    queue.paused = true;
    write_queue(&app, &queue)
}

#[tauri::command]
fn resume_queue(app: tauri::AppHandle) -> Result<(), String> {
    let mut queue = load_queue(&app);
    queue.paused = false;
    write_queue(&app, &queue)
}

#[tauri::command]
fn retry_queue_job(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut queue = load_queue(&app);
    let now = now_ms();
    let Some(job) = queue.jobs.iter_mut().find(|job| job.id == id) else {
        return Err("Không tìm thấy tác vụ trong hàng đợi.".into());
    };
    job.status = "queued".into();
    job.error = None;
    job.retry_count += 1;
    job.updated_at = now;
    write_queue(&app, &queue)
}

#[tauri::command]
fn cancel_queue_job(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut queue = load_queue(&app);
    let now = now_ms();
    let Some(job) = queue.jobs.iter_mut().find(|job| job.id == id) else {
        return Err("Không tìm thấy tác vụ trong hàng đợi.".into());
    };
    job.status = "cancelled".into();
    job.updated_at = now;
    write_queue(&app, &queue)
}

#[tauri::command]
fn clear_queue_history(app: tauri::AppHandle) -> Result<(), String> {
    let mut queue = load_queue(&app);
    queue.jobs.retain(|job| {
        matches!(job.status.as_str(), "queued" | "running" | "paused")
    });
    write_queue(&app, &queue)
}

#[tauri::command]
fn get_benchmark_samples(app: tauri::AppHandle) -> Vec<BenchmarkSample> {
    load_benchmarks(&app)
}

#[tauri::command]
fn add_benchmark_sample(
    app: tauri::AppHandle,
    stage: String,
    fps: f64,
    ping: u32,
) -> Result<(), String> {
    if !matches!(stage.as_str(), "before" | "game_idle" | "game_queue" | "after") {
        return Err("Mốc đo không hợp lệ.".into());
    }
    if !(1.0..=1000.0).contains(&fps) || ping > 1000 {
        return Err("FPS hoặc ping không hợp lệ.".into());
    }
    let mut samples = load_benchmarks(&app);
    samples.insert(
        0,
        BenchmarkSample {
            stage,
            fps,
            ping,
            created_at: now_ms(),
        },
    );
    let json = serde_json::to_string_pretty(&samples).map_err(|e| e.to_string())?;
    std::fs::write(benchmark_path(&app)?, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_benchmark_samples(app: tauri::AppHandle) -> Result<(), String> {
    std::fs::write(benchmark_path(&app)?, "[]").map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> PublicSettings {
    let mut s = load_settings(&app);
    if !s.optimization_applied {
        s.pause_while_game = true;
        s.performance_profile = "performance".into();
        s.encoder = "amf".into();
        s.optimization_applied = true;
        let _ = write_settings(&app, &s);
    }
    PublicSettings {
        worker_url: s.worker_url,
        has_token: !s.api_token.is_empty(),
        watch_dir: s.watch_dir,
        auto_delete_mkv: s.auto_delete_mkv,
        pause_while_game: s.pause_while_game,
        performance_profile: s.performance_profile,
        encoder: s.encoder,
        auto_delete_after_upload: s.auto_delete_after_upload,
        simple_mode: s.simple_mode,
    }
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    worker_url: String,
    api_token: String,
) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.worker_url = worker_url
        .trim()
        .trim_end_matches('/')
        .replace(
            "https://nghapiti-highlight.hl-clips.workers.dev",
            "https://highlight.nghapiti.workers.dev",
        )
        .replace(
            "https://nghapiti-highlight.nghapiti.workers.dev",
            "https://highlight.nghapiti.workers.dev",
        )
        .replace(
            "https://nhapiti-highlight.hl-clips.workers.dev",
            "https://highlight.nghapiti.workers.dev",
        );
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

        let names = ["VALORANT-Win64-Shipping.exe", "VALORANT.exe"];
        for name in names {
            let output = std::process::Command::new("tasklist")
                .args(["/FI", &format!("IMAGENAME eq {}", name), "/FO", "CSV", "/NH"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            if let Ok(out) = output {
                let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
                if text.contains(&name.to_lowercase()) {
                    return true;
                }
            }
        }
    }
    false
}

#[tauri::command]
fn get_game_status() -> String {
    if is_game_running() {
        "running".into()
    } else {
        "offline".into()
    }
}

fn should_pause_for_game(app: &tauri::AppHandle) -> bool {
    load_settings(app).pause_while_game && is_game_running()
}

#[tauri::command]
fn set_pause_while_game(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.pause_while_game = enabled;
    write_settings(&app, &s)
}

#[tauri::command]
fn set_performance_profile(app: tauri::AppHandle, profile: String) -> Result<(), String> {
    if !matches!(profile.as_str(), "performance" | "balanced" | "quality") {
        return Err("Cấu hình hiệu suất không hợp lệ.".into());
    }
    let mut s = load_settings(&app);
    s.performance_profile = profile;
    write_settings(&app, &s)
}

#[tauri::command]
fn set_encoder(app: tauri::AppHandle, encoder: String) -> Result<(), String> {
    if !matches!(encoder.as_str(), "auto" | "amf" | "nvenc" | "qsv" | "x264") {
        return Err("Bộ mã hóa không hợp lệ.".into());
    }
    let mut s = load_settings(&app);
    s.encoder = encoder;
    write_settings(&app, &s)
}

#[tauri::command]
async fn get_available_encoders(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(["-hide_banner", "-encoders"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut encoders = vec!["x264".to_string()];
    if text.contains("h264_amf") { encoders.insert(0, "amf".to_string()); }
    if text.contains("h264_nvenc") { encoders.push("nvenc".to_string()); }
    if text.contains("h264_qsv") { encoders.push("qsv".to_string()); }
    encoders.push("auto".to_string());
    Ok(encoders)
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
    if should_pause_for_game(&app) {
        return Err("Đã tạm dừng xử lý vì Valorant đang chạy.".into());
    }
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
        let profile = load_settings(&app).performance_profile;
        let settings = load_settings(&app);
        let encoder = if settings.encoder == "auto" {
            "amf"
        } else {
            settings.encoder.as_str()
        };
        let quality_args = match profile.as_str() {
            "performance" => {
                vec!["quality", "speed", "ultrafast", "24"]
            }
            "quality" => {
                vec!["quality", "balanced", "slow", "17"]
            }
            _ => {
                vec!["quality", "balanced", "veryfast", "20"]
            }
        };
        match encoder {
            "amf" => args.extend([
                "-c:v".into(), "h264_amf".into(),
                "-quality".into(), quality_args[1].into(),
                "-rc".into(), "vbr_latency".into(),
                "-qmin".into(), "18".into(),
                "-qmax".into(), "32".into(),
                "-pix_fmt".into(), "yuv420p".into(),
            ]),
            "nvenc" => args.extend([
                "-c:v".into(), "h264_nvenc".into(),
                "-preset".into(), if profile == "quality" { "p7" } else { "p5" }.into(),
                "-cq".into(), quality_args[3].into(),
                "-pix_fmt".into(), "yuv420p".into(),
            ]),
            "qsv" => args.extend([
                "-c:v".into(), "h264_qsv".into(),
                "-preset".into(), quality_args[2].into(),
                "-global_quality".into(), quality_args[3].into(),
                "-pix_fmt".into(), "yuv420p".into(),
            ]),
            _ => args.extend([
                "-c:v".into(), "libx264".into(),
                "-preset".into(), quality_args[2].into(),
                "-crf".into(), quality_args[3].into(),
                "-pix_fmt".into(), "yuv420p".into(),
            ]),
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
// ---------- Ảnh thu nhỏ ----------

fn has_file(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false)
}

#[tauri::command]
async fn make_thumbnail(app: tauri::AppHandle, path: String) -> Result<String, String> {
    if should_pause_for_game(&app) {
        return Err("Đã tạm dừng xử lý vì Valorant đang chạy.".into());
    }
    let meta = std::fs::metadata(&path).map_err(|_| "Không tìm thấy file video.".to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (path.as_str(), meta.len(), mtime).hash(&mut hasher);
    let file_name = format!("{:016x}.jpg", hasher.finish());

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(file_name);
    let out_str = out.to_string_lossy().to_string();

    if !has_file(&out) {
        // Thử lấy khung hình ở giây thứ 1, nếu video quá ngắn thì lấy khung đầu
        for seek in ["1", "0"] {
            let _ = app
                .shell()
                .sidecar("ffmpeg")
                .map_err(|e| e.to_string())?
                .args([
                    "-y", "-ss", seek,
                    "-i", path.as_str(),
                    "-frames:v", "1",
                    "-vf", "scale=320:-2",
                    "-q:v", "5",
                    out_str.as_str(),
                ])
                .output()
                .await;
            if has_file(&out) {
                break;
            }
        }
    }

    let bytes = std::fs::read(&out).map_err(|_| "Không tạo được ảnh thu nhỏ.".to_string())?;
    if bytes.is_empty() {
        return Err("Không tạo được ảnh thu nhỏ.".into());
    }
    Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)))
}
// ---------- Tự động xóa MKV sau khi chuyển ----------

#[tauri::command]
fn set_auto_delete_mkv(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.auto_delete_mkv = enabled;
    write_settings(&app, &s)
}

#[tauri::command]
fn set_auto_delete_after_upload(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.auto_delete_after_upload = enabled;
    write_settings(&app, &s)
}

#[tauri::command]
fn set_simple_mode(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.simple_mode = enabled;
    write_settings(&app, &s)
}

#[tauri::command]
fn trash_local_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Ok(());
    }
    if !matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()),
        Some(ext) if ext == "mkv" || ext == "mp4"
    ) {
        return Err("Chỉ có thể xóa file MKV hoặc MP4.".into());
    }
    trash::delete(p).map_err(|e| format!("Không chuyển được file vào Thùng rác: {e}"))
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
    thumb_upload_url: Option<String>,
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
// Xin link upload tạm từ Worker
async fn request_ticket(
    client: &reqwest::Client,
    settings: &Settings,
    slug: &str,
) -> Result<UploadTicket, UploadError> {
    let res = client
        .post(format!("{}/api/uploads", settings.worker_url))
        .bearer_auth(&settings.api_token)
        .json(&serde_json::json!({ "slug": slug }))
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
    if status.as_u16() == 409 {
        return Err(UploadError::Fatal(
            "Tên link này đã có người dùng. Hãy chọn tên khác.".into(),
        ));
    }
    if status.as_u16() == 400 {
        return Err(UploadError::Fatal(
            "Tên link không hợp lệ (chỉ chữ thường, số và dấu gạch ngang, dài 6 đến 48 ký tự).".into(),
        ));
    }
    if status.is_server_error() {
        if status.as_u16() == 503 {
            return Err(UploadError::Fatal(
                "Worker chưa cấu hình khóa Backblaze. Hãy đặt lại B2_KEY_ID và B2_APP_KEY trong Cloudflare Worker.".into(),
            ));
        }
        return Err(UploadError::Retryable(format!("Worker đang lỗi ({status}).")));
    }
    if !status.is_success() {
        if status.as_u16() == 404 {
            return Err(UploadError::Fatal(
                "Không tìm thấy Worker API (404). Hãy đặt Địa chỉ Worker là https://nghapiti-highlight.hl-clips.workers.dev (không thêm /api/uploads).".into(),
            ));
        }
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
// Tạo ảnh xem trước 1280px từ video và upload kèm. Lỗi ở bước này không làm hỏng upload.
async fn upload_thumbnail(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    video: &str,
    url: &str,
) -> Result<(), String> {
    if should_pause_for_game(app) {
        return Err("Đã tạm dừng xử lý vì Valorant đang chạy.".into());
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join("upload-preview.jpg");
    let _ = std::fs::remove_file(&out);
    let out_str = out.to_string_lossy().to_string();

    // Lấy khung hình ở giây thứ 1, nếu video quá ngắn thì lấy khung đầu
    for seek in ["1", "0"] {
        let _ = app
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| e.to_string())?
            .args([
                "-y", "-ss", seek,
                "-i", video,
                "-frames:v", "1",
                "-vf", "scale=1280:-2",
                "-q:v", "3",
                out_str.as_str(),
            ])
            .output()
            .await;
        if has_file(&out) {
            break;
        }
    }

    let bytes = std::fs::read(&out).map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("Ảnh xem trước rỗng.".into());
    }

    let res = client
        .put(url)
        .header(reqwest::header::CONTENT_TYPE, "image/jpeg")
        .timeout(Duration::from_secs(60))
        .body(bytes)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("Upload ảnh xem trước lỗi ({})", res.status()))
    }
}
#[tauri::command]
async fn upload_video(
    app: tauri::AppHandle,
    state: State<'_, UploadState>,
    path: String,
    limit_kbps: u64, // 0 = không giới hạn
    slug: Option<String>,
) -> Result<String, String> {
    if should_pause_for_game(&app) {
        return Err("Đã tạm dừng upload vì Valorant đang chạy.".into());
    }
    let slug = slug.unwrap_or_default();
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
            let ticket = request_ticket(&client, &settings, &slug).await?;
            put_file(
                &app,
                &client,
                &ticket.upload_url,
                &path,
                limit_kbps,
                cancel.clone(),
            )
            .await?;

            if let Some(thumb_url) = &ticket.thumb_upload_url {
                if let Err(e) = upload_thumbnail(&app, &client, &path, thumb_url).await {
                    println!("Không upload được ảnh xem trước: {e}");
                }
            }

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
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
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

#[derive(Deserialize, Serialize)]
struct CloudVideo {
    id: String,
    size: u64,
    modified: String,
    #[serde(rename = "hasThumbnail")]
    has_thumbnail: bool,
}

#[tauri::command]
async fn list_cloud_videos(app: tauri::AppHandle) -> Result<Vec<CloudVideo>, String> {
    let settings = load_settings(&app);
    if settings.worker_url.is_empty() {
        return Err("Chưa cài đặt địa chỉ Worker.".into());
    }

    let res = reqwest::Client::new()
        .get(format!("{}/api/videos", settings.worker_url))
        .send()
        .await
        .map_err(|e| format!("Không kết nối được thư viện Cloud: {}", e.without_url()))?;

    if !res.status().is_success() {
        return Err(format!("Không tải được thư viện ({})", res.status()));
    }

    res.json::<Vec<CloudVideo>>()
        .await
        .map_err(|e| format!("Phản hồi thư viện không hợp lệ: {}", e.without_url()))
}
// ---------- Dự án dựng phim ----------

fn projects_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("projects.json"))
}

#[tauri::command]
fn load_projects(app: tauri::AppHandle) -> String {
    projects_path(&app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| "[]".to_string())
}

#[tauri::command]
fn save_projects(app: tauri::AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("Dữ liệu không hợp lệ: {e}"))?;
    std::fs::write(projects_path(&app)?, json).map_err(|e| e.to_string())
}

// Xóa file MP4 dang dở sau khi dựng thất bại hoặc bị hủy
#[tauri::command]
fn remove_partial(path: String) {
    let p = Path::new(&path);
    if p.extension()
        .map(|e| e.eq_ignore_ascii_case("mp4"))
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(p);
    }
}

// ---------- Dựng phim: chạy FFmpeg với tham số do giao diện dựng ----------

#[derive(Default)]
struct ComposeState {
    child: Mutex<Option<CommandChild>>,
    cancel: Arc<AtomicBool>,
}

#[tauri::command]
async fn run_ffmpeg(
    app: tauri::AppHandle,
    state: State<'_, ComposeState>,
    args: Vec<String>,
) -> Result<(), String> {
    if should_pause_for_game(&app) {
        return Err("Đã tạm dừng dựng phim vì Valorant đang chạy.".into());
    }
    if args.is_empty() {
        return Err("Thiếu tham số FFmpeg.".into());
    }
    state.cancel.store(false, Ordering::Relaxed);

    let profile = load_settings(&app).performance_profile;
    let settings = load_settings(&app);
    let encoder = if settings.encoder == "auto" {
        "amf"
    } else {
        settings.encoder.as_str()
    };
    let (preset, crf) = match profile.as_str() {
        "performance" => ("ultrafast", "24"),
        "quality" => ("slow", "17"),
        _ => ("veryfast", "20"),
    };
    let mut normalized_args = args;
    if matches!(encoder, "amf" | "nvenc" | "qsv") {
        let mut filtered: Vec<String> = Vec::new();
        let mut i = 0;
        while i < normalized_args.len() {
            if normalized_args[i] == "-c:v" {
                filtered.push(normalized_args[i].clone());
                filtered.push(match encoder {
                    "amf" => "h264_amf".into(),
                    "nvenc" => "h264_nvenc".into(),
                    "qsv" => "h264_qsv".into(),
                    _ => "libx264".into(),
                });
                i += 2;
            } else if normalized_args[i] == "-preset" || normalized_args[i] == "-crf" {
                i += 2;
            } else {
                filtered.push(normalized_args[i].clone());
                i += 1;
            }
        }
        let output = filtered.pop();
        if encoder == "amf" {
            filtered.extend([
                "-quality".into(),
                if profile == "performance" { "speed" } else { "balanced" }.into(),
                "-rc".into(),
                "vbr_latency".into(),
            ]);
        } else if encoder == "nvenc" {
            filtered.extend([
                "-preset".into(),
                if profile == "quality" { "p7" } else { "p5" }.into(),
                "-cq".into(),
                crf.into(),
            ]);
        } else {
            filtered.extend([
                "-preset".into(),
                preset.into(),
                "-global_quality".into(),
                crf.into(),
            ]);
        }
        if let Some(output) = output {
            filtered.push(output);
        }
        normalized_args = filtered;
    } else {
        for i in 0..normalized_args.len() {
            if normalized_args[i] == "-preset" {
                if let Some(value) = normalized_args.get_mut(i + 1) { *value = preset.into(); }
            }
            if normalized_args[i] == "-crf" {
                if let Some(value) = normalized_args.get_mut(i + 1) { *value = crf.into(); }
            }
        }
    }

    let mut full: Vec<String> = ["-hide_banner", "-nostdin", "-progress", "pipe:1", "-nostats"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    full.extend(normalized_args);

    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(full)
        .spawn()
        .map_err(|e| e.to_string())?;

    let pid = child.pid();
    if set_below_normal_priority(pid) {
        println!("FFmpeg dựng phim (pid {pid}) đã đặt mức ưu tiên Below Normal");
    }
    *state.child.lock().unwrap() = Some(child);

    let mut tail: Vec<String> = Vec::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line);
                for l in text.lines() {
                    if let Some(v) = l.strip_prefix("out_time_us=") {
                        if let Ok(us) = v.trim().parse::<u64>() {
                            let _ = app.emit("compose-progress", us / 1000);
                        }
                    }
                }
            }
            CommandEvent::Stderr(line) => {
                for l in String::from_utf8_lossy(&line).lines() {
                    if !l.trim().is_empty() {
                        tail.push(l.to_string());
                        if tail.len() > 12 {
                            tail.remove(0);
                        }
                    }
                }
            }
            CommandEvent::Terminated(p) => {
                state.child.lock().unwrap().take();
                if state.cancel.load(Ordering::Relaxed) {
                    return Err("Đã hủy dựng phim.".into());
                }
                return if p.code == Some(0) {
                    Ok(())
                } else {
                    Err(format!("FFmpeg lỗi (mã {:?}):\n{}", p.code, tail.join("\n")))
                };
            }
            _ => {}
        }
    }

    state.child.lock().unwrap().take();
    Ok(())
}

#[tauri::command]
fn cancel_ffmpeg(state: State<'_, ComposeState>) {
    state.cancel.store(true, Ordering::Relaxed);
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(UploadState::default())
        .manage(WatchState::default())
        .manage(ComposeState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Tự bật theo dõi thư mục đã lưu từ lần trước
            let handle = app.handle().clone();
            let monitor_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                let mut last_status = String::new();
                loop {
                    let status = if is_game_running() { "running" } else { "offline" };
                    if status != last_status {
                        let _ = monitor_handle.emit("game-status", status);
                        last_status = status.to_string();
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            });
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
            get_game_status,
            get_settings,
            save_settings,
            set_pause_while_game,
            set_performance_profile,
            set_encoder,
            get_available_encoders,
            get_queue,
            add_queue_job,
            update_queue_job,
            pause_queue,
            resume_queue,
            retry_queue_job,
            cancel_queue_job,
            clear_queue_history,
            get_benchmark_samples,
            add_benchmark_sample,
            clear_benchmark_samples,
            set_watch_dir,
            list_clips,
            load_library,
            save_library,
            path_exists,
            upload_video,
            cancel_upload,
            delete_video,
            list_cloud_videos,
            set_auto_delete_mkv,
            set_auto_delete_after_upload,
            set_simple_mode,
            trash_local_file,
            trash_source_after_verify,
            make_thumbnail,
            load_projects,
            save_projects,
            remove_partial,
            run_ffmpeg,
            cancel_ffmpeg
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}