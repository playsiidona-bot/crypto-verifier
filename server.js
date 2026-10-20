require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { ethers } = require('ethers');
const { Connection, PublicKey } = require('@solana/web3.js');
const { WalletContractV4, TonClient, Address, fromNano } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
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
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || "";

const POLYGON_RPC = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
const BSC_RPC = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org";
const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const TON_RPC = process.env.TON_API_URL || "https://toncenter.com/api/v2/jsonRPC";
const TON_API_KEY = process.env.TON_API_KEY || "";
const INVOICE_EXPIRY_MINUTES = parseInt(process.env.INVOICE_EXPIRY_MINUTES || "60", 10);
const WATCHER_INTERVAL_MS = (parseInt(process.env.WATCHER_INTERVAL_SECONDS || "10", 10)) * 1000;

// Token Contract Addresses (USDT)
const POLYGON_USDT_CONTRACT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"; // 6 decimals
const BSC_USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";     // 18 decimals
const SOLANA_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";     // 6 decimals

// Blockchain Providers
const polygonProvider = new ethers.JsonRpcProvider(POLYGON_RPC);
const bscProvider = new ethers.JsonRpcProvider(BSC_RPC);
const solanaConnection = new Connection(SOLANA_RPC, 'confirmed');
const tonClient = new TonClient({ endpoint: TON_RPC, apiKey: TON_API_KEY });

const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];

// Database for active Invoices
const invoices = new Map();

// --- 1. Address Derivation Engine (Unique Address per Order) ---
function getEvmAddress(orderIndex) {
  const hdNode = ethers.HDNodeWallet.fromPhrase(MASTER_MNEMONIC);
  const derived = hdNode.derivePath(`m/44'/60'/0'/0/${orderIndex}`);
  return derived.address;
}

async function getSolanaAddress(orderIndex) {
  const seed = await bip39.mnemonicToSeed(MASTER_MNEMONIC);
  const path = `m/44'/501'/${orderIndex}'/0'`;
  const derived = derivePath(path, seed.toString('hex')).key;
  const { Keypair } = require('@solana/web3.js');
  const keypair = Keypair.fromSeed(derived);
  return keypair.publicKey.toBase58();
}

async function getTonAddress(orderIndex) {
  const keyPair = await mnemonicToPrivateKey(MASTER_MNEMONIC.trim().split(/\s+/));
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
    walletId: Number(orderIndex)
  });
  return wallet.address.toString({ bounceable: false });
}

async function createInvoiceData(orderId, amountUsd, callbackUrl = null) {
  const orderIndex = parseInt(orderId, 10);
  const [polygonAddress, solanaAddress, tonAddress] = await Promise.all([
    getEvmAddress(orderIndex),
    getSolanaAddress(orderIndex),
    getTonAddress(orderIndex)
  ]);

  const invoice = {
    order_id: orderIndex,
    amount_expected: parseFloat(amountUsd),
    status: 'PENDING',
    created_at: new Date(),
    expires_at: new Date(Date.now() + INVOICE_EXPIRY_MINUTES * 60 * 1000),
    callback_url: callbackUrl,
    addresses: {
      polygon: polygonAddress,
      bep20: polygonAddress,
      solana: solanaAddress,
      ton: tonAddress
    }
  };

  invoices.set(orderIndex, invoice);
  return invoice;
}

// --- 2. Balance Verification Engine (Without TxHash) ---
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

async function checkSolanaUsdt(address) {
  try {
    const tokenAccounts = await solanaConnection.getParsedTokenAccountsByOwner(
      new PublicKey(address),
      { mint: new PublicKey(SOLANA_USDT_MINT) }
    );
    if (!tokenAccounts.value || tokenAccounts.value.length === 0) return 0;
    const amount = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
    return amount || 0;
  } catch (err) {
    return 0;
  }
}

async function checkTonBalance(address) {
  try {
    const balanceNano = await tonClient.getBalance(Address.parse(address));
    return parseFloat(fromNano(balanceNano));
  } catch (err) {
    return 0;
  }
}

