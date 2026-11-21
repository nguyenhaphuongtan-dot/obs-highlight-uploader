import { AwsClient } from "aws4fetch";

interface Env {
  B2_ENDPOINT_HOST: string;
  B2_REGION: string;
  BUCKET_NAME: string;
  B2_KEY_ID: string;
  B2_APP_KEY: string;
  API_TOKEN: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{4,46}[a-z0-9]$/;
const CRAWLER = /bot|crawler|spider|preview|discord|slack|telegram|whatsapp|facebook|twitter/i;

function newId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function makeClient(env: Env): AwsClient {
  const accessKeyId = env.B2_KEY_ID?.trim();
  const secretAccessKey = env.B2_APP_KEY?.trim();
  return new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: env.B2_REGION,
  });
}

// B2 dùng kiểu đường dẫn: https://endpoint/bucket/key
function objectUrl(env: Env, key: string, expires: number): URL {
  const url = new URL(`https://${env.B2_ENDPOINT_HOST}/${env.BUCKET_NAME}/${key}`);
  url.searchParams.set("X-Amz-Expires", String(expires));
  return url;
}

async function createUpload(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Authorization") !== `Bearer ${env.API_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!env.B2_KEY_ID?.trim() || !env.B2_APP_KEY?.trim()) {
    return Response.json(
      { error: "backblaze_credentials_missing" },
      { status: 503 },
    );
  }

  // Tên link do người dùng đặt (tùy chọn)
  let slug = "";
  try {
    const body = (await request.json()) as { slug?: unknown };
    if (typeof body?.slug === "string") slug = body.slug.trim().toLowerCase();
  } catch {
    // Không có nội dung gửi kèm: dùng mã ngẫu nhiên
  }

  let id: string;
  if (slug) {
    if (!ID_PATTERN.test(slug)) {
      return Response.json({ error: "invalid_slug" }, { status: 400 });
    }
    if (await objectExists(env, `videos/${slug}.mp4`)) {
      return Response.json({ error: "taken" }, { status: 409 });
    }
    id = slug;
  } else {
    id = newId();
  }

  const client = makeClient(env);

  const video = await client.sign(
    new Request(objectUrl(env, `videos/${id}.mp4`, 3600), {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
    }),
    { aws: { signQuery: true } }
  );

  const thumb = await client.sign(
    new Request(objectUrl(env, `videos/${id}.jpg`, 3600), {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
    }),
    { aws: { signQuery: true } }
  );

  const origin = new URL(request.url).origin;
  return Response.json({
    id,
    uploadUrl: video.url,
    thumbUploadUrl: thumb.url,
    viewUrl: `${origin}/v/${id}`,
  });
}

// Trả thẳng nội dung file từ Backblaze, có hỗ trợ tua (Range) để bot và trình phát đo được file
async function proxyObject(
  request: Request,
  env: Env,
  key: string,
  contentType: string
): Promise<Response> {
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const signed = await makeClient(env).sign(
    new Request(objectUrl(env, key, 300), { method }),
    { aws: { signQuery: true } }
  );

  const upstreamHeaders = new Headers();
  const range = request.headers.get("Range");
  if (range) upstreamHeaders.set("Range", range);

  const upstream = await fetch(signed.url, { method, headers: upstreamHeaders });
  if (upstream.status === 404) return new Response("Not found", { status: 404 });
  if (upstream.status === 416) return new Response("Range not satisfiable", { status: 416 });
  if (!upstream.ok) return new Response("Upstream error", { status: 502 });

  const out = new Headers({
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=300",
  });
  for (const h of ["Content-Length", "Content-Range", "ETag", "Last-Modified"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: out,
  });
}

