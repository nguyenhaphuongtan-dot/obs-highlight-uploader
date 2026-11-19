import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Segment } from "../library";

type Props = {
  path: string;
  durationMs: number;
  segments: Segment[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: (startMs: number, endMs: number) => void;
  onUpdate: (id: string, patch: Partial<Segment>) => void;
  onRemove: (id: string) => void;
};

const MIN_MS = 500;
const BEFORE_MS = 10000;
const AFTER_MS = 5000;

function fmt(ms: number) {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

export default function SegmentEditor({
  path,
  durationMs,
  segments,
  selectedId,
  onSelect,
  onAdd,
  onUpdate,
  onRemove,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopAtRef = useRef<number | null>(null);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState(false);

  const sel = segments.find((s) => s.id === selectedId) ?? null;

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

  const onTimelineClick = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    seek(((e.clientX - rect.left) / rect.width) * durationMs);
  };

  const addAtCurrent = () => {
    const start = Math.max(0, current - BEFORE_MS);
    const end = Math.min(durationMs, current + AFTER_MS);
    if (end - start < MIN_MS) return;
    onAdd(start, end);
  };

  const setStart = (ms: number) => {
    if (!sel) return;
    const s = Math.min(Math.max(0, ms), sel.endMs - MIN_MS);
    onUpdate(sel.id, { startMs: s });
    seek(s);
  };

  const setEnd = (ms: number) => {
    if (!sel) return;
    const e = Math.max(Math.min(durationMs, ms), sel.startMs + MIN_MS);
    onUpdate(sel.id, { endMs: e });
    seek(e);
  };

  const playSelection = () => {
    const v = videoRef.current;
    if (!v || !sel) return;
    stopAtRef.current = sel.endMs;
    v.currentTime = sel.startMs / 1000;
    v.play().catch(() => {});
  };

  const pct = (ms: number) => `${(ms / durationMs) * 100}%`;

  return (
    <section className="card">
      <p className="note">Chọn các đoạn bạn muốn giữ lại</p>

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

      <div className="timeline" onClick={onTimelineClick}>
        {segments.map((s) => (
          <div
            key={s.id}
            className={
              "seg" +
              (s.viewUrl ? " up" : s.cutPath ? " cut" : "") +
              (s.id === selectedId ? " sel" : "")
            }
            style={{ left: pct(s.startMs), width: pct(s.endMs - s.startMs) }}
            title={`${s.label}: ${fmt(s.startMs)} → ${fmt(s.endMs)}`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(s.id);
            }}
          />
        ))}
        <div className="playhead" style={{ left: pct(current) }} />
      </div>

      <p className="note">Vị trí hiện tại: {fmt(current)} / {fmt(durationMs)}</p>
      <div className="row">
        <button onClick={() => seek(current - 1000)}>−1s</button>
        <button onClick={() => seek(current - 100)}>−0.1s</button>
        <button onClick={() => seek(current + 100)}>+0.1s</button>
        <button onClick={() => seek(current + 1000)}>+1s</button>
      </div>

      <button onClick={addAtCurrent}>
        + Thêm mốc tại vị trí hiện tại (10 giây trước, 5 giây sau)
      </button>

      {sel ? (
        <div className="seg-edit">
          <label htmlFor="seg-label">Tên đoạn</label>
          <input
            id="seg-label"
            value={sel.label}
            onChange={(e) => onUpdate(sel.id, { label: e.target.value })}
          />

          <label htmlFor="seg-start">Điểm đầu: {fmt(sel.startMs)}</label>
          <input
            id="seg-start"
            type="range"
            min={0}
            max={durationMs}
            step={100}
            value={sel.startMs}
            onChange={(e) => setStart(Number(e.target.value))}
          />
          <button onClick={() => setStart(current)}>Đặt điểm đầu tại vị trí hiện tại</button>

          <label htmlFor="seg-end">Điểm cuối: {fmt(sel.endMs)}</label>
          <input
            id="seg-end"
            type="range"
            min={0}
            max={durationMs}
            step={100}
            value={sel.endMs}
            onChange={(e) => setEnd(Number(e.target.value))}
          />
          <button onClick={() => setEnd(current)}>Đặt điểm cuối tại vị trí hiện tại</button>

          <p className="note">
            Đoạn: {fmt(sel.startMs)} → {fmt(sel.endMs)} ({((sel.endMs - sel.startMs) / 1000).toFixed(1)} giây)
          </p>
          <div className="row">
            <button onClick={playSelection}>▶ Xem thử</button>
            <button onClick={() => onSelect(null)}>Bỏ chọn</button>
            <button onClick={() => onRemove(sel.id)}>Xóa đoạn</button>
          </div>
        </div>
      ) : (
        <p className="note">
          {segments.length === 0
            ? "Chưa có đoạn nào. Tua tới khoảnh khắc đáng nhớ rồi bấm Thêm mốc."
            : "Bấm vào một khối trên thanh thời gian để chọn và chỉnh đoạn."}
        </p>
      )}
    </section>
  );
}