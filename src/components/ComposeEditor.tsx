import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as RPE } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  clamp,
  clipLen,
  fadeFactor,
  fmtTime,
  layoutClips,
  musicLen,
  roundProject,
} from "../compose";
import type { Project } from "../compose";

export type Selection = { kind: "v" | "m"; id: string } | null;

type Props = {
  project: Project;
  selection: Selection;
  visible: boolean;
  locked: boolean;
  onSelect: (s: Selection) => void;
  onCommit: (p: Project) => void;
};

type DragMode = "move" | "start" | "end";

type Drag = {
  kind: "v" | "m";
  id: string;
  mode: DragMode;
  originX: number;
  orig: Project;
};

const MIN_MS = 500;
const TAIL_MS = 6000;
const RULER_H = 22;
const V_H = 46;
const GAP = 10;
const LANE_H = 34;
const STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

function clock(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s - m * 60)).padStart(2, "0")}`;
}

// Tính dự án mới từ trạng thái ban đầu và vị trí chuột hiện tại
function applyDrag(orig: Project, d: Drag, clientX: number, pxPerMs: number): Project {
  const dMs = (clientX - d.originX) / pxPerMs;

  if (d.kind === "v") {
    const clips = orig.clips.map((c) => ({ ...c }));
    const idx = clips.findIndex((c) => c.id === d.id);
    if (idx < 0) return orig;
    const c = clips[idx];

    if (d.mode === "move") {
      const { placed } = layoutClips(orig.clips);
      const center = placed[idx].startMs + dMs + clipLen(c) / 2;
      const others = orig.clips.filter((x) => x.id !== d.id);
      let acc = 0;
      let insertAt = 0;
      for (const o of others) {
        if (acc + clipLen(o) / 2 < center) insertAt++;
        acc += clipLen(o);
      }
      const next = [...others];
      next.splice(insertAt, 0, orig.clips[idx]);
      return { ...orig, clips: next };
    }

    if (d.mode === "start") c.inMs = clamp(c.inMs + dMs, 0, c.outMs - MIN_MS);
    else c.outMs = clamp(c.outMs + dMs, c.inMs + MIN_MS, c.sourceDurationMs);
    return { ...orig, clips };
  }

  const music = orig.music.map((m) => ({ ...m }));
  const m = music.find((x) => x.id === d.id);
  if (!m) return orig;
  const { totalMs } = layoutClips(orig.clips);

  if (d.mode === "move") {
    m.startMs = clamp(m.startMs + dMs, 0, Math.max(0, totalMs - MIN_MS));
  } else if (d.mode === "start") {
    // Kéo mép trái: cắt đầu bài nhưng giữ nguyên nhịp, nên dời cả điểm bắt đầu
    const lo = Math.max(-m.inMs, -m.startMs);
    const hi = m.outMs - MIN_MS - m.inMs;
    const dd = clamp(dMs, lo, hi);
    m.inMs += dd;
    m.startMs += dd;
  } else {
    m.outMs = clamp(m.outMs + dMs, m.inMs + MIN_MS, m.fileDurationMs);
  }
  return { ...orig, music };
}

export default function ComposeEditor({
  project,
  selection,
  visible,
  locked,
  onSelect,
  onCommit,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const tlRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const draftRef = useRef<Project | null>(null);
  const scrubbing = useRef(false);

  const [draft, setDraft] = useState<Project | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(24);

  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const activeSrcRef = useRef("");
  const activeClipRef = useRef<string | null>(null);
  const switchingRef = useRef(false);

  const pxPerMs = pxPerSec / 1000;

  // Bản đang hiển thị (có thể là bản nháp khi đang kéo) và bản đã lưu (dùng để phát thử)
  const view = draft ?? project;
  const viewLayout = useMemo(() => layoutClips(view.clips), [view.clips]);
  const layout = useMemo(() => layoutClips(project.clips), [project.clips]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const projectRef = useRef(project);
  projectRef.current = project;

  const lanes = useMemo(() => {
    const sorted = [...view.music].sort((a, b) => a.startMs - b.startMs);
    const ends: number[] = [];
    const lane = new Map<string, number>();
    for (const m of sorted) {
      let i = ends.findIndex((e) => e <= m.startMs);
      if (i < 0) {
        i = ends.length;
        ends.push(0);
      }
      ends[i] = m.startMs + musicLen(m);
      lane.set(m.id, i);
    }
    return { lane, count: Math.max(1, ends.length) };
  }, [view.music]);

  // ---------- Trình phát thử ----------

  const pauseAll = () => {
    videoRef.current?.pause();
    audioRefs.current.forEach((a) => a.pause());
  };

  const loadAt = (t: number, play: boolean) => {
    const v = videoRef.current;
    const L = layoutRef.current;
    if (!v || L.placed.length === 0) return;

    const tt = clamp(t, 0, L.totalMs);
    const hit =
      L.placed.find((pl) => tt >= pl.startMs && tt < pl.startMs + pl.lenMs) ??
      L.placed[L.placed.length - 1];
    const local = hit.clip.inMs + clamp(tt - hit.startMs, 0, hit.lenMs);
    const src = convertFileSrc(hit.clip.source);

    activeClipRef.current = hit.clip.id;
    timeRef.current = tt;
    setTime(tt);

    const apply = () => {
      v.currentTime = local / 1000;
      if (play) v.play().catch(() => {});
      switchingRef.current = false;
    };

    if (activeSrcRef.current !== src) {
      activeSrcRef.current = src;
      switchingRef.current = true;
      v.onloadedmetadata = () => {
        v.onloadedmetadata = null;
        apply();
      };
      v.src = src;
      v.load();
    } else {
      apply();
    }
  };

  const syncAudio = (t: number) => {
    for (const m of projectRef.current.music) {
      const a = audioRefs.current.get(m.id);
      if (!a) continue;
      const pos = t - m.startMs;
      if (pos >= 0 && pos < musicLen(m)) {
        const want = (m.inMs + pos) / 1000;
        a.volume = clamp(m.volume * fadeFactor(m, pos), 0, 1);
        if (a.paused) {
          a.currentTime = want;
          a.play().catch(() => {});
        } else if (Math.abs(a.currentTime - want) > 0.3) {
          a.currentTime = want;
        }
      } else if (!a.paused) {
        a.pause();
      }
    }
  };

  const seekTo = (t: number) => {
    loadAt(t, playingRef.current);
  };

  const togglePlay = () => {
    if (playing) {
      pauseAll();
      setPlaying(false);
      return;
    }
    const L = layoutRef.current;
    if (L.placed.length === 0) return;
    const start = timeRef.current >= L.totalMs - 50 ? 0 : timeRef.current;
    loadAt(start, true);
    setPlaying(true);
  };

  // Vòng lặp theo dõi khi đang phát, đứng yên thì không chạy
  useEffect(() => {
    playingRef.current = playing;
    if (!playing) {
      audioRefs.current.forEach((a) => a.pause());
      return;
    }
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      const L = layoutRef.current;
      if (v && L.placed.length > 0 && !switchingRef.current) {
        const idx = L.placed.findIndex((pl) => pl.clip.id === activeClipRef.current);
        const cur = idx >= 0 ? L.placed[idx] : null;
        if (cur) {
          const vms = v.currentTime * 1000;
          if (vms >= cur.clip.outMs - 30 || v.ended) {
            const next = L.placed[idx + 1];
            if (!next) {
              pauseAll();
              timeRef.current = L.totalMs;
              setTime(L.totalMs);
              setPlaying(false);
              return;
            }
            loadAt(next.startMs, true);
          } else {
            const t = cur.startMs + (vms - cur.clip.inMs);
            timeRef.current = t;
            setTime(t);
            syncAudio(t);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Tải lại khung hình khi danh sách đoạn video thay đổi
  const clipsSig = project.clips
    .map((c) => `${c.id}:${c.source}:${c.inMs}:${c.outMs}`)
    .join("|");
  useEffect(() => {
    if (playingRef.current) {
      pauseAll();
      setPlaying(false);
    }
    const v = videoRef.current;
    if (project.clips.length === 0) {
      if (v) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
      activeSrcRef.current = "";
      activeClipRef.current = null;
      timeRef.current = 0;
      setTime(0);
      return;
    }
    loadAt(timeRef.current, false);
  }, [clipsSig]);

  // Âm lượng tiếng game (phát thử tối đa 100%)
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = clamp(project.originalVolume, 0, 1);
  }, [project.originalVolume]);

  // Tạm dừng khi chuyển sang tab khác
  useEffect(() => {
    if (!visible && playingRef.current) {
      pauseAll();
      setPlaying(false);
    }
  }, [visible]);

  // Cuộn thanh thời gian theo con trỏ khi đang phát
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !playing) return;
    const x = time * pxPerMs;
    if (x < sc.scrollLeft + 10 || x > sc.scrollLeft + sc.clientWidth - 30) {
      sc.scrollLeft = Math.max(0, x - 40);
    }
  }, [time, playing, pxPerMs]);

  // ---------- Tua trên thanh thời gian ----------

  const timeFromX = (clientX: number) => {
    const el = tlRef.current;
    if (!el) return 0;
    return (clientX - el.getBoundingClientRect().left) / pxPerMs;
  };

  const bgDown = (e: RPE<HTMLDivElement>) => {
    if (e.button !== 0) return;
    scrubbing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekTo(timeFromX(e.clientX));
  };

  const bgMove = (e: RPE<HTMLDivElement>) => {
    if (scrubbing.current) seekTo(timeFromX(e.clientX));
  };

  const bgUp = () => {
    scrubbing.current = false;
  };

  // ---------- Kéo khối ----------

  const beginDrag = (e: RPE<HTMLElement>, kind: "v" | "m", id: string, mode: DragMode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect({ kind, id });
    if (locked) return;

    if (playingRef.current) {
      pauseAll();
      setPlaying(false);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { kind, id, mode, originX: e.clientX, orig: project };
    draftRef.current = project;
    setDraft(project);
  };

  const moveDrag = (e: RPE<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const next = applyDrag(d.orig, d, e.clientX, pxPerMs);
    draftRef.current = next;
    setDraft(next);
  };

  // Chỉ lưu khi thả chuột
  const endDrag = () => {
    const d = dragRef.current;
    const last = draftRef.current;
    dragRef.current = null;
    draftRef.current = null;
    setDraft(null);
    if (!d || !last) return;
    if (JSON.stringify(last) !== JSON.stringify(d.orig)) onCommit(roundProject(last));
  };

  // ---------- Hiển thị ----------

  const fit = () => {
    const w = scrollRef.current?.clientWidth ?? 600;
    const total = Math.max(1000, viewLayout.totalMs + TAIL_MS);
    setPxPerSec(clamp((w - 6) / (total / 1000), 4, 200));
  };

  const musicTop = RULER_H + V_H + GAP;
  const musicH = lanes.count * LANE_H + 6;
  const timelineH = musicTop + musicH + 6;
  const widthPx = Math.max(300, (viewLayout.totalMs + TAIL_MS) * pxPerMs);

  const stepS = STEPS_S.find((s) => s * pxPerSec >= 70) ?? 600;
  const ticks: number[] = [];
  for (let s = 0; s * 1000 <= viewLayout.totalMs + TAIL_MS; s += stepS) ticks.push(s);

  const isSel = (kind: "v" | "m", id: string) =>
    selection?.kind === kind && selection.id === id;

  return (
    <section className="card">
      <video ref={videoRef} className="preview" playsInline />
      {project.music.map((m) => (
        <audio
          key={m.id}
          src={convertFileSrc(m.file)}
          preload="auto"
          ref={(el) => {
            if (el) audioRefs.current.set(m.id, el);
            else audioRefs.current.delete(m.id);
          }}
        />
      ))}

      <div className="row">
        <button onClick={togglePlay} disabled={project.clips.length === 0}>
          {playing ? "⏸ Tạm dừng" : "▶ Phát thử"}
        </button>
        <span className="note">
          {fmtTime(time)} / {fmtTime(viewLayout.totalMs)}
        </span>
      </div>

      <div className="row">
        <label className="zoom">
          Phóng to thanh thời gian: {Math.round(pxPerSec)} px/giây
          <input
            type="range"
            min={4}
            max={200}
            step={1}
            value={Math.round(pxPerSec)}
            onChange={(e) => setPxPerSec(Number(e.target.value))}
          />
        </label>
        <button onClick={fit}>Vừa khung</button>
      </div>

      <div className="ct-wrap">
        <div className="ct-labels">
          <div style={{ height: RULER_H }} />
          <div className="ct-label" style={{ height: V_H, marginBottom: GAP }}>
            Video
          </div>
          <div className="ct-label" style={{ height: musicH }}>
            Nhạc
          </div>
        </div>

        <div className="ct-scroll" ref={scrollRef}>
          <div
            className="ct-timeline"
            ref={tlRef}
            style={{ width: widthPx, height: timelineH }}
            onPointerDown={bgDown}
            onPointerMove={bgMove}
            onPointerUp={bgUp}
            onPointerCancel={bgUp}
          >
            {ticks.map((s) => (
              <div key={s} className="ct-tick" style={{ left: s * 1000 * pxPerMs }}>
                {clock(s)}
              </div>
            ))}

            {viewLayout.placed.map((pl) => (
              <div
                key={pl.clip.id}
                className={"ct-block v" + (isSel("v", pl.clip.id) ? " sel" : "")}
                style={{
                  left: pl.startMs * pxPerMs,
                  width: Math.max(14, pl.lenMs * pxPerMs),
                  top: RULER_H,
                  height: V_H,
                }}
                title={`${pl.clip.label} (${(pl.lenMs / 1000).toFixed(1)} giây)`}
                onPointerDown={(e) => beginDrag(e, "v", pl.clip.id, "move")}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <div
                  className="ct-handle l"
                  onPointerDown={(e) => beginDrag(e, "v", pl.clip.id, "start")}
                />
                <span className="ct-block-text">{pl.clip.label}</span>
                <div
                  className="ct-handle r"
                  onPointerDown={(e) => beginDrag(e, "v", pl.clip.id, "end")}
                />
              </div>
            ))}

            {view.music.map((m) => (
              <div
                key={m.id}
                className={"ct-block m" + (isSel("m", m.id) ? " sel" : "")}
                style={{
                  left: m.startMs * pxPerMs,
                  width: Math.max(14, musicLen(m) * pxPerMs),
                  top: musicTop + (lanes.lane.get(m.id) ?? 0) * LANE_H,
                  height: LANE_H - 4,
                }}
                title={`${m.label} (${(musicLen(m) / 1000).toFixed(1)} giây)`}
                onPointerDown={(e) => beginDrag(e, "m", m.id, "move")}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <div
                  className="ct-handle l"
                  onPointerDown={(e) => beginDrag(e, "m", m.id, "start")}
                />
                <span className="ct-block-text">♪ {m.label}</span>
                <div
                  className="ct-handle r"
                  onPointerDown={(e) => beginDrag(e, "m", m.id, "end")}
                />
              </div>
            ))}

            <div className="playhead" style={{ left: time * pxPerMs }} />
          </div>
        </div>
      </div>

      <p className="note">
        Kéo khối để dời, kéo hai mép để cắt bớt. Kéo trên vùng trống để tua. Nhạc dài hơn video sẽ
        bị cắt ở cuối video khi xuất.
      </p>
    </section>
  );
}