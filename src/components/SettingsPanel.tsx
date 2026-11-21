import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type PublicSettings = {
  worker_url: string;
  has_token: boolean;
  pause_while_game: boolean;
  performance_profile: string;
  encoder: string;
  auto_delete_after_upload: boolean;
  simple_mode: boolean;
};

export default function SettingsPanel() {
  const [workerUrl, setWorkerUrl] = useState("");
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [pauseWhileGame, setPauseWhileGame] = useState(true);
  const [performanceProfile, setPerformanceProfile] = useState("balanced");
  const [encoder, setEncoder] = useState("auto");
  const [autoDeleteAfterUpload, setAutoDeleteAfterUpload] = useState(false);
  const [simpleMode, setSimpleMode] = useState(true);
  const [availableEncoders, setAvailableEncoders] = useState<string[]>(["auto"]);
  const [message, setMessage] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const load = async () => {
    const s = await invoke<PublicSettings>("get_settings");
    setWorkerUrl(s.worker_url);
    setHasToken(s.has_token);
    setPauseWhileGame(s.pause_while_game);
    setPerformanceProfile(s.performance_profile);
    setEncoder(s.encoder);
    setAutoDeleteAfterUpload(s.auto_delete_after_upload);
    setSimpleMode(s.simple_mode);
    if (!s.worker_url || !s.has_token) setIsOpen(true);
  };

  useEffect(() => {
    load();
    invoke<string[]>("get_available_encoders")
      .then(setAvailableEncoders)
      .catch(() => {});
  }, []);

  const saveSettings = async () => {
    try {
      await invoke("save_settings", { workerUrl, apiToken: token });
      await invoke("set_pause_while_game", { enabled: pauseWhileGame });
      await invoke("set_performance_profile", { profile: performanceProfile });
      await invoke("set_encoder", { encoder });
      await invoke("set_auto_delete_after_upload", { enabled: autoDeleteAfterUpload });
      await invoke("set_simple_mode", { enabled: simpleMode });
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

      <label className="check">
        <input
          type="checkbox"
          checked={simpleMode}
          onChange={(e) => setSimpleMode(e.target.checked)}
        />
        Chế độ đơn giản - chỉ hiện Cắt clip và theo dõi OBS
      </label>

      <label htmlFor="worker-url">Địa chỉ Worker</label>
      <input
        id="worker-url"
        value={workerUrl}
        placeholder="https://highlight.nghapiti.workers.dev"
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

      <label htmlFor="encoder">Bộ mã hóa video</label>
      <select
        id="encoder"
        value={encoder}
        onChange={(e) => setEncoder(e.target.value)}
      >
        {availableEncoders.map((value) => (
          <option key={value} value={value}>
            {value === "auto"
              ? "Tự động (ưu tiên GPU)"
              : value === "amf"
                ? "AMD AMF"
                : value === "nvenc"
                  ? "NVIDIA NVENC"
                  : value === "qsv"
                    ? "Intel Quick Sync"
                    : "CPU x264"}
          </option>
        ))}
      </select>

      <label className="check">
        <input
          type="checkbox"
          checked={autoDeleteAfterUpload}
          onChange={(e) => setAutoDeleteAfterUpload(e.target.checked)}
        />
        Tự chuyển file đã upload vào Thùng rác
      </label>

      <button onClick={saveSettings}>Lưu cài đặt</button>
      {message && <p className="note">{message}</p>}
    </details>
  );
}