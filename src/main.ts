import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const pickBtn = $<HTMLButtonElement>("#pick-btn");
const convertBtn = $<HTMLButtonElement>("#convert-btn");
const openBtn = $<HTMLButtonElement>("#open-btn");
const label = $<HTMLParagraphElement>("#file-path");
const info = $<HTMLPreElement>("#info");
const progressWrap = $<HTMLDivElement>("#progress-wrap");
const progressBar = $<HTMLDivElement>("#progress-bar");
const status = $<HTMLParagraphElement>("#status");

const settingsBox = $<HTMLDetailsElement>("#settings");
const workerUrlInput = $<HTMLInputElement>("#worker-url");
const tokenInput = $<HTMLInputElement>("#api-token");
const saveSettingsBtn = $<HTMLButtonElement>("#save-settings");
const settingsStatus = $<HTMLParagraphElement>("#settings-status");

const uploadBox = $<HTMLDivElement>("#upload-box");
const limitSel = $<HTMLSelectElement>("#limit");
const uploadBtn = $<HTMLButtonElement>("#upload-btn");
const cancelBtn = $<HTMLButtonElement>("#cancel-btn");
const upWrap = $<HTMLDivElement>("#up-progress-wrap");
const upBar = $<HTMLDivElement>("#up-progress-bar");
const upStatus = $<HTMLParagraphElement>("#up-status");
const linkInput = $<HTMLInputElement>("#link");
const copyBtn = $<HTMLButtonElement>("#copy-btn");

let currentPath = "";
let outputPath = "";
let durationMs = 0;
let audioIsAac = false;
let uploadStartedAt = 0;

// ---------- Cài đặt ----------

async function loadSettings() {
  const s = await invoke<{ worker_url: string; has_token: boolean }>("get_settings");
  workerUrlInput.value = s.worker_url;
  tokenInput.placeholder = s.has_token
    ? "Đã lưu (để trống nếu giữ nguyên)"
    : "Dán API_TOKEN vào đây";
  if (!s.worker_url || !s.has_token) settingsBox.open = true;
}

saveSettingsBtn.addEventListener("click", async () => {
  try {
    await invoke("save_settings", {
      workerUrl: workerUrlInput.value,
      apiToken: tokenInput.value,
    });
    tokenInput.value = "";
    settingsStatus.textContent = "Đã lưu cài đặt.";
    await loadSettings();
  } catch (e) {
    settingsStatus.textContent = "Lỗi: " + e;
  }
});

loadSettings();

// ---------- Tiến trình ----------

listen<number>("remux-progress", (event) => {
  if (durationMs <= 0) return;
  const percent = Math.min(100, (event.payload / durationMs) * 100);
  progressBar.style.width = percent.toFixed(1) + "%";
  status.textContent = `Đang chuyển... ${percent.toFixed(0)}%`;
});

listen<[number, number]>("upload-progress", (event) => {
  const [done, total] = event.payload;
  const percent = total > 0 ? (done / total) * 100 : 0;
  const seconds = Math.max(0.5, (Date.now() - uploadStartedAt) / 1000);
  const mbDone = done / 1024 / 1024;
  const mbTotal = total / 1024 / 1024;
  upBar.style.width = percent.toFixed(1) + "%";
  upStatus.textContent =
    `Đang upload... ${percent.toFixed(0)}% ` +
    `(${mbDone.toFixed(1)}/${mbTotal.toFixed(1)} MB, ${(mbDone / seconds).toFixed(1)} MB/s)`;
});

// ---------- Chọn file ----------

pickBtn.addEventListener("click", async () => {
  const path = await open({
    multiple: false,
    filters: [{ name: "Video", extensions: ["mkv"] }],
  });
  if (!path) return;

  currentPath = path;
  label.textContent = path;
  info.textContent = "Đang đọc thông tin...";
  status.textContent = "";
  progressWrap.hidden = true;
  openBtn.hidden = true;
  uploadBox.hidden = true;
  convertBtn.disabled = true;

  try {
    const json = await invoke<string>("probe_video", { path });
    const data = JSON.parse(json);
    const video = data.streams.find((s: any) => s.codec_type === "video");
    const audio = data.streams.find((s: any) => s.codec_type === "audio");

    const [num, den] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
    const fps = den ? (num / den).toFixed(2) : "?";
    durationMs = Number(data.format.duration) * 1000;
    audioIsAac = audio?.codec_name === "aac";
    const sizeMB = (Number(data.format.size) / 1024 / 1024).toFixed(1);

    info.textContent =
      `Độ phân giải: ${video?.width}x${video?.height}\n` +
      `FPS: ${fps}\n` +
      `Codec hình: ${video?.codec_name}\n` +
      `Codec tiếng: ${audio?.codec_name ?? "không có"}\n` +
      `Thời lượng: ${(durationMs / 1000).toFixed(1)} giây\n` +
      `Dung lượng: ${sizeMB} MB`;

    convertBtn.disabled = false;
  } catch (e) {
    info.textContent = "Lỗi: " + e;
  }
});

