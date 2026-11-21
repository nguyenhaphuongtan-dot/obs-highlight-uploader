# Tauri + Vanilla TS

## Cấu trúc dự án

```text
src/                 Giao diện React của app desktop
src-tauri/           Mã Rust và cấu hình Tauri
backend/             Cloudflare Worker xử lý upload Backblaze
dist/                Build frontend (sinh tự động)
src-tauri/target/    Build Rust (sinh tự động)
src-tauri/binaries/  FFmpeg/FFprobe dành cho app
```

## Chạy dự án

```powershell
npm install
npm run tauri:dev
```

## Build app desktop

```powershell
npm run tauri:build
```

## Chạy hoặc deploy Worker

```powershell
cd backend
npm install
npm run dev
npm run deploy
```

## Cloud Worker

Địa chỉ Worker mặc định cho bản hiện tại:

`https://nghapiti-highlight.hl-clips.workers.dev`

Trang thư viện clip:

`https://nghapiti-highlight.hl-clips.workers.dev/library`

This template should help get you started developing with Tauri in vanilla HTML, CSS and Typescript.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
