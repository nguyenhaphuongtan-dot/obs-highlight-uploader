import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

type CloudVideo = {
  id: string;
  size: number;
  modified: string;
  hasThumbnail: boolean;
};

type Props = {
  onBusyChange: (busy: boolean) => void;
};

export default function LibraryPanel({ onBusyChange }: Props) {
  const [videos, setVideos] = useState<CloudVideo[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [workerUrl, setWorkerUrl] = useState("");

  const refresh = async () => {
    setLoading(true);
    setMessage("");
    try {
      const settings = await invoke<{ worker_url: string }>("get_settings");
      setWorkerUrl(settings.worker_url.replace(/\/$/, ""));
      setVideos(await invoke<CloudVideo[]>("list_cloud_videos"));
    } catch (e) {
      setMessage("Lỗi: " + e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    onBusyChange(loading || working);
  }, [loading, working, onBusyChange]);

  const copyLink = async (id: string) => {
    const settings = await invoke<{ worker_url: string }>("get_settings");
    const url = `${settings.worker_url.replace(/\/$/, "")}/v/${id}`;
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Đã sao chép link.");
    } catch {
      setMessage(url);
    }
  };

  const openVideo = async (id: string) => {
    const settings = await invoke<{ worker_url: string }>("get_settings");
    await openUrl(`${settings.worker_url.replace(/\/$/, "")}/v/${id}`);
  };

  const deleteVideo = async (id: string) => {
    const settings = await invoke<{ worker_url: string }>("get_settings");
    const viewUrl = `${settings.worker_url.replace(/\/$/, "")}/v/${id}`;
    const confirmed = await ask(
      `Xóa "${id}" khỏi Cloud? Hành động này không thể hoàn tác.`,
      { title: "Xóa clip", kind: "warning", okLabel: "Xóa", cancelLabel: "Hủy" }
    );
    if (!confirmed) return;

    setWorking(true);
    setMessage("");
    try {
      await invoke("delete_video", { viewUrl });
      setMessage(`Đã xóa "${id}" khỏi Cloud.`);
      await refresh();
    } catch (e) {
      setMessage("Lỗi: " + e);
    } finally {
      setWorking(false);
    }
  };

  const filtered = videos.filter((video) =>
    video.id.toLowerCase().includes(search.trim().toLowerCase())
  );

  return (
    <main className="library-view">
      <div className="library-toolbar">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Tìm theo tên link..."
        />
        <button onClick={refresh} disabled={loading || working}>Làm mới</button>
      </div>

      {message && <p className="note">{message}</p>}
      {loading ? (
        <p className="library-empty">Đang tải thư viện Cloud...</p>
      ) : filtered.length === 0 ? (
        <p className="library-empty">
          {search ? "Không tìm thấy clip phù hợp." : "Chưa có clip nào được upload."}
        </p>
      ) : (
        <div className="library-grid">
          {filtered.map((video) => (
            <article className="library-card" key={video.id}>
              {video.hasThumbnail ? (
                <img
                  className="library-thumb"
                  src={`${workerUrl}/thumb/${encodeURIComponent(video.id)}.jpg`}
                  alt=""
                  data-id={video.id}
                  onError={(e) => { e.currentTarget.hidden = true; }}
                />
              ) : (
                <div className="library-thumb library-thumb-empty">Không có thumbnail</div>
              )}
              <div className="library-card-body">
                <strong className="library-name">{video.id}</strong>
                <p className="note">
                  {(video.size / 1024 / 1024).toFixed(1)} MB
                  {video.modified && ` · ${new Date(video.modified).toLocaleString("vi-VN")}`}
                </p>
                <div className="library-actions">
                  <button onClick={() => openVideo(video.id)}>Xem</button>
                  <button className="secondary" onClick={() => copyLink(video.id)}>Sao chép</button>
                  <button
                    className="danger"
                    disabled={working}
                    onClick={() => deleteVideo(video.id)}
                  >
                    Xóa
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
