/**
 * أداة تدقيق الصور — الوسيط بين صفحة الموظفين وقوقل شيت.
 * يُضاف كملف مستقل (مثلاً Audit.gs) جنب أي سكربت موجود في الشيت، بدون ما تمسح سكربتكم.
 * كل الأسماء الداخلية تبدأ بـ audit عشان ما تتعارض معه.
 * الدوال العامة: doGet و doPost و apiRead و apiSave و apiPing و setupAudit.
 *
 * - يقرأ الأعمدة بأسمائها لا بمواقعها، فترتيب الأعمدة في الشيت لا يهم.
 * - قوائم التقييم (Verdict / Info) تُقرأ من الـ Data validation الموجودة في الشيت.
 * - لما القرار يصير Approved أو Need fixing، يكتب التاريخ في عمود Date المخفي اللي بعد Info
 *   (سكربت onEdit حقكم ما يشتغل لما الكتابة تجي من سكربت، فالأداة تكتبه بنفسها).
 * - كل حفظ يتحقق إن المنتج ما زال في نفس الصف وإنه ما زال مسنداً لنفس الموظف قبل الكتابة.
 * - LockService يمنع تداخل الكتابة إذا حفظ أكثر من موظف في نفس اللحظة.
 */

/* ===================== إعداد لمرة واحدة =====================
   شغّل setupAudit مرة من المحرر: توافق على الصلاحيات، وتطبع أعمدة التاريخ اللي لقاها.
   (أي دالة تشغّلها من المحرر، مثل doGet، تسوي نفس الشي.) */
function setupAudit() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty("API_KEY");
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, "").slice(0, 16);
    props.setProperty("API_KEY", key);
  }
  var cols = auditColumns_(auditSheet_().getRange(1, 1, 1, auditSheet_().getLastColumn()).getValues()[0]);
  Logger.log("عمود تاريخ المحتوى: " + (cols.cDate >= 0 ? auditColName_(cols.cDate) : "غير موجود"));
  Logger.log("عمود تاريخ الجودة: " + (cols.qDate >= 0 ? auditColName_(cols.qDate) : "غير موجود"));
  Logger.log("API_KEY = " + key + "   (تحتاجها فقط لطريقة الملف المحلي)");
}

function auditColName_(i) { var n = i + 1, s = ""; while (n) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); } return s; }

var AUDIT_SHEET_NAME = "Nutrition Validation"; // لو ما لقاه يستخدم أول ورقة

var AUDIT_COLS = {
  code: "Master Product Code",
  old: "Old Nutrition Link",
  claude: "Claude Nutrition link",
  gemini: "Gemini Nutrition Link",
  aiDecision: ["Claude Decision", "Cloud Decision"], // أي اسم من الاثنين
  aiComment: "Claude Comment",
  cAgent: "Content Agent",
  cVerdict: "Content Verdict",
  cComments: "Content Comments",
  qAgent: "Quality Agent",
  qVerdict: "Quality Verdict",
  qComments: "Quality Comments",
};

var AUDIT_DEFAULT_OPTIONS = {
  verdict: ["New", "Approved", "Need fixing"],
  info: ["Original Image Okay", "Gemni Correct ", "Claude Correct ", "None correct "],
};

/* القيم اللي تعني "لسه ما انقيّم" */
var AUDIT_NOT_DONE = ["", "new"];

/* ===================== قراءة ===================== */

/* فتح رابط الـ Web App يعرض الأداة نفسها (ملف Index في نفس المشروع).
   والصفحة تكلم السكربت مباشرة عن طريق apiRead / apiSave، وتسجيل دخول الشركة هو الحماية. */
function doGet(e) {
  if (!e) return setupAudit(); // تشغيل من المحرر بزر Run: يسوي الإعداد مهما كانت الدالة المختارة
  var p = e.parameter || {};
  if (!p.action) {
    return HtmlService.createHtmlOutputFromFile("Index")
      .setTitle("تدقيق الصور")
      .addMetaTag("viewport", "width=device-width, initial-scale=1");
  }
  // طريقة الملف المحلي (تحتاج نشر Anyone + كلمة سر)
  try { auditCheckSecret_(p.key); return auditOut_(auditRead_(p)); }
  catch (err) { return auditOut_({ ok: false, error: String(err.message || err) }); }
}

function apiRead(p) {
  try { return auditRead_(p || {}); } catch (err) { return { ok: false, error: String(err.message || err) }; }
}

function apiSave(req) {
  try { return auditSaveAll_(req || {}); } catch (err) { return { ok: false, error: String(err.message || err) }; }
}

function apiPing(p) {
  try { return auditPing_(p || {}); } catch (err) { return { ok: false, error: String(err.message || err) }; }
}

/* ===================== المتصلون الآن =====================
   كل صفحة مفتوحة لها رقم خاص (client) وترسل نبضة كل 25 ثانية فيها: حساب قوقل اللي فاتحها،
   واسم الموظف اللي مختاره الحين، ورقم المنتج. لما ينتقل لاسم ثاني، يتحدث نفس السجل بدل ما ينضاف سجل جديد.
   كل شي في الذاكرة المؤقتة (CacheService)، ما يكتب في الشيت ولا ينتظر قفل الحفظ. */
