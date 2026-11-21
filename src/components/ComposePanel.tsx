import { useEffect, useRef, useState } from "react";
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ComposeEditor from "./ComposeEditor";
import type { Selection } from "./ComposeEditor";
import UploadPanel from "./UploadPanel";
import VideoPreview from "./VideoPreview";
import ProgressBar from "./ProgressBar";
import { loadLibrary } from "../library";
import type { Library } from "../library";
import {
  buildComposeArgs,
  fmtTime,
  layoutClips,
  loadProjects,
  makeMClip,
  makeVClip,
  saveProjects,
  uid,
} from "../compose";
import type { Project } from "../compose";

type Props = {
  visible: boolean;
  onBusyChange: (busy: boolean) => void;
};

function baseName(p: string) {
  return p.split(/[\\/]/).pop() ?? p;
}

function stripExt(n: string) {
  return n.replace(/\.[^.]+$/, "");
}

export default function ComposePanel({ visible, onBusyChange }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const projectsRef = useRef<Project[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [library, setLibrary] = useState<Library>({});
  const [exporting, setExporting] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [progressMs, setProgressMs] = useState(0);
  const [exportVersion, setExportVersion] = useState(0);
  const [message, setMessage] = useState("");

  const project = projects.find((p) => p.id === currentId) ?? null;
  const busy = exporting || uploadBusy;
  const totalMs = project ? layoutClips(project.clips).totalMs : 0;

  useEffect(() => {
    loadProjects().then((list) => {
      projectsRef.current = list;
      setProjects(list);
      if (list.length > 0) setCurrentId(list[0].id);
    });
  }, []);

  useEffect(() => {
    onBusyChange(busy);
  }, [busy]);

  // Đọc lại thư viện clip mỗi khi mở tab này, để thấy các đoạn mới đánh dấu
  useEffect(() => {
    if (visible) loadLibrary().then(setLibrary);
  }, [visible]);

  useEffect(() => {
    const unlisten = listen<number>("compose-progress", (e) => setProgressMs(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // ---------- Lưu dự án ----------

  const commit = (list: Project[]) => {
    projectsRef.current = list;
    setProjects(list);
    saveProjects(list).catch(() => {});
  };

  const updateProject = (id: string, fn: (p: Project) => Project) => {
    commit(projectsRef.current.map((p) => (p.id === id ? fn(p) : p)));
  };

  const newProject = () => {
    const p: Project = {
      id: uid(),
      name: `Dựng phim ${projectsRef.current.length + 1}`,
      clips: [],
      music: [],
      originalVolume: 1,
      quality: "fast",
      createdAt: Date.now(),
    };
    commit([...projectsRef.current, p]);
    setCurrentId(p.id);
    setSelection(null);
    setMessage("");
  };

  const deleteProject = async () => {
    if (!project) return;
    const ok = await ask(
      `Xóa dự án "${project.name}"? Các file video, nhạc và file đã xuất trên máy không bị xóa.`,
      { title: "Xóa dự án", kind: "warning", okLabel: "Xóa", cancelLabel: "Hủy" }
    );
    if (!ok) return;
    const rest = projectsRef.current.filter((p) => p.id !== project.id);
    commit(rest);
    setCurrentId(rest[0]?.id ?? null);
    setSelection(null);
  };

  // ---------- Thêm đoạn và nhạc ----------

  const addClip = async (source: string, label: string, inMs?: number, outMs?: number) => {
    if (!project) {
      setMessage("Hãy tạo hoặc chọn một dự án trước.");
      return;
    }
    const id = project.id;
    try {
      const clip = await makeVClip(source, label, inMs, outMs);
      updateProject(id, (p) => ({ ...p, clips: [...p.clips, clip] }));
      setSelection({ kind: "v", id: clip.id });
      setMessage("");
    } catch (e) {
      setMessage("Lỗi: " + e);
    }
  };

  const addVideoFile = async () => {
    const f = await open({
      multiple: false,
      filters: [{ name: "Video MP4", extensions: ["mp4"] }],
    });
    if (f) await addClip(f, stripExt(baseName(f)));
  };

  const addMusic = async () => {
    if (!project) {
      setMessage("Hãy tạo hoặc chọn một dự án trước.");
      return;
    }
    const f = await open({
      multiple: false,
      filters: [{ name: "Nhạc", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac"] }],
    });
    if (!f) return;
    const id = project.id;
    try {
      const total = layoutClips(
        projectsRef.current.find((p) => p.id === id)?.clips ?? []
      ).totalMs;
      const m = await makeMClip(f, stripExt(baseName(f)), total);
      updateProject(id, (p) => ({ ...p, music: [...p.music, m] }));
      setSelection({ kind: "m", id: m.id });
      setMessage("");
    } catch (e) {
      setMessage("Lỗi: " + e);
    }
  };

  // ---------- Chỉnh khối đang chọn ----------

  const selClip =
    project && selection?.kind === "v"
      ? project.clips.find((c) => c.id === selection.id)
      : undefined;
  const selMusic =
    project && selection?.kind === "m"
      ? project.music.find((m) => m.id === selection.id)
      : undefined;

  const moveClip = (dir: -1 | 1) => {
    if (!project || !selClip) return;
    updateProject(project.id, (p) => {
      const i = p.clips.findIndex((c) => c.id === selClip.id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.clips.length) return p;
      const clips = [...p.clips];
      [clips[i], clips[j]] = [clips[j], clips[i]];
      return { ...p, clips };
    });
  };

  const removeSelected = () => {
    if (!project || !selection) return;
    updateProject(project.id, (p) =>
      selection.kind === "v"
        ? { ...p, clips: p.clips.filter((c) => c.id !== selection.id) }
        : { ...p, music: p.music.filter((m) => m.id !== selection.id) }
    );
    setSelection(null);
  };

  const patchMusic = (patch: Partial<NonNullable<typeof selMusic>>) => {
    if (!project || !selMusic) return;
    updateProject(project.id, (p) => ({
      ...p,
      music: p.music.map((m) => (m.id === selMusic.id ? { ...m, ...patch } : m)),
    }));
  };

  const patchClipLabel = (label: string) => {
    if (!project || !selClip) return;
    updateProject(project.id, (p) => ({
      ...p,
      clips: p.clips.map((c) => (c.id === selClip.id ? { ...c, label } : c)),
    }));
  };

  // ---------- Xuất ----------

  const exportProject = async () => {
    if (!project || project.clips.length === 0) return;

    if (await invoke<boolean>("is_game_running")) {
      const settings = await invoke<{ pause_while_game: boolean }>("get_settings");
      if (settings.pause_while_game) {
        setMessage("Đang chọn nơi lưu trước khi thêm vào hàng đợi...");
      }
    }

    const safeName = project.name.replace(/[\\/:*?"<>|]/g, "_");
    const chosen = await save({
      defaultPath: project.outputPath ?? `${safeName}.mp4`,
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    });
    if (!chosen) return;

    const lower = chosen.toLowerCase();
    if (
      project.clips.some((c) => c.source.toLowerCase() === lower) ||
      project.music.some((m) => m.file.toLowerCase() === lower)
    ) {
      setMessage("Lỗi: file đầu ra trùng với một file nguồn, hãy chọn tên khác.");
      return;
    }

    const existedBefore = await invoke<boolean>("path_exists", { path: chosen });

    const gameRunning = await invoke<boolean>("is_game_running");
    const settings = await invoke<{ pause_while_game: boolean }>("get_settings");
    if (gameRunning && settings.pause_while_game) {
      await invoke("add_queue_job", {
        kind: "compose",
        payload: {
          args: buildComposeArgs(project, chosen),
          outputPath: chosen,
          projectId: project.id,
        },
      });
      setMessage("Đã thêm tác vụ dựng phim vào hàng đợi.");
      return;
    }

    setExporting(true);
    setProgressMs(0);
    setMessage("Đang dựng phim...");

    try {
      await invoke("run_ffmpeg", { args: buildComposeArgs(project, chosen) });
      updateProject(project.id, (p) => ({ ...p, outputPath: chosen }));
      setExportVersion((v) => v + 1);
      setMessage("Đã dựng xong: " + chosen);
    } catch (e) {
      if (!existedBefore) await invoke("remove_partial", { path: chosen }).catch(() => {});
      setMessage("Lỗi: " + e);
    } finally {
      setExporting(false);
    }
  };

  const deleteRemote = async () => {
    if (!project?.viewUrl) return;
    const ok = await ask(
      "Xóa video này khỏi cloud? Link chia sẻ sẽ ngừng hoạt động. File trên máy bạn không bị xóa.",
      { title: "Xóa khỏi cloud", kind: "warning", okLabel: "Xóa", cancelLabel: "Hủy" }
    );
    if (!ok) return;
    try {
      await invoke("delete_video", { viewUrl: project.viewUrl });
      updateProject(project.id, (p) => ({ ...p, viewUrl: undefined, uploadedAt: undefined }));
      setMessage("Đã xóa video khỏi cloud.");
    } catch (e) {
      setMessage("Lỗi: " + e);
    }
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Đã sao chép link.");
    } catch {
      setMessage("Không sao chép tự động được. Link: " + url);
    }
  };

  const sources = Object.values(library)
    .filter((rec) => rec.mp4Path)
    .map((rec) => ({
      mp4: rec.mp4Path!,
      name: baseName(rec.mp4Path!),
      segments: rec.segments ?? [],
    }));

  const percent = totalMs > 0 ? (progressMs / totalMs) * 100 : 0;

  return (
    <div className="layout">
      {/* Cột trái: dự án và nguồn clip */}
      <aside className="col">
        <section className="card">
          <p className="note">Dự án dựng phim</p>
          <select
            value={currentId ?? ""}
            disabled={busy}
            onChange={(e) => {
              setCurrentId(e.target.value || null);
              setSelection(null);
              setMessage("");
            }}
          >
            {projects.length === 0 && <option value="">(chưa có dự án)</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div className="row">
            <button onClick={newProject} disabled={busy}>
              + Dự án mới
            </button>
            <button onClick={deleteProject} disabled={busy || !project}>
              Xóa dự án
            </button>
          </div>
        </section>

        <section className="card">
          <p className="note">Thêm đoạn video vào dòng thời gian</p>
          {sources.length === 0 && (
            <p className="note">
              Chưa có clip nào được chuyển MP4. Hãy chuyển clip ở tab Cắt clip, hoặc thêm file MP4 bên dưới.
            </p>
          )}
          {sources.map((s) => (
            <div className="src" key={s.mp4}>
              <div className="clip-name">{s.name}</div>
              <div className="src-actions">
                <button disabled={busy || !project} onClick={() => addClip(s.mp4, stripExt(s.name))}>
                  + Cả clip
                </button>
                {s.segments.map((seg) => (
                  <button
                    key={seg.id}
                    disabled={busy || !project}
                    onClick={() =>
                      addClip(s.mp4, `${stripExt(s.name)} · ${seg.label}`, seg.startMs, seg.endMs)
                    }
                  >
                    + {seg.label} ({((seg.endMs - seg.startMs) / 1000).toFixed(0)}s)
                  </button>
                ))}
              </div>
            </div>
          ))}
          <button onClick={addVideoFile} disabled={busy || !project}>
            Thêm file MP4 khác...
          </button>
        </section>

        <section className="card">
          <p className="note">Nhạc nền</p>
          <button onClick={addMusic} disabled={busy || !project}>
            + Thêm nhạc từ máy...
          </button>
          <p className="note">Hỗ trợ mp3, wav, m4a, aac, ogg, flac.</p>
        </section>
      </aside>

      {/* Cột giữa: trình phát và thanh thời gian */}
      <section className="col">
        {project ? (
          <ComposeEditor
            key={project.id}
            project={project}
            selection={selection}
            visible={visible}
            locked={busy}
            onSelect={setSelection}
            onCommit={(p) => updateProject(project.id, () => p)}
          />
        ) : (
          <p className="note">Bấm "+ Dự án mới" ở cột bên trái để bắt đầu dựng phim.</p>
        )}
      </section>

      {/* Cột phải: thuộc tính, xuất, upload */}
      <aside className="col">
        {project && (
          <>
            <section className="card">
              <label htmlFor="pname">Tên dự án</label>
              <input
                id="pname"
                value={project.name}
                disabled={busy}
                onChange={(e) => updateProject(project.id, (p) => ({ ...p, name: e.target.value }))}
              />
              <label htmlFor="ovol">
                Âm lượng tiếng game: {Math.round(project.originalVolume * 100)}%
              </label>
              <input
                id="ovol"
                type="range"
                min={0}
                max={200}
                step={5}
                value={Math.round(project.originalVolume * 100)}
                disabled={busy}
                onChange={(e) =>
                  updateProject(project.id, (p) => ({
                    ...p,
                    originalVolume: Number(e.target.value) / 100,
                  }))
                }
              />
              <p className="note">
                {project.clips.length} đoạn video, {project.music.length} bài nhạc, tổng{" "}
                {fmtTime(totalMs)}
              </p>
            </section>

            {selClip && (
              <section className="card">
                <p className="note">Đoạn video đã chọn</p>
                <label htmlFor="clabel">Tên</label>
                <input
                  id="clabel"
                  value={selClip.label}
                  disabled={busy}
                  onChange={(e) => patchClipLabel(e.target.value)}
                />
                <p className="note">
                  Lấy từ {fmtTime(selClip.inMs)} đến {fmtTime(selClip.outMs)} (
                  {((selClip.outMs - selClip.inMs) / 1000).toFixed(1)} giây)
                </p>
                <div className="row">
                  <button disabled={busy} onClick={() => moveClip(-1)}>
                    ◀ Dời trước
                  </button>
                  <button disabled={busy} onClick={() => moveClip(1)}>
                    Dời sau ▶
                  </button>
                </div>
                <button disabled={busy} onClick={removeSelected}>
                  Xóa đoạn khỏi dự án
                </button>
              </section>
            )}

            {selMusic && (
              <section className="card">
                <p className="note">Bài nhạc đã chọn</p>
                <label htmlFor="mlabel">Tên</label>
                <input
                  id="mlabel"
                  value={selMusic.label}
                  disabled={busy}
                  onChange={(e) => patchMusic({ label: e.target.value })}
                />
                <label htmlFor="mvol">Âm lượng: {Math.round(selMusic.volume * 100)}%</label>
                <input
                  id="mvol"
                  type="range"
                  min={0}
                  max={200}
                  step={5}
                  value={Math.round(selMusic.volume * 100)}
                  disabled={busy}
                  onChange={(e) => patchMusic({ volume: Number(e.target.value) / 100 })}
                />
                <label htmlFor="mfi">Mờ dần vào: {(selMusic.fadeInMs / 1000).toFixed(1)} giây</label>
                <input
                  id="mfi"
                  type="range"
                  min={0}
                  max={10000}
                  step={100}
                  value={selMusic.fadeInMs}
                  disabled={busy}
                  onChange={(e) => patchMusic({ fadeInMs: Number(e.target.value) })}
                />
                <label htmlFor="mfo">Mờ dần ra: {(selMusic.fadeOutMs / 1000).toFixed(1)} giây</label>
                <input
                  id="mfo"
                  type="range"
                  min={0}
                  max={10000}
                  step={100}
                  value={selMusic.fadeOutMs}
                  disabled={busy}
                  onChange={(e) => patchMusic({ fadeOutMs: Number(e.target.value) })}
                />
                <p className="note">
                  Bắt đầu tại {fmtTime(selMusic.startMs)}, dùng đoạn {fmtTime(selMusic.inMs)} đến{" "}
                  {fmtTime(selMusic.outMs)} của bài.
                </p>
                <button disabled={busy} onClick={removeSelected}>
                  Xóa bài nhạc khỏi dự án
                </button>
              </section>
            )}

            <section className="card">
              <label htmlFor="quality">Chất lượng xuất</label>
              <select
                id="quality"
                value={project.quality}
                disabled={busy}
                onChange={(e) =>
                  updateProject(project.id, (p) => ({
                    ...p,
                    quality: e.target.value as Project["quality"],
                  }))
                }
              >
                <option value="fast">Nhanh (file lớn hơn, ít tốn CPU hơn)</option>
                <option value="good">Đẹp (file nhỏ hơn, chậm và tốn CPU hơn)</option>
              </select>
              <div className="row">
                <button onClick={exportProject} disabled={busy || project.clips.length === 0}>
                  Xuất video
                </button>
                {exporting && <button onClick={() => invoke("cancel_ffmpeg")}>Hủy</button>}
              </div>
              {exporting && <ProgressBar percent={percent} />}
            </section>
          </>
        )}

        {message && <p className="note">{message}</p>}

        {project?.outputPath && !exporting && (
          <>
            <VideoPreview
              key={project.outputPath + exportVersion}
              path={project.outputPath}
              label="Bản đã dựng (bản này sẽ được upload)"
            />
            <p className="note">File: {project.outputPath}</p>
            <UploadPanel
              key={project.outputPath + ":" + exportVersion}
              outputPath={project.outputPath}
              suggestedName={project.name}
              onBusyChange={setUploadBusy}
              onUploaded={(url) =>
                updateProject(project.id, (p) => ({
                  ...p,
                  viewUrl: url,
                  uploadedAt: Date.now(),
                }))
              }
            />
            {project.viewUrl && (
              <section className="card">
                <p className="note">Link hiện tại của dự án</p>
                <input readOnly value={project.viewUrl} onFocus={(e) => e.currentTarget.select()} />
                <div className="row">
                  <button onClick={() => copyLink(project.viewUrl!)}>Sao chép link</button>
                  <button disabled={busy} onClick={deleteRemote}>
                    Xóa khỏi cloud
                  </button>
                </div>
              </section>
            )}
          </>
        )}
      </aside>
    </div>
  );
}