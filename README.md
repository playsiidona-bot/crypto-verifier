# 🚀 Unified Crypto (Polygon & BEP-20) + Ethiopian Birr (Telebirr & CBE) Gateway

ለ **Render (render.com)** ተብሎ የተዘጋጀ፣ በ **Polygon (USDT)**፣ **BNB Smart Chain BEP-20 (USDT)** እና በኢትዮጵያ የሀገር ውስጥ ክፍያዎች (**Telebirr & CBE**) ክፍያዎችን የሚቀበል እና የሚያረጋግጥ የተሟላ ባክኢንድ እና **የአድሚን ቴሌግራም ቦት**።

---

## 🌟 ዋና ዋና ባህሪያት (Features)

1. **Polygon & BEP-20 (BSC) Auto-Verifier:** ለእያንዳንዱ ትዕዛዝ ወይም ደንበኛ ልዩ አድራሻ (Unique Address) በማውጣት ያለምንም TxHash በራስ-ሰር ያረጋግጣል።
2. **🇪🇹 Ethiopian Birr Gateway (Telebirr & CBE):** በ `abrhamyalew/unified-receipt-verifier` አሰራር መሰረት የቴሌብር እና የንግድ ባንክ (CBE) ደረሰኞችን አረጋግጦ ክፍያዎችን ይቀበላል።
3. **⏱️ Cronjob Keep-Alive (200 OK):** በ `https://your-app.onrender.com/ping` በኩል በነፃ የ Cronjob ሰርቪሶች (ለምሳሌ፡ cron-job.org ወይም UptimeRobot) በየ 5 ደቂቃው እየጠራ Render እንዳይተኛ (Sleep እንዳያደርግ) ያደርጋል።
4. **👑 Admin-Only Telegram Bot:** ቦቱ ለአስተዳዳሪው ብቻ የተፈቀደ ሲሆን ውብ ዩአይ (UI)፣ የትዕዛዝ ማመንጫ ካርድ እና የትራንዛክሽን መከታተያ አለው።
5. **🔍 On-Demand Transaction & Receipt Checker (`/check`):** ክፍያ በመሃል ቢዘገይ አድሚኑ በቀላሉ `/check <TxHash_ወይም_ደረሰኝ>` ብሎ በመላክ በሰከንዶች ውስጥ ማረጋገጥ ይችላል።
6. **🔄 Rescan (`/rescan`):** ሁሉንም አድራሻዎች በብሎክቼይን ላይ በአንድ ጊዜ ፈልጎ ወዲያውኑ የማረጋገጫ ትዕዛዝ።

---

## 📱 የቴሌግራም ቦት አጠቃቀም (Bot Commands)

* `/start` ➔ ዋናውን የአድሚን ዳሽቦርድ ሜኑ ለመክፈት
* `➕ አዲስ ደረሰኝ (New Invoice)` ወይም `/new 20` ➔ የ $20 USDT እና የብር (ETB) የክፍያ ካርድ ከነ አድራሻው ማመንጨት
* `🔍 ትራንዛክሽን ፈትሽ (Check Tx)` ወይም `/check <TxHash_ወይም_የቴሌብር_ደረሰኝ>` ➔ ክፍያን በብሎክቼይን ወይም በባንክ በኩል ማረጋገጥ
* `🔄 Rescan (አድራሻዎችን ፈትሽ)` ➔ ሁሉንም አድራሻዎች በአንድ ጊዜ ቃኝቶ ያረጋገጠበት
* `📊 የክፍያዎች ሪፖርት (Stats)` ➔ አጠቃላይ የተሰበሰበ ገቢና የተሳኩ ክፍያዎችን ማየት
* `⚡ የሲስተም ሁኔታ (Ping / Health)` ➔ የሰርቨሩን 200 OK ሁኔታ ማየት

---

## 🛠️ የ Cronjob ቅንብር (Render እንዳይተኛ)

1. ወደ [cron-job.org](https://cron-job.org) ወይም [uptimerobot.com](https://uptimerobot.com) ይግቡ።
2. አዲስ ሞኒተር ፍጠሩ፡
   * **URL:** `https://<YOUR_RENDER_URL>/ping`
   * **Interval:** በየ 5 ወይም 10 ደቂቃው
3. ሲስተሙ ሁልጊዜ **`200 OK`** ስለሚመልስ Render በፍጹም አይተኛም (24/7 ነቅቶ ይሰራል)!
