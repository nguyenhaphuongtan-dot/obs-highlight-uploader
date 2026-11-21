import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
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

type DragMode = "move" | "start" | "end";

type Drag = {
  id: string;
  mode: DragMode;
  originX: number;
  origStart: number;
  origEnd: number;
  width: number;
};

type Draft = { id: string; startMs: number; endMs: number };

const MIN_MS = 500;
const BEFORE_MS = 10000;
const AFTER_MS = 5000;
const TICK_STEPS = [500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const scrubbing = useRef(false);

  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [draft, setDraft] = useState<Draft | null>(null);

  const sel = segments.find((s) => s.id === selectedId) ?? null;
  const shown = (s: Segment): Segment =>
    draft && draft.id === s.id ? { ...s, startMs: draft.startMs, endMs: draft.endMs } : s;
  const selShown = sel ? shown(sel) : null;

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

  // Khi phóng to, cuộn thanh thời gian để con trỏ phát luôn nằm trong tầm nhìn
  useEffect(() => {
    const sc = scrollRef.current;
    const tl = timelineRef.current;
    if (!sc || !tl || zoom <= 1 || dragRef.current) return;
    const x = (current / durationMs) * tl.clientWidth;
    if (x < sc.scrollLeft + 20 || x > sc.scrollLeft + sc.clientWidth - 20) {
      sc.scrollLeft = x - sc.clientWidth / 2;
    }
  }, [current, zoom, durationMs]);

  const seek = (ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = clamp(ms, 0, durationMs);
    v.currentTime = clamped / 1000;
    setCurrent(clamped);
  };

  const seekFromX = (clientX: number) => {
    const tl = timelineRef.current;
    if (!tl) return;
    const rect = tl.getBoundingClientRect();
    if (rect.width <= 0) return;
    seek(((clientX - rect.left) / rect.width) * durationMs);
  };

  // ---------- Lướt trên vùng trống của thanh thời gian ----------

  const timelineDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    scrubbing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromX(e.clientX);
  };

  const timelineMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubbing.current) seekFromX(e.clientX);
  };

  const timelineUp = () => {
    scrubbing.current = false;
  };

  // ---------- Kéo khối đoạn hoặc hai mép ----------

  const beginDrag = (e: ReactPointerEvent<HTMLElement>, seg: Segment, mode: DragMode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const tl = timelineRef.current;
    if (!tl) return;

    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      id: seg.id,
      mode,
      originX: e.clientX,
      origStart: seg.startMs,
      origEnd: seg.endMs,
      width: tl.getBoundingClientRect().width,
    };
    const initial = { id: seg.id, startMs: seg.startMs, endMs: seg.endMs };
    draftRef.current = initial;
    setDraft(initial);
    onSelect(seg.id);
  };

  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.width <= 0) return;

    const deltaMs = ((e.clientX - d.originX) / d.width) * durationMs;
    let start = d.origStart;
    let end = d.origEnd;

    if (d.mode === "move") {
      const len = d.origEnd - d.origStart;
      start = clamp(d.origStart + deltaMs, 0, durationMs - len);
      end = start + len;
    } else if (d.mode === "start") {
      start = clamp(d.origStart + deltaMs, 0, d.origEnd - MIN_MS);
    } else {
      end = clamp(d.origEnd + deltaMs, d.origStart + MIN_MS, durationMs);
    }

    const next = { id: d.id, startMs: start, endMs: end };
    draftRef.current = next;
    setDraft(next);
    seek(d.mode === "end" ? end : start); // xem được khung hình tại mép đang kéo
  };

  // Chỉ lưu khi thả chuột, tránh ghi đĩa liên tục trong lúc kéo
  const endDrag = () => {
    const d = dragRef.current;
    const last = draftRef.current;
    dragRef.current = null;
    draftRef.current = null;
    setDraft(null);
    if (!d || !last) return;

    const changed =
      Math.abs(last.startMs - d.origStart) >= 1 || Math.abs(last.endMs - d.origEnd) >= 1;
    if (changed) {
      onUpdate(d.id, { startMs: Math.round(last.startMs), endMs: Math.round(last.endMs) });
    }
  };

  // ---------- Các nút khác ----------

  const addAtCurrent = () => {
    const start = Math.max(0, current - BEFORE_MS);
    const end = Math.min(durationMs, current + AFTER_MS);
    if (end - start < MIN_MS) return;
    onAdd(start, end);
  };

  const startFromPlayhead = () => {
    if (!sel) return;
    onUpdate(sel.id, { startMs: Math.round(clamp(current, 0, sel.endMs - MIN_MS)) });
  };

  const endFromPlayhead = () => {
    if (!sel) return;
    onUpdate(sel.id, { endMs: Math.round(clamp(current, sel.startMs + MIN_MS, durationMs)) });
  };

  const playSelection = () => {
    const v = videoRef.current;
    if (!v || !sel) return;
    stopAtRef.current = sel.endMs;
    v.currentTime = sel.startMs / 1000;
    v.play().catch(() => {});
  };

  // ---------- Thước thời gian ----------

  const pct = (ms: number) => `${(ms / durationMs) * 100}%`;
  const visibleSpan = durationMs / zoom;
  const step = TICK_STEPS.find((s) => visibleSpan / s <= 8) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks: number[] = [];
  for (let t = 0; t <= durationMs; t += step) ticks.push(t);

  const tickLabel = (ms: number) => {
    const s = ms / 1000;
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return step < 1000
      ? `${m}:${r.toFixed(1).padStart(4, "0")}`
      : `${m}:${String(Math.round(r)).padStart(2, "0")}`;
  };

  return (
    <section className="card">
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

      <div className="row">
        <button onClick={addAtCurrent}>+ Thêm mốc tại vị trí hiện tại</button>
        <label className="zoom">
          Phóng to thanh thời gian: {zoom}x
          <input
            type="range"
            min={1}
            max={40}
            step={1}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="timeline-scroll" ref={scrollRef}>
        <div
          className="timeline"
          ref={timelineRef}
          style={{ width: `${zoom * 100}%` }}
          onPointerDown={timelineDown}
          onPointerMove={timelineMove}
          onPointerUp={timelineUp}
          onPointerCancel={timelineUp}
        >
          {ticks.map((t) => (
            <div key={t} className="ruler-tick" style={{ left: pct(t) }}>
              {tickLabel(t)}
            </div>
          ))}

          {segments.map((s0) => {
            const s = shown(s0);
            return (
              <div
                key={s.id}
                className={
                  "seg" +
                  (s.viewUrl ? " up" : s.cutPath ? " cut" : "") +
                  (s.id === selectedId ? " sel" : "")
                }
                style={{ left: pct(s.startMs), width: pct(s.endMs - s.startMs) }}
                title={`${s.label}: ${fmt(s.startMs)} → ${fmt(s.endMs)}`}
                onPointerDown={(e) => beginDrag(e, s0, "move")}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <div
                  className="seg-handle l"
                  onPointerDown={(e) => beginDrag(e, s0, "start")}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                />
                <span className="seg-label">{s.label}</span>
                <div
                  className="seg-handle r"
                  onPointerDown={(e) => beginDrag(e, s0, "end")}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                />
              </div>
            );
          })}

          <div className="playhead" style={{ left: pct(current) }} />
        </div>
      </div>

      <p className="note">
        Vị trí hiện tại: {fmt(current)} / {fmt(durationMs)}. Kéo khối để dời đoạn, kéo hai mép để
        đổi điểm đầu/cuối, kéo trên vùng trống để lướt video.
      </p>

      {selShown ? (
        <div className="seg-edit">
          <label htmlFor="seg-label">Tên đoạn</label>
          <input
            id="seg-label"
            value={selShown.label}
            onChange={(e) => onUpdate(selShown.id, { label: e.target.value })}
          />
          <p className="note">
            {fmt(selShown.startMs)} → {fmt(selShown.endMs)} (
            {((selShown.endMs - selShown.startMs) / 1000).toFixed(1)} giây)
          </p>
          <div className="row">
            <button onClick={startFromPlayhead}>Đặt điểm đầu tại vị trí hiện tại</button>
            <button onClick={endFromPlayhead}>Đặt điểm cuối tại vị trí hiện tại</button>
          </div>
          <div className="row">
            <button onClick={playSelection}>▶ Xem thử</button>
            <button onClick={() => onSelect(null)}>Bỏ chọn</button>
            <button onClick={() => onRemove(selShown.id)}>Xóa đoạn</button>
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