async function objectExists(env: Env, key: string): Promise<boolean> {
  try {
    const signed = await makeClient(env).sign(
      new Request(objectUrl(env, key, 60), { method: "GET" }),
      { aws: { signQuery: true } }
    );
    // Chỉ xin 1 byte đầu để biết file có tồn tại hay không
    const res = await fetch(signed.url, { headers: { Range: "bytes=0-0" } });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

type GalleryVideo = {
  id: string;
  size: number;
  modified: string;
  hasThumbnail: boolean;
};

async function listVideos(env: Env): Promise<GalleryVideo[]> {
  if (!env.B2_KEY_ID?.trim() || !env.B2_APP_KEY?.trim()) {
    throw new Error("Backblaze credentials missing");
  }

  const url = new URL(`https://${env.B2_ENDPOINT_HOST}/${env.BUCKET_NAME}`);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("prefix", "videos/");
  url.searchParams.set("max-keys", "1000");

  const signed = await makeClient(env).sign(
    new Request(url, { method: "GET" }),
    { aws: { signQuery: true } }
  );
  const response = await fetch(signed.url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Backblaze returned ${response.status}`);
  }

  const xml = await response.text();
  const objects = new Map<string, { size: number; modified: string }>();
  const keys = new Set<string>();

  for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const content = block[1];
    const key = content.match(/<Key>([\s\S]*?)<\/Key>/)?.[1]?.trim();
    if (!key) continue;
    keys.add(key);

    const size = Number(content.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0);
    const modified = content.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1]?.trim() ?? "";
    const relative = key.startsWith("videos/")
      ? key.slice("videos/".length)
      : key;
    objects.set(relative, { size, modified });
  }

  return Array.from(objects.entries())
    .filter(([name]) => name.endsWith(".mp4"))
    .map(([name, details]) => {
      const id = name.replace(/\.mp4$/i, "");
      return {
        id,
        size: details.size,
        modified: details.modified,
        hasThumbnail: keys.has(`videos/${id}.jpg`),
      };
    })
    .filter((video) => ID_PATTERN.test(video.id))
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

async function deleteVideo(request: Request, env: Env, id: string): Promise<Response> {
  if (request.headers.get("Authorization") !== `Bearer ${env.API_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!ID_PATTERN.test(id)) return new Response("Bad id", { status: 400 });

  const client = makeClient(env);
  const base = `https://${env.B2_ENDPOINT_HOST}/${env.BUCKET_NAME}/videos/${id}`;

  const res = await client.fetch(`${base}.mp4`, { method: "DELETE" });
  // 404 nghĩa là file không còn nữa, vẫn coi là đã xóa
  if (!res.ok && res.status !== 404) {
    return new Response(`Backblaze trả về lỗi ${res.status}`, { status: 502 });
  }

  // Xóa luôn ảnh xem trước (video cũ không có ảnh thì bỏ qua)
  await client.fetch(`${base}.jpg`, { method: "DELETE" }).catch(() => {});
  return Response.json({ deleted: true });
}

async function libraryApi(env: Env): Promise<Response> {
  try {
    const videos = await listVideos(env);
    return Response.json(videos, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return Response.json(
      { error: "gallery_unavailable" },
      { status: 502 }
    );
  }
}

function galleryPage(): Response {
  const html = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Thư viện Highlight</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #17171b; color: #f4f4f5; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 24px; border-bottom: 1px solid #34343b; }
    h1 { margin: 0; font-size: 20px; }
    main { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .toolbar { display: flex; gap: 10px; margin-bottom: 18px; }
    input { width: 100%; padding: 11px 12px; border: 1px solid #3b3b44; border-radius: 8px; background: #232329; color: #fff; font: inherit; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
    .card { overflow: hidden; border: 1px solid #34343b; border-radius: 12px; background: #232329; }
    .thumb { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #111; }
    .body { display: grid; gap: 10px; padding: 12px; }
    .name { font-weight: 700; overflow-wrap: anywhere; }
    .meta { color: #aaaab4; font-size: 13px; }
    .actions { display: flex; gap: 8px; }
    button, .link { flex: 1; border: 0; border-radius: 7px; background: #24c8db; color: #08262b; text-align: center; text-decoration: none; padding: 9px; font: inherit; cursor: pointer; }
    button.secondary { background: #3a3a43; color: #fff; }
    .message { color: #aaaab4; text-align: center; padding: 40px 10px; }
  </style>
</head>
<body>
  <header><h1>Thư viện Highlight</h1><span id="count"></span></header>
  <main>
    <div class="toolbar"><input id="search" type="search" placeholder="Tìm theo tên link..." /></div>
    <div id="grid" class="grid"></div>
    <p id="message" class="message">Đang tải clip...</p>
  </main>
  <script>
    var all = [];
    var grid = document.getElementById("grid");
    var message = document.getElementById("message");
    var count = document.getElementById("count");

    function formatSize(bytes) {
      if (!bytes) return "";
      return (bytes / 1024 / 1024).toFixed(1) + " MB";
    }

    function render() {
      var query = document.getElementById("search").value.toLowerCase().trim();
      var videos = all.filter(function (video) {
        return !query || video.id.toLowerCase().includes(query);
      });
      count.textContent = videos.length + " clip";
      grid.innerHTML = "";
      message.hidden = videos.length > 0;
      videos.forEach(function (video) {
        var card = document.createElement("article");
        card.className = "card";
        var thumb = document.createElement("img");
        thumb.className = "thumb";
        thumb.loading = "lazy";
        thumb.alt = "";
        thumb.src = video.hasThumbnail ? "/thumb/" + encodeURIComponent(video.id) + ".jpg" : "";
        thumb.onerror = function () { thumb.hidden = true; };
        var body = document.createElement("div");
        body.className = "body";
        var name = document.createElement("div");
        name.className = "name";
        name.textContent = video.id;
        var meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = [formatSize(video.size), video.modified ? new Date(video.modified).toLocaleString("vi-VN") : ""].filter(Boolean).join(" · ");
        var actions = document.createElement("div");
        actions.className = "actions";
        var view = document.createElement("a");
        view.className = "link";
        view.href = "/v/" + encodeURIComponent(video.id);
        view.textContent = "Xem";
        var copy = document.createElement("button");
        copy.className = "secondary";
        copy.textContent = "Sao chép link";
        copy.onclick = function () {
          navigator.clipboard.writeText(location.origin + "/v/" + video.id).then(function () {
            copy.textContent = "Đã sao chép";
            setTimeout(function () { copy.textContent = "Sao chép link"; }, 1500);
          });
        };
        actions.append(view, copy);
        body.append(name, meta, actions);
        card.append(thumb, body);
        grid.append(card);
      });
    }

    fetch("/api/videos").then(function (response) {
      if (!response.ok) throw new Error("Không tải được danh sách");
      return response.json();
    }).then(function (videos) {
      all = videos;
      message.hidden = true;
      if (!videos.length) {
        message.hidden = false;
        message.textContent = "Chưa có clip nào được upload.";
      }
      render();
    }).catch(function (error) {
      message.textContent = error.message;
    });

    document.getElementById("search").addEventListener("input", render);
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function viewerPage(request: Request, env: Env, id: string): Promise<Response> {
  if (!ID_PATTERN.test(id)) return new Response("Not found", { status: 404 });

  const origin = new URL(request.url).origin;
  const ua = request.headers.get("User-Agent") ?? "";
  let meta = "";

  // Chỉ bot (Discord, Telegram...) mới cần thẻ xem trước, và chỉ khi video có ảnh xem trước
  if (CRAWLER.test(ua) && (await objectExists(env, `videos/${id}.jpg`))) {
    const page = `${origin}/v/${id}`;
    const video = `${origin}/media/${id}.mp4`;
    const image = `${origin}/thumb/${id}.jpg`;
    meta = `
  <meta property="og:site_name" content="OBS Highlight" />
  <meta property="og:title" content="Highlight Valorant" />
  <meta property="og:type" content="video.other" />
  <meta property="og:url" content="${page}" />
  <meta property="og:image" content="${image}" />
  <meta property="og:video" content="${video}" />
  <meta property="og:video:secure_url" content="${video}" />
  <meta property="og:video:type" content="video/mp4" />
  <meta name="twitter:card" content="player" />
  <meta name="theme-color" content="#24c8db" />`;
  }

  const html = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Highlight</title>${meta}
  <style>
    html, body { margin: 0; height: 100%; background: #111; }
    body { display: flex; align-items: center; justify-content: center; }
    video { max-width: 100%; max-height: 100vh; }
    p { color: #aaa; font-family: system-ui, sans-serif; text-align: center; padding: 0 20px; }
  </style>
</head>
<body>
  <video src="/media/${id}.mp4" controls autoplay playsinline></video>
  <p id="err" hidden>Không tải được video. Video có thể đã bị xóa hoặc mạng đang gặp sự cố.</p>
  <script>
    var v = document.querySelector("video");
    v.addEventListener("error", function () {
      v.hidden = true;
      document.getElementById("err").hidden = false;
    });
  </script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const readOnly = request.method === "GET" || request.method === "HEAD";

    if (request.method === "POST" && pathname === "/api/uploads") {
      return createUpload(request, env);
    }
    if (readOnly && pathname === "/api/videos") {
      return libraryApi(env);
    }
    if (readOnly && pathname === "/library") {
      return galleryPage();
    }
    if (request.method === "DELETE" && pathname.startsWith("/api/videos/")) {
      return deleteVideo(request, env, pathname.slice("/api/videos/".length));
    }
    if (readOnly && pathname.startsWith("/media/")) {
      const id = pathname.slice("/media/".length).replace(/\.mp4$/i, "");
      if (!ID_PATTERN.test(id)) return new Response("Not found", { status: 404 });
      return proxyObject(request, env, `videos/${id}.mp4`, "video/mp4");
    }
    if (readOnly && pathname.startsWith("/thumb/")) {
      const id = pathname.slice("/thumb/".length).replace(/\.jpg$/i, "");
      if (!ID_PATTERN.test(id)) return new Response("Not found", { status: 404 });
      return proxyObject(request, env, `videos/${id}.jpg`, "image/jpeg");
    }
    if (readOnly && pathname.startsWith("/v/")) {
      return viewerPage(request, env, pathname.slice("/v/".length));
    }
    return new Response("Not found", { status: 404 });
  },
};