var AUDIT_ONLINE_MS = 60 * 1000;

function auditPing_(p) {
  var email = "";
  try { email = Session.getActiveUser().getEmail() || ""; } catch (e) {}
  var cache = CacheService.getScriptCache();
  var lock = LockService.getDocumentLock() || LockService.getUserLock();
  var map = {}, now = Date.now();
  if (lock.tryLock(3000)) {
    try {
      map = JSON.parse(cache.get("online") || "{}");
      Object.keys(map).forEach(function (k) { if (now - map[k].t > AUDIT_ONLINE_MS) delete map[k]; });
      if (p.client) {
        if (p.leave) delete map[p.client];
        else map[p.client] = { t: now, email: email, agent: auditClean_(p.name || ""), role: p.role || "", pos: Number(p.pos) || 0, total: Number(p.total) || 0 };
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
    if (now - v.t > AUDIT_ONLINE_MS) return;
    var id = v.email || "client:" + k;
    if (!people[id] || people[id].t < v.t) people[id] = v;
  });
  return { ok: true, me: email, online: Object.keys(people).map(function (k) { return people[k]; }) };
}

function auditRead_(p) {
  if (p.action === "ping") return auditPing_(p);
  var sh = auditSheet_(), data = sh.getDataRange().getValues(), cols = auditColumns_(data[0]);
  if (p.action === "init") return auditInit_(sh, data, cols);
  if (p.action === "tasks") return auditTasks_(data, cols, p.agent, p.role);
  throw new Error("unknown action");
}

function auditInit_(sh, data, cols) {
  var agents = {};
  ["content", "quality"].forEach(function (role) {
    var c = auditRoleCols_(cols, role);
    if (c.agent < 0 || c.verdict < 0) return;
    for (var i = 1; i < data.length; i++) {
      var name = auditClean_(data[i][c.agent]);
      if (!name) continue;
      var k = role + "|" + name;
      var a = agents[k] || (agents[k] = { name: name, role: role, total: 0, done: 0 });
      a.total++;
      if (auditIsDone_(data[i][c.verdict])) a.done++;
    }
  });
  var list = Object.keys(agents).map(function (k) { return agents[k]; });
  list.sort(function (a, b) { return a.role === b.role ? a.name.localeCompare(b.name) : a.role === "content" ? -1 : 1; });
  return {
    ok: true,
    title: SpreadsheetApp.getActiveSpreadsheet().getName(),
    agents: list,
    options: { content: auditOptions_(sh, cols, "content"), quality: auditOptions_(sh, cols, "quality") },
    missing: Object.keys(AUDIT_COLS).filter(function (k) { return cols[k] < 0; }).map(function (k) { return [].concat(AUDIT_COLS[k])[0]; }),
  };
}

function auditTasks_(data, cols, agent, role) {
  var c = auditRoleCols_(cols, role);
  if (c.agent < 0) throw new Error("عمود " + (role === "quality" ? AUDIT_COLS.qAgent : AUDIT_COLS.cAgent) + " غير موجود في الشيت");
  agent = auditClean_(agent);
  var tasks = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (auditClean_(r[c.agent]) !== agent) continue;
    tasks.push({
      row: i + 1,
      code: auditStr_(r[cols.code]),
      old: auditStr_(r[cols.old]).trim(),
      claude: auditStr_(r[cols.claude]).trim(),
      gemini: auditStr_(r[cols.gemini]).trim(),
      aiDecision: auditStr_(r[cols.aiDecision]),
      aiComment: auditStr_(r[cols.aiComment]),
      verdict: auditStr_(r[c.verdict]),
      info: auditStr_(r[c.info]),
      comments: auditStr_(r[c.comments]),
    });
  }
  return { ok: true, tasks: tasks };
}

/* ===================== حفظ ===================== */

function doPost(e) {
  if (!e) return setupAudit();
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return auditOut_({ ok: false, error: "bad request" }); }
  try { auditCheckSecret_(req.key); return auditOut_(auditSaveAll_(req)); }
  catch (err) { return auditOut_({ ok: false, error: String(err.message || err) }); }
}

function auditSaveAll_(req) {
  if (req.action !== "save" || !req.updates || !req.updates.length) return { ok: false, error: "nothing to save" };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = auditSheet_(), cols = auditColumns_(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]);
    var opts = { content: auditOptions_(sh, cols, "content"), quality: auditOptions_(sh, cols, "quality") };
    var results = req.updates.map(function (u) {
      try { return auditSave_(sh, cols, opts, u); } catch (err) { return { id: u.id, ok: false, error: String(err.message || err) }; }
    });
    SpreadsheetApp.flush();
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

