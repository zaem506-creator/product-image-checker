# الوسيط بين الأداة و GitHub Models (Google Apps Script)

GitHub يرفض الاتصال من صفحة مفتوحة كملف على جهازك (CORS). هالسكربت يشتغل على سيرفرات Google: الأداة ترسل له، وهو يرسل لـ GitHub ويرجّع الجواب. والتوكن يبقى محفوظ داخل السكربت، مو في متصفحك.

## الإعداد (مرة وحدة)

1. ادخل **https://script.google.com** واضغط **New project**.
2. امسح الكود اللي فيه، والصق كل محتوى ملف **`Code.gs`**، واضغط 💾 **Save**.
3. **حط التوكن وكلمة السر:**
   - اضغط ⚙️ **Project Settings** من اليسار، وانزل لـ **Script Properties**، واضغط **Add script property**.
   - أضف خاصيتين:
     - `GITHUB_TOKEN` وقيمتها التوكن من GitHub (يبدأ بـ `github_pat_`).
     - `SECRET` وقيمتها كلمة سر تخترعها أنت، مثلاً `Hs-2026-image`.
   - اضغط **Save script properties**.
4. **جرّب التوكن:** ارجع لـ **Editor** (`<>`). من القائمة اللي فوق اختار الدالة **`test`** واضغط **▶ Run**. أول مرة يطلب صلاحيات: اضغط **Review permissions**، واختار حسابك، و**Allow**. تحت في **Execution log** لازم يطلع `200`. لو طلع `401`، التوكن ناقصه صلاحية **Models: Read-only**.
5. **انشره:** اضغط **Deploy ← New deployment**. من ⚙️ جنب Select type اختار **Web app**، وبعدها:
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
   - اضغط **Deploy** وانسخ **Web app URL** (ينتهي بـ `/exec`).
6. **في الأداة:** في خانة الإيجنت اختار **GitHub Models**، والصق **Web app URL** في الخانة الأولى، وكلمة السر (`SECRET`) في الثانية، واضغط **حفظ المفتاح**.

## ملاحظات
- **Anyone** معناها أي أحد عنده الرابط يقدر يرسل للسكربت. بس بدون كلمة السر يرفضه، فلا تشارك الرابط وكلمة السر مع بعض.
- لو شركتكم ما تسمح بـ **Anyone** في Google Workspace، الخيار بيطلع مقفل. وقتها تحتاج حساب Google شخصي، أو موافقة الـIT.
- لو عدّلت الكود بعدين: **Deploy ← Manage deployments ← ✏️ ← Version: New version ← Deploy**، عشان يبقى نفس الرابط.
