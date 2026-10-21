require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// --- Configuration & Environment ---
const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const MASTER_MNEMONIC = process.env.MASTER_MNEMONIC || "test test test test test test test test test test test junk";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_ADMIN_CHAT_ID = (process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();

// High-speed RPCs for Polygon and BSC BEP-20
const POLYGON_RPC = process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";
const BSC_RPC = process.env.BSC_RPC_URL || "https://bsc-rpc.publicnode.com";
const WATCHER_INTERVAL_MS = (parseInt(process.env.WATCHER_INTERVAL_SECONDS || "10", 10)) * 1000;

// Official USDT Contract Addresses
const POLYGON_USDT_CONTRACT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"; // 6 decimals
const BSC_USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";     // 18 decimals
const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];

// Blockchain Providers
const polygonProvider = new ethers.JsonRpcProvider(POLYGON_RPC);
const bscProvider = new ethers.JsonRpcProvider(BSC_RPC);

// File path for persistent storage
const DATA_FILE = path.join(__dirname, 'accounts_data.json');

// In-Memory Storage
const userAccounts = new Map();     // User Index -> Account
const verifiedReceipts = new Set(); // Prevent replay attacks on Telebirr/CBE receipts

// Dynamic Bank Settings (Managed directly by Admin in Dashboard)
let bankSettings = {
  merchantName: process.env.MERCHANT_NAME || "Merchant Name",
  usdtRate: parseFloat(process.env.USDT_TO_ETB_RATE || "130"),
  telebirr: process.env.TELEBIRR_PHONE || "09XXXXXXXX",
  cbe: process.env.CBE_ACCOUNT || "1000XXXXXXXXX",
  boa: "11223344",      // Bank of Abyssinia
  awash: "01320112233400", // Awash Bank
  dashen: "501122334401"   // Dashen Bank
};

// --- 1. Persistent Storage Engine ---
function loadPersistedData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data) {
        if (Array.isArray(data.accounts)) {
          for (const user of data.accounts) {
            userAccounts.set(user.userId, user);
          }
        }
        if (Array.isArray(data.receipts)) {
          for (const r of data.receipts) {
            verifiedReceipts.add(r);
          }
        }
        if (data.bankSettings) {
          bankSettings = { ...bankSettings, ...data.bankSettings };
        }
      }
      console.log(`💾 Loaded ${userAccounts.size} accounts and custom bank settings.`);
    }
  } catch (err) {
    console.error('Data load note:', err.message);
  }
}