function auditSave_(sh, cols, opts, u) {
  var role = u.role === "quality" ? "quality" : "content";
  var c = auditRoleCols_(cols, role);
  var row = auditFindRow_(sh, cols, Number(u.row), auditStr_(u.code));
  if (!row) return { id: u.id, ok: false, code: "gone", error: "المنتج " + u.code + " لم يعد موجودا في الشيت" };

  var assigned = auditClean_(sh.getRange(row, c.agent + 1).getValue());
  if (assigned !== auditClean_(u.agent)) {
    return { id: u.id, ok: false, code: "reassigned", assigned: assigned, error: "المنتج " + u.code + " أصبح مسندا إلى " + (assigned || "لا أحد"), reassigned: true };
  }

  var f = u.fields || {};
  if ("verdict" in f) {
    if (f.verdict !== "" && opts[role].verdict.indexOf(f.verdict) < 0) throw new Error("قيمة Verdict غير مسموحة: " + f.verdict);
    sh.getRange(row, c.verdict + 1).setValue(f.verdict);
    // نفس قاعدة سكربت الشيت: سكربت onEdit ما يشتغل لما الكتابة تجي من سكربت، فالأداة تكتب التاريخ بنفسها
    if (auditIsDone_(f.verdict) && c.date >= 0) sh.getRange(row, c.date + 1).setValue(new Date());
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
  return { id: u.id, ok: true, row: row };
}

/* الصف المتوقع لو ما زال فيه نفس المنتج، وإلا نبحث عن الكود (لو المشرف رتّب أو أضاف صفوف) */
function auditFindRow_(sh, cols, row, code) {
  if (!code) return 0;
  if (row >= 2 && row <= sh.getLastRow() && auditStr_(sh.getRange(row, cols.code + 1).getValue()).trim() === code.trim()) return row;
  var hit = sh.getRange(2, cols.code + 1, Math.max(sh.getLastRow() - 1, 1), 1)
    .createTextFinder(code.trim()).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

/* ===================== أعمدة وقوائم ===================== */

function auditColumns_(header) {
  var norm = header.map(auditNorm_);
  var cols = {};
  Object.keys(AUDIT_COLS).forEach(function (k) {
    cols[k] = -1;
    [].concat(AUDIT_COLS[k]).some(function (name) { cols[k] = norm.indexOf(auditNorm_(name)); return cols[k] >= 0; });
  });
  // يوجد عمودان باسم Info: كل واحد يتبع عمود الـ Verdict اللي قبله
  cols.cInfo = auditInfoAfter_(norm, cols.cVerdict, cols.cComments);
  cols.qInfo = auditInfoAfter_(norm, cols.qVerdict, cols.qComments);
  // وعمود Date المخفي اللي بعده: ينكتب فيه التاريخ لما القرار يصير Approved أو Need fixing
  cols.cDate = auditHeaderAfter_(norm, "date", cols.cVerdict, cols.cComments);
  cols.qDate = auditHeaderAfter_(norm, "date", cols.qVerdict, cols.qComments);
  return cols;
}

function auditInfoAfter_(norm, verdictCol, commentsCol) { return auditHeaderAfter_(norm, "info", verdictCol, commentsCol); }

function auditHeaderAfter_(norm, name, verdictCol, commentsCol) {
  if (verdictCol < 0) return -1;
  var end = commentsCol > verdictCol ? commentsCol : norm.length;
  for (var i = verdictCol + 1; i < end; i++) if (norm[i] === name) return i;
  return -1;
}

function auditRoleCols_(cols, role) {
  return role === "quality"
    ? { agent: cols.qAgent, verdict: cols.qVerdict, info: cols.qInfo, comments: cols.qComments, date: cols.qDate }
    : { agent: cols.cAgent, verdict: cols.cVerdict, info: cols.cInfo, comments: cols.cComments, date: cols.cDate };
}

function auditOptions_(sh, cols, role) {
  var c = auditRoleCols_(cols, role);
  return { verdict: auditListIn_(sh, c.verdict) || AUDIT_DEFAULT_OPTIONS.verdict, info: auditListIn_(sh, c.info) || AUDIT_DEFAULT_OPTIONS.info };
}

/* يقرأ قائمة الخيارات من الـ Data validation في الصف 2 */
function auditListIn_(sh, col) {
  if (col < 0 || sh.getLastRow() < 2) return null;
  var rule = sh.getRange(2, col + 1).getDataValidation();
  if (!rule || rule.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) return null;
  var values = rule.getCriteriaValues()[0];
  return values && values.length ? values.map(String) : null;
}

/* ===================== أدوات ===================== */

function auditCheckSecret_(key) {
  var expected = PropertiesService.getScriptProperties().getProperty("API_KEY");
  if (!expected) throw new Error("setup: شغّل الدالة setup مرة من المحرر أولاً");
  if (key !== expected) throw new Error("كلمة السر (API_KEY) غير صحيحة");
}

function auditSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(AUDIT_SHEET_NAME) || ss.getSheets()[0];
}

function auditIsDone_(v) { return AUDIT_NOT_DONE.indexOf(auditClean_(v).toLowerCase()) < 0; }
function auditNorm_(s) { return String(s).replace(/\s+/g, " ").trim().toLowerCase(); }
function auditClean_(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
function auditStr_(v) { return v == null ? "" : String(v); }

function auditOut_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
