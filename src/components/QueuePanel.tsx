import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type QueueJob = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  retryCount: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

type JobQueue = {
  paused: boolean;
  jobs: QueueJob[];
};

export default function QueuePanel() {
  const [queue, setQueue] = useState<JobQueue>({ paused: false, jobs: [] });
  const [message, setMessage] = useState("");
  const processing = useRef(false);

  const refresh = async () => {
    try {
      setQueue(await invoke<JobQueue>("get_queue"));
    } catch (e) {
      setMessage("Lỗi: " + e);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const tick = async () => {
      if (processing.current) return;
      const nextQueue = await invoke<JobQueue>("get_queue").catch(() => null);
      if (!nextQueue) return;
      setQueue(nextQueue);
      if (nextQueue.paused) return;

      const running = await invoke<boolean>("is_game_running").catch(() => false);
      if (running) return;

      const settings = await invoke<{ pause_while_game: boolean }>("get_settings").catch(
        () => ({ pause_while_game: true })
      );
      if (settings.pause_while_game && running) return;

      const job = nextQueue.jobs.find((item) => item.status === "queued");
      if (!job) return;

      processing.current = true;
      await invoke("update_queue_job", {
        id: job.id,
        status: "running",
        error: null,
      }).catch(() => {});
      await refresh();

      try {
        if (job.kind === "upload") {
          await invoke("upload_video", {
            path: String(job.payload.path ?? ""),
            limitKbps: Number(job.payload.limitKbps ?? 2048),
            slug: String(job.payload.slug ?? ""),
          });
        } else {
          throw new Error(`Loại tác vụ chưa hỗ trợ: ${job.kind}`);
        }
        await invoke("update_queue_job", {
          id: job.id,
          status: "completed",
          error: null,
        });
        setMessage(`Đã hoàn thành tác vụ ${job.id}.`);
      } catch (e) {
        const text = String(e);
        const gameNow = await invoke<boolean>("is_game_running").catch(() => false);
        await invoke("update_queue_job", {
          id: job.id,
          status: gameNow ? "queued" : "failed",
          error: gameNow ? null : text,
        });
        if (!gameNow) setMessage(`Tác vụ ${job.id} thất bại: ${text}`);
      } finally {
        processing.current = false;
        await refresh();
      }
    };

    tick();
    const timer = window.setInterval(tick, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const toggleQueue = async () => {
    await invoke(queue.paused ? "resume_queue" : "pause_queue");
    await refresh();
  };

  const retryJob = async (id: string) => {
    await invoke("retry_queue_job", { id });
    await refresh();
  };

  const cancelJob = async (id: string) => {
    await invoke("cancel_queue_job", { id });
    await refresh();
  };

  const clearHistory = async () => {
    await invoke("clear_queue_history");
    await refresh();
  };

  const label = (status: QueueJob["status"]) => {
    const labels: Record<QueueJob["status"], string> = {
      queued: "Đang chờ",
      running: "Đang chạy",
      paused: "Tạm dừng",
      completed: "Hoàn thành",
      failed: "Thất bại",
      cancelled: "Đã hủy",
    };
    return labels[status];
  };

  return (
    <main className="queue-view">
      <div className="queue-toolbar">
        <button onClick={toggleQueue}>
          {queue.paused ? "Tiếp tục hàng đợi" : "Tạm dừng hàng đợi"}
        </button>
        <button className="secondary" onClick={refresh}>Làm mới</button>
        <button className="secondary" onClick={clearHistory}>Xóa lịch sử</button>
      </div>

      {message && <p className="note">{message}</p>}

      {queue.jobs.length === 0 ? (
        <p className="library-empty">Hàng đợi hiện đang trống.</p>
      ) : (
        <div className="queue-list">
          {queue.jobs.map((job) => (
            <article className="queue-card" key={job.id}>
              <div className="queue-main">
                <strong>{job.kind === "upload" ? "Upload clip" : job.kind}</strong>
                <span className={`badge queue-status ${job.status}`}>{label(job.status)}</span>
                <p className="note">
                  {job.kind === "upload"
                    ? String(job.payload.path ?? "")
                    : JSON.stringify(job.payload)}
                </p>
                {job.error && <p className="queue-error">{job.error}</p>}
              </div>
              <div className="queue-actions">
                {(job.status === "failed" || job.status === "cancelled") && (
                  <button onClick={() => retryJob(job.id)}>Thử lại</button>
                )}
                {(job.status === "queued" || job.status === "running") && (
                  <button className="danger" onClick={() => cancelJob(job.id)}>Hủy</button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