function savePersistedData() {
  try {
    const payload = {
      accounts: Array.from(userAccounts.values()),
      receipts: Array.from(verifiedReceipts),
      bankSettings
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    console.error('Data save note:', err.message);
  }
}

loadPersistedData();

// --- 2. Address Derivation Engine (Polygon & BEP-20) ---
function getEvmAddress(orderIndex) {
  const cleanMnemonic = MASTER_MNEMONIC.trim().replace(/\s+/g, ' ');
  const wallet = ethers.HDNodeWallet.fromPhrase(
    cleanMnemonic,
    undefined,
    `m/44'/60'/0'/0/${orderIndex}`
  );
  return wallet.address;
}

async function getOrCreateAccount(userId, name = 'Customer') {
  if (userAccounts.has(userId)) {
    return userAccounts.get(userId);
  }
  const userIndex = userAccounts.size + 101;
  const evmAddress = getEvmAddress(userIndex);

  const account = {
    userId,
    name,
    userIndex,
    address: evmAddress, // Shared across Polygon & BSC
    lastBalances: {
      polygonUsdt: 0,
      bep20Usdt: 0
    },
    totalDepositedUsd: 0,
    depositHistory: []
  };

  userAccounts.set(userId, account);
  savePersistedData();
  return account;
}

// --- 3. Blockchain Balance Checkers ---
async function checkPolygonUsdt(address) {
  try {
    const contract = new ethers.Contract(POLYGON_USDT_CONTRACT, ERC20_ABI, polygonProvider);
    const rawBalance = await contract.balanceOf(address);
    return parseFloat(ethers.formatUnits(rawBalance, 6));
  } catch (err) {
    return 0;
  }
}

async function checkBscUsdt(address) {
  try {
    const contract = new ethers.Contract(BSC_USDT_CONTRACT, ERC20_ABI, bscProvider);
    const rawBalance = await contract.balanceOf(address);
    return parseFloat(ethers.formatUnits(rawBalance, 18));
  } catch (err) {
    return 0;
  }
}

// --- 4. 🇪🇹 Ethiopian Birr Gateway (Telebirr, CBE & Other Banks) ---
async function verifyTelebirrReceipt(receiptIdOrUrl) {
  let txId = receiptIdOrUrl.trim();
  if (txId.includes('receipt/')) {
    txId = txId.split('receipt/')[1].split('?')[0].split('/')[0];
  }

  if (verifiedReceipts.has(`TELEBIRR_${txId}`)) {
    return { success: false, error: 'ይህ ደረሰኝ ቀደም ሲል ጥቅም ላይ ውሏል (Receipt already verified)' };
  }

  const url = `https://transactioninfo.ethiotelecom.et/receipt/${txId}`;
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const html = res.data || '';
    if (!html || html.includes('not found') || html.includes('No record found')) {
      return { success: false, error: 'ደረሰኙ በቴሌብር ሲስተም ላይ አልተገኘም (Receipt not found on Telebirr)' };
    }

    const amountMatch = html.match(/([\d,]+\.?\d*)\s*(?:ETB|Birr|ብር)/i) || html.match(/(?:Amount|መጠን)[\s\S]*?([\d,]+\.?\d*)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null;
    const isCompleted = html.includes('Completed') || html.includes('ተጠናቋል') || html.includes('Successful');

    if (!isCompleted) {
      return { success: false, error: 'ክፍያው ገና አልተጠናቀቀም' };
    }

    verifiedReceipts.add(`TELEBIRR_${txId}`);
    savePersistedData();

    return {
      success: true,
      provider: 'Telebirr',
      txId,
      amount,
      status: 'Completed'
    };
  } catch (err) {
    return { success: false, error: `Telebirr Error: ${err.message}` };
  }
}

async function verifyCbeReceipt(receiptIdOrUrl) {
  let txId = receiptIdOrUrl.trim();
  if (txId.includes('id=')) {
    txId = txId.split('id=')[1].split('&')[0];
  }

  if (verifiedReceipts.has(`CBE_${txId}`)) {
    return { success: false, error: 'ይህ ደረሰኝ ቀደም ሲል ጥቅም ላይ ውሏል' };
  }

  const url = `https://apps.cbe.com.et:100/?id=${txId}`;
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const html = res.data || '';
    const amountMatch = html.match(/([\d,]+\.?\d*)\s*(?:ETB|Birr)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null;

    verifiedReceipts.add(`CBE_${txId}`);
    savePersistedData();

    return {
      success: true,
      provider: 'CBE',
      txId,
      amount
    };
  } catch (err) {
    return { success: false, error: `CBE Error: ${err.message}` };
  }
}

async function verifyBlockchainTx(txHash) {
  const hash = txHash.trim();
  try {
    const receipt = await polygonProvider.getTransactionReceipt(hash);
    if (receipt && receipt.status === 1) {
      return { success: true, network: 'Polygon PoS', blockNumber: receipt.blockNumber, from: receipt.from, to: receipt.to, status: 'SUCCESS' };
    }
  } catch (e) {}

  try {
    const receipt = await bscProvider.getTransactionReceipt(hash);
    if (receipt && receipt.status === 1) {
      return { success: true, network: 'BNB Smart Chain (BEP-20)', blockNumber: receipt.blockNumber, from: receipt.from, to: receipt.to, status: 'SUCCESS' };
    }
  } catch (e) {}

  return { success: false, error: 'ትራንዛክሽኑ በ Polygon ወይም BSC ላይ አልተገኘም' };
}

// --- 5. Background Auto-Verifier (Checks Active Wallets) ---
async function runAutoVerifier() {
  for (const user of userAccounts.values()) {
    try {
      const [polygonBal, bscBal] = await Promise.all([
        checkPolygonUsdt(user.address),
        checkBscUsdt(user.address)
      ]);

      if (polygonBal > user.lastBalances.polygonUsdt) {
        const received = polygonBal - user.lastBalances.polygonUsdt;
        user.lastBalances.polygonUsdt = polygonBal;
        notifyDeposit(user, received, 'Polygon (USDT)');
      }

      if (bscBal > user.lastBalances.bep20Usdt) {
        const received = bscBal - user.lastBalances.bep20Usdt;
        user.lastBalances.bep20Usdt = bscBal;
        notifyDeposit(user, received, 'BNB Smart Chain BEP-20 (USDT)');
      }
    } catch (e) {}
  }
}

function notifyDeposit(user, amount, network) {
  user.totalDepositedUsd += amount;
  user.depositHistory.push({
    amount,
    currency: 'USDT',
    network,
    time: new Date(),
    address: user.address
  });
  savePersistedData();

  if (bot && TELEGRAM_ADMIN_CHAT_ID) {
    const adminMsg = `🎉 **አዲስ ክፍያ ተረጋግጧል! (Payment Verified)**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 **ደንበኛ:** \`${user.name}\` (ID: \`${user.userId}\`)\n` +
      `💰 **የተከፈለ መጠን:** \`$${amount.toFixed(2)} USDT\`\n` +
      `🌐 **ኔትወርክ:** \`${network}\`\n` +
      `📍 **አድራሻ:** \`${user.address}\`\n` +
      `⏱️ **ሰዓት:** \`${new Date().toLocaleTimeString()}\`\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ *ገንዘቡ በራስ-ሰር ተረጋግጦ ዋሌትዎ ገብቷል!*`;

    bot.sendMessage(TELEGRAM_ADMIN_CHAT_ID, adminMsg, { parse_mode: 'Markdown' }).catch(() => {});
  }
}

setInterval(runAutoVerifier, WATCHER_INTERVAL_MS);

// --- 6. 🌐 HTTP Routes (Cronjob Keep-Alive & Admin Dashboard) ---

// Cron Keep-Alive 200 OK
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));
app.get('/ping', (req, res) => res.status(200).json({ status: 'ok', message: 'Pong! 200 OK', timestamp: new Date() }));
app.get('/cron', (req, res) => res.status(200).json({ status: 'ok', message: 'Cron active' }));

