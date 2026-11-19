import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ProgressBar from "./ProgressBar";

type Props = {
  outputPath: string;
  onBusyChange: (busy: boolean) => void;
  onUploaded: (url: string) => void;
};

export default function UploadPanel({ outputPath, onBusyChange, onUploaded }: Props) {
  const [limit, setLimit] = useState("2048");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [note, setNote] = useState("");
  const [link, setLink] = useState("");
  const [message, setMessage] = useState("");
  const startedAt = useRef(0);

  useEffect(() => {
    const unlistenProgress = listen<[number, number]>("upload-progress", (e) => {
      setProgress(e.payload);
      if (e.payload[0] > 0) setNote("");
    });
    const unlistenStatus = listen<string>("upload-status", (e) => {
      setNote(e.payload);
      startedAt.current = Date.now(); // tính lại tốc độ cho lần thử mới
    });
    return () => {
      unlistenProgress.then((f) => f());
      unlistenStatus.then((f) => f());
    };
  }, []);

  useEffect(() => {
    onBusyChange(uploading);
  }, [uploading]);

  const percent = progress && progress[1] > 0 ? (progress[0] / progress[1]) * 100 : 0;

  let statusText = message;
  if (uploading) {
    if (note) {
      statusText = note;
    } else if (progress) {
      const seconds = Math.max(0.5, (Date.now() - startedAt.current) / 1000);
      const mbDone = progress[0] / 1024 / 1024;
      const mbTotal = progress[1] / 1024 / 1024;
      statusText =
        `Đang upload... ${percent.toFixed(0)}% ` +
        `(${mbDone.toFixed(1)}/${mbTotal.toFixed(1)} MB, ${(mbDone / seconds).toFixed(1)} MB/s)`;
    }
  }

  const start = async () => {
    const gameRunning = await invoke<boolean>("is_game_running");
    if (gameRunning) {
      const proceed = await ask(
        "Valorant đang chạy. Upload dùng băng thông mạng và có thể làm tăng ping. " +
          "Nên chọn giới hạn tốc độ thấp. Vẫn upload?",
        { title: "Cảnh báo", kind: "warning", okLabel: "Vẫn upload", cancelLabel: "Để sau" }
      );
      if (!proceed) return;
    }

    setUploading(true);
    setLink("");
    setProgress(null);
    setNote("");
    setMessage("Đang kết nối...");
    startedAt.current = Date.now();

    try {
      const url = await invoke<string>("upload_video", {
        path: outputPath,
        limitKbps: Number(limit),
      });
      setLink(url);
      onUploaded(url);
      try {
        await navigator.clipboard.writeText(url);
        setMessage("Upload xong! Link đã được sao chép.");
      } catch {
        setMessage("Upload xong! Hãy sao chép link bên dưới.");
      }
    } catch (e) {
      setMessage("Lỗi: " + e);
    } finally {
      setNote("");
      setUploading(false);
    }
  };

  const cancel = () => invoke("cancel_upload");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setMessage("Đã sao chép link!");
    } catch {
      setMessage("Không sao chép tự động được, hãy chọn link và nhấn Ctrl+C.");
    }
  };

  return (
    <section className="card">
      <label htmlFor="limit">Giới hạn tốc độ upload</label>
      <select
        id="limit"
        value={limit}
        disabled={uploading}
        onChange={(e) => setLimit(e.target.value)}
      >
        <option value="0">Không giới hạn</option>
        <option value="4096">4 MB/s</option>
        <option value="2048">2 MB/s</option>
        <option value="1024">1 MB/s</option>
        <option value="512">512 KB/s</option>
      </select>

      <div className="row">
        <button onClick={start} disabled={uploading}>
          Upload lên Cloud
        </button>
        {uploading && <button onClick={cancel}>Hủy upload</button>}
      </div>

      {(uploading || progress) && <ProgressBar percent={percent} color="var(--green)" />}
      {statusText && <p className="note">{statusText}</p>}

      {link && (
        <>
          <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <button onClick={copy}>Sao chép link</button>
        </>
      )}
    </section>
  );
}