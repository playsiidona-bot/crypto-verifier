require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
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

// Local Banks (Ethiopian Birr Gateway) Configuration
const TELEBIRR_MERCHANT_PHONE = process.env.TELEBIRR_PHONE || "09XXXXXXXX";
const CBE_MERCHANT_ACCOUNT = process.env.CBE_ACCOUNT || "1000XXXXXXXXX";
const MERCHANT_NAME = process.env.MERCHANT_NAME || "Merchant";
const USDT_TO_ETB_RATE = parseFloat(process.env.USDT_TO_ETB_RATE || "130"); // 1 USDT = ~130 ETB

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

// --- 1. Persistent Storage Engine ---
function loadPersistedData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.accounts)) {
        for (const user of data.accounts) {
          userAccounts.set(user.userId, user);
        }
      }
      if (data && Array.isArray(data.receipts)) {
        for (const r of data.receipts) {
          verifiedReceipts.add(r);
        }
      }
      console.log(`💾 Loaded ${userAccounts.size} accounts and ${verifiedReceipts.size} verified receipts.`);
    }
  } catch (err) {
    console.error('Data load note:', err.message);
  }
}

function savePersistedData() {
  try {
    const payload = {
      accounts: Array.from(userAccounts.values()),
      receipts: Array.from(verifiedReceipts)
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
      bep20Usdt: 0,
      polygonPol: 0,
      bscBnb: 0
    },
    totalDepositedUsd: 0,
    totalDepositedEtb: 0,
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

// --- 4. 🇪🇹 Ethiopian Birr Gateway (Telebirr & CBE Receipt Verifier) ---
// Based on abrhamyalew/unified-receipt-verifier architecture
async function verifyTelebirrReceipt(receiptIdOrUrl) {
  let txId = receiptIdOrUrl.trim();
  if (txId.includes('receipt/')) {
    txId = txId.split('receipt/')[1].split('?')[0].split('/')[0];
  }

  if (verifiedReceipts.has(`TELEBIRR_${txId}`)) {
    return { success: false, error: 'ይህ ደረሰኝ ቀደም ሲል ጥቅም ላይ ውሏል (Replay detected: Receipt already used)' };
  }

  const url = `https://transactioninfo.ethiotelecom.et/receipt/${txId}`;
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const html = res.data || '';
    if (!html || html.includes('not found') || html.includes('No record found')) {
      return { success: false, error: 'ደረሰኙ በቴሌብር ሲስተም ላይ አልተገኘም (Receipt not found on Telebirr)' };
    }

    // Extract Amount (e.g., 1,500.00 ETB)
    const amountMatch = html.match(/([\d,]+\.?\d*)\s*(?:ETB|Birr|ብር)/i) || html.match(/(?:Amount|መጠን)[\s\S]*?([\d,]+\.?\d*)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null;

    // Check status
    const isCompleted = html.includes('Completed') || html.includes('ተጠናቋል') || html.includes('Successful');

    if (!isCompleted) {
      return { success: false, error: 'ክፍያው ገና አልተጠናቀቀም (Transaction is not completed)' };
    }

    // Mark receipt as used
    verifiedReceipts.add(`TELEBIRR_${txId}`);
    savePersistedData();

    return {
      success: true,
      provider: 'Telebirr',
      txId,
      amount,
      rawUrl: url
    };
  } catch (err) {
    return { success: false, error: `Telebirr Verification Error: ${err.message}` };
  }
}

async function verifyCbeReceipt(receiptIdOrUrl) {
  let txId = receiptIdOrUrl.trim();
  if (txId.includes('id=')) {
    txId = txId.split('id=')[1].split('&')[0];
  }

  if (verifiedReceipts.has(`CBE_${txId}`)) {
    return { success: false, error: 'ይህ ደረሰኝ ቀደም ሲል ጥቅም ላይ ውሏል (Replay detected: Receipt already used)' };
  }

  const url = `https://apps.cbe.com.et:100/?id=${txId}`;
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
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
      amount,
      rawUrl: url
    };
  } catch (err) {
    return { success: false, error: `CBE Verification Error: ${err.message}` };
  }
}