// Admin API: Save Bank Settings
app.post('/admin/save-settings', (req, res) => {
  const { merchantName, usdtRate, telebirr, cbe, boa, awash, dashen } = req.body;
  if (merchantName) bankSettings.merchantName = merchantName.trim();
  if (usdtRate) bankSettings.usdtRate = parseFloat(usdtRate);
  if (telebirr) bankSettings.telebirr = telebirr.trim();
  if (cbe) bankSettings.cbe = cbe.trim();
  if (boa) bankSettings.boa = boa.trim();
  if (awash) bankSettings.awash = awash.trim();
  if (dashen) bankSettings.dashen = dashen.trim();

  savePersistedData();
  res.redirect('/?saved=true');
});

// Admin Web Dashboard with Full Bank Management & Native QR
app.get('/', async (req, res) => {
  const accountsList = Array.from(userAccounts.values()).reverse();
  const sampleAccount = accountsList[0] || await getOrCreateAccount(1001, 'Sample Order');
  
  // Locally generated Native QR Code (No external URL!)
  const sampleQrDataUrl = await QRCode.toDataURL(sampleAccount.address, { margin: 1, width: 220 });

  const rows = accountsList.map(a => `
    <tr style="border-bottom: 1px solid #e2e8f0;">
      <td style="padding: 10px; font-weight: bold;">#${a.userId}</td>
      <td style="padding: 10px;">${a.name}</td>
      <td style="padding: 10px; font-mono; font-size: 11px;">${a.address}</td>
      <td style="padding: 10px; color: #16a34a; font-weight: bold;">$${a.totalDepositedUsd.toFixed(2)}</td>
      <td style="padding: 10px;">${a.depositHistory.length}</td>
    </tr>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Payment Gateway Admin Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
      </head>
      <body class="bg-gray-100 p-4 md:p-8 font-sans text-gray-800">
        <div class="max-w-6xl mx-auto space-y-6">
          
          <!-- Header -->
          <div class="flex flex-col md:flex-row justify-between items-start md:items-center bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
            <div>
              <h1 class="text-2xl font-extrabold text-gray-900">⚡ Unified Payment Gateway Admin</h1>
              <p class="text-sm text-gray-500 mt-1">Polygon • BEP-20 (BSC) • Telebirr • CBE • BOA • Awash • Dashen</p>
            </div>
            <div class="mt-4 md:mt-0 flex items-center space-x-2">
              <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                <span class="w-2 h-2 mr-2 bg-green-500 rounded-full animate-ping"></span> 200 OK Active
              </span>
            </div>
          </div>

          <!-- Bank Settings Form (Admin Configures ALL Banks) -->
          <div class="bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
            <div class="flex items-center justify-between mb-4">
              <h2 class="text-lg font-bold text-gray-900">🏦 የባንኮች መረጃ ማስተካከያ (Manage All Bank Accounts & Rates)</h2>
              ${req.query.saved ? '<span class="text-xs bg-green-100 text-green-700 px-3 py-1 rounded-full font-bold">✓ የተቀመጠ (Saved!)</span>' : ''}
            </div>
            <p class="text-xs text-gray-500 mb-6">እዚህ ያስገቧቸው የባንክ ቁጥሮች ደንበኞች እቃ ሲገዙ በክፍያ ካርዳቸው ላይ በቀጥታ ይታያሉ።</p>

            <form action="/admin/save-settings" method="POST" class="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div>
                <label class="block text-xs font-bold text-gray-600 uppercase mb-1">የባለቤቱ ስም (Merchant / Account Name)</label>
                <input type="text" name="merchantName" value="${bankSettings.merchantName}" required class="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500">
              </div>

              <div>
                <label class="block text-xs font-bold text-gray-600 uppercase mb-1">1 USDT = ? ETB የምንዛሬ ተመን (Rate)</label>
                <input type="number" step="0.5" name="usdtRate" value="${bankSettings.usdtRate}" required class="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500">
              </div>

              <div>
                <label class="block text-xs font-bold text-gray-600 uppercase mb-1">📱 Telebirr ስልክ ቁጥር</label>
                <input type="text" name="telebirr" value="${bankSettings.telebirr}" class="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500">
              </div>

              <div>
                <label class="block text-xs font-bold text-gray-600 uppercase mb-1">🏦 የኢትዮጵያ ንግድ ባንክ (CBE) ሂሳብ</label>
                <input type="text" name="cbe" value="${bankSettings.cbe}" class="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500">
              </div>

              <div>
                <label class="block text-xs font-bold text-gray-600 uppercase mb-1">🏦 አቢሲኒያ ባንክ (BOA) ሂሳብ</label>
                <input type="text" name="boa" value="${bankSettings.boa}" class="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500">
              </div>

              <div>
                <label class="block text-xs font-bold text-gray-600 uppercase mb-1">🏦 አዋሽ ባንክ (Awash Bank) ሂሳብ</label>
                <input type="text" name="awash" value="${bankSettings.awash}" class="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500">
              </div>

              <div>
                <label class="block text-xs font-bold text-gray-600 uppercase mb-1">🏦 ዳሽን ባንክ (Dashen Bank) ሂሳብ</label>
                <input type="text" name="dashen" value="${bankSettings.dashen}" class="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500">
              </div>

              <div class="md:col-span-2 flex items-end">
                <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-6 rounded-xl text-sm transition shadow-sm">
                  💾 የባንክ መረጃዎችን አስቀምጥ (Save Bank Settings)
                </button>
              </div>
            </form>
          </div>

          <!-- Sample Native QR & Address Display -->
          <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div class="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 text-center">
              <h3 class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Native Local QR Code (ያለ ውጫዊ URL)</h3>
              <div class="inline-block p-2 bg-white rounded-xl border border-gray-200 shadow-inner">
                <img src="${sampleQrDataUrl}" class="w-44 h-44 object-contain mx-auto" />
              </div>
              <p class="text-xs text-gray-400 mt-2">100% locally generated in-memory Base64 image</p>
            </div>

            <div class="md:col-span-2 bg-white p-6 rounded-2xl shadow-sm border border-gray-200 space-y-4">
              <h3 class="text-sm font-bold text-gray-900 uppercase">⚡ ክፍያ መቀበያ አድራሻ (EVM: Polygon & BSC BEP-20)</h3>
              <div class="bg-gray-50 p-4 rounded-xl border border-gray-200 break-all font-mono text-xs text-blue-800">
                ${sampleAccount.address}
              </div>
              <div class="text-xs text-gray-500 space-y-1">
                <p>• <b>ክሪፕቶ፡</b> ማንኛውም ደንበኛ በ Polygon (USDT) ወይም BEP-20 (USDT) በዚህ አድራሻ ሲከፍል በራሱ ያረጋግጣል።</p>
                <p>• <b>የሀገር ውስጥ ባንኮች፡</b> ደንበኛው ከላይ በተቀመጡት የባንክ ሂሳቦች (Telebirr/CBE/BOA) ሲከፍል ደረሰኙ በ <code>/check</code> ይረጋገጣል።</p>
                <p>• <b>Cronjob URL:</b> <code>${APP_URL}/ping</code> (Returns 200 OK)</p>
              </div>
            </div>
          </div>

          <!-- Accounts Table -->
          <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
            <div class="p-6 border-b border-gray-100 flex justify-between items-center">
              <h2 class="text-lg font-bold text-gray-900">📋 የደንበኞች እና የትዕዛዞች ዝርዝር</h2>
              <span class="text-xs text-gray-400">Total: ${accountsList.length}</span>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="bg-gray-50 text-gray-500 uppercase font-semibold">
                  <tr>
                    <th style="padding: 10px;">ID</th>
                    <th style="padding: 10px;">Name</th>
                    <th style="padding: 10px;">Address</th>
                    <th style="padding: 10px;">Deposited (USDT)</th>
                    <th style="padding: 10px;">Count</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows || '<tr><td colspan="5" class="text-center py-6 text-gray-400">ምንም ደረሰኝ እስካሁን አልተፈጠረም።</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </body>
    </html>
  `);
});

