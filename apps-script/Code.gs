/**
 * Relay between the image-check page and GitHub Models.
 * GitHub Models refuses calls made straight from a page opened as a file (CORS); this script makes the call from
 * Google's servers instead and hands the answer back. The GitHub token stays here, in the script's properties.
 *
 * Script properties (Project Settings → Script Properties):
 *   GITHUB_TOKEN  the fine-grained token with "Models: Read-only"
 *   SECRET        a password you make up; the page sends it with every request, so no one else can use your token
 */
var GH_API = "https://models.github.ai/inference/chat/completions";

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ error: "bad request" }); }
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty("SECRET"), token = props.getProperty("GITHUB_TOKEN");
  if (!secret || !token) return out_({ error: "setup", message: "GITHUB_TOKEN or SECRET is missing in Script Properties" });
  if (req.secret !== secret) return out_({ error: "secret" });
  var res = UrlFetchApp.fetch(GH_API, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify(req.body),
    muteHttpExceptions: true,
  });
  var h = res.getHeaders();
  return out_({ status: res.getResponseCode(), body: res.getContentText(), retryAfter: h["Retry-After"] || h["retry-after"] || "" });
}

/* opening the web app's link in a browser shows {"ok":true} when it is deployed */
function doGet() {
  return out_({ ok: true });
}

/* Run this once from the editor (select "test", press Run): it checks the token works and shows GitHub's answer in the log */
function test() {
  var token = PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");
  var res = UrlFetchApp.fetch(GH_API, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ model: "openai/gpt-4.1", messages: [{ role: "user", content: "Say OK" }], max_tokens: 5 }),
    muteHttpExceptions: true,
  });
  Logger.log(res.getResponseCode() + " " + res.getContentText().slice(0, 300));
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