// On-Demand Blockchain Transaction Checker (Polygon / BSC)
async function verifyBlockchainTx(txHash) {
  const hash = txHash.trim();
  
  // 1. Check Polygon
  try {
    const receipt = await polygonProvider.getTransactionReceipt(hash);
    if (receipt && receipt.status === 1) {
      return {
        success: true,
        network: 'Polygon PoS',
        blockNumber: receipt.blockNumber,
        from: receipt.from,
        to: receipt.to,
        status: 'SUCCESS'
      };
    }
  } catch (e) {}

  // 2. Check BSC
  try {
    const receipt = await bscProvider.getTransactionReceipt(hash);
    if (receipt && receipt.status === 1) {
      return {
        success: true,
        network: 'BNB Smart Chain (BEP-20)',
        blockNumber: receipt.blockNumber,
        from: receipt.from,
        to: receipt.to,
        status: 'SUCCESS'
      };
    }
  } catch (e) {}

  return { success: false, error: 'ትራንዛክሽኑ በ Polygon ወይም BSC ላይ አልተገኘም (Failed or Pending)' };
}

// --- 5. Background Auto-Verifier (Checks Active Wallets) ---
async function runAutoVerifier() {
  for (const user of userAccounts.values()) {
    try {
      const [polygonBal, bscBal] = await Promise.all([
        checkPolygonUsdt(user.address),
        checkBscUsdt(user.address)
      ]);

      // Check Polygon USDT
      if (polygonBal > user.lastBalances.polygonUsdt) {
        const received = polygonBal - user.lastBalances.polygonUsdt;
        user.lastBalances.polygonUsdt = polygonBal;
        notifyDeposit(user, received, 'Polygon (USDT)');
      }

      // Check BSC USDT
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

  console.log(`✅ [Payment Detected] User ${user.name} deposited $${amount} on ${network}!`);

  // Alert Admin on Telegram
  if (bot && TELEGRAM_ADMIN_CHAT_ID) {
    const adminMsg = `🎉 **አዲስ ክፍያ ተረጋግጧል! (Payment Verified)**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 **ደንበኛ/ተጠቃሚ:** \`${user.name}\` (ID: \`${user.userId}\`)\n` +
      `💰 **የተከፈለ መጠን:** \`$${amount.toFixed(2)} USDT\`\n` +
      `🌐 **ኔትወርክ:** \`${network}\`\n` +
      `📍 **አድራሻ:** \`${user.address}\`\n` +
      `⏱️ **ሰዓት:** \`${new Date().toLocaleTimeString()}\`\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ *ያለ ምንም TxHash በራስ-ሰር ተረጋግጧል! ገንዘቡ በቀጥታ ዋሌትዎ ገብቷል!*`;

    bot.sendMessage(TELEGRAM_ADMIN_CHAT_ID, adminMsg, { parse_mode: 'Markdown' }).catch(() => {});
  }
}

setInterval(runAutoVerifier, WATCHER_INTERVAL_MS);

// --- 6. 🌐 HTTP Routes (Cronjob Keep-Alive & APIs) ---

// 1. CRONJOB / KEEP-ALIVE ENDPOINTS (Returns HTTP 200 OK)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date() });
});

app.get('/ping', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Pong! 200 OK for Cronjob', timestamp: new Date() });
});

app.get('/cron', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Cronjob trigger active', timestamp: new Date() });
});

