# 🚀 Multi-Chain Crypto Payment Auto-Verifier + Telegram Admin Bot (Render Ready)

ለ **Render (render.com)** ተብሎ የተዘጋጀ፣ ለ **Solana, Polygon, BEP-20 (BSC), እና TON** ኔትወርኮች ለእያንዳንዱ ትዕዛዝ **Unique Address** በማመንጨት **ያለ TxHash** ክፍያዎችን በራስ-ሰር የሚያረጋግጥ እና **የቴሌግራም አድሚን ቦት (Telegram Admin Bot)** ያለው ፈጣን የክሪፕቶ ጌትዌይ ባክኢንድ።

---

## 🌟 ዋና ዋና ባህሪያት (Features)

1. **Unique Deposit Address:** ለእያንዳንዱ `order_id` በ 4ቱም ኔትወርኮች ላይ ራሱን የቻለ አድራሻ ያወጣል።
2. **ያለ Hash በራስ-ሰር ማረጋገጥ:** ደንበኛው ክፍያ ልኮ የግብይት ቁጥር (Hash) ማስገባት አይጠበቅበትም፤ ባክኢንዱ በየ 10 ሰከንዱ በ RPC በኩል አድራሻውን በመፈተሽ ክፍያው እንደገባ አውቶማቲክ ያረጋግጣል (`status: PAID`)።
3. **🤖 Telegram Admin Bot:**
   * **ቅጽበታዊ ማሳወቂያ (Instant Alert):** ደንበኛው ክፍያ በፈጸመ ቅጽበት ወደ እርስዎ ቴሌግራም ዝርዝር መረጃ ይልካል!
   * **በቴሌግራም አዲስ ደረሰኝ መፍጠር:** `/new 15` በማለት በሰከንድ ውስጥ የደንበኛ መክፈያ ሊንክ ያዘጋጁ።
   * **ሁኔታ መከታተያ:** `/status 1001` እና `/stats` የገቢ ሪፖርት ማየት።
4. **የተሟላ Web Service UI:** 
   * **Dashboard (`/`):** አጠቃላይ የክፍያዎች ሰንጠረዥ እና አዲስ ደረሰኝ መፍጠሪያ።
   * **Customer Checkout (`/pay/:order_id`):** ደንበኛው ገብቶ በ QR ኮድ የሚከፍልበትና በ 4 ሰከንድ ውስጥ ክፍያው ሲረጋገጥ አረንጓዴ የሚያበራ ገጽ።

---

## 🤖 የቴሌግራም ቦት ማዘጋጃ ቅደም ተከተል (2 ደቂቃ)

1. **Bot Token ማግኘት:**
   * ቴሌግራም ላይ [@BotFather](https://t.me/botfather) ይክፈቱ።
   * `/newbot` ብለው ይላኩለትና የቦቱን ስም ያስገቡ። የሚሰጥዎትን የ **HTTP API Token** ይያዙ።
2. **የራስዎን Chat ID ማግኘት:**
   * ቴሌግራም ላይ [@userinfobot](https://t.me/userinfobot) ይክፈቱና `/start` ይበሉት። የእርስዎን **Id** (ቁጥር) ይሰጥዎታል።
3. Render ላይ በሚከተሉት Environment Variables ውስጥ ያስገቧቸው፡
   * `TELEGRAM_BOT_TOKEN`: ከ BotFather ያገኙት ቶከን
   * `TELEGRAM_ADMIN_CHAT_ID`: ከ userinfobot ያገኙት የርስዎ ID
   * `APP_URL`: የእርስዎ የ Render ድረ-ገጽ አድራሻ (ለምሳሌ፡ `https://my-crypto.onrender.com`)

---

## 🛠️ ወደ GitHub እና Render የመጫኛ ቅደም ተከተል

```bash
cd "render-crypto-verifier"
git init
git add .
git commit -m "Render crypto verifier with Telegram Admin Bot"
git branch -M main
git remote add origin https://github.com/<YOUR_USERNAME>/<YOUR_REPO_NAME>.git
git push -u origin main
```

### Render ላይ መጫን፡
1. [dashboard.render.com](https://dashboard.render.com/) ይግቡ።
2. **New +** ➔ **Web Service** ብለው የ GitHub ሪፖዎን ያገናኙ።
3. በ **Environment Variables** ውስጥ የሚከተሉትን ያስገቡ፡
   * `MASTER_MNEMONIC`: የእርስዎ 12 ወይም 24 ቃላት
   * `TELEGRAM_BOT_TOKEN`: የቴሌግራም ቦት ቶከን
   * `TELEGRAM_ADMIN_CHAT_ID`: የእርስዎ የቴሌግራም Chat ID
   * `APP_URL`: የእርስዎ Render URL
4. **Deploy** ሲሉት በ 1 ደቂቃ ውስጥ ቦቱ እና ዌብሳይቱ Live ይሆናሉ!

---

## 📱 የቴሌግራም ቦት ትዕዛዞች (Bot Commands)

* `/start` - ቦቱን ለመክፈትና ዋና ሜኑ ለማየት
* `/new 25` - የ $25 ዶላር አዲስ የደንበኛ መክፈያ ሊንክ ለማመንጨት
* `/status 1001` - የትዕዛዝ ቁጥር #1001 ሁኔታ ለመፈተሽ
* `/stats` - አጠቃላይ የተከፈሉ ክፍያዎችንና ጠቅላላ ገቢ ለመመልከት
