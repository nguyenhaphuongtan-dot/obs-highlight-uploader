import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

type Props = { path: string; label: string };

export default function VideoPreview({ path, label }: Props) {
  const [error, setError] = useState(false);

  return (
    <section className="card">
      <p className="note">{label}</p>
      {error ? (
        <p className="note">
          Không phát thử được file này trong app (có thể do định dạng hoặc quyền truy cập).
          Bạn vẫn có thể chuyển sang MP4 rồi xem bản MP4.
        </p>
      ) : (
        <video
          className="preview"
          src={convertFileSrc(path)}
          controls
          preload="metadata"
          onError={() => setError(true)}
        />
      )}
    </section>
  );
}