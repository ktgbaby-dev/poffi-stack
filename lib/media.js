// Product images, stored in Postgres and served with long-lived cache headers.
// The URL contains part of the content hash, so a replaced image always gets a new URL.
import { createHash } from "node:crypto";
import { getDb } from "./db.js";
import { bad, notFound } from "./http.js";

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export const mediaUrl = (id, sha) => `/media/${Number(id)}-${String(sha || "").slice(0, 12)}`;

// Recognise the file by its first bytes, never by the name or the browser's claim.
export function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export function imageSize(buf, mime) {
  try {
    if (mime === "image/png") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === "image/webp") {
      const kind = buf.subarray(12, 16).toString("ascii");
      if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (kind === "VP8L") { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    }
    if (mime === "image/jpeg") {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
  } catch { /* unknown layout */ }
  return { width: null, height: null };
}

export async function saveImage(base64, adminId) {
  if (typeof base64 !== "string" || !base64) throw bad("no_image", "Choose an image to upload.");
  const data = base64.replace(/^data:[^;]+;base64,/, "");
  const buf = Buffer.from(data, "base64");
  if (!buf.length) throw bad("no_image", "That image is empty.");
  if (buf.length > MAX_IMAGE_BYTES) throw bad("image_too_large", "That image is too large (3 MB max).");
  const mime = sniffImage(buf);
  if (!mime) throw bad("not_an_image", "Upload a JPG, PNG or WebP image.");
  const sha = createHash("sha256").update(buf).digest("hex");
  const { width, height } = imageSize(buf, mime);
  const { query } = await getDb();
  const { rows } = await query(
    `INSERT INTO media (sha256, mime, bytes, size, width, height, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256 RETURNING id, sha256`,
    [sha, mime, buf, buf.length, width, height, adminId ?? null]);
  return { id: Number(rows[0].id), url: mediaUrl(rows[0].id, rows[0].sha256), width, height, size: buf.length };
}

export async function serveMedia(file, request) {
  const m = /^(\d+)-([0-9a-f]{6,64})$/.exec(file || "");
  if (!m) throw notFound();
  const { query } = await getDb();
  const { rows } = await query(`SELECT mime, bytes, sha256 FROM media WHERE id = $1`, [Number(m[1])]);
  if (!rows.length || !rows[0].sha256.startsWith(m[2])) throw notFound();
  const etag = `"${rows[0].sha256.slice(0, 32)}"`;
  const headers = { "Content-Type": rows[0].mime, "Cache-Control": "public, max-age=31536000, immutable", ETag: etag, "X-Content-Type-Options": "nosniff" };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const bytes = rows[0].bytes instanceof Uint8Array ? rows[0].bytes : Buffer.from(rows[0].bytes);
  return new Response(bytes, { status: 200, headers });
}