// --- 3. Background Auto-Verifier (Watcher Loop) ---
async function runAutoVerifier() {
  const now = new Date();

  for (const [orderId, invoice] of invoices.entries()) {
    if (invoice.status !== 'PENDING') continue;

    if (now > invoice.expires_at) {
      invoice.status = 'EXPIRED';
      continue;
    }

    try {
      const [polygonBalance, bscBalance, solanaBalance, tonBalance] = await Promise.all([
        checkPolygonUsdt(invoice.addresses.polygon),
        checkBscUsdt(invoice.addresses.bep20),
        checkSolanaUsdt(invoice.addresses.solana),
        checkTonBalance(invoice.addresses.ton)
      ]);

      let detectedNetwork = null;
      let detectedAmount = 0;

      if (polygonBalance >= invoice.amount_expected) {
        detectedNetwork = 'Polygon (USDT)';
        detectedAmount = polygonBalance;
      } else if (bscBalance >= invoice.amount_expected) {
        detectedNetwork = 'BNB Smart Chain BEP20 (USDT)';
        detectedAmount = bscBalance;
      } else if (solanaBalance >= invoice.amount_expected) {
        detectedNetwork = 'Solana (USDT)';
        detectedAmount = solanaBalance;
      } else if (tonBalance >= invoice.amount_expected) {
        detectedNetwork = 'TON (Coin)';
        detectedAmount = tonBalance;
      }

      if (detectedNetwork) {
        invoice.status = 'PAID';
        invoice.paid_at = new Date();
        invoice.paid_network = detectedNetwork;
        invoice.paid_amount = detectedAmount;

        console.log(`✅ [Payment Detected] Order #${orderId} paid ${detectedAmount} on ${detectedNetwork}!`);

        // Send Telegram Instant Alert to Admin
        sendTelegramPaymentAlert(invoice);

        // Send Webhook callback if provided
        if (invoice.callback_url) {
          triggerWebhook(invoice);
        }
      }
    } catch (error) {
      // Ignore network hiccup
    }
  }
}

async function triggerWebhook(invoice) {
  try {
    await axios.post(invoice.callback_url, {
      event: 'PAYMENT_VERIFIED',
      order_id: invoice.order_id,
      status: invoice.status,
      paid_network: invoice.paid_network,
      paid_amount: invoice.paid_amount,
      paid_at: invoice.paid_at
    }, { timeout: 8000 });
  } catch (err) {
    console.error(`Webhook error for #${invoice.order_id}:`, err.message);
  }
}

setInterval(runAutoVerifier, WATCHER_INTERVAL_MS);

// --- 4. 🤖 Telegram Admin Bot Integration ---
let bot = null;

