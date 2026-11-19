import { useEffect, useRef, useState } from "react";
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import SettingsPanel from "./components/SettingsPanel";
import ClipList from "./components/ClipList";
import UploadPanel from "./components/UploadPanel";
import VideoPreview from "./components/VideoPreview";
import TrimEditor from "./components/TrimEditor";
import type { TrimRange } from "./components/TrimEditor";
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
  const [sourceExists, setSourceExists] = useState(true);
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [converting, setConverting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progressMs, setProgressMs] = useState(0);
  const [progressTotalMs, setProgressTotalMs] = useState(0);
  const [showBar, setShowBar] = useState(false);
  const [outputPath, setOutputPath] = useState("");
  const [cutPath, setCutPath] = useState("");
  const [cutVersion, setCutVersion] = useState(0);
  const [range, setRange] = useState<TrimRange>({ startMs: 0, endMs: 0 });
  const [precise, setPrecise] = useState(false);
  const [autoDelete, setAutoDelete] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [message, setMessage] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);

  const [library, setLibrary] = useState<Library>({});
  const libraryRef = useRef<Library>({});

  const busy = converting || exporting || uploadBusy || probing;
  const uploadPath = cutPath || outputPath;

  useEffect(() => {
    loadLibrary().then((lib) => {
      libraryRef.current = lib;
      setLibrary(lib);
    });
    invoke<{ auto_delete_mkv: boolean }>("get_settings").then((s) =>
      setAutoDelete(s.auto_delete_mkv)
    );
  }, []);

  useEffect(() => {
    const unlisten = listen<number>("remux-progress", (e) => setProgressMs(e.payload));
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

  const toggleAutoDelete = async (enabled: boolean) => {
    if (enabled) {
      const ok = await ask(
        "Sau khi chuyển sang MP4 thành công và kiểm tra file MP4 đọc được, " +
          "app sẽ chuyển file MKV gốc vào Thùng rác.\n\n" +
          "Nếu MP4 có vấn đề, MKV được giữ nguyên. Thùng rác vẫn chiếm dung lượng " +
          "cho tới khi bạn dọn.",
        { title: "Bật tự động xóa MKV?", kind: "warning", okLabel: "Bật", cancelLabel: "Hủy" }
      );
      if (!ok) return;
    }
    try {
      await invoke("set_auto_delete_mkv", { enabled });
      setAutoDelete(enabled);
    } catch (e) {
      setMessage("Lỗi: " + e);
    }
  };

  const loadPath = async (p: string) => {
    const rec = libraryRef.current[p];
    const mkvExists = await invoke<boolean>("path_exists", { path: p });

    // Nếu clip này đã chuyển MP4 trước đó và file còn tồn tại thì dùng lại
    let existing = "";
    if (rec?.mp4Path && (await invoke<boolean>("path_exists", { path: rec.mp4Path }))) {
      existing = rec.mp4Path;
    }

    if (!mkvExists && !existing) {
      setMessage("Không tìm thấy file MKV lẫn MP4 của clip này (có thể đã bị xóa hoặc di chuyển).");
      return;
    }

    setPath(p);
    setSourceExists(mkvExists);
    setInfo(null);
    setCutPath("");
    setProgressMs(0);
    setShowBar(false);
    setOutputPath(existing);
    setMessage(existing ? "Clip này đã được chuyển MP4 trước đó: " + existing : "");
    setProbing(true);

    try {
      const json = await invoke<string>("probe_video", { path: mkvExists ? p : existing });
      const parsed = parseInfo(json);
      setInfo(parsed);
      setRange({ startMs: 0, endMs: parsed.durationMs });
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

  const confirmIfGameRunning = async (text: string, okLabel: string) => {
    const gameRunning = await invoke<boolean>("is_game_running");
    if (!gameRunning) return true;
    return await ask(text, { title: "Cảnh báo", kind: "warning", okLabel, cancelLabel: "Để sau" });
  };

  const convert = async () => {
    if (!info || !sourceExists) return;

    const proceed = await confirmIfGameRunning(
      "Valorant đang chạy. Chuyển video lúc này có thể làm giảm FPS. Bạn vẫn muốn tiếp tục?",
      "Vẫn chuyển"
    );
    if (!proceed) return;

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
    setCutPath("");
    setProgressMs(0);
    setProgressTotalMs(info.durationMs);
    setShowBar(true);
    setConverting(true);
    setMessage("Đang chuyển...");

    try {
      await invoke("remux_video", {
        input: path,
        output: chosen,
        copyAudio: info.audioCodec === "aac",
        startMs: 0,
        durationMs: 0,
        precise: false,
      });
      setProgressMs(info.durationMs);
      setOutputPath(chosen);
      setRange({ startMs: 0, endMs: info.durationMs });
      updateRecord(path, { mp4Path: chosen, convertedAt: Date.now() });

      let note = "Hoàn tất! File đã lưu tại: " + chosen + ".";

      if (autoDelete) {
        try {
          await invoke("trash_source_after_verify", {
            source: path,
            mp4: chosen,
            expectedMs: Math.round(info.durationMs),
          });
          updateRecord(path, { mkvDeleted: true });
          setSourceExists(false);
          setRefreshKey((k) => k + 1);
          note += " Đã chuyển file MKV gốc vào Thùng rác.";
        } catch (e) {
          note += " Không xóa MKV gốc (MKV được giữ nguyên): " + e;
        }
      }
      setMessage(note);
    } catch (e) {
      setMessage("Lỗi: " + e);
    } finally {
      setConverting(false);
    }
  };

  const exportCut = async () => {
    if (!info || !outputPath) return;

    const clipMs = range.endMs - range.startMs;
    const isFull = range.startMs <= 0 && range.endMs >= info.durationMs - 50;
    if (isFull) {
      setMessage("Bạn chưa chọn đoạn cắt nào (đang chọn cả clip). Hãy kéo điểm đầu hoặc điểm cuối.");
      return;
    }

    if (precise) {
      const proceed = await confirmIfGameRunning(
        "Valorant đang chạy. Cắt chính xác (encode lại) tốn CPU và có thể làm giảm FPS. Vẫn tiếp tục?",
        "Vẫn cắt"
      );
      if (!proceed) return;
    }

    const chosen = await save({
      defaultPath: outputPath.replace(/\.mp4$/i, "_cut.mp4"),
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    });
    if (!chosen) return;

    if (chosen.toLowerCase() === outputPath.toLowerCase()) {
      setMessage("Lỗi: file đã cắt không được trùng file MP4 gốc.");
      return;
    }

    setProgressMs(0);
    setProgressTotalMs(clipMs);
    setShowBar(true);
    setExporting(true);
    setMessage("Đang cắt...");

    try {
      await invoke("remux_video", {
        input: outputPath,
        output: chosen,
        copyAudio: true,
        startMs: Math.round(range.startMs),
        durationMs: Math.round(clipMs),
        precise,
      });
      setProgressMs(clipMs);
      setCutPath(chosen);
      setCutVersion((v) => v + 1);
      setMessage("Đã cắt xong! File: " + chosen);
    } catch (e) {
      setMessage("Lỗi: " + e);
    } finally {
      setExporting(false);
    }
  };

  const deleteRemote = async (clipPath: string, viewUrl: string) => {
    const ok = await ask(
      "Xóa video này khỏi cloud? Link chia sẻ sẽ ngừng hoạt động. File trên máy bạn không bị xóa.",
      { title: "Xóa khỏi cloud", kind: "warning", okLabel: "Xóa", cancelLabel: "Hủy" }
    );
    if (!ok) return;
    setMessage("Đang xóa trên cloud...");
    try {
      await invoke("delete_video", { viewUrl });
      updateRecord(clipPath, { viewUrl: undefined, uploadedAt: undefined });
      setMessage("Đã xóa video khỏi cloud.");
    } catch (e) {
      setMessage("Lỗi: " + e);
    }
  };

  const percent = progressTotalMs > 0 ? (progressMs / progressTotalMs) * 100 : 0;

  return (
    <main className="container">
      <h1>OBS Highlight Uploader</h1>

      <SettingsPanel />

      <ClipList
        library={library}
        refreshKey={refreshKey}
        onSelect={loadPath}
        onDelete={deleteRemote}
        disabled={busy}
      />

      <button onClick={pick} disabled={busy}>
        Chọn file MKV khác
      </button>
      <p className="path">
        {path || "Chưa chọn file"}
        {path && !sourceExists && " (file MKV gốc không còn, đang dùng bản MP4)"}
      </p>

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

      {path && sourceExists && !outputPath && (
        <VideoPreview key={path} path={path} label="Xem trước clip gốc (MKV)" />
      )}

      <button onClick={convert} disabled={!info || busy || !sourceExists}>
        {outputPath ? "Chuyển lại sang MP4" : "Chuyển sang MP4"}
      </button>

      <label className="check">
        <input
          type="checkbox"
          checked={autoDelete}
          disabled={busy}
          onChange={(e) => toggleAutoDelete(e.target.checked)}
        />
        Tự động chuyển MKV vào Thùng rác sau khi chuyển MP4 thành công
      </label>

      {outputPath && info && (
        <>
          <TrimEditor
            key={outputPath}
            path={outputPath}
            durationMs={info.durationMs}
            range={range}
            onChange={setRange}
          />

          <section className="card">
            <label htmlFor="mode">Chế độ cắt</label>
            <select
              id="mode"
              value={precise ? "precise" : "fast"}
              disabled={busy}
              onChange={(e) => setPrecise(e.target.value === "precise")}
            >
              <option value="fast">Nhanh (không encode lại, điểm đầu có thể lệch vài giây)</option>
              <option value="precise">Chính xác (encode lại, chậm hơn, tốn CPU)</option>
            </select>
            <button onClick={exportCut} disabled={busy}>
              Xuất đoạn đã chọn
            </button>
          </section>
        </>
      )}

      {showBar && <ProgressBar percent={percent} />}
      {message && <p className="note">{message}</p>}

      {cutPath && (
        <>
          <VideoPreview
            key={cutPath + cutVersion}
            path={cutPath}
            label="Xem lại đoạn đã cắt (bản này sẽ được upload)"
          />
          <button onClick={() => setCutPath("")} disabled={busy}>
            Bỏ bản cắt (upload bản đầy đủ)
          </button>
        </>
      )}

      {outputPath && (
        <>
          <button onClick={() => revealItemInDir(uploadPath)}>Mở thư mục</button>
          <p className="note">File sẽ upload: {uploadPath}</p>
          <UploadPanel
            key={uploadPath}
            outputPath={uploadPath}
            onBusyChange={setUploadBusy}
            onUploaded={(url) => updateRecord(path, { viewUrl: url, uploadedAt: Date.now() })}
          />
        </>
      )}
    </main>
  );
}