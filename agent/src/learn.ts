/* npm run learn — turns the agent's mistakes the team corrected (data/feedback.jsonl) into examples it learns from.
   Each case where the team's decision differs from the agent's is copied into examples/ with the team's decision. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { download } from "./image.ts";
import { EXAMPLES_FILE, loadExamples, ROOT, type Example } from "./judge.ts";

const FEEDBACK = path.join(ROOT, "data", "feedback.jsonl");
const sig = (s: string, r: string[]) => s + ":" + [...r].sort().join(",");

const rows = fs.existsSync(FEEDBACK) ? fs.readFileSync(FEEDBACK, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
/* the latest correction of each image wins */
const last = new Map<string, any>();
for (const r of rows) last.set(r.key, r);

const examples = loadExamples(), have = new Set(examples.map((e) => e.key));
fs.mkdirSync(path.join(ROOT, "examples", "img"), { recursive: true });
let added = 0;
for (const r of last.values()) {
  const agentReasons = (r.agent?.reasons || []).map((x: { code: string }) => x.code);
  if (have.has(r.key) || sig(r.agent?.status, agentReasons) === sig(r.human.status, r.human.reasons)) continue;
  let img: Buffer;
  try { img = r.file ? fs.readFileSync(path.join(ROOT, "data", "feedback-img", r.file)) : await download(r.url); }
  catch (e) { console.warn(`skipped (can't get the image): ${r.key}`); continue; }
  const name = crypto.createHash("sha1").update(r.key).digest("hex").slice(0, 16) + ".img";
  fs.writeFileSync(path.join(ROOT, "examples", "img", name), img);
  const ex: Example = { key: r.key, image: name, status: r.human.status, reasons: r.human.reasons, why: r.human.why };
  examples.push(ex);
  have.add(r.key);
  added++;
  console.log(`+ ${r.human.status} ${r.human.reasons.join(",") || ""}  (agent said ${r.agent?.status} ${agentReasons.join(",")})  ${r.key}`);
}
fs.writeFileSync(EXAMPLES_FILE, JSON.stringify(examples, null, 2) + "\n");
console.log(`\n${added} new example(s), ${examples.length} in total. Restart "npm start" to use them.`);
if (examples.length > 60) console.log("Many examples make every check slower and dearer: keep the clearest ones per reason (edit examples/examples.json).");
