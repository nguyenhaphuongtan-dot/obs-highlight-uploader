import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Clip = {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedMs: number;
};

type Props = {
  onSelect: (path: string) => void;
  disabled: boolean;
};

function sortClips(list: Clip[]): Clip[] {
  return [...list].sort((a, b) => b.modifiedMs - a.modifiedMs);
}

export default function ClipList({ onSelect, disabled }: Props) {
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

  useEffect(() => {
    const unlisten = listen<Clip>("clip-detected", (e) => {
      setClips((prev) => sortClips([...prev.filter((c) => c.path !== e.payload.path), e.payload]));
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

      {dir && clips.length === 0 && <p className="note">Chưa có clip .mkv nào trong thư mục.</p>}

      <ul className="clips">
        {clips.map((c) => (
          <li key={c.path}>
            <div>
              <div className="clip-name">{c.name}</div>
              <div className="note">
                {new Date(c.modifiedMs).toLocaleString("vi-VN")} ·{" "}
                {(c.sizeBytes / 1024 / 1024).toFixed(1)} MB
              </div>
            </div>
            <button disabled={disabled} onClick={() => onSelect(c.path)}>
              Dùng clip này
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}