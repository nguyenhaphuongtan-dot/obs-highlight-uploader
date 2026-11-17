import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";


const pickBtn = document.querySelector<HTMLButtonElement>("#pick-btn")!;
const convertBtn = document.querySelector<HTMLButtonElement>("#convert-btn")!;
const openBtn = document.querySelector<HTMLButtonElement>("#open-btn")!;
const label = document.querySelector<HTMLParagraphElement>("#file-path")!;
const info = document.querySelector<HTMLPreElement>("#info")!;
const progressWrap = document.querySelector<HTMLDivElement>("#progress-wrap")!;
const progressBar = document.querySelector<HTMLDivElement>("#progress-bar")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;

let currentPath = "";
let outputPath = "";
let durationMs = 0;
let audioIsAac = false;

listen<number>("remux-progress", (event) => {
  if (durationMs <= 0) return;
  const percent = Math.min(100, (event.payload / durationMs) * 100);
  progressBar.style.width = percent.toFixed(1) + "%";
  status.textContent = `Đang chuyển... ${percent.toFixed(0)}%`;
});

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

convertBtn.addEventListener("click", async () => {
    const gameRunning = await invoke<boolean>("is_game_running");
  if (gameRunning) {
    const proceed = await ask(
      "Valorant đang chạy. Chuyển video lúc này có thể làm giảm FPS. Bạn vẫn muốn tiếp tục?",
      {
        title: "Cảnh báo",
        kind: "warning",
        okLabel: "Vẫn chuyển",
        cancelLabel: "Để sau",
      }
    );
    if (!proceed) return;
  }
  const suggested = currentPath.replace(/\.mkv$/i, ".mp4");
  const chosen = await save({
    defaultPath: suggested,
    filters: [{ name: "MP4", extensions: ["mp4"] }],
  });
  if (!chosen) return; // người dùng bấm Hủy

  // Không cho ghi đè chính file nguồn
  if (chosen.toLowerCase() === currentPath.toLowerCase()) {
    status.textContent = "Lỗi: file đầu ra không được trùng file nguồn.";
    return;
  }

  outputPath = chosen;
  convertBtn.disabled = true;
  pickBtn.disabled = true;
  openBtn.hidden = true;
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