if (TELEGRAM_BOT_TOKEN) {
  try {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
    console.log("🤖 Telegram Admin Bot initialized successfully!");

    bot.on('polling_error', (error) => {
      // Quiet harmless polling warnings
      console.log('Telegram Polling note:', error.code || error.message);
    });

    const adminKeyboard = {
      reply_markup: {
        keyboard: [
          [{ text: '➕ አዲስ ደረሰኝ ($10)' }, { text: '➕ አዲስ ደረሰኝ ($25)' }],
          [{ text: '📊 የክፍያዎች ሁኔታ (Stats)' }, { text: '⚙️ Service Health' }]
        ],
        resize_keyboard: true
      }
    };

    // /start command
    bot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;
      const welcomeText = `👋 ሰላም የአስተዳዳሪ ፓነል (Admin Panel) እንኳን ደህና መጡ!\n\n` +
        `ይህ ቦት የክሪፕቶ ክፍያዎችን በ **Solana, Polygon, BEP-20, እና TON** በራስ-ሰር ይከታተላል።\n\n` +
        `📌 **የትእዛዝ ዝርዝር (Commands):**\n` +
        `• \`/new <መጠን>\` - አዲስ የክፍያ ሊንክ ለማመንጨት (ለምሳሌ፡ \`/new 15\`)\n` +
        `• \`/status <order_id>\` - የክፍያ ሁኔታን ለመፈተሽ (ለምሳሌ፡ \`/status 1001\`)\n` +
        `• \`/stats\` - አጠቃላይ የክፍያ ስታቲስቲክስ ለማየት\n\n` +
        `ከታች ያሉትን አዝራሮች በመጫን ወዲያውኑ መጠቀም ይችላሉ፡`;
      bot.sendMessage(chatId, welcomeText, adminKeyboard);
    });

    // Handle Quick Button presses
    bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const text = msg.text || '';

      if (text.startsWith('/start') || text.startsWith('/new') || text.startsWith('/status') || text.startsWith('/stats')) {
        return; // Handled by onText
      }

      if (text === '➕ አዲስ ደረሰኝ ($10)') {
        await handleCreateOrderViaBot(chatId, 10.0);
      } else if (text === '➕ አዲስ ደረሰኝ ($25)') {
        await handleCreateOrderViaBot(chatId, 25.0);
      } else if (text === '📊 የክፍያዎች ሁኔታ (Stats)') {
        handleStatsViaBot(chatId);
      } else if (text === '⚙️ Service Health') {
        bot.sendMessage(chatId, `🟢 **Crypto Verifier Online!**\n\nActive Invoices: ${invoices.size}\nServer Time: ${new Date().toLocaleTimeString()}`, { parse_mode: 'Markdown' });
      }
    });

    // /new <amount> command
    bot.onText(/\/new\s*(\d+(\.\d+)?)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const amount = parseFloat(match[1]);
      await handleCreateOrderViaBot(chatId, amount);
    });

    // /status <order_id> command
    bot.onText(/\/status\s*(\d+)/, (msg, match) => {
      const chatId = msg.chat.id;
      const orderId = parseInt(match[1], 10);
      const invoice = invoices.get(orderId);

      if (!invoice) {
        return bot.sendMessage(chatId, `❌ ደረሰኝ #${orderId} አልተገኘም።`);
      }

      const statusEmoji = invoice.status === 'PAID' ? '✅ PAID' : invoice.status === 'PENDING' ? '⏳ PENDING' : '❌ EXPIRED';
      const reply = `📦 **ደረሰኝ #${invoice.order_id}**\n` +
        `💵 መጠን፡ $${invoice.amount_expected} USDT\n` +
        `📊 ሁኔታ፡ **${statusEmoji}**\n` +
        `🌐 የተከፈለበት፡ ${invoice.paid_network || 'አልተከፈለም'}\n` +
        `🔗 Checkout Link:\n${APP_URL}/pay/${invoice.order_id}`;
      bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
    });

    // /stats command
    bot.onText(/\/stats/, (msg) => {
      handleStatsViaBot(msg.chat.id);
    });

    async function handleCreateOrderViaBot(chatId, amount) {
      try {
        const orderId = Math.floor(1000 + Math.random() * 90000);
        const invoice = await createInvoiceData(orderId, amount);
        const checkoutUrl = `${APP_URL}/pay/${orderId}`;

        const reply = `✅ **አዲስ የክፍያ ደረሰኝ ተዘጋጅቷል!**\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `📦 **Order ID:** \`#${orderId}\`\n` +
          `💵 **የክፍያ መጠን:** \`$${amount.toFixed(2)} USDT\`\n` +
          `⏳ **የማብቂያ ጊዜ:** \`${INVOICE_EXPIRY_MINUTES} ደቂቃዎች\`\n\n` +
          `🔗 **የደንበኛ መክፈያ ሊንክ (Checkout Link):**\n` +
          `${checkoutUrl}\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `*(ይህንን ሊንክ ኮፒ አድርገው ለደንበኛዎ ይላኩ። ደንበኛው ክፍያውን ሲልክ ወዲያውኑ ማሳወቂያ ይደርስዎታል)*`;

        bot.sendMessage(chatId, reply, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💳 የክፍያ ገጹን ክፈት (Open Checkout)', url: checkoutUrl }]
            ]
          }
        });
      } catch (err) {
        bot.sendMessage(chatId, `❌ ስህተት ተፈጥሯል፡ ${err.message}`);
      }
    }

    function handleStatsViaBot(chatId) {
      let paidCount = 0;
      let pendingCount = 0;
      let totalVolume = 0;

      for (const inv of invoices.values()) {
        if (inv.status === 'PAID') {
          paidCount++;
          totalVolume += (inv.paid_amount || inv.amount_expected);
        } else if (inv.status === 'PENDING') {
          pendingCount++;
        }
      }

      const msg = `📊 **የክፍያዎች አጠቃላይ ሪፖርት (Stats)**\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `✅ **የተከፈሉ ክፍያዎች:** ${paidCount}\n` +
        `⏳ **በመጠባበቅ ላይ ያሉ:** ${pendingCount}\n` +
        `💰 **አጠቃላይ ገቢ:** $${totalVolume.toFixed(2)} USDT\n` +
        `📦 **አጠቃላይ ትዕዛዞች:** ${invoices.size}\n` +
        `━━━━━━━━━━━━━━━━━━━━`;
      bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    }

  } catch (botErr) {
    console.error("Telegram Bot initialization error:", botErr.message);
  }
}

