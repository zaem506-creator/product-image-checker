/* Getting an image (link, Google Drive share link or uploaded file), shrinking it for the model, and measuring the pixels
   the model can't judge by eye: exact border colours, transparency, and the outline of what isn't white. */
import sharp from "sharp";

export class ImageError extends Error {
  constructor(public code: "invalid" | "noopen", message: string) {
    super(message);
  }
}

/* Drive share links open a web page, not the picture: the same file is served as a plain image by these two addresses */
function sources(u: string): string[] {
  let host = "";
  try { host = new URL(u).host; } catch { return [u]; }
  if (!/(^|\.)(drive|docs)\.google\.com$/i.test(host)) return [u];
  const m = /\/file\/d\/([\w-]{10,})/.exec(u) || /[?&]id=([\w-]{10,})/.exec(u);
  return m ? [`https://lh3.googleusercontent.com/d/${m[1]}=s0`, `https://drive.usercontent.google.com/download?id=${m[1]}&export=view`] : [u];
}

export async function download(u: string): Promise<Buffer> {
  if (!/^https?:\/\//i.test(u)) throw new ImageError("invalid", "not a link");
  let last: unknown = null;
  for (const src of sources(u)) {
    for (const delay of [0, 1000, 3000]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        const r = await fetch(src, { signal: AbortSignal.timeout(30000), headers: { "user-agent": "Mozilla/5.0 product-image-agent" } });
        if (!r.ok) {
          last = new ImageError(r.status === 401 || r.status === 403 ? "noopen" : "invalid", `HTTP ${r.status}`);
          if (r.status !== 429 && r.status < 500) break;
          continue;
        }
        const type = r.headers.get("content-type") || "";
        const b = Buffer.from(await r.arrayBuffer());
        if (/^text\//i.test(type) || b.length < 100) { last = new ImageError("noopen", "the link opens a page, not an image"); break; }
        return b;
      } catch (e) {
        last = e;
      }
    }
  }
  throw last instanceof ImageError ? last : new ImageError("invalid", String((last as Error)?.message || last));
}

export interface Prepared {
  jpeg: string; /* base64, at most 1568 px on the long side */
  width: number;
  height: number;
  measured: Measurements;
}

export interface Measurements {
  transparent: boolean;
  border: { top: string; bottom: string; left: string; right: string }; /* median colour of each side's outer 2% band */
  outline: null | { fill: number; offCentre: number; edgesTouched: number }; /* box around non-white pixels */
}

const hex = (v: number) => "#" + Math.round(v).toString(16).padStart(2, "0").toUpperCase().repeat(3);
const isWhite = (r: number, g: number, b: number) => Math.min(r, g, b) >= 238 && Math.max(r, g, b) - Math.min(r, g, b) <= 16;

function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}

function measure(d: Buffer, W: number, H: number, transparent: boolean): Measurements {
  const band = Math.max(3, Math.round(Math.min(W, H) * 0.02));
  const sides: number[][] = [[], [], [], []];
  const rows = new Uint32Array(H), cols = new Uint32Array(W);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3, r = d[i], g = d[i + 1], b = d[i + 2], lv = (r + g + b) / 3;
      const sd = y < band ? 0 : y >= H - band ? 1 : x < band ? 2 : x >= W - band ? 3 : -1;
      if (sd >= 0) sides[sd].push(lv);
      if (!isWhite(r, g, b)) { rows[y]++; cols[x]++; }
    }
  const [top, bottom, left, right] = sides.map((s) => hex(median(s)));
  const tr = Math.max(1, W * 0.004), tc = Math.max(1, H * 0.004);
  let y0 = -1, y1 = -1, x0 = -1, x1 = -1;
  for (let y = 0; y < H; y++) if (rows[y] > tr) { if (y0 < 0) y0 = y; y1 = y; }
  for (let x = 0; x < W; x++) if (cols[x] > tc) { if (x0 < 0) x0 = x; x1 = x; }
  const outline = y0 < 0 || x0 < 0 ? null : {
    fill: Math.max((x1 - x0 + 1) / W, (y1 - y0 + 1) / H),
    offCentre: Math.abs((x0 + x1) / 2 - (W - 1) / 2) / W,
    edgesTouched: (x0 <= 1 ? 1 : 0) + (y0 <= 1 ? 1 : 0) + (x1 >= W - 2 ? 1 : 0) + (y1 >= H - 2 ? 1 : 0),
  };
  return { transparent, border: { top, bottom, left, right }, outline };
}

export async function prepare(buf: Buffer): Promise<Prepared> {
  let meta;
  try { meta = await sharp(buf).metadata(); } catch { throw new ImageError("invalid", "the file is damaged or is not an image"); }
  const width = meta.autoOrient?.width || meta.width || 0, height = meta.autoOrient?.height || meta.height || 0;
  if (!width || !height) throw new ImageError("invalid", "the file is damaged or is not an image");
  /* transparency drawn on white, the same way the catalogue shows it; EXIF rotation applied, as browsers do */
  const base = () => sharp(buf).rotate().flatten({ background: "#ffffff" });
  const small = await base().resize(800, 800, { fit: "inside", withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  /* an alpha channel alone isn't transparency (many PNGs carry one that is fully opaque) */
  const transparent = !!meta.hasAlpha && !(await sharp(buf).stats()).isOpaque;
  const measured = measure(small.data, small.info.width, small.info.height, transparent);
  const jpeg = (await base().resize(1568, 1568, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer()).toString("base64");
  return { jpeg, width, height, measured };
}

export function describe(p: Prepared): string {
  const m = p.measured, o = m.outline, pc = (v: number) => Math.round(v * 100) + "%";
  return [
    `Original size: ${p.width}×${p.height} px.`,
    `Transparent background in the original: ${m.transparent ? "yes" : "no"}.`,
    `Measured border colours (median of each side's outer 2%): top ${m.border.top}, bottom ${m.border.bottom}, left ${m.border.left}, right ${m.border.right}.`,
    o
      ? `Outline of non-white pixels: fills ${pc(o.fill)} along its longer side; its horizontal centre is ${pc(o.offCentre)} of the width from the image centre; touches ${o.edgesTouched} of 4 edges.`
      : "Outline of non-white pixels: none found (the image is almost all white, or the background is not white).",
  ].join("\n");
}
