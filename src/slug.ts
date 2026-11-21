// Đổi chuỗi bất kỳ (có dấu tiếng Việt) thành dạng dùng được trong link
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function randomSuffix(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

// Trả về chuỗi rỗng nếu Worker nên tự sinh mã ngẫu nhiên
export function buildSlug(name: string, addRandom: boolean): string {
  const base = slugify(name);
  if (!base) return "";
  let slug = addRandom ? `${base}-${randomSuffix(4)}` : base;
  if (slug.length < 6) slug = `${slug}-${randomSuffix(4)}`;
  return slug;
}