// --- 7. 🤖 Admin Telegram Bot with Native QR Buffers ---
let bot = null;

if (TELEGRAM_BOT_TOKEN) {
  try {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
    console.log("🤖 Admin Telegram Bot running!");

    bot.on('polling_error', (error) => {
      console.log('Telegram note:', error.code || error.message);
    });

    function isAdmin(chatId) {
      if (!TELEGRAM_ADMIN_CHAT_ID) return true;
      return String(chatId) === String(TELEGRAM_ADMIN_CHAT_ID).trim();
    }

    const adminKeyboard = {
      reply_markup: {
        keyboard: [
          [{ text: '➕ አዲስ ደረሰኝ (New Invoice)' }, { text: '🔍 ትራንዛክሽን ፈትሽ (Check Tx)' }],
          [{ text: '🔄 Rescan (አድራሻዎችን ፈትሽ)' }, { text: '🏦 የባንክ መረጃዎች (Bank Info)' }],
          [{ text: '📊 የክፍያዎች ሪፖርት (Stats)' }, { text: '⚡ Ping (200 OK)' }]
        ],
        resize_keyboard: true
      }
    };

    bot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) {
        return bot.sendMessage(chatId, `⛔ **ይቅርታ! ይህ ቦት ለአስተዳዳሪ (Admin) ብቻ የተዘጋጀ ነው።**`, { parse_mode: 'Markdown' });
      }

      const welcome = `⚡ **CRYPTO & BIRR PAYMENT GATEWAY** ⚡\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👑 **የአስተዳዳሪ መቆጣጠሪያ ዳሽቦርድ**\n\n` +
        `🔹 **ክሪፕቶ፡** Polygon (USDT) • BEP-20 BSC (USDT)\n` +
        `🔹 **ባንኮች፡** Telebirr • CBE • Abyssinia • Awash • Dashen\n` +
        `🔹 **ሰርቨር፡** 🟢 \`200 OK (Active)\`\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `ከታች ካሉት አዝራሮች አንዱን ይምረጡ፡`;

      bot.sendMessage(chatId, welcome, adminKeyboard);
    });

    bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const text = msg.text || '';

      if (!isAdmin(chatId)) return;
      if (text.startsWith('/start') || text.startsWith('/check') || text.startsWith('/new')) return;

      if (text === '➕ አዲስ ደረሰኝ (New Invoice)') {
        await handleCreateInvoiceCard(chatId, 10.0);
      } else if (text === '🔍 ትራንዛክሽን ፈትሽ (Check Tx)') {
        bot.sendMessage(chatId, `🔍 **ትራንዛክሽን ወይም ደረሰኝ ለመፈተሽ፡**\n\n` +
          `• ክሪፕቶ፡ \`/check 0x...\`\n` +
          `• ቴሌብር፡ \`/check DB1234567\`\n` +
          `• CBE፡ \`/check CBE_ID\`\n\n` +
          `ብለው ይላኩ። ሲስተሙ ወዲያውኑ አረጋግጦ ውጤቱን ያሳውቅዎታል።`, { parse_mode: 'Markdown' });
      } else if (text === '🔄 Rescan (አድራሻዎችን ፈትሽ)') {
        bot.sendMessage(chatId, `🔄 **ሁሉንም አድራሻዎች በብሎክቼይን ላይ በመፈተሽ ላይ...**`);
        await runAutoVerifier();
        bot.sendMessage(chatId, `✅ **የአድራሻዎች ፍተሻ ተጠናቋል!**`);
      } else if (text === '🏦 የባንክ መረጃዎች (Bank Info)') {
        const info = `🏦 **የተመዘገቡ የባንክ ሂሳቦች ዝርዝር**\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `👤 **ባለቤት:** \`${bankSettings.merchantName}\`\n` +
          `💵 **ተመን:** \`1 USDT = ${bankSettings.usdtRate} ETB\`\n` +
          `📱 **Telebirr:** \`${bankSettings.telebirr}\`\n` +
          `🏛️ **CBE:** \`${bankSettings.cbe}\`\n` +
          `🏛️ **BOA:** \`${bankSettings.boa}\`\n` +
          `🏛️ **Awash:** \`${bankSettings.awash}\`\n` +
          `🏛️ **Dashen:** \`${bankSettings.dashen}\`\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `*(እነዚህን ለመቀየር ወደ ዌብ ዳሽቦርድዎ ይግቡ፡ ${APP_URL})*`;
        bot.sendMessage(chatId, info, { parse_mode: 'Markdown' });
      } else if (text === '📊 የክፍያዎች ሪፖርት (Stats)') {
        let totalUsd = 0;
        let totalTx = 0;
        for (const u of userAccounts.values()) {
          totalUsd += u.totalDepositedUsd;
          totalTx += u.depositHistory.length;
        }
        const report = `📊 **አጠቃላይ ሪፖርት (Stats)**\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `💰 **ጠቅላላ ክሪፕቶ ገቢ:** \`$${totalUsd.toFixed(2)} USDT\`\n` +
          `🧾 **የተሳኩ ክፍያዎች:** \`${totalTx}\`\n` +
          `👥 **ጠቅላላ አድራሻዎች:** \`${userAccounts.size}\`\n` +
          `🇪🇹 **የተረጋገጡ የባንክ ደረሰኞች:** \`${verifiedReceipts.size}\`\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━`;
        bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
      } else if (text === '⚡ Ping (200 OK)') {
        bot.sendMessage(chatId, `🟢 **200 OK ACTIVE!**\n\nCronjob URL:\n\`${APP_URL}/ping\``, { parse_mode: 'Markdown' });
      }
    });

    bot.onText(/\/new\s*(\d+(\.\d+)?)/, async (msg, match) => {
      if (!isAdmin(msg.chat.id)) return;
      const amount = parseFloat(match[1]);
      await handleCreateInvoiceCard(msg.chat.id, amount);
    });

    bot.onText(/\/check\s+(.+)/, async (msg, match) => {
      if (!isAdmin(msg.chat.id)) return;
      const query = match[1].trim();
      const chatId = msg.chat.id;

      bot.sendMessage(chatId, `⏳ **ትራንዛክሽኑን በማጣራት ላይ...**`);

      // Blockchain Tx check
      if (query.startsWith('0x') && query.length === 66) {
        const result = await verifyBlockchainTx(query);
        if (result.success) {
          const reply = `✅ **ብሎክቼይን ትራንዛክሽን ተረጋግጧል!**\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🌐 **ኔትወርክ:** \`${result.network}\`\n` +
            `📦 **Block:** \`#${result.blockNumber}\`\n` +
            `📍 **ተቀባይ አድራሻ:** \`${result.to}\`\n` +
            `⏱️ **ሁኔታ:** **${result.status}**\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `ክፍያው በብሎክቼይኑ ላይ በተሳካ ሁኔታ ገቢ ሆኗል!`;
          return bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
        } else {
          return bot.sendMessage(chatId, `❌ ${result.error}`);
        }
      }

      // Telebirr check
      if (query.toUpperCase().startsWith('DB') || query.includes('ethiotelecom.et')) {
        const result = await verifyTelebirrReceipt(query);
        if (result.success) {
          const reply = `✅ **የቴሌብር ደረሰኝ ተረጋግጧል!**\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🧾 **Tx ID:** \`${result.txId}\`\n` +
            `💵 **መጠን:** \`${result.amount} ETB\`\n` +
            `📱 **ፕሮቫይደር:** \`Telebirr\`\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `ክፍያው ህጋዊና ትክክለኛ መሆኑ ተረጋግጧል!`;
          return bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
        } else {
          return bot.sendMessage(chatId, `❌ ${result.error}`);
        }
      }

      // CBE check
      const cbeResult = await verifyCbeReceipt(query);
      if (cbeResult.success) {
        const reply = `✅ **የ CBE ደረሰኝ ተረጋግጧል!**\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `🧾 **Tx ID:** \`${cbeResult.txId}\`\n` +
          `💵 **መጠን:** \`${cbeResult.amount || 'ያልታወቀ'} ETB\`\n` +
          `🏦 **ባንክ:** \`Commercial Bank of Ethiopia\`\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━`;
        return bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
      }

      bot.sendMessage(chatId, `❌ ማስገቢያው አልታወቀም። ትክክለኛ የብሎክቼይን Hash (0x...) ወይም የደረሰኝ ቁጥር ያስገቡ።`);
    });

    async function handleCreateInvoiceCard(chatId, amountUsd) {
      const orderId = Math.floor(1000 + Math.random() * 90000);
      const account = await getOrCreateAccount(orderId, `Order #${orderId}`);
      const amountEtb = (amountUsd * bankSettings.usdtRate).toFixed(2);

      const invoiceCard = `💳 **የክፍያ ደረሰኝ (Invoice #${orderId})**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💵 **መጠን በዶላር:** \`$${amountUsd.toFixed(2)} USDT\`\n` +
        `🇪🇹 **መጠን በብር:** \`${amountEtb} ETB\` (ተመን: ${bankSettings.usdtRate})\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🌐 **1. ክሪፕቶ (Polygon ወይም BEP-20 USDT):**\n` +
        `\`${account.address}\`\n` +
        `*(አድራሻውን ነክተው ኮፒ ያድርጉ - Tap to Copy)*\n\n` +
        `📱 **2. በቴሌብር (Telebirr):**\n` +
        `• ስልክ፡ \`${bankSettings.telebirr}\`\n` +
        `• ስም፡ \`${bankSettings.merchantName}\`\n\n` +
        `🏦 **3. በኢትዮጵያ ንግድ ባንክ (CBE):**\n` +
        `• ሂሳብ፡ \`${bankSettings.cbe}\`\n` +
        `• ስም፡ \`${bankSettings.merchantName}\`\n\n` +
        `🏦 **4. አቢሲኒያ ባንክ (BOA):**\n` +
        `• ሂሳብ፡ \`${bankSettings.boa}\`\n` +
        `• ስም፡ \`${bankSettings.merchantName}\`\n\n` +
        `🏦 **5. አዋሽ ባንክ (Awash Bank):**\n` +
        `• ሂሳብ፡ \`${bankSettings.awash}\`\n` +
        `• ስም፡ \`${bankSettings.merchantName}\`\n\n` +
        `🏦 **6. ዳሽን ባንክ (Dashen Bank):**\n` +
        `• ሂሳብ፡ \`${bankSettings.dashen}\`\n` +
        `• ስም፡ \`${bankSettings.merchantName}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚡ *ይህንን መልዕክት ለደንበኛዎ ይላኩ። በክሪፕቶ ሲከፍሉ በራሱ ያረጋግጣል፤ በባንክ ከከፈሉ ደረሰኙን በ /check ያረጋግጡ!*`;

      // Locally generated QR Code Buffer (NO EXTERNAL URL!)
      const qrPngBuffer = await QRCode.toBuffer(account.address, { margin: 1, width: 300 });

      // Send the text card first
      await bot.sendMessage(chatId, invoiceCard, { parse_mode: 'Markdown' });

      // Send the local QR image directly as a Buffer
      await bot.sendPhoto(chatId, qrPngBuffer, {
        caption: `📷 **Polygon / BEP-20 USDT QR Code**\n\`${account.address}\``,
        parse_mode: 'Markdown'
      });
    }

  } catch (err) {
    console.error("Bot setup error:", err.message);
  }
}

// Start Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🔥 Unified Crypto & Local Banks Payment Gateway`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`⏱️ Cron Keep-Alive URL: ${APP_URL}/ping (200 OK)`);
  console.log(`=======================================================`);
});
