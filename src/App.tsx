import { useEffect, useRef, useState } from "react";
import { open, save, ask, message as showMessage } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import SettingsPanel from "./components/SettingsPanel";
import ClipList from "./components/ClipList";
import UploadPanel from "./components/UploadPanel";
import VideoPreview from "./components/VideoPreview";
import ProgressBar from "./components/ProgressBar";
import { loadLibrary, saveLibrary } from "./library";
import type { ClipRecord, Library } from "./library";

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
  const [previewPath, setPreviewPath] = useState("");
  const [message, setMessage] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);

  const [library, setLibrary] = useState<Library>({});
  const libraryRef = useRef<Library>({});

  const busy = converting || uploadBusy || probing;

  useEffect(() => {
    loadLibrary().then((lib) => {
      libraryRef.current = lib;
      setLibrary(lib);
    });
  }, []);

  useEffect(() => {
    const unlisten = listen<number>("remux-progress", (e) => setConvertMs(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const updateRecord = (mkvPath: string, patch: ClipRecord) => {
    const next: Library = {
      ...libraryRef.current,
      [mkvPath]: { ...libraryRef.current[mkvPath], ...patch },
    };
    libraryRef.current = next;
    setLibrary(next);
    saveLibrary(next).catch(() => {});
  };

  const loadPath = async (p: string) => {
    setPath(p);
    setInfo(null);
    setConvertMs(0);
    setShowConvertBar(false);
    setMessage("");
    setProbing(true);

    // Nếu clip này đã chuyển MP4 trước đó và file còn tồn tại thì dùng lại
    let existing = "";
    const rec = libraryRef.current[p];
    if (rec?.mp4Path && (await invoke<boolean>("path_exists", { path: rec.mp4Path }))) {
      existing = rec.mp4Path;
    }
    setOutputPath(existing);
    setPreviewPath(existing || p);
    if (existing) setMessage("Clip này đã được chuyển MP4 trước đó: " + existing);

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
      setPreviewPath(chosen);
      updateRecord(path, { mp4Path: chosen });
      setMessage("Hoàn tất! File đã lưu tại: " + chosen);
    } catch (e) {
      setMessage("Lỗi: " + e);
    } finally {
      setConverting(false);
    }
  };
  const deleteRemote = async (clipPath: string, viewUrl: string) => {
    try {
      const ok = await ask(
        "Xóa video này khỏi cloud? Link chia sẻ sẽ ngừng hoạt động. File trên máy bạn không bị xóa.",
        { title: "Xóa khỏi cloud", kind: "warning", okLabel: "Xóa", cancelLabel: "Hủy" }
      );
      if (!ok) return;

      setMessage("Đang xóa trên cloud...");
      await invoke("delete_video", { viewUrl });
      updateRecord(clipPath, { viewUrl: undefined, uploadedAt: undefined });
      setMessage("Đã xóa video khỏi cloud.");
      await showMessage("Đã xóa video khỏi cloud. Link chia sẻ không còn hoạt động.", {
        title: "Xóa khỏi cloud",
        kind: "info",
      });
    } catch (e) {
      console.error("delete_video lỗi:", e);
      setMessage("Lỗi: " + e);
      await showMessage("Xóa thất bại: " + e, { title: "Lỗi", kind: "error" });
    }
  };
  const convertPercent =
    info && info.durationMs > 0 ? (convertMs / info.durationMs) * 100 : 0;

  const previewLabel = previewPath.toLowerCase().endsWith(".mp4")
    ? "Xem trước bản MP4 đã chuyển"
    : "Xem trước clip gốc (MKV)";

  return (
    <main className="container">
      <h1>OBS Highlight Uploader</h1>

      <SettingsPanel />

      <ClipList library={library} onSelect={loadPath} onDelete={deleteRemote} disabled={busy} />
      <button onClick={pick} disabled={busy}>
        Chọn file MKV khác
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

      {previewPath && (
        <VideoPreview key={previewPath} path={previewPath} label={previewLabel} />
      )}

      <button onClick={convert} disabled={!info || busy}>
        Chuyển sang MP4
      </button>

      {showConvertBar && <ProgressBar percent={convertPercent} />}
      {message && <p className="note">{message}</p>}

      {outputPath && (
        <>
          <button onClick={() => revealItemInDir(outputPath)}>Mở thư mục</button>
          <UploadPanel
            key={outputPath}
            outputPath={outputPath}
            onBusyChange={setUploadBusy}
            onUploaded={(url) => updateRecord(path, { viewUrl: url, uploadedAt: Date.now() })}
          />
        </>
      )}
    </main>
  );
}