/* The agent: one product image in, the team's verdict out. The rules and the team's own example decisions go first
   (cached, they are the same on every call), then the image and its measurements. */
import Anthropic from "@anthropic-ai/sdk";
import { betaJSONSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REASONS, REASON_CODES, SYSTEM_PROMPT, type ReasonCode } from "./rules.ts";
import { describe, download, ImageError, prepare, type Prepared } from "./image.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MODEL = process.env.AGENT_MODEL || "claude-opus-5-5";
const EFFORT = (process.env.AGENT_EFFORT || "high") as "low" | "medium" | "high" | "xhigh" | "max";
/* several independent looks at the same image; when they disagree the image goes to review instead of a guess */
const VOTES = Math.max(1, Number(process.env.AGENT_VOTES || 1));

const client = new Anthropic();

/* written out by hand (not transformed) so the allowed values stay a real enum the API enforces */
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["approved", "rejected", "review"] },
    reasons: {
      type: "array",
      items: {
        type: "object",
        properties: { code: { type: "string", enum: REASON_CODES }, detail: { type: "string" } },
        required: ["code", "detail"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["status", "reasons", "note"],
  additionalProperties: false,
} as const;
interface Verdict {
  status: "approved" | "rejected" | "review";
  reasons: { code: ReasonCode; detail: string }[];
  note: string;
}

export interface Result {
  status: "approved" | "rejected" | "review";
  reasons: { code: ReasonCode | "invalid" | "noopen"; label: string; detail: string }[];
  note: string;
  width?: number;
  height?: number;
  votes?: string[];
}

/* ===== the team's examples: examples/examples.json + the pictures in examples/img ===== */
export interface Example {
  key: string; /* the image link, or the uploaded file's name */
  image: string; /* file inside examples/img */
  status: "approved" | "rejected" | "review";
  reasons: ReasonCode[];
  why?: string;
}
export const EXAMPLES_FILE = path.join(ROOT, "examples", "examples.json");
export function loadExamples(): Example[] {
  try { return JSON.parse(fs.readFileSync(EXAMPLES_FILE, "utf8")); } catch { return []; }
}

let exampleBlocks: Promise<Anthropic.Beta.BetaContentBlockParam[]> | null = null;
let exampleCount = 0;
export function reloadExamples() { exampleBlocks = null; }
function examplesContent(): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  if (!exampleBlocks) exampleBlocks = (async () => {
    const list = loadExamples(), out: Anthropic.Beta.BetaContentBlockParam[] = [];
    let n = 0;
    for (const ex of list) {
      let p: Prepared;
      try { p = await prepare(fs.readFileSync(path.join(ROOT, "examples", "img", ex.image))); }
      catch { console.warn(`example skipped, can't read examples/img/${ex.image}`); continue; }
      n++;
      const verdict = ex.status === "approved" ? "approved" : `${ex.status}${ex.reasons.length ? " — " + ex.reasons.join(", ") : ""}`;
      out.push({ type: "text", text: `Example ${n} — the audit team's decision: ${verdict}.${ex.why ? " Why: " + ex.why : ""}\n${describe(p)}` });
      out.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.jpeg } });
    }
    exampleCount = n;
    if (out.length) out.unshift({ type: "text", text: `${n} examples of the audit team's past decisions:` });
    return out;
  })();
  exampleBlocks.catch(() => { exampleBlocks = null; });
  return exampleBlocks;
}
export async function examplesLoaded() { await examplesContent(); return exampleCount; }

async function ask(p: Prepared): Promise<Verdict> {
  const ex = await examplesContent();
  const content: Anthropic.Beta.BetaContentBlockParam[] = ex.map((b) => ({ ...b }));
  /* the cache ends after the last example: everything before it is identical on every call */
  if (content.length) content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: "ephemeral", ttl: "1h" } } as Anthropic.Beta.BetaContentBlockParam;
  content.push(
    { type: "text", text: "The image to audit:" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.jpeg } },
    { type: "text", text: `Measurements of this image:\n${describe(p)}\n\nAudit it against every rule and give your verdict.` },
  );
  const res = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: EFFORT, format: betaJSONSchemaOutputFormat(VERDICT_SCHEMA, { transform: false }) },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output)
    return { status: "review", reasons: [], note: "الإيجنت ما قدر يحكم على هذي الصورة — شيّك عليها بعينك" };
  return res.parsed_output as Verdict;
}

function clean(v: Verdict): Verdict {
  /* one entry per reason; an approval carries no reasons, a rejection needs at least one */
  const seen = new Set<string>();
  const reasons = v.reasons.filter((r) => !seen.has(r.code) && seen.add(r.code));
  if (v.status === "approved") return { ...v, reasons: [] };
  if (v.status === "rejected" && !reasons.length) return { ...v, status: "review", reasons };
  return { ...v, reasons };
}

export async function judge(input: { url?: string; data?: Buffer }): Promise<Result> {
  let p: Prepared;
  try { p = await prepare(input.data || (await download(input.url || ""))); }
  catch (e) {
    if (!(e instanceof ImageError)) throw e;
    const code = e.code;
    return { status: "rejected", reasons: [{ code, label: code === "noopen" ? "Photos not matching the Standard ( Not Open Source Image Link )" : "Photos not matching the Standard ( Invalid Link )", detail: e.message }], note: code === "noopen" ? "الرابط مو رابط صورة مفتوح" : "الصورة ما فتحت" };
  }
  const looks = (await Promise.all(Array.from({ length: VOTES }, () => ask(p)))).map(clean);
  let v = looks[0];
  if (looks.length > 1) {
    const sig = (x: Verdict) => x.status + ":" + x.reasons.map((r) => r.code).sort().join(",");
    if (!looks.every((x) => sig(x) === sig(looks[0])))
      v = { status: "review", reasons: looks.flatMap((x) => x.reasons).filter((r, i, a) => a.findIndex((q) => q.code === r.code) === i), note: "الإيجنت تردد في هذي الصورة — شيّك عليها بعينك. " + looks.map((x) => x.note).join(" / ") };
  }
  return {
    status: v.status,
    reasons: v.reasons.map((r) => ({ code: r.code, label: REASONS[r.code], detail: r.detail })),
    note: v.note,
    width: p.width,
    height: p.height,
    votes: looks.length > 1 ? looks.map((x) => x.status) : undefined,
  };
}
