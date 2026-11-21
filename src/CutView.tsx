import { useEffect, useRef, useState } from "react";
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import SettingsPanel from "./components/SettingsPanel";
import ClipList from "./components/ClipList";
import UploadPanel from "./components/UploadPanel";
import VideoPreview from "./components/VideoPreview";
import SegmentEditor from "./components/SegmentEditor";
import ProgressBar from "./components/ProgressBar";
import { loadLibrary, saveLibrary } from "./library";
import type { ClipRecord, Library, Segment } from "./library";

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

export default function CutView({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportVersion, setExportVersion] = useState(0);
  const [precise, setPrecise] = useState(false);
  const [autoDelete, setAutoDelete] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [message, setMessage] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);

  const [library, setLibrary] = useState<Library>({});
  const libraryRef = useRef<Library>({});

  const busy = converting || exporting || uploadBusy || probing;
    useEffect(() => {
    onBusyChange?.(busy);
  }, [busy]);
  const segments: Segment[] = library[path]?.segments ?? [];
  const selected = segments.find((s) => s.id === selectedId) ?? null;
  const uploadPath = selected ? selected.cutPath ?? "" : outputPath;

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

  // ---------- Thư viện ----------

  const updateRecord = (mkvPath: string, patch: ClipRecord) => {
    const next: Library = {
      ...libraryRef.current,
      [mkvPath]: { ...libraryRef.current[mkvPath], ...patch },
    };
    libraryRef.current = next;
    setLibrary(next);
    saveLibrary(next).catch(() => {});
  };

  const patchSegment = (mkvPath: string, id: string, patch: Partial<Segment>) => {
    const rec = libraryRef.current[mkvPath];
    const timeChanged = patch.startMs !== undefined || patch.endMs !== undefined;
    const list = (rec?.segments ?? []).map((s) =>
      s.id === id ? { ...s, ...patch, ...(timeChanged ? { cutPath: undefined } : {}) } : s
    );
    updateRecord(mkvPath, { segments: list });
  };

  const addSegment = (startMs: number, endMs: number) => {
    const rec = libraryRef.current[path];
    const maxNo = Math.max(0, ...(rec?.segments ?? []).map((s) => s.no));
    const no = rec?.nextSegmentNo ?? maxNo + 1;
    const seg: Segment = {
      id: `${Date.now().toString(36)}${no}`,
      no,
      label: `Đoạn ${no}`,
      startMs,
      endMs,
    };
    updateRecord(path, { segments: [...(rec?.segments ?? []), seg], nextSegmentNo: no + 1 });
    setSelectedId(seg.id);
  };

  const removeSegment = (id: string) => {
    const rec = libraryRef.current[path];
    updateRecord(path, { segments: (rec?.segments ?? []).filter((s) => s.id !== id) });
    if (selectedId === id) setSelectedId(null);
  };

  // ---------- Cài đặt ----------

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

  // ---------- Chọn clip ----------

  const loadPath = async (p: string) => {
    const rec = libraryRef.current[p];
    const mkvExists = await invoke<boolean>("path_exists", { path: p });

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
    setSelectedId(null);
    setProgressMs(0);
    setShowBar(false);
    setOutputPath(existing);
    setMessage(existing ? "Clip này đã được chuyển MP4 trước đó: " + existing : "");
    setProbing(true);

    try {
      const json = await invoke<string>("probe_video", { path: mkvExists ? p : existing });
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

  const confirmIfGameRunning = async (text: string, okLabel: string) => {
    const gameRunning = await invoke<boolean>("is_game_running");
    if (!gameRunning) return true;
    return await ask(text, { title: "Cảnh báo", kind: "warning", okLabel, cancelLabel: "Để sau" });
  };

  // ---------- Chuyển MP4 ----------

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
    setSelectedId(null);
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

  // ---------- Xuất các đoạn ----------

  const cutFile = (seg: Segment) => outputPath.replace(/\.mp4$/i, `_${seg.no}.mp4`);

  const exportSegments = async (list: Segment[]) => {
    if (!info || !outputPath || list.length === 0) return;

    const gameRunning = await invoke<boolean>("is_game_running");
    const settings = await invoke<{ pause_while_game: boolean }>("get_settings");
    if (gameRunning && settings.pause_while_game) {
      for (const seg of list) {
        const clipMs = seg.endMs - seg.startMs;
        await invoke("add_queue_job", {
          kind: "remux",
          payload: {
            input: outputPath,
            output: cutFile(seg),
            copyAudio: true,
            startMs: Math.round(seg.startMs),
            durationMs: Math.round(clipMs),
            precise,
          },
        });
      }
      setMessage(`Đã thêm ${list.length} tác vụ cắt vào hàng đợi.`);
      return;
    }

    if (precise) {
      const proceed = await confirmIfGameRunning(
        "Valorant đang chạy. Cắt chính xác (encode lại) tốn CPU và có thể làm giảm FPS. Vẫn tiếp tục?",
        "Vẫn cắt"
      );
      if (!proceed) return;
    }

    setShowBar(true);
    setExporting(true);

    try {
      for (let i = 0; i < list.length; i++) {
        const seg = list[i];
        const clipMs = seg.endMs - seg.startMs;
        const out = cutFile(seg);

        setProgressMs(0);
        setProgressTotalMs(clipMs);
        setMessage(`Đang cắt "${seg.label}" (${i + 1}/${list.length})...`);

        await invoke("remux_video", {
          input: outputPath,
          output: out,
          copyAudio: true,
          startMs: Math.round(seg.startMs),
          durationMs: Math.round(clipMs),
          precise,
        });
        patchSegment(path, seg.id, { cutPath: out });
      }
      setExportVersion((v) => v + 1);
      setMessage(`Đã cắt xong ${list.length} đoạn.`);
    } catch (e) {
      setMessage("Lỗi: " + e);
    } finally {
      setExporting(false);
    }
  };

  // ---------- Xóa trên cloud ----------

  const deleteRemote = async (clipPath: string, viewUrl: string, segmentId?: string) => {
    const ok = await ask(
      "Xóa video này khỏi cloud? Link chia sẻ sẽ ngừng hoạt động. File trên máy bạn không bị xóa.",
      { title: "Xóa khỏi cloud", kind: "warning", okLabel: "Xóa", cancelLabel: "Hủy" }
    );
    if (!ok) return;
    setMessage("Đang xóa trên cloud...");
    try {
      await invoke("delete_video", { viewUrl });
      if (segmentId) {
        patchSegment(clipPath, segmentId, { viewUrl: undefined, uploadedAt: undefined });
      } else {
        updateRecord(clipPath, { viewUrl: undefined, uploadedAt: undefined });
      }
      setMessage("Đã xóa video khỏi cloud.");
    } catch (e) {
      setMessage("Lỗi: " + e);
    }
  };

  const percent = progressTotalMs > 0 ? (progressMs / progressTotalMs) * 100 : 0;

  return (
    <div className="layout">
        {/* Cột trái: cài đặt và danh sách clip */}
        <aside className="col">
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
        </aside>

        {/* Cột giữa: video và thanh thời gian */}
        <section className="col">
          <p className="path">
            {path || "Chưa chọn clip. Hãy bấm \"Dùng clip này\" ở danh sách bên trái."}
            {path && !sourceExists && " (file MKV gốc không còn, đang dùng bản MP4)"}
          </p>

          {path && sourceExists && !outputPath && (
            <VideoPreview key={path} path={path} label="Xem trước clip gốc (MKV)" />
          )}

          {outputPath && info && (
            <SegmentEditor
              key={outputPath}
              path={outputPath}
              durationMs={info.durationMs}
              segments={segments}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAdd={addSegment}
              onUpdate={(id, patch) => patchSegment(path, id, patch)}
              onRemove={removeSegment}
            />
          )}

          {path && !outputPath && (
            <p className="note">Chuyển sang MP4 (cột bên phải) để bắt đầu chọn các đoạn cần giữ.</p>
          )}
        </section>

        {/* Cột phải: thông tin, chuyển, xuất, upload */}
        <aside className="col">
          {probing && <p className="note">Đang đọc thông tin...</p>}

          {info && (
            <p className="note">
              {info.width}x{info.height} · {info.fps} FPS · {(info.durationMs / 1000).toFixed(1)} giây
            </p>
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
            <section className="card">
              <label htmlFor="mode">Chế độ cắt</label>
              <select
                id="mode"
                value={precise ? "precise" : "fast"}
                disabled={busy}
                onChange={(e) => setPrecise(e.target.value === "precise")}
              >
                <option value="fast">Nhanh (không encode lại, đầu clip có thể lệch vài giây)</option>
                <option value="precise">Chính xác (encode lại, chậm hơn, tốn CPU)</option>
              </select>
              <div className="row">
                <button
                  disabled={busy || !selected}
                  onClick={() => selected && exportSegments([selected])}
                >
                  Xuất đoạn đã chọn
                </button>
                <button
                  disabled={busy || segments.length === 0}
                  onClick={() => exportSegments(segments)}
                >
                  Xuất tất cả ({segments.length})
                </button>
              </div>
            </section>
          )}

          {showBar && <ProgressBar percent={percent} />}
          {message && <p className="note">{message}</p>}

          {selected?.cutPath && (
            <VideoPreview
              key={selected.cutPath + exportVersion}
              path={selected.cutPath}
              label={`Xem lại "${selected.label}" (bản này sẽ được upload)`}
            />
          )}

          {selected && !selected.cutPath && (
            <p className="note">
              Đoạn "{selected.label}" chưa được xuất. Bấm "Xuất đoạn đã chọn" trước khi upload,
              hoặc bỏ chọn đoạn để upload cả clip.
            </p>
          )}

          {uploadPath && (
            <>
              <button onClick={() => revealItemInDir(uploadPath)}>Mở thư mục</button>
              <p className="note">File sẽ upload: {uploadPath}</p>
              <UploadPanel
                key={uploadPath + ":" + exportVersion}
                outputPath={uploadPath}
                suggestedName={
                  selected
                    ? selected.label
                    : (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "")
                }
                onBusyChange={setUploadBusy}
                onUploaded={(url) => {
                  if (selected) {
                    patchSegment(path, selected.id, { viewUrl: url, uploadedAt: Date.now() });
                  } else {
                    updateRecord(path, { viewUrl: url, uploadedAt: Date.now() });
                  }
                }}
              />
            </>
          )}
        </aside>
     </div>
  );
}