import { invoke } from "@tauri-apps/api/core";

export type Segment = {
  id: string;
  no: number; // số thứ tự cố định, dùng để đặt tên file
  label: string;
  startMs: number;
  endMs: number;
  cutPath?: string;
  viewUrl?: string;
  uploadedAt?: number;
};

export type ClipRecord = {
  mp4Path?: string;
  viewUrl?: string;
  uploadedAt?: number;
  convertedAt?: number;
  mkvDeleted?: boolean;
  segments?: Segment[];
  nextSegmentNo?: number;
};

// Khóa là đường dẫn file MKV gốc
export type Library = Record<string, ClipRecord>;

export async function loadLibrary(): Promise<Library> {
  try {
    return JSON.parse(await invoke<string>("load_library"));
  } catch {
    return {};
  }
}

export async function saveLibrary(lib: Library): Promise<void> {
  await invoke("save_library", { json: JSON.stringify(lib) });
}