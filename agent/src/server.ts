/* Serves the image-check page and the agent behind it:
   POST /api/judge     {url} or {data: "data:image/...;base64,...", name}  -> the agent's verdict
   POST /api/feedback  {key, url?, data?, agent, human}                    -> saved to data/feedback.jsonl (what `npm run learn` reads)
   The API key stays here on the server; the page never sees it. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { examplesLoaded, judge, MODEL, ROOT } from "./judge.ts";
import { REASON_CODES } from "./rules.ts";

const PORT = Number(process.env.PORT || 8787);
const PUBLIC = path.join(ROOT, "..", "public");
const DATA = path.join(ROOT, "data");
const MAX_BODY = 40 * 1024 * 1024;

function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((res, rej) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) { rej(new Error("too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => { try { res(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); } catch (e) { rej(e); } });
    req.on("error", rej);
  });
}
function dataUrl(s: unknown): Buffer | undefined {
  const m = typeof s === "string" ? /^data:[^;,]*;base64,(.*)$/s.exec(s) : null;
  return m ? Buffer.from(m[1], "base64") : undefined;
}
function send(res: http.ServerResponse, code: number, obj: unknown) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

/* a few at a time, so a long list doesn't hit the API's rate limit all at once */
let running = 0;
const queue: (() => void)[] = [];
const LIMIT = Number(process.env.AGENT_PARALLEL || 4);
async function slot<T>(f: () => Promise<T>): Promise<T> {
  if (running >= LIMIT) await new Promise<void>((r) => queue.push(r));
  running++;
  try { return await f(); } finally { running--; queue.shift()?.(); }
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

http.createServer(async (req, res) => {
  /* the page may also be opened as a file (file://) — it then calls this server on localhost */
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url || "/", "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/api/health")
      return send(res, 200, { ok: true, model: MODEL, examples: await examplesLoaded() });

    if (req.method === "POST" && url.pathname === "/api/judge") {
      const b = await body(req);
      const r = await slot(() => judge({ url: b.url, data: dataUrl(b.data) }));
      return send(res, 200, r);
    }

    if (req.method === "POST" && url.pathname === "/api/feedback") {
      const b = await body(req);
      const st = ["approved", "rejected", "review"];
      const human = b.human || {};
      if (!st.includes(human.status) || !Array.isArray(human.reasons) || human.reasons.some((c: string) => !REASON_CODES.includes(c as never)))
        return send(res, 400, { error: "bad feedback" });
      fs.mkdirSync(path.join(DATA, "feedback-img"), { recursive: true });
      /* an uploaded picture has no link to download again later: keep its file */
      let file: string | undefined;
      const img = dataUrl(b.data);
      if (img) { file = crypto.createHash("sha1").update(img).digest("hex").slice(0, 16) + ".img"; fs.writeFileSync(path.join(DATA, "feedback-img", file), img); }
      /* an uploaded picture is known by its content (two files may share a name like IMG_0001.jpg), a link by itself */
      const row = { at: new Date().toISOString(), key: file ? "upload:" + file : String(b.url || b.key), name: file ? String(b.key || "") : undefined, url: b.url || undefined, file, agent: b.agent, human: { status: human.status, reasons: human.reasons, why: human.why || undefined } };
      fs.appendFileSync(path.join(DATA, "feedback.jsonl"), JSON.stringify(row) + "\n");
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const f = path.join(PUBLIC, rel);
      if (f.startsWith(PUBLIC + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
        fs.createReadStream(f).pipe(res);
        return;
      }
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String((e as Error)?.message || e) });
  }
}).listen(PORT, async () => {
  console.log(`Image check + agent: http://localhost:${PORT}   (model ${MODEL}, ${await examplesLoaded()} examples)`);
});
