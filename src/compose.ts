import { invoke } from "@tauri-apps/api/core";

export type VClip = {
  id: string;
  label: string;
  source: string; // đường dẫn file MP4
  inMs: number;
  outMs: number;
  sourceDurationMs: number;
  width: number;
  height: number;
  fps: string;
  hasAudio: boolean;
};

export type MClip = {
  id: string;
  label: string;
  file: string;
  startMs: number; // vị trí bắt đầu trên dòng thời gian của dự án
  inMs: number; // đoạn dùng trong file nhạc
  outMs: number;
  fileDurationMs: number;
  volume: number; // 1 = 100%
  fadeInMs: number;
  fadeOutMs: number;
};

export type Project = {
  id: string;
  name: string;
  clips: VClip[];
  music: MClip[];
  originalVolume: number; // âm lượng tiếng game, 1 = 100%
  quality: "fast" | "good";
  outputPath?: string;
  viewUrl?: string;
  uploadedAt?: number;
  createdAt: number;
};

export type Placed = { clip: VClip; startMs: number; lenMs: number };

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export const clipLen = (c: VClip) => c.outMs - c.inMs;
export const musicLen = (m: MClip) => m.outMs - m.inMs;

export function layoutClips(clips: VClip[]) {
  let acc = 0;
  const placed: Placed[] = clips.map((clip) => {
    const lenMs = clipLen(clip);
    const p = { clip, startMs: acc, lenMs };
    acc += lenMs;
    return p;
  });
  return { placed, totalMs: acc };
}

