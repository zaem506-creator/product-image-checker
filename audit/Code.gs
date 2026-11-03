/**
 * أداة تدقيق الصور — الوسيط بين صفحة الموظفين وقوقل شيت.
 * يُلصق هذا الملف داخل الشيت نفسه (Extensions → Apps Script) ويُنشر كـ Web App.
 *
 * - يقرأ الأعمدة بأسمائها لا بمواقعها، فترتيب الأعمدة في الشيت لا يهم.
 * - قوائم التقييم (Verdict / Info) تُقرأ من الـ Data validation الموجودة في الشيت،
 *   فلو عدّلت القائمة في الشيت تتعدل في الأداة تلقائياً.
 * - كل حفظ يتحقق إن المنتج ما زال في نفس الصف وإنه ما زال مسنداً لنفس الموظف قبل الكتابة.
 * - LockService يمنع تداخل الكتابة إذا حفظ أكثر من موظف في نفس اللحظة.
 *
 * أول مرة: شغّل الدالة setup من المحرر (تضيف الأعمدة الناقصة وتولّد كلمة السر وتطبعها في السجل).
 */

/* ===================== إعداد لمرة واحدة =====================
   setup أول دالة في الملف، فتكون هي المختارة تلقائياً جنب زر Run */

/**
 * شغّلها مرة من المحرر (اختر setup واضغط Run):
 *  - تضيف في آخر الشيت الأعمدة الناقصة: Quality Agent و Content Saved At و Quality Saved At
 *  - تولّد كلمة سر (API_KEY) لو ما فيه وحدة وتطبعها في Execution log
 */
function setup() {
  var sh = sheet_();
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cols = columns_(header);
  ["qAgent", "cSavedAt", "qSavedAt"].forEach(function (k) {
    if (cols[k] >= 0) return;
    var col = sh.getLastColumn() + 1;
    sh.getRange(1, col).setValue(COLS[k]).setFontWeight("bold");
    if (/SavedAt$/.test(k)) sh.getRange(2, col, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat("yyyy-mm-dd hh:mm");
    Logger.log("أُضيف عمود: " + COLS[k]);
  });

  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty("API_KEY");
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, "").slice(0, 16);
    props.setProperty("API_KEY", key);
  }
  Logger.log("API_KEY = " + key + "   ← انسخها وحطها في ملف index.html");
}

var SHEET_NAME = "Nutrition Validation"; // لو ما لقاه يستخدم أول ورقة

var COLS = {
  code: "Master Product Code",
  old: "Old Nutrition Link",
  claude: "Claude Nutrition link",
  gemini: "Gemini Nutrition Link",
  aiDecision: ["Claude Decision", "Cloud Decision"], // أي اسم من الاثنين
  aiComment: "Claude Comment",
  cAgent: "Content Agent",
  cVerdict: "Content Verdict",
  cComments: "Content Comments",
  cSavedAt: "Content Saved At",
  qAgent: "Quality Agent",
  qVerdict: "Quality Verdict",
  qComments: "Quality Comments",
  qSavedAt: "Quality Saved At",
};

var DEFAULT_OPTIONS = {
  verdict: ["New", "Approved", "Need fixing"],
  info: ["Original Image Okay", "Gemni Correct ", "Claude Correct ", "None correct "],
};

/* القيم اللي تعني "لسه ما انقيّم" */
var NOT_DONE = ["", "new"];

/* ===================== قراءة ===================== */

/* فتح رابط الـ Web App يعرض الأداة نفسها (ملف Index في نفس المشروع).
   والصفحة تكلم السكربت مباشرة عن طريق apiRead / apiSave، وتسجيل دخول الشركة هو الحماية. */
function doGet(e) {
  if (!e) return setup(); // تشغيل من المحرر بزر Run: يسوي الإعداد مهما كانت الدالة المختارة
  var p = e.parameter || {};
  if (!p.action) {
    return HtmlService.createHtmlOutputFromFile("Index")
      .setTitle("تدقيق الصور")
      .addMetaTag("viewport", "width=device-width, initial-scale=1");
  }
  // طريقة الملف المحلي (تحتاج نشر Anyone + كلمة سر)
  try { checkSecret_(p.key); return out_(read_(p)); }
  catch (err) { return out_({ ok: false, error: String(err.message || err) }); }
}

function apiRead(p) {
  try { return read_(p || {}); } catch (err) { return { ok: false, error: String(err.message || err) }; }
}

function apiSave(req) {
  try { return saveAll_(req || {}); } catch (err) { return { ok: false, error: String(err.message || err) }; }
}

function apiPing(p) {
  try { return ping_(p || {}); } catch (err) { return { ok: false, error: String(err.message || err) }; }
}