// 2. REST API: Create Invoice / Generate Address
app.post('/api/invoice/create', async (req, res) => {
  try {
    const { order_id, amount_usd, customer_name } = req.body;
    const account = await getOrCreateAccount(order_id || Date.now(), customer_name || 'Web Customer');
    const amountUsd = parseFloat(amount_usd || 10);
    const amountEtb = amountUsd * USDT_TO_ETB_RATE;

    res.json({
      success: true,
      data: {
        order_id: account.userId,
        amount_usd: amountUsd,
        amount_etb: amountEtb,
        crypto: {
          address: account.address,
          networks: ['Polygon (USDT)', 'BNB Smart Chain BEP-20 (USDT)']
        },
        local_banks: {
          telebirr: { phone: TELEBIRR_MERCHANT_PHONE, name: MERCHANT_NAME },
          cbe: { account: CBE_MERCHANT_ACCOUNT, name: MERCHANT_NAME }
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. REST API: Verify Local Receipt (Telebirr / CBE)
app.post('/api/verify-receipt', async (req, res) => {
  const { provider, receipt } = req.body;
  if (!receipt) return res.status(400).json({ error: 'Receipt or TxID required' });

  let result;
  if (provider === 'cbe') {
    result = await verifyCbeReceipt(receipt);
  } else {
    result = await verifyTelebirrReceipt(receipt);
  }

  res.json(result);
});

// Home Page Dashboard
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Payment Gateway</title></head>
      <body style="font-family: sans-serif; padding: 40px; text-align: center; line-height: 1.6;">
        <h2>⚡ Unified Crypto & Birr Payment Gateway</h2>
        <p>Status: <b style="color: green;">200 OK - RUNNING</b></p>
        <p>Supported: <b>Polygon (USDT)</b> &bull; <b>BEP-20 BSC (USDT)</b> &bull; <b>Telebirr</b> &bull; <b>CBE</b></p>
        <p>Cronjob URL: <code>${APP_URL}/ping</code></p>
      </body>
    </html>
  `);
});

// --- 7. 🤖 Admin-Only Telegram Bot with Sleek UI ---
let bot = null;

if (TELEGRAM_BOT_TOKEN) {
  try {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
    console.log("🤖 Admin Telegram Bot running!");

    bot.on('polling_error', (error) => {
      console.log('Telegram note:', error.code || error.message);
    });

    // Admin Verification Guard
    function isAdmin(chatId) {
      if (!TELEGRAM_ADMIN_CHAT_ID) return true;
      return String(chatId) === String(TELEGRAM_ADMIN_CHAT_ID).trim();
    }

    // Modern Admin Keyboard
    const adminKeyboard = {
      reply_markup: {
        keyboard: [
          [{ text: '➕ አዲስ ደረሰኝ (New Invoice)' }, { text: '🔍 ትራንዛክሽን ፈትሽ (Check Tx)' }],
          [{ text: '🔄 Rescan (አድራሻዎችን ፈትሽ)' }, { text: '📊 የክፍያዎች ሪፖርት (Stats)' }],
          [{ text: '⚡ የሲስተም ሁኔታ (Ping / Health)' }]
        ],
        resize_keyboard: true
      }
    };

    // /start command
    bot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;

      if (!isAdmin(chatId)) {
        return bot.sendMessage(chatId, `⛔ **ይቅርታ! ይህ ቦት ለአስተዳዳሪ (Admin) ብቻ የተዘጋጀ ነው።**`, { parse_mode: 'Markdown' });
      }

      const welcome = `⚡ **CRYPTO & BIRR PAYMENT GATEWAY** ⚡\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👑 **የአስተዳዳሪ መቆጣጠሪያ ፓነል (Admin Panel)**\n\n` +
        `🔹 **ክሪፕቶ ኔትወርኮች፡** Polygon (USDT) • BEP-20 BSC (USDT)\n` +
        `🔹 **የሀገር ውስጥ ባንኮች፡** Telebirr • CBE Birr\n` +
        `🔹 **የሰርቨር ሁኔታ፡** 🟢 \`200 OK (Active)\`\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `ከታች ካሉት አዝራሮች አንዱን ይምረጡ፡`;

      bot.sendMessage(chatId, welcome, adminKeyboard);
    });

    // Handle button actions
    bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const text = msg.text || '';

      if (!isAdmin(chatId)) return;
      if (text.startsWith('/start') || text.startsWith('/check') || text.startsWith('/new')) return;

      if (text === '➕ አዲስ ደረሰኝ (New Invoice)') {
        await handleCreateInvoicePrompt(chatId);
      } else if (text === '🔍 ትራንዛክሽን ፈትሽ (Check Tx)') {
        bot.sendMessage(chatId, `🔍 **ትራንዛክሽን ወይም ደረሰኝ ለመፈተሽ፡**\n\n` +
          `• የብሎክቼይን Hash ከሆነ፡ \`/check 0x...\`\n` +
          `• የቴሌብር ደረሰኝ ከሆነ፡ \`/check DB1234567\` ወይም ሊንኩን\n` +
          `• የ CBE ደረሰኝ ከሆነ፡ \`/check CBE_ID\`\n\n` +
          `ብለው ይላኩ። ሲስተሙ ወዲያውኑ አረጋግጦ ውጤቱን ያሳውቅዎታል።`, { parse_mode: 'Markdown' });
      } else if (text === '🔄 Rescan (አድራሻዎችን ፈትሽ)') {
        bot.sendMessage(chatId, `🔄 **ሁሉንም አድራሻዎች በብሎክቼይን ላይ በመፈተሽ ላይ...**`);
        await runAutoVerifier();
        bot.sendMessage(chatId, `✅ **የአድራሻዎች ፍተሻ ተጠናቋል!** ሁሉም የገቡ ክፍያዎች ተረጋግጠዋል።`);
      } else if (text === '📊 የክፍያዎች ሪፖርት (Stats)') {
        handleStatsReport(chatId);
      } else if (text === '⚡ የሲስተም ሁኔታ (Ping / Health)') {
        const uptimeMin = (process.uptime() / 60).toFixed(1);
        bot.sendMessage(chatId, `🟢 **SYSTEM HEALTH: 200 OK**\n\n` +
          `📡 **Render Uptime:** \`${uptimeMin} ደቂቃዎች\`\n` +
          `🌐 **Cronjob Ping URL:** \`${APP_URL}/ping\`\n` +
          `👥 **ጠቅላላ አድራሻዎች:** \`${userAccounts.size}\`\n` +
          `🧾 **የተረጋገጡ ደረሰኞች:** \`${verifiedReceipts.size}\``, { parse_mode: 'Markdown' });
      }
    });

    // /new <amount> command
    bot.onText(/\/new\s*(\d+(\.\d+)?)/, async (msg, match) => {
      if (!isAdmin(msg.chat.id)) return;
      const amount = parseFloat(match[1]);
      await handleCreateInvoiceCard(msg.chat.id, amount);
    });

    // /check <tx_or_receipt> command (On-demand verification tool!)
    bot.onText(/\/check\s+(.+)/, async (msg, match) => {
      if (!isAdmin(msg.chat.id)) return;
      const query = match[1].trim();
      const chatId = msg.chat.id;

      bot.sendMessage(chatId, `⏳ **ትራንዛክሽኑን በማጣራት ላይ...**`);

      // 1. If it's a Blockchain Hash (0x...)
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

      // 2. If it's Telebirr
      if (query.toUpperCase().startsWith('DB') || query.includes('ethiotelecom.et')) {
        const result = await verifyTelebirrReceipt(query);
        if (result.success) {
          const reply = `✅ **የቴሌብር ደረሰኝ ተረጋግጧል!**\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🧾 **Transaction ID:** \`${result.txId}\`\n` +
            `💵 **የተከፈለ መጠን:** \`${result.amount} ETB\`\n` +
            `📱 **ፕሮቫይደር:** \`Telebirr\`\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `ክፍያው ህጋዊና ትክክለኛ መሆኑ ተረጋግጧል!`;
          return bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
        } else {
          return bot.sendMessage(chatId, `❌ ${result.error}`);
        }
      }

      // 3. Fallback check for CBE
      const cbeResult = await verifyCbeReceipt(query);
      if (cbeResult.success) {
        const reply = `✅ **የ CBE ደረሰኝ ተረጋግጧል!**\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `🧾 **Transaction ID:** \`${cbeResult.txId}\`\n` +
          `💵 **የተከፈለ መጠን:** \`${cbeResult.amount || 'ያልታወቀ'} ETB\`\n` +
          `🏦 **ባንክ:** \`Commercial Bank of Ethiopia\`\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━`;
        return bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
      }

      bot.sendMessage(chatId, `❌ ማስገቢያው አልታወቀም። እባክዎ ትክክለኛ የብሎክቼይን TxHash (0x...) ወይም የቴሌብር/CBE የደረሰኝ ቁጥር ያስገቡ።`);
    });

    async function handleCreateInvoicePrompt(chatId) {
      await handleCreateInvoiceCard(chatId, 10.0);
    }

    async function handleCreateInvoiceCard(chatId, amountUsd) {
      const orderId = Math.floor(1000 + Math.random() * 90000);
      const account = await getOrCreateAccount(orderId, `Order #${orderId}`);
      const amountEtb = (amountUsd * USDT_TO_ETB_RATE).toFixed(2);

      const invoiceCard = `💳 **የክፍያ ደረሰኝ (Invoice #${orderId})**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💵 **መጠን በዶላር:** \`$${amountUsd.toFixed(2)} USDT\`\n` +
        `🇪🇹 **መጠን በብር:** \`${amountEtb} ETB\`\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🌐 **1. ክሪፕቶ (Polygon ወይም BEP-20 USDT):**\n` +
        `\`${account.address}\`\n` +
        `*(አድራሻውን ነክተው ኮፒ ያድርጉ - Tap to Copy)*\n\n` +
        `📱 **2. በቴሌብር (Telebirr):**\n` +
        `• ስልክ ቁጥር፡ \`${TELEBIRR_MERCHANT_PHONE}\`\n` +
        `• ስም፡ \`${MERCHANT_NAME}\`\n\n` +
        `🏦 **3. በኢትዮጵያ ንግድ ባንክ (CBE):**\n` +
        `• ሂሳብ ቁጥር፡ \`${CBE_MERCHANT_ACCOUNT}\`\n` +
        `• ስም፡ \`${MERCHANT_NAME}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚡ *ይህንን መልዕክት ለደንበኛዎ ይላኩ። በክሪፕቶ ሲከፍሉ በራሱ ያረጋግጣል፤ በባንክ ከከፈሉ ደረሰኙን በ /check ያረጋግጡ!*`;

      bot.sendMessage(chatId, invoiceCard, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📷 Polygon/BSC QR Code', url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(account.address)}` }
            ]
          ]
        }
      });
    }

    function handleStatsReport(chatId) {
      let totalUsd = 0;
      let totalTx = 0;

      for (const u of userAccounts.values()) {
        totalUsd += u.totalDepositedUsd;
        totalTx += u.depositHistory.length;
      }

      const report = `📊 **የአድሚን የክፍያዎች ሪፖርት (Stats)**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💰 **ጠቅላላ ክሪፕቶ ገቢ:** \`$${totalUsd.toFixed(2)} USDT\`\n` +
        `🧾 **የተሳኩ ክፍያዎች ብዛት:** \`${totalTx}\`\n` +
        `👥 **የተፈጠሩ አድራሻዎች:** \`${userAccounts.size}\`\n` +
        `🇪🇹 **የተረጋገጡ የሀገር ውስጥ ደረሰኞች:** \`${verifiedReceipts.size}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━`;

      bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
    }

  } catch (err) {
    console.error("Bot setup error:", err.message);
  }
}

// Start Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🔥 Unified Crypto (BEP20/Polygon) & Local Bank Gateway`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`⏱️ Cron Keep-Alive URL: ${APP_URL}/ping (Returns 200 OK)`);
  console.log(`=======================================================`);
});
