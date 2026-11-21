import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type PublicSettings = {
  worker_url: string;
  has_token: boolean;
  pause_while_game: boolean;
  performance_profile: string;
};

export default function SettingsPanel() {
  const [workerUrl, setWorkerUrl] = useState("");
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [pauseWhileGame, setPauseWhileGame] = useState(true);
  const [performanceProfile, setPerformanceProfile] = useState("balanced");
  const [message, setMessage] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const load = async () => {
    const s = await invoke<PublicSettings>("get_settings");
    setWorkerUrl(s.worker_url);
    setHasToken(s.has_token);
    setPauseWhileGame(s.pause_while_game);
    setPerformanceProfile(s.performance_profile);
    if (!s.worker_url || !s.has_token) setIsOpen(true);
  };

  useEffect(() => {
    load();
  }, []);

  const saveSettings = async () => {
    try {
      await invoke("save_settings", { workerUrl, apiToken: token });
      await invoke("set_pause_while_game", { enabled: pauseWhileGame });
      await invoke("set_performance_profile", { profile: performanceProfile });
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

      <label htmlFor="performance-profile">Chế độ hiệu suất</label>
      <select
        id="performance-profile"
        value={performanceProfile}
        onChange={(e) => setPerformanceProfile(e.target.value)}
      >
        <option value="performance">Performance - ít tải CPU nhất</option>
        <option value="balanced">Balanced - cân bằng tốc độ/chất lượng</option>
        <option value="quality">Quality - chất lượng cao, tốn tải nhất</option>
      </select>

      <button onClick={saveSettings}>Lưu cài đặt</button>
      {message && <p className="note">{message}</p>}
    </details>
  );
}