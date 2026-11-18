import { useEffect, useState } from "react";
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ClipList from "./components/ClipList";
import SettingsPanel from "./components/SettingsPanel";
import UploadPanel from "./components/UploadPanel";
import ProgressBar from "./components/ProgressBar";


type VideoInfo = {
  width: number;
  height: number;
  fps: string;
  videoCodec: string;
  audioCodec: string | null;
  durationMs: number;
  sizeMB: string;
};

function parseInfo(json: string): VideoInfo {
  const data = JSON.parse(json);
  const video = data.streams.find((s: any) => s.codec_type === "video");
  const audio = data.streams.find((s: any) => s.codec_type === "audio");
  const [num, den] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);

  return {
    width: video?.width,
    height: video?.height,
    fps: den ? (num / den).toFixed(2) : "?",
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name ?? null,
    durationMs: Number(data.format.duration) * 1000,
    sizeMB: (Number(data.format.size) / 1024 / 1024).toFixed(1),
  };
}

export default function App() {
  const [path, setPath] = useState("");
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertMs, setConvertMs] = useState(0);
  const [showConvertBar, setShowConvertBar] = useState(false);
  const [outputPath, setOutputPath] = useState("");
  const [message, setMessage] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);

  const busy = converting || uploadBusy || probing;

  useEffect(() => {
    const unlisten = listen<number>("remux-progress", (e) => setConvertMs(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

    const loadPath = async (p: string) => {
    setPath(p);
    setInfo(null);
    setOutputPath("");
    setConvertMs(0);
    setShowConvertBar(false);
    setMessage("");
    setProbing(true);

    try {
      const json = await invoke<string>("probe_video", { path: p });
      setInfo(parseInfo(json));
    } catch (e) {
      setMessage("Lỗi: " + e);
    } finally {
      setProbing(false);
    }
  };

  const pick = async () => {
    const p = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mkv"] }],
    });
    if (p) await loadPath(p);
  };

  const convert = async () => {
    if (!info) return;

    const gameRunning = await invoke<boolean>("is_game_running");
    if (gameRunning) {
      const proceed = await ask(
        "Valorant đang chạy. Chuyển video lúc này có thể làm giảm FPS. Bạn vẫn muốn tiếp tục?",
        { title: "Cảnh báo", kind: "warning", okLabel: "Vẫn chuyển", cancelLabel: "Để sau" }
      );
      if (!proceed) return;
    }

    const chosen = await save({
      defaultPath: path.replace(/\.mkv$/i, ".mp4"),
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    });
    if (!chosen) return;

    if (chosen.toLowerCase() === path.toLowerCase()) {
      setMessage("Lỗi: file đầu ra không được trùng file nguồn.");
      return;
    }

    setOutputPath("");
    setConvertMs(0);
    setShowConvertBar(true);
    setConverting(true);
    setMessage("Đang chuyển...");

    try {
      await invoke("remux_video", {
        input: path,
        output: chosen,
        copyAudio: info.audioCodec === "aac",
      });
      setConvertMs(info.durationMs);
      setOutputPath(chosen);
      setMessage("Hoàn tất! File đã lưu tại: " + chosen);
    } catch (e) {
      setMessage("Lỗi: " + e);
    } finally {
      setConverting(false);
    }
  };

  const convertPercent = info && info.durationMs > 0 ? (convertMs / info.durationMs) * 100 : 0;

  return (
    <main className="container">
      <h1>OBS Highlight Uploader</h1>

      <SettingsPanel />
      <ClipList onSelect={loadPath} disabled={busy} />
      <button onClick={pick} disabled={busy}>
        Chọn file MKV
      </button>
      <p className="path">{path || "Chưa chọn file"}</p>

      {probing && <p className="note">Đang đọc thông tin...</p>}

      {info && (
        <pre className="info">
          {`Độ phân giải: ${info.width}x${info.height}\n` +
            `FPS: ${info.fps}\n` +
            `Codec hình: ${info.videoCodec}\n` +
            `Codec tiếng: ${info.audioCodec ?? "không có"}\n` +
            `Thời lượng: ${(info.durationMs / 1000).toFixed(1)} giây\n` +
            `Dung lượng: ${info.sizeMB} MB`}
        </pre>
      )}

      <button onClick={convert} disabled={!info || busy}>
        Chuyển sang MP4
      </button>

      {showConvertBar && <ProgressBar percent={convertPercent} />}
      {message && <p className="note">{message}</p>}

      {outputPath && (
        <>
          <button onClick={() => revealItemInDir(outputPath)}>Mở thư mục</button>
          <UploadPanel key={outputPath} outputPath={outputPath} onBusyChange={setUploadBusy} />
        </>
      )}
    </main>
  );
}