// Function to send alert to admin when payment arrives
function sendTelegramPaymentAlert(invoice) {
  if (!bot) return;
  const targetChatId = TELEGRAM_ADMIN_CHAT_ID;
  if (!targetChatId) return;

  const alertMsg = `🎉 **አዲስ ክፍያ በራስ-ሰር ተረጋግጧል! (Payment Verified)**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📦 **Order ID:** \`#${invoice.order_id}\`\n` +
    `💰 **የተከፈለ መጠን:** \`$${invoice.paid_amount} USDT\`\n` +
    `🌐 **ኔትወርክ:** \`${invoice.paid_network}\`\n` +
    `⏱️ **ሰዓት:** \`${new Date().toLocaleTimeString()}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ *ደንበኛው ምንም TxHash ሳያስገባ ባክኢንዱ ክፍያውን አረጋግጧል። ገንዘቡ በቀጥታ ወደ ዋሌትዎ ገብቷል!*`;

  bot.sendMessage(targetChatId, alertMsg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔍 ዝርዝሩን እይ (View Invoice)', url: `${APP_URL}/pay/${invoice.order_id}` }]
      ]
    }
  }).catch(e => console.log('Telegram send alert error:', e.message));
}

// --- 5. Web Service Pages ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

// Admin Dashboard UI
app.get('/', (req, res) => {
  const invoiceList = Array.from(invoices.values()).reverse();
  const rows = invoiceList.map(inv => `
    <tr style="border-bottom: 1px solid #e2e8f0;">
      <td style="padding: 12px; font-weight: bold;">#${inv.order_id}</td>
      <td style="padding: 12px;">$${inv.amount_expected}</td>
      <td style="padding: 12px;">
        <span style="padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600; 
          background: ${inv.status === 'PAID' ? '#dcfce7; color: #166534;' : inv.status === 'PENDING' ? '#fef9c3; color: #854d0e;' : '#fee2e2; color: #991b1b;'}">
          ${inv.status}
        </span>
      </td>
      <td style="padding: 12px; font-size: 13px; color: #475569;">${inv.paid_network || '-'}</td>
      <td style="padding: 12px;">
        <a href="/pay/${inv.order_id}" target="_blank" style="color: #2563eb; text-decoration: none; font-weight: 600;">View Checkout &rarr;</a>
      </td>
    </tr>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Crypto Payment Gateway - Admin Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
      </head>
      <body class="bg-gray-50 text-gray-800 p-4 md:p-10 font-sans">
        <div class="max-w-5xl mx-auto space-y-6">
          <div class="flex flex-col md:flex-row justify-between items-start md:items-center bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <div>
              <h1 class="text-2xl font-bold text-gray-900">⚡ Crypto Payment Auto-Verifier</h1>
              <p class="text-sm text-gray-500 mt-1">Solana, Polygon, BEP-20 (BSC), TON &bull; Unique Addresses &bull; Telegram Admin Bot</p>
            </div>
            <div class="mt-4 md:mt-0 flex items-center space-x-3">
              <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                <span class="w-2 h-2 mr-2 bg-green-500 rounded-full animate-pulse"></span> Service Active
              </span>
              ${bot ? '<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">🤖 Bot Active</span>' : ''}
            </div>
          </div>

          <!-- Create Order Form -->
          <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <h2 class="text-lg font-bold text-gray-900 mb-4">➕ አዲስ የክፍያ ደረሰኝ ፍጠር (Create New Invoice)</h2>
            <form action="/create-invoice-web" method="POST" class="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label class="block text-xs font-semibold text-gray-600 uppercase mb-1">Order ID</label>
                <input type="number" name="order_id" required value="${Math.floor(1000 + Math.random() * 9000)}" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              </div>
              <div>
                <label class="block text-xs font-semibold text-gray-600 uppercase mb-1">Amount (USD / USDT)</label>
                <input type="number" step="0.01" name="amount_usd" required value="10.00" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              </div>
              <div class="flex items-end">
                <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg text-sm transition">
                  Create Invoice & Checkout
                </button>
              </div>
            </form>
          </div>

          <!-- Invoices Table -->
          <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div class="p-6 border-b border-gray-100">
              <h2 class="text-lg font-bold text-gray-900">📋 የክፍያዎች ዝርዝር (Invoices)</h2>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-sm">
                <thead class="bg-gray-50 text-gray-500 uppercase text-xs">
                  <tr>
                    <th style="padding: 12px;">Order ID</th>
                    <th style="padding: 12px;">Amount</th>
                    <th style="padding: 12px;">Status</th>
                    <th style="padding: 12px;">Network Paid</th>
                    <th style="padding: 12px;">Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows || '<tr><td colspan="5" class="text-center py-8 text-gray-400">እስካሁን ምንም ደረሰኝ አልተፈጠረም። ከላይ አዲስ ይፍጠሩ።</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </body>
    </html>
  `);
});

