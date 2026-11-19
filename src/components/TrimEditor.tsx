import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

export type TrimRange = { startMs: number; endMs: number };

type Props = {
  path: string;
  durationMs: number;
  range: TrimRange;
  onChange: (r: TrimRange) => void;
};

const MIN_CLIP_MS = 500;

function fmt(ms: number) {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

export default function TrimEditor({ path, durationMs, range, onChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopAtRef = useRef<number | null>(null);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState(false);

  // Chỉ cập nhật mượt khi đang phát, đứng yên thì không tốn gì
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        const ms = v.currentTime * 1000;
        setCurrent(ms);
        if (stopAtRef.current !== null && ms >= stopAtRef.current) {
          v.pause();
          stopAtRef.current = null;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const seek = (ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.min(Math.max(0, ms), durationMs);
    v.currentTime = clamped / 1000;
    setCurrent(clamped);
  };

  const setStart = (ms: number) => {
    const s = Math.min(Math.max(0, ms), range.endMs - MIN_CLIP_MS);
    onChange({ startMs: s, endMs: range.endMs });
    seek(s);
  };

  const setEnd = (ms: number) => {
    const e = Math.max(Math.min(durationMs, ms), range.startMs + MIN_CLIP_MS);
    onChange({ startMs: range.startMs, endMs: e });
    seek(e);
  };

  const playSelection = () => {
    const v = videoRef.current;
    if (!v) return;
    stopAtRef.current = range.endMs;
    v.currentTime = range.startMs / 1000;
    v.play().catch(() => {});
  };

  const selectedMs = range.endMs - range.startMs;

  return (
    <section className="card">
      <p className="note">Cắt clip: chọn đoạn bạn muốn giữ lại</p>

      {error ? (
        <p className="note">Không phát được video trong app nên chưa thể cắt.</p>
      ) : (
        <video
          ref={videoRef}
          className="preview"
          src={convertFileSrc(path)}
          controls
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onSeeked={(e) => setCurrent(e.currentTarget.currentTime * 1000)}
          onTimeUpdate={(e) => {
            if (!playing) setCurrent(e.currentTarget.currentTime * 1000);
          }}
          onError={() => setError(true)}
        />
      )}

      <p className="note">Vị trí hiện tại: {fmt(current)} / {fmt(durationMs)}</p>
      <div className="row">
        <button onClick={() => seek(current - 1000)}>−1s</button>
        <button onClick={() => seek(current - 100)}>−0.1s</button>
        <button onClick={() => seek(current + 100)}>+0.1s</button>
        <button onClick={() => seek(current + 1000)}>+1s</button>
      </div>

      <label htmlFor="trim-start">Điểm đầu: {fmt(range.startMs)}</label>
      <input
        id="trim-start"
        type="range"
        min={0}
        max={durationMs}
        step={100}
        value={range.startMs}
        onChange={(e) => setStart(Number(e.target.value))}
      />
      <button onClick={() => setStart(current)}>Đặt điểm đầu tại vị trí hiện tại</button>

      <label htmlFor="trim-end">Điểm cuối: {fmt(range.endMs)}</label>
      <input
        id="trim-end"
        type="range"
        min={0}
        max={durationMs}
        step={100}
        value={range.endMs}
        onChange={(e) => setEnd(Number(e.target.value))}
      />
      <button onClick={() => setEnd(current)}>Đặt điểm cuối tại vị trí hiện tại</button>

      <p className="note">
        Đoạn đã chọn: {fmt(range.startMs)} → {fmt(range.endMs)} ({(selectedMs / 1000).toFixed(1)} giây)
      </p>
      <div className="row">
        <button onClick={playSelection}>▶ Xem thử đoạn đã chọn</button>
        <button onClick={() => onChange({ startMs: 0, endMs: durationMs })}>Chọn cả clip</button>
      </div>
    </section>
  );
}