// ---------- Chuyển MP4 ----------

convertBtn.addEventListener("click", async () => {
  const gameRunning = await invoke<boolean>("is_game_running");
  if (gameRunning) {
    const proceed = await ask(
      "Valorant đang chạy. Chuyển video lúc này có thể làm giảm FPS. Bạn vẫn muốn tiếp tục?",
      { title: "Cảnh báo", kind: "warning", okLabel: "Vẫn chuyển", cancelLabel: "Để sau" }
    );
    if (!proceed) return;
  }

  const suggested = currentPath.replace(/\.mkv$/i, ".mp4");
  const chosen = await save({
    defaultPath: suggested,
    filters: [{ name: "MP4", extensions: ["mp4"] }],
  });
  if (!chosen) return;

  if (chosen.toLowerCase() === currentPath.toLowerCase()) {
    status.textContent = "Lỗi: file đầu ra không được trùng file nguồn.";
    return;
  }

  outputPath = chosen;
  convertBtn.disabled = true;
  pickBtn.disabled = true;
  openBtn.hidden = true;
  uploadBox.hidden = true;
  progressBar.style.width = "0%";
  progressWrap.hidden = false;
  status.textContent = "Đang chuyển...";

  try {
    await invoke("remux_video", {
      input: currentPath,
      output: outputPath,
      copyAudio: audioIsAac,
    });
    progressBar.style.width = "100%";
    status.textContent = "Hoàn tất! File đã lưu tại: " + outputPath;
    openBtn.hidden = false;
    resetUploadUi();
    uploadBox.hidden = false;
  } catch (e) {
    status.textContent = "Lỗi: " + e;
  } finally {
    convertBtn.disabled = false;
    pickBtn.disabled = false;
  }
});

openBtn.addEventListener("click", async () => {
  if (outputPath) await revealItemInDir(outputPath);
});

// ---------- Upload ----------

function resetUploadUi() {
  upWrap.hidden = true;
  upBar.style.width = "0%";
  upStatus.textContent = "";
  linkInput.hidden = true;
  copyBtn.hidden = true;
  cancelBtn.hidden = true;
  uploadBtn.disabled = false;
}

uploadBtn.addEventListener("click", async () => {
  if (!outputPath) return;

  const gameRunning = await invoke<boolean>("is_game_running");
  if (gameRunning) {
    const proceed = await ask(
      "Valorant đang chạy. Upload dùng băng thông mạng và có thể làm tăng ping. " +
        "Nên chọn giới hạn tốc độ thấp. Vẫn upload?",
      { title: "Cảnh báo", kind: "warning", okLabel: "Vẫn upload", cancelLabel: "Để sau" }
    );
    if (!proceed) return;
  }

  resetUploadUi();
  uploadBtn.disabled = true;
  pickBtn.disabled = true;
  convertBtn.disabled = true;
  cancelBtn.hidden = false;
  upWrap.hidden = false;
  upStatus.textContent = "Đang kết nối...";
  uploadStartedAt = Date.now();

  try {
    const viewUrl = await invoke<string>("upload_video", {
      path: outputPath,
      limitKbps: Number(limitSel.value),
    });
    upBar.style.width = "100%";
    upStatus.textContent = "Upload xong! Link xem:";
    linkInput.value = viewUrl;
    linkInput.hidden = false;
    copyBtn.hidden = false;
    try {
      await navigator.clipboard.writeText(viewUrl);
      upStatus.textContent = "Upload xong! Link đã được sao chép:";
    } catch {
      /* không sao chép tự động được, người dùng bấm nút */
    }
  } catch (e) {
    upStatus.textContent = "Lỗi: " + e;
  } finally {
    cancelBtn.hidden = true;
    uploadBtn.disabled = false;
    pickBtn.disabled = false;
    convertBtn.disabled = false;
  }
});

cancelBtn.addEventListener("click", async () => {
  await invoke("cancel_upload");
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(linkInput.value);
    upStatus.textContent = "Đã sao chép link!";
  } catch {
    linkInput.select();
    upStatus.textContent = "Hãy nhấn Ctrl+C để sao chép link đang được chọn.";
  }
});