/* ===================== المتصلون الآن =====================
   كل صفحة مفتوحة لها رقم خاص (client) وترسل نبضة كل 25 ثانية فيها: حساب قوقل اللي فاتحها،
   واسم الموظف اللي مختاره الحين، ورقم المنتج. لما ينتقل لاسم ثاني، يتحدث نفس السجل بدل ما ينضاف سجل جديد.
   كل شي في الذاكرة المؤقتة (CacheService)، ما يكتب في الشيت ولا ينتظر قفل الحفظ. */
var ONLINE_MS = 60 * 1000;

function ping_(p) {
  var email = "";
  try { email = Session.getActiveUser().getEmail() || ""; } catch (e) {}
  var cache = CacheService.getScriptCache();
  var lock = LockService.getDocumentLock() || LockService.getUserLock();
  var map = {}, now = Date.now();
  if (lock.tryLock(3000)) {
    try {
      map = JSON.parse(cache.get("online") || "{}");
      Object.keys(map).forEach(function (k) { if (now - map[k].t > ONLINE_MS) delete map[k]; });
      if (p.client) {
        if (p.leave) delete map[p.client];
        else map[p.client] = { t: now, email: email, agent: clean_(p.name || ""), role: p.role || "", pos: Number(p.pos) || 0, total: Number(p.total) || 0 };
      }
      cache.put("online", JSON.stringify(map), 600);
    } finally {
      lock.releaseLock();
    }
  } else {
    map = JSON.parse(cache.get("online") || "{}");
  }
  // شخص واحد = حساب واحد، حتى لو فاتح الأداة في أكثر من تبويب (ناخذ آخر نشاط)
  var people = {};
  Object.keys(map).forEach(function (k) {
    var v = map[k];
    if (now - v.t > ONLINE_MS) return;
    var id = v.email || "client:" + k;
    if (!people[id] || people[id].t < v.t) people[id] = v;
  });
  return { ok: true, me: email, online: Object.keys(people).map(function (k) { return people[k]; }) };
}

function read_(p) {
  if (p.action === "ping") return ping_(p);
  var sh = sheet_(), data = sh.getDataRange().getValues(), cols = columns_(data[0]);
  if (p.action === "init") return init_(sh, data, cols);
  if (p.action === "tasks") return tasks_(data, cols, p.agent, p.role);
  throw new Error("unknown action");
}

function init_(sh, data, cols) {
  var agents = {};
  ["content", "quality"].forEach(function (role) {
    var c = roleCols_(cols, role);
    if (c.agent < 0 || c.verdict < 0) return;
    for (var i = 1; i < data.length; i++) {
      var name = clean_(data[i][c.agent]);
      if (!name) continue;
      var k = role + "|" + name;
      var a = agents[k] || (agents[k] = { name: name, role: role, total: 0, done: 0 });
      a.total++;
      if (isDone_(data[i][c.verdict])) a.done++;
    }
  });
  var list = Object.keys(agents).map(function (k) { return agents[k]; });
  list.sort(function (a, b) { return a.role === b.role ? a.name.localeCompare(b.name) : a.role === "content" ? -1 : 1; });
  return {
    ok: true,
    title: SpreadsheetApp.getActiveSpreadsheet().getName(),
    agents: list,
    options: { content: options_(sh, cols, "content"), quality: options_(sh, cols, "quality") },
    missing: Object.keys(COLS).filter(function (k) { return cols[k] < 0 && !/SavedAt$/.test(k); }).map(function (k) { return [].concat(COLS[k])[0]; }),
  };
}

function tasks_(data, cols, agent, role) {
  var c = roleCols_(cols, role);
  if (c.agent < 0) throw new Error("عمود " + (role === "quality" ? COLS.qAgent : COLS.cAgent) + " غير موجود في الشيت");
  agent = clean_(agent);
  var tasks = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (clean_(r[c.agent]) !== agent) continue;
    tasks.push({
      row: i + 1,
      code: str_(r[cols.code]),
      old: str_(r[cols.old]).trim(),
      claude: str_(r[cols.claude]).trim(),
      gemini: str_(r[cols.gemini]).trim(),
      aiDecision: str_(r[cols.aiDecision]),
      aiComment: str_(r[cols.aiComment]),
      verdict: str_(r[c.verdict]),
      info: str_(r[c.info]),
      comments: str_(r[c.comments]),
    });
  }
  return { ok: true, tasks: tasks };
}

/* ===================== حفظ ===================== */

function doPost(e) {
  if (!e) return setup();
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: "bad request" }); }
  try { checkSecret_(req.key); return out_(saveAll_(req)); }
  catch (err) { return out_({ ok: false, error: String(err.message || err) }); }
}

function saveAll_(req) {
  if (req.action !== "save" || !req.updates || !req.updates.length) return { ok: false, error: "nothing to save" };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_(), cols = columns_(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]);
    var opts = { content: options_(sh, cols, "content"), quality: options_(sh, cols, "quality") };
    var results = req.updates.map(function (u) {
      try { return save_(sh, cols, opts, u); } catch (err) { return { id: u.id, ok: false, error: String(err.message || err) }; }
    });
    SpreadsheetApp.flush();
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

