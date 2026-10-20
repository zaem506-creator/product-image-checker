/* npm run eval -- [labels.csv] [--limit N]
   Measures the agent against the team's own decisions. The labels are either
   - a CSV saved from the tool's Excel file after a reviewer corrected the "Status" and "Reason" columns, or
   - (no file given) every correction saved from the page in data/feedback.jsonl.
   Images that are teaching examples are left out: the agent has already seen their answer. */
import fs from "node:fs";
import path from "node:path";
import { judge, loadExamples, MODEL, ROOT, type Result } from "./judge.ts";
import { REASON_CODES, reasonsFromText, type ReasonCode } from "./rules.ts";

interface Label { key: string; url: string; status: "approved" | "rejected"; reasons: ReasonCode[] }

function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/)[0] || "", sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : first.includes("\t") && !first.includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
function statusOf(s: string): "approved" | "rejected" | null {
  s = s.trim().toLowerCase();
  if (/^(approved|ok|pass|مطابق|مقبول)/.test(s)) return "approved";
  if (/^(rejected|fail|reject|مرفوض|غير مطابق)/.test(s)) return "rejected";
  return null;
}

function fromCsv(file: string): Label[] {
  const rows = parseCsv(fs.readFileSync(file, "utf8")), head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const L = col(/link|url|رابط/), S = col(/status|الحالة|القرار/), R = col(/reason|السبب/);
  if (L < 0 || S < 0) throw new Error(`${file}: needs a link column and a Status column (found: ${rows[0].join(" | ")})`);
  const out: Label[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const st = statusOf(r[S] || ""), url = (r[L] || "").trim();
    if (!st || !url) { skipped++; continue; }
    out.push({ key: url, url, status: st, reasons: st === "rejected" && R >= 0 ? reasonsFromText(r[R] || "") : [] });
  }
  if (skipped) console.log(`${skipped} row(s) skipped (no link, or a status that is not Approved/Rejected)`);
  return out;
}
function fromFeedback(): (Label & { file?: string })[] {
  const f = path.join(ROOT, "data", "feedback.jsonl");
  if (!fs.existsSync(f)) throw new Error("no labels: give a CSV file, or correct some results on the page first (data/feedback.jsonl)");
  const last = new Map<string, any>();
  for (const l of fs.readFileSync(f, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l); last.set(r.key, r); }
  return [...last.values()].filter((r) => r.human.status !== "review").map((r) => ({ key: r.key, url: r.url, file: r.file, status: r.human.status, reasons: r.human.reasons }));
}

const args = process.argv.slice(2), li = args.indexOf("--limit"), limit = li >= 0 ? Number(args[li + 1]) : Infinity;
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--limit");
const seen = new Set(loadExamples().map((e) => e.key));
let labels = (file ? fromCsv(file) : fromFeedback()).filter((l) => !seen.has(l.key));
labels = labels.slice(0, limit);
console.log(`Checking ${labels.length} labelled image(s) with ${MODEL}…`);

const results: (Result | null)[] = new Array(labels.length).fill(null);
let next = 0, done = 0;
await Promise.all(Array.from({ length: Number(process.env.AGENT_PARALLEL || 4) }, async () => {
  while (next < labels.length) {
    const i = next++, l = labels[i] as Label & { file?: string };
    try {
      results[i] = await judge(l.file ? { data: fs.readFileSync(path.join(ROOT, "data", "feedback-img", l.file)) } : { url: l.url });
    } catch (e) { console.warn(`error on ${l.key}: ${(e as Error).message}`); }
    process.stdout.write(`\r${++done}/${labels.length}`);
  }
}));
process.stdout.write("\n\n");

/* ===== scores ===== */
const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—");
let decided = 0, right = 0, rightFull = 0, review = 0, falseOk = 0, falseBad = 0, errors = 0, unopened = 0;
const per = Object.fromEntries(REASON_CODES.map((c) => [c, { tp: 0, fp: 0, fn: 0 }]));
const lines = [["Image Link", "Team", "Team reasons", "Agent", "Agent reasons", "Match", "Agent note"]];
labels.forEach((l, i) => {
  const r = results[i];
  if (!r) { errors++; return; }
  /* a link that didn't open says nothing about the agent's judgement */
  if (r.reasons.some((x) => x.code === "invalid" || x.code === "noopen")) { unopened++; lines.push([l.key, l.status, l.reasons.join(","), "not opened", "", "-", r.reasons[0].detail]); return; }
  const ar = r.reasons.map((x) => x.code).filter((c): c is ReasonCode => (REASON_CODES as string[]).includes(c));
  let match = "review";
  if (r.status === "review") review++;
  else {
    decided++;
    if (r.status === l.status) {
      right++;
      const full = l.status === "approved" || [...ar].sort().join() === [...l.reasons].sort().join();
      if (full) rightFull++;
      match = full ? "yes" : "status only";
    } else { match = "NO"; if (r.status === "approved") falseOk++; else falseBad++; }
    if (l.status === "rejected" && r.status === "rejected")
      for (const c of REASON_CODES) {
        const h = l.reasons.includes(c), a = ar.includes(c);
        if (h && a) per[c].tp++; else if (a) per[c].fp++; else if (h) per[c].fn++;
      }
  }
  lines.push([l.key, l.status, l.reasons.join(","), r.status, ar.join(","), match, r.note]);
});
const total = labels.length - errors - unopened;
console.log(`Images judged:                    ${total}${errors ? `  (${errors} failed with an error)` : ""}${unopened ? `  (${unopened} link(s) didn't open, left out)` : ""}`);
console.log(`Sent to review (no decision):     ${review}  (${pct(review, total)})`);
console.log(`Correct approve/reject decision:  ${right} of ${decided}  = ${pct(right, decided)}   ← the 95% target`);
console.log(`  …and every reason right too:    ${rightFull} of ${decided}  = ${pct(rightFull, decided)}`);
console.log(`  wrongly approved:               ${falseOk}`);
console.log(`  wrongly rejected:               ${falseBad}`);
console.log(`\nPer reason (on images both rejected):  found / wrongly added / missed`);
for (const c of REASON_CODES) { const p = per[c]; if (p.tp + p.fp + p.fn) console.log(`  ${c.padEnd(8)} ${String(p.tp).padStart(4)} / ${String(p.fp).padStart(4)} / ${String(p.fn).padStart(4)}`); }

const out = path.join(ROOT, "data", "eval-results.csv");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, "﻿" + lines.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n"));
console.log(`\nEvery image with both decisions: ${path.relative(process.cwd(), out)}`);
