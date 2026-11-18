import { AwsClient } from "aws4fetch";

interface Env {
  B2_ENDPOINT_HOST: string;
  B2_REGION: string;
  BUCKET_NAME: string;
  B2_KEY_ID: string;
  B2_APP_KEY: string;
  API_TOKEN: string;
}

const ID_PATTERN = /^[a-z0-9]{6,32}$/;

function newId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function makeClient(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APP_KEY,
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

  const id = newId();
  const key = `videos/${id}.mp4`;

  const signed = await makeClient(env).sign(
    new Request(objectUrl(env, key, 3600), {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
    }),
    { aws: { signQuery: true } }
  );

  const origin = new URL(request.url).origin;
  return Response.json({
    id,
    uploadUrl: signed.url,
    viewUrl: `${origin}/v/${id}`,
  });
}

// Chuyển hướng tới link tải tạm của B2; trình duyệt tự xử lý tua video
async function serveMedia(env: Env, id: string): Promise<Response> {
  if (!ID_PATTERN.test(id)) return new Response("Not found", { status: 404 });

  const signed = await makeClient(env).sign(
    new Request(objectUrl(env, `videos/${id}.mp4`, 3600), { method: "GET" }),
    { aws: { signQuery: true } }
  );

  return new Response(null, {
    status: 302,
    headers: { Location: signed.url, "Cache-Control": "no-store" },
  });
}
async function deleteVideo(request: Request, env: Env, id: string): Promise<Response> {
  if (request.headers.get("Authorization") !== `Bearer ${env.API_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!ID_PATTERN.test(id)) return new Response("Bad id", { status: 400 });

  const url = `https://${env.B2_ENDPOINT_HOST}/${env.BUCKET_NAME}/videos/${id}.mp4`;
  const res = await makeClient(env).fetch(url, { method: "DELETE" });

  // 404 nghĩa là file không còn nữa, vẫn coi là đã xóa
  if (!res.ok && res.status !== 404) {
    return new Response(`Backblaze trả về lỗi ${res.status}`, { status: 502 });
  }
  return Response.json({ deleted: true });
}

function viewerPage(id: string): Response {
  if (!ID_PATTERN.test(id)) return new Response("Not found", { status: 404 });

  const html = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Highlight</title>
  <style>
    html, body { margin: 0; height: 100%; background: #111; }
    body { display: flex; align-items: center; justify-content: center; }
    video { max-width: 100%; max-height: 100vh; }
  </style>
</head>
<body>
  <video src="/media/${id}" controls autoplay playsinline></video>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "POST" && pathname === "/api/uploads") {
      return createUpload(request, env);
    }
    if (request.method === "GET" && pathname.startsWith("/media/")) {
      return serveMedia(env, pathname.slice("/media/".length));
    }
    if (request.method === "GET" && pathname.startsWith("/v/")) {
      return viewerPage(pathname.slice("/v/".length));
    }
    if (request.method === "DELETE" && pathname.startsWith("/api/videos/")) {
      return deleteVideo(request, env, pathname.slice("/api/videos/".length));
    }
    return new Response("Not found", { status: 404 });
  },
};