function save_(sh, cols, opts, u) {
  var role = u.role === "quality" ? "quality" : "content";
  var c = roleCols_(cols, role);
  var row = findRow_(sh, cols, Number(u.row), str_(u.code));
  if (!row) return { id: u.id, ok: false, code: "gone", error: "المنتج " + u.code + " لم يعد موجودا في الشيت" };

  var assigned = clean_(sh.getRange(row, c.agent + 1).getValue());
  if (assigned !== clean_(u.agent)) {
    return { id: u.id, ok: false, code: "reassigned", assigned: assigned, error: "المنتج " + u.code + " أصبح مسندا إلى " + (assigned || "لا أحد"), reassigned: true };
  }

  var f = u.fields || {};
  if ("verdict" in f) {
    if (f.verdict !== "" && opts[role].verdict.indexOf(f.verdict) < 0) throw new Error("قيمة Verdict غير مسموحة: " + f.verdict);
    sh.getRange(row, c.verdict + 1).setValue(f.verdict);
  }
  if ("info" in f && c.info >= 0) {
    if (f.info !== "" && opts[role].info.indexOf(f.info) < 0) throw new Error("قيمة Info غير مسموحة: " + f.info);
    sh.getRange(row, c.info + 1).setValue(f.info);
  }
  if ("comments" in f && c.comments >= 0) {
    var text = String(f.comments).slice(0, 5000);
    if (/^[=+\-@]/.test(text)) text = "'" + text; // نص عادي، مو معادلة
    sh.getRange(row, c.comments + 1).setValue(text);
  }
  if (c.savedAt >= 0) sh.getRange(row, c.savedAt + 1).setValue(new Date());
  return { id: u.id, ok: true, row: row };
}

/* الصف المتوقع لو ما زال فيه نفس المنتج، وإلا نبحث عن الكود (لو المشرف رتّب أو أضاف صفوف) */
function findRow_(sh, cols, row, code) {
  if (!code) return 0;
  if (row >= 2 && row <= sh.getLastRow() && str_(sh.getRange(row, cols.code + 1).getValue()).trim() === code.trim()) return row;
  var hit = sh.getRange(2, cols.code + 1, Math.max(sh.getLastRow() - 1, 1), 1)
    .createTextFinder(code.trim()).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

/* ===================== أعمدة وقوائم ===================== */

function columns_(header) {
  var norm = header.map(norm_);
  var cols = {};
  Object.keys(COLS).forEach(function (k) {
    cols[k] = -1;
    [].concat(COLS[k]).some(function (name) { cols[k] = norm.indexOf(norm_(name)); return cols[k] >= 0; });
  });
  // يوجد عمودان باسم Info: كل واحد يتبع عمود الـ Verdict اللي قبله
  cols.cInfo = infoAfter_(norm, cols.cVerdict, cols.cComments);
  cols.qInfo = infoAfter_(norm, cols.qVerdict, cols.qComments);
  return cols;
}

function infoAfter_(norm, verdictCol, commentsCol) {
  if (verdictCol < 0) return -1;
  var end = commentsCol > verdictCol ? commentsCol : norm.length;
  for (var i = verdictCol + 1; i < end; i++) if (norm[i] === "info") return i;
  return -1;
}

function roleCols_(cols, role) {
  return role === "quality"
    ? { agent: cols.qAgent, verdict: cols.qVerdict, info: cols.qInfo, comments: cols.qComments, savedAt: cols.qSavedAt }
    : { agent: cols.cAgent, verdict: cols.cVerdict, info: cols.cInfo, comments: cols.cComments, savedAt: cols.cSavedAt };
}

function options_(sh, cols, role) {
  var c = roleCols_(cols, role);
  return { verdict: listIn_(sh, c.verdict) || DEFAULT_OPTIONS.verdict, info: listIn_(sh, c.info) || DEFAULT_OPTIONS.info };
}

/* يقرأ قائمة الخيارات من الـ Data validation في الصف 2 */
function listIn_(sh, col) {
  if (col < 0 || sh.getLastRow() < 2) return null;
  var rule = sh.getRange(2, col + 1).getDataValidation();
  if (!rule || rule.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) return null;
  var values = rule.getCriteriaValues()[0];
  return values && values.length ? values.map(String) : null;
}

/* ===================== أدوات ===================== */

function checkSecret_(key) {
  var expected = PropertiesService.getScriptProperties().getProperty("API_KEY");
  if (!expected) throw new Error("setup: شغّل الدالة setup مرة من المحرر أولاً");
  if (key !== expected) throw new Error("كلمة السر (API_KEY) غير صحيحة");
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
}

function isDone_(v) { return NOT_DONE.indexOf(clean_(v).toLowerCase()) < 0; }
function norm_(s) { return String(s).replace(/\s+/g, " ").trim().toLowerCase(); }
function clean_(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
function str_(v) { return v == null ? "" : String(v); }

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
