import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type BenchmarkSample = {
  stage: "before" | "game_idle" | "game_queue" | "after";
  fps: number;
  ping: number;
  createdAt: number;
};

const stages: Array<{ value: BenchmarkSample["stage"]; label: string }> = [
  { value: "before", label: "Trước khi chơi" },
  { value: "game_idle", label: "Trong game - app idle" },
  { value: "game_queue", label: "Trong game - queue đang chạy" },
  { value: "after", label: "Sau khi thoát game" },
];

export default function PerformancePanel() {
  const [stage, setStage] = useState<BenchmarkSample["stage"]>("before");
  const [fps, setFps] = useState("");
  const [ping, setPing] = useState("");
  const [samples, setSamples] = useState<BenchmarkSample[]>([]);
  const [message, setMessage] = useState("");

  const refresh = async () => {
    try {
      setSamples(await invoke<BenchmarkSample[]>("get_benchmark_samples"));
    } catch (e) {
      setMessage("Lỗi: " + e);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const saveSample = async () => {
    const fpsValue = Number(fps);
    const pingValue = Number(ping);
    if (!Number.isFinite(fpsValue) || fpsValue <= 0) {
      setMessage("Hãy nhập FPS hợp lệ.");
      return;
    }
    if (!Number.isFinite(pingValue) || pingValue < 0) {
      setMessage("Hãy nhập ping hợp lệ.");
      return;
    }
    try {
      await invoke("add_benchmark_sample", {
        stage,
        fps: fpsValue,
        ping: Math.round(pingValue),
      });
      setFps("");
      setPing("");
      setMessage("Đã lưu mẫu đo.");
      await refresh();
    } catch (e) {
      setMessage("Lỗi: " + e);
    }
  };

  const clearSamples = async () => {
    try {
      await invoke("clear_benchmark_samples");
      await refresh();
      setMessage("Đã xóa lịch sử đo.");
    } catch (e) {
      setMessage("Lỗi: " + e);
    }
  };

  const stageLabel = (value: BenchmarkSample["stage"]) =>
    stages.find((item) => item.value === value)?.label ?? value;

  return (
    <main className="performance-view">
      <section className="performance-card">
        <h2>Đo FPS và ping</h2>
        <p className="note">
          Ghi theo cùng trận/hồ sơ game để so sánh tải của app.
        </p>
        <div className="benchmark-fields">
          <label>
            Mốc đo
            <select value={stage} onChange={(e) => setStage(e.target.value as BenchmarkSample["stage"])}>
              {stages.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>
          <label>
            FPS
            <input
              type="number"
              min="1"
              max="1000"
              value={fps}
              onChange={(e) => setFps(e.target.value)}
              placeholder="Ví dụ: 240"
            />
          </label>
          <label>
            Ping (ms)
            <input
              type="number"
              min="0"
              max="1000"
              value={ping}
              onChange={(e) => setPing(e.target.value)}
              placeholder="Ví dụ: 18"
            />
          </label>
        </div>
        <div className="benchmark-actions">
          <button onClick={saveSample}>Lưu mẫu đo</button>
          <button className="secondary" onClick={clearSamples}>Xóa lịch sử</button>
        </div>
        {message && <p className="note">{message}</p>}
      </section>

      <section className="benchmark-history">
        <h2>Lịch sử đo</h2>
        {samples.length === 0 ? (
          <p className="library-empty">Chưa có mẫu đo nào.</p>
        ) : (
          <div className="benchmark-list">
            {samples.map((sample) => (
              <article className="benchmark-row" key={`${sample.createdAt}-${sample.stage}`}>
                <strong>{stageLabel(sample.stage)}</strong>
                <span>{sample.fps.toFixed(0)} FPS</span>
                <span>{sample.ping} ms</span>
                <time>{new Date(sample.createdAt).toLocaleString("vi-VN")}</time>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