export function fmtTime(ms: number) {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

export function roundProject(p: Project): Project {
  return {
    ...p,
    clips: p.clips.map((c) => ({
      ...c,
      inMs: Math.round(c.inMs),
      outMs: Math.round(c.outMs),
    })),
    music: p.music.map((m) => ({
      ...m,
      startMs: Math.round(m.startMs),
      inMs: Math.round(m.inMs),
      outMs: Math.round(m.outMs),
    })),
  };
}

// Hệ số mờ dần (0 đến 1) tại vị trí posMs bên trong khối nhạc, dùng cho phát thử
export function fadeFactor(m: MClip, posMs: number) {
  const len = musicLen(m);
  let f = 1;
  if (m.fadeInMs > 0 && posMs < m.fadeInMs) f = Math.min(f, posMs / m.fadeInMs);
  if (m.fadeOutMs > 0 && posMs > len - m.fadeOutMs) f = Math.min(f, (len - posMs) / m.fadeOutMs);
  return Math.max(0, f);
}

// ---------- Lưu và đọc dự án ----------

export async function loadProjects(): Promise<Project[]> {
  try {
    const data = JSON.parse(await invoke<string>("load_projects"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function saveProjects(list: Project[]): Promise<void> {
  await invoke("save_projects", { json: JSON.stringify(list) });
}

// ---------- Đọc thông tin file để tạo khối ----------

export async function makeVClip(
  source: string,
  label: string,
  inMs?: number,
  outMs?: number
): Promise<VClip> {
  const exists = await invoke<boolean>("path_exists", { path: source });
  if (!exists) throw new Error("Không tìm thấy file: " + source);

  const data = JSON.parse(await invoke<string>("probe_video", { path: source }));
  const video = data.streams?.find((s: any) => s.codec_type === "video");
  const audio = data.streams?.find((s: any) => s.codec_type === "audio");
  if (!video) throw new Error("File này không có hình.");

  const dur = Number(data.format?.duration) * 1000;
  if (!isFinite(dur) || dur <= 0) throw new Error("Không đọc được thời lượng video.");

  let fps: string | undefined = video.r_frame_rate;
  if (!fps || fps.startsWith("0/")) fps = video.avg_frame_rate;
  if (!fps || fps.startsWith("0/")) fps = "60";

  const start = clamp(inMs ?? 0, 0, dur);
  const end = clamp(outMs ?? dur, start + 100, dur);

  return {
    id: uid(),
    label,
    source,
    inMs: start,
    outMs: end,
    sourceDurationMs: dur,
    width: video.width,
    height: video.height,
    fps,
    hasAudio: !!audio,
  };
}

export async function makeMClip(file: string, label: string, totalMs: number): Promise<MClip> {
  const data = JSON.parse(await invoke<string>("probe_video", { path: file }));
  const dur = Number(data.format?.duration) * 1000;
  if (!isFinite(dur) || dur <= 0) throw new Error("Không đọc được thời lượng file nhạc.");
  if (!data.streams?.some((s: any) => s.codec_type === "audio")) {
    throw new Error("File này không có âm thanh.");
  }

  return {
    id: uid(),
    label,
    file,
    startMs: 0,
    inMs: 0,
    outMs: totalMs > 0 ? Math.min(dur, totalMs) : dur,
    fileDurationMs: dur,
    volume: 0.5,
    fadeInMs: 500,
    fadeOutMs: 1500,
  };
}

// ---------- Dựng lệnh FFmpeg ----------

const sec = (ms: number) => (ms / 1000).toFixed(3);

export function buildComposeArgs(p: Project, output: string): string[] {
  const { totalMs } = layoutClips(p.clips);
  const first = p.clips[0];
  const W = first.width - (first.width % 2);
  const H = first.height - (first.height % 2);
  const fps = first.fps;
  const n = p.clips.length;

  const args: string[] = ["-y"];
  p.clips.forEach((c) => {
    args.push("-ss", sec(c.inMs), "-t", sec(clipLen(c)), "-i", c.source);
  });
  p.music.forEach((m) => {
    args.push("-ss", sec(m.inMs), "-t", sec(musicLen(m)), "-i", m.file);
  });

  const stereo = "aformat=sample_fmts=fltp:channel_layouts=stereo";
  const f: string[] = [];

  p.clips.forEach((c, i) => {
    const dur = sec(clipLen(c));
    f.push(
      `[${i}:v]fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,trim=duration=${dur},` +
        `setpts=PTS-STARTPTS,format=yuv420p[v${i}]`
    );
    if (c.hasAudio) {
      f.push(
        `[${i}:a:0]aresample=48000,${stereo},apad,atrim=0:${dur},asetpts=PTS-STARTPTS[a${i}]`
      );
    } else {
      f.push(`anullsrc=r=48000:cl=stereo,${stereo},atrim=0:${dur},asetpts=PTS-STARTPTS[a${i}]`);
    }
  });

  const joined = p.clips.map((_, i) => `[v${i}][a${i}]`).join("");
  f.push(`${joined}concat=n=${n}:v=1:a=1[vout][acat]`);
  f.push(`[acat]volume=${p.originalVolume.toFixed(2)}[aorig]`);

  p.music.forEach((m, j) => {
    const idx = n + j;
    const len = musicLen(m);
    const fi = Math.min(m.fadeInMs, len);
    const fo = Math.min(m.fadeOutMs, Math.max(0, len - fi));
    const chain = [
      `[${idx}:a:0]aresample=48000`,
      stereo,
      `atrim=0:${sec(len)}`,
      "asetpts=PTS-STARTPTS",
      `volume=${m.volume.toFixed(2)}`,
    ];
    if (fi > 0) chain.push(`afade=t=in:st=0:d=${sec(fi)}`);
    if (fo > 0) chain.push(`afade=t=out:st=${sec(len - fo)}:d=${sec(fo)}`);
    const delay = Math.round(m.startMs);
    if (delay > 0) chain.push(`adelay=${delay}|${delay}`);
    f.push(`${chain.join(",")}[m${j}]`);
  });

  if (p.music.length > 0) {
    const inputs = ["[aorig]", ...p.music.map((_, j) => `[m${j}]`)].join("");
    f.push(
      `${inputs}amix=inputs=${p.music.length + 1}:duration=first:dropout_transition=0:normalize=0,` +
        `alimiter=limit=0.95[aout]`
    );
  } else {
    f.push("[aorig]alimiter=limit=0.95[aout]");
  }

  const quality =
    p.quality === "good"
      ? ["-preset", "medium", "-crf", "18"]
      : ["-preset", "veryfast", "-crf", "22"];

  args.push(
    "-filter_complex", f.join(";"),
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264",
    ...quality,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-t", sec(totalMs),
    "-movflags", "+faststart",
    output
  );
  return args;
}