app.post('/create-invoice-web', async (req, res) => {
  const { order_id, amount_usd } = req.body;
  await createInvoiceData(order_id, amount_usd);
  res.redirect(`/pay/${order_id}`);
});

// Customer Checkout Page
app.get('/pay/:order_id', (req, res) => {
  const orderId = parseInt(req.params.order_id, 10);
  const invoice = invoices.get(orderId);

  if (!invoice) {
    return res.status(404).send('<h2 style="font-family: sans-serif; text-align: center; margin-top: 50px;">Invoice not found.</h2>');
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Pay Invoice #${invoice.order_id}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
        <script>
          let currentTab = 'polygon';
          const addresses = ${JSON.stringify(invoice.addresses)};

          function selectTab(tab) {
            currentTab = tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('bg-blue-600', 'text-white'));
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.add('bg-gray-100', 'text-gray-700'));
            
            document.getElementById('tab-' + tab).classList.remove('bg-gray-100', 'text-gray-700');
            document.getElementById('tab-' + tab).classList.add('bg-blue-600', 'text-white');

            const addr = addresses[tab];
            document.getElementById('display-address').innerText = addr;
            document.getElementById('qr-img').src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(addr);
          }

          function copyAddress() {
            const addr = document.getElementById('display-address').innerText;
            navigator.clipboard.writeText(addr);
            const btn = document.getElementById('copy-btn');
            btn.innerText = 'Copied! ✅';
            setTimeout(() => { btn.innerText = 'Copy Address 📋'; }, 2000);
          }

          async function checkPaymentStatus() {
            try {
              const res = await fetch('/api/invoice/${invoice.order_id}');
              const data = await res.json();
              if (data.data && data.data.status === 'PAID') {
                document.getElementById('payment-box').classList.add('hidden');
                document.getElementById('success-box').classList.remove('hidden');
              }
            } catch (e) {}
          }
          setInterval(checkPaymentStatus, 4000);
        </script>
      </head>
      <body class="bg-gray-100 min-h-screen flex items-center justify-center p-4 font-sans">
        <div class="bg-white max-w-md w-full rounded-2xl shadow-xl overflow-hidden border border-gray-100">
          <div class="bg-gradient-to-r from-blue-600 to-indigo-700 p-6 text-white text-center">
            <h1 class="text-xl font-bold">Crypto Checkout</h1>
            <p class="text-sm opacity-90 mt-1">Order #${invoice.order_id}</p>
            <div class="mt-3 text-3xl font-extrabold">$${invoice.amount_expected.toFixed(2)} <span class="text-sm font-medium">USDT</span></div>
          </div>

          <div id="success-box" class="${invoice.status === 'PAID' ? '' : 'hidden'} p-8 text-center space-y-4">
            <div class="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto text-3xl">
              ✓
            </div>
            <h2 class="text-2xl font-bold text-gray-900">ክፍያው ተረጋግጧል!</h2>
            <p class="text-sm text-gray-600">Payment received and verified successfully!</p>
            <p class="text-xs text-gray-400">Network: ${invoice.paid_network || 'Blockchain'}</p>
            <a href="/" class="inline-block bg-gray-900 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-gray-800">ወደ ዋናው ገጽ ተመለስ</a>
          </div>

          <div id="payment-box" class="${invoice.status === 'PAID' ? 'hidden' : ''} p-6 space-y-5">
            <p class="text-xs text-center text-gray-500">ከታች ካሉት ኔትወርኮች አንዱን መርጠው ትክክለኛውን መጠን ይላኩ። ያለ hash በራሱ ያረጋግጣል።</p>

            <div class="grid grid-cols-4 gap-1 bg-gray-50 p-1 rounded-xl">
              <button id="tab-polygon" onclick="selectTab('polygon')" class="tab-btn py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white transition">Polygon</button>
              <button id="tab-bep20" onclick="selectTab('bep20')" class="tab-btn py-2 text-xs font-semibold rounded-lg bg-gray-100 text-gray-700 transition">BSC BEP20</button>
              <button id="tab-solana" onclick="selectTab('solana')" class="tab-btn py-2 text-xs font-semibold rounded-lg bg-gray-100 text-gray-700 transition">Solana</button>
              <button id="tab-ton" onclick="selectTab('ton')" class="tab-btn py-2 text-xs font-semibold rounded-lg bg-gray-100 text-gray-700 transition">TON</button>
            </div>

            <div class="flex justify-center py-2">
              <div class="p-2 border border-gray-200 rounded-xl bg-white shadow-sm">
                <img id="qr-img" src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(invoice.addresses.polygon)}" class="w-44 h-44 object-contain">
              </div>
            </div>

            <div class="space-y-2">
              <label class="block text-xs font-semibold text-gray-500 uppercase text-center">Deposit Address (ልዩ አድራሻ)</label>
              <div class="bg-gray-50 p-3 rounded-xl border border-gray-200 break-all text-xs font-mono text-center text-gray-800" id="display-address">
                ${invoice.addresses.polygon}
              </div>
              <button id="copy-btn" onclick="copyAddress()" class="w-full bg-gray-100 hover:bg-gray-200 text-gray-800 text-xs font-bold py-2.5 rounded-xl transition">
                Copy Address 📋
              </button>
            </div>

            <div class="flex items-center justify-center space-x-2 text-xs text-blue-600 font-medium pt-2">
              <span class="w-2 h-2 bg-blue-500 rounded-full animate-ping"></span>
              <span>ክፍያዎን በመጠባበቅ ላይ... (Auto-Checking)</span>
            </div>
          </div>
        </div>
      </body>
    </html>
  `);
});

// JSON API Routes
app.post('/api/invoice/create', async (req, res) => {
  try {
    const { order_id, amount_usd, callback_url } = req.body;
    const invoice = await createInvoiceData(order_id, amount_usd, callback_url);
    res.json({ success: true, data: invoice });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/invoice/:order_id', (req, res) => {
  const invoice = invoices.get(parseInt(req.params.order_id, 10));
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  res.json({ success: true, data: invoice });
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
