import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ClipRecord, Library } from "../library";

type Clip = {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedMs: number;
};

type Item = {
  key: string; // đường dẫn MKV gốc, dùng làm khóa trong thư viện
  name: string;
  sizeBytes?: number;
  timeMs: number;
  rec?: ClipRecord;
};

type Props = {
  library: Library;
  refreshKey: number;
  onSelect: (path: string) => void;
  onDelete: (clipPath: string, viewUrl: string) => void;
  disabled: boolean;
};

function baseName(p: string) {
  return p.split(/[\\/]/).pop() ?? p;
}

function statusOf(rec?: ClipRecord) {
  if (rec?.viewUrl) return { text: "Đã upload", cls: "badge green" };
  if (rec?.mp4Path) return { text: "Đã chuyển MP4", cls: "badge blue" };
  return { text: "Mới", cls: "badge" };
}

export default function ClipList({ library, refreshKey, onSelect, onDelete, disabled }: Props) {
  const [dir, setDir] = useState("");
  const [clips, setClips] = useState<Clip[]>([]);
  const [message, setMessage] = useState("");

  const refresh = async (folder: string) => {
    if (!folder) {
      setClips([]);
      return;
    }
    setClips(await invoke<Clip[]>("list_clips", { dir: folder }));
  };

  useEffect(() => {
    invoke<{ watch_dir: string }>("get_settings").then((s) => {
      setDir(s.watch_dir);
      refresh(s.watch_dir);
    });
  }, []);

  // Làm mới khi App yêu cầu (ví dụ sau khi xóa MKV)
  useEffect(() => {
    if (dir) refresh(dir);
  }, [refreshKey]);

  useEffect(() => {
    const unlisten = listen<Clip>("clip-detected", (e) => {
      setClips((prev) => [...prev.filter((c) => c.path !== e.payload.path), e.payload]);
      setMessage(`Phát hiện clip mới: ${e.payload.name}`);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const chooseFolder = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (!picked) return;
    try {
      await invoke("set_watch_dir", { dir: picked });
      setDir(picked);
      setMessage("");
      await refresh(picked);
    } catch (e) {
      setMessage("Lỗi: " + e);
    }
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Đã sao chép link.");
    } catch {
      setMessage("Không sao chép tự động được. Link: " + url);
    }
  };

  // Gộp: các file MKV trong thư mục + các clip đã có MP4 nhưng MKV không còn trong danh sách
  const clipPaths = new Set(clips.map((c) => c.path));
  const items: Item[] = [
    ...clips.map((c) => ({
      key: c.path,
      name: c.name,
      sizeBytes: c.sizeBytes,
      timeMs: c.modifiedMs,
      rec: library[c.path],
    })),
    ...Object.entries(library)
      .filter(([key, rec]) => !clipPaths.has(key) && rec.mp4Path)
      .map(([key, rec]) => ({
        key,
        name: baseName(rec.mp4Path!),
        timeMs: rec.convertedAt ?? rec.uploadedAt ?? 0,
        rec,
      })),
  ].sort((a, b) => b.timeMs - a.timeMs);

  return (
    <section className="card">
      <div className="row">
        <button onClick={chooseFolder} disabled={disabled}>
          {dir ? "Đổi thư mục clip" : "Chọn thư mục OBS lưu clip"}
        </button>
        {dir && <button onClick={() => refresh(dir)}>Làm mới</button>}
      </div>
      {dir && <p className="note">Đang theo dõi: {dir}</p>}
      {message && <p className="note">{message}</p>}

      {dir && items.length === 0 && <p className="note">Chưa có clip nào.</p>}

      <ul className="clips">
        {items.map((c) => {
          const st = statusOf(c.rec);
          return (
            <li key={c.key}>
              <div>
                <div className="clip-name">{c.name}</div>
                <div className="note">
                  {c.timeMs > 0 ? new Date(c.timeMs).toLocaleString("vi-VN") : "—"}
                  {c.sizeBytes !== undefined && ` · ${(c.sizeBytes / 1024 / 1024).toFixed(1)} MB`}{" "}
                  <span className={st.cls}>{st.text}</span>
                  {c.rec?.mkvDeleted && <span className="badge">MKV đã xóa</span>}
                </div>
              </div>
              <div className="clip-actions">
                {c.rec?.viewUrl && (
                  <>
                    <button onClick={() => copyLink(c.rec!.viewUrl!)}>Sao chép link</button>
                    <button disabled={disabled} onClick={() => onDelete(c.key, c.rec!.viewUrl!)}>
                      Xóa khỏi cloud
                    </button>
                  </>
                )}
                <button disabled={disabled} onClick={() => onSelect(c.key)}>
                  Dùng clip này
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}