import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import CutView from "./CutView";
import ComposePanel from "./components/ComposePanel";
import LibraryPanel from "./components/LibraryPanel";
import QueuePanel from "./components/QueuePanel";
import PerformancePanel from "./components/PerformancePanel";

type Mode = "cut" | "compose" | "library" | "queue" | "performance";

export default function App() {
  const [mode, setMode] = useState<Mode>("cut");
  const [cutBusy, setCutBusy] = useState(false);
  const [composeBusy, setComposeBusy] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [gameRunning, setGameRunning] = useState(false);
  const [pauseWhileGame, setPauseWhileGame] = useState(true);
  const [simpleMode, setSimpleMode] = useState(true);
  const busy = cutBusy || composeBusy || libraryBusy;

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const [running, settings] = await Promise.all([
          invoke<boolean>("is_game_running"),
          invoke<{ pause_while_game: boolean; simple_mode: boolean }>("get_settings"),
        ]);
        if (!cancelled) {
          setGameRunning(running);
          setPauseWhileGame(settings.pause_while_game);
          setSimpleMode(settings.simple_mode);
        }
      } catch {
        // Giữ trạng thái cũ nếu tray app đang khởi tạo.
      }
    };
    const unlisten = listen<string>("game-status", (event) => {
      if (!cancelled) setGameRunning(event.payload === "running");
    });
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (simpleMode && mode !== "cut") setMode("cut");
  }, [simpleMode, mode]);

  const go = (m: Mode) => {
    if (m === mode) return;
    // Dừng mọi video và nhạc đang phát trước khi chuyển tab
    document
      .querySelectorAll("video, audio")
      .forEach((el) => (el as HTMLMediaElement).pause());
    setMode(m);
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>OBS Highlight Uploader</h1>
        {pauseWhileGame && (
          <span className={gameRunning ? "performance-status paused" : "performance-status"}>
            {gameRunning ? "Valorant đang chạy - đã tạm dừng xử lý nặng" : "Sẵn sàng xử lý"}
          </span>
        )}
        <nav className="tabs">
          <button
            className={mode === "cut" ? "tab active" : "tab"}
            disabled={busy}
            onClick={() => go("cut")}
          >
            Cắt clip
          </button>
          {!simpleMode && (
            <>
              <button
                className={mode === "compose" ? "tab active" : "tab"}
                disabled={busy}
                onClick={() => go("compose")}
              >
                Dựng phim
              </button>
              <button
                className={mode === "library" ? "tab active" : "tab"}
                disabled={busy}
                onClick={() => go("library")}
              >
                Thư viện
              </button>
              <button
                className={mode === "queue" ? "tab active" : "tab"}
                disabled={busy}
                onClick={() => go("queue")}
              >
                Hàng đợi
              </button>
              <button
                className={mode === "performance" ? "tab active" : "tab"}
                disabled={busy}
                onClick={() => go("performance")}
              >
                Hiệu suất
              </button>
            </>
          )}
        </nav>
      </header>

      {/* Cả hai màn hình luôn được giữ nguyên trạng thái, chỉ ẩn đi khi không dùng */}
      <div className="view" style={{ display: mode === "cut" ? "flex" : "none" }}>
        <CutView onBusyChange={setCutBusy} />
      </div>
      <div className="view" style={{ display: mode === "compose" ? "flex" : "none" }}>
        <ComposePanel visible={mode === "compose"} onBusyChange={setComposeBusy} />
      </div>
      <div className="view" style={{ display: mode === "library" ? "flex" : "none" }}>
        <LibraryPanel onBusyChange={setLibraryBusy} />
      </div>
      <div className="view" style={{ display: mode === "queue" ? "flex" : "none" }}>
        <QueuePanel />
      </div>
      <div className="view" style={{ display: mode === "performance" ? "flex" : "none" }}>
        <PerformancePanel />
      </div>
    </div>
  );
}