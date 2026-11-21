import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

type PublicSettings = {
  worker_url: string;
  has_token: boolean;
  pause_while_game: boolean;
};

export default function SettingsPanel() {
  const [workerUrl, setWorkerUrl] = useState("");
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [pauseWhileGame, setPauseWhileGame] = useState(true);
  const [message, setMessage] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const load = async () => {
    const s = await invoke<PublicSettings>("get_settings");
    setWorkerUrl(s.worker_url);
    setHasToken(s.has_token);
    setPauseWhileGame(s.pause_while_game);
    if (!s.worker_url || !s.has_token) setIsOpen(true);
  };

  useEffect(() => {
    load();
  }, []);

  const saveSettings = async () => {
    try {
      await invoke("save_settings", { workerUrl, apiToken: token });
      await invoke("set_pause_while_game", { enabled: pauseWhileGame });
      setToken("");
      setMessage("Đã lưu cài đặt.");
      await load();
    } catch (e) {
      setMessage("Lỗi: " + e);
    }
  };

  return (
    <details open={isOpen} onToggle={(e) => setIsOpen(e.currentTarget.open)}>
      <summary>Cài đặt Cloud</summary>

      <label htmlFor="worker-url">Địa chỉ Worker</label>
      <input
        id="worker-url"
        value={workerUrl}
        placeholder="https://nghapiti-highlight.hl-clips.workers.dev"
        onChange={(e) => setWorkerUrl(e.target.value)}
      />

      <label htmlFor="api-token">Mã bí mật (API_TOKEN)</label>
      <input
        id="api-token"
        type="password"
        value={token}
        placeholder={hasToken ? "Đã lưu (để trống nếu giữ nguyên)" : "Dán API_TOKEN vào đây"}
        onChange={(e) => setToken(e.target.value)}
      />

      <label className="check">
        <input
          type="checkbox"
          checked={pauseWhileGame}
          onChange={(e) => setPauseWhileGame(e.target.checked)}
        />
        Tạm dừng xử lý và upload khi Valorant đang chạy
      </label>

      <button onClick={saveSettings}>Lưu cài đặt</button>
      {workerUrl && (
        <button
          type="button"
          onClick={() => openUrl(`${workerUrl.replace(/\/$/, "")}/library`)}
        >
          Mở thư viện clip trên web
        </button>
      )}
      {message && <p className="note">{message}</p>}
    </details>
  );
}