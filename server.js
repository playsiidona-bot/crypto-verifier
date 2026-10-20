require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { ethers } = require('ethers');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
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

const POLYGON_RPC = process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";
const BSC_RPC = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org";
const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const TON_RPC = process.env.TON_API_URL || "https://toncenter.com/api/v2/jsonRPC";
const TON_API_KEY = process.env.TON_API_KEY || "";
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

// In-Memory Storage
const userAccounts = new Map(); // Telegram User ID -> User Account
const invoices = new Map();     // Order ID -> Invoice

// --- 1. Address Derivation Engine (Unique Address per User / Order) ---
function getEvmAddress(orderIndex) {
  const cleanMnemonic = MASTER_MNEMONIC.trim().replace(/\s+/g, ' ');
  const wallet = ethers.HDNodeWallet.fromPhrase(
    cleanMnemonic,
    undefined,
    `m/44'/60'/0'/0/${orderIndex}`
  );
  return wallet.address;
}

async function getSolanaAddress(orderIndex) {
  const cleanMnemonic = MASTER_MNEMONIC.trim().replace(/\s+/g, ' ');
  const seed = await bip39.mnemonicToSeed(cleanMnemonic);
  const path = `m/44'/501'/${orderIndex}'/0'`;
  const derived = derivePath(path, seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derived);
  return keypair.publicKey.toBase58();
}

async function getTonAddress(orderIndex) {
  const cleanMnemonic = MASTER_MNEMONIC.trim().replace(/\s+/g, ' ');
  const words = cleanMnemonic.split(' ');
  const keyPair = await mnemonicToPrivateKey(words);
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
    walletId: Number(orderIndex)
  });
  return wallet.address.toString({ bounceable: false });
}

// Get or create permanent unique deposit addresses for a Telegram User
async function getOrCreateUserAccount(userId, username = 'User') {
  if (userAccounts.has(userId)) {
    return userAccounts.get(userId);
  }

  const userIndex = userAccounts.size + 101; // Sequential index starting at 101
  const [polygonAddr, solanaAddr, tonAddr] = await Promise.all([
    getEvmAddress(userIndex),
    getSolanaAddress(userIndex),
    getTonAddress(userIndex)
  ]);

  const userAccount = {
    userId,
    username,
    userIndex,
    createdAt: new Date(),
    addresses: {
      polygon: polygonAddr,
      bep20: polygonAddr,
      solana: solanaAddr,
      ton: tonAddr
    },
    // Track last verified balances to detect ANY incoming amount
    lastBalances: {
      polygon: 0,
      bep20: 0,
      solana: 0,
      ton: 0
    },
    totalDeposited: 0,
    depositHistory: []
  };

  userAccounts.set(userId, userAccount);
  return userAccount;
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

// --- 3. Background Auto-Verifier (Checks Any Amount, Anytime) ---
async function runAutoVerifier() {
  // Check user permanent deposit addresses
  for (const [userId, user] of userAccounts.entries()) {
    try {
      const [polygonBal, bscBal, solanaBal, tonBal] = await Promise.all([
        checkPolygonUsdt(user.addresses.polygon),
        checkBscUsdt(user.addresses.bep20),
        checkSolanaUsdt(user.addresses.solana),
        checkTonBalance(user.addresses.ton)
      ]);

      // Check Polygon USDT increase
      if (polygonBal > user.lastBalances.polygon) {
        const received = polygonBal - user.lastBalances.polygon;
        user.lastBalances.polygon = polygonBal;
        handleSuccessfulDeposit(user, received, 'Polygon (USDT)', user.addresses.polygon);
      }

      // Check BSC USDT increase
      if (bscBal > user.lastBalances.bep20) {
        const received = bscBal - user.lastBalances.bep20;
        user.lastBalances.bep20 = bscBal;
        handleSuccessfulDeposit(user, received, 'BSC BEP-20 (USDT)', user.addresses.bep20);
      }

      // Check Solana USDT increase
      if (solanaBal > user.lastBalances.solana) {
        const received = solanaBal - user.lastBalances.solana;
        user.lastBalances.solana = solanaBal;
        handleSuccessfulDeposit(user, received, 'Solana (USDT)', user.addresses.solana);
      }

      // Check TON coin increase
      if (tonBal > user.lastBalances.ton) {
        const received = tonBal - user.lastBalances.ton;
        user.lastBalances.ton = tonBal;
        handleSuccessfulDeposit(user, received, 'TON (Coin)', user.addresses.ton);
      }
    } catch (e) {
      // Quiet fail
    }
  }

  // Also check standard web invoices
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
        detectedNetwork = 'BSC BEP-20 (USDT)';
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
      }
    } catch (err) {}
  }
}

// Action when ANY payment arrives at any time
function handleSuccessfulDeposit(user, amount, network, address) {
  user.totalDeposited += amount;
  user.depositHistory.push({
    amount,
    network,
    time: new Date(),
    address
  });

  console.log(`🎉 [Payment Verified] User ${user.username} (${user.userId}) sent $${amount} on ${network}!`);

  // 1. Notify the Customer in Telegram
  if (bot && user.userId) {
    const userMsg = `🎉 **ክፍያዎ ደርሷል! (Payment Received)**\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 **የተከፈለ መጠን:** \`$${amount.toFixed(2)} USDT\`\n` +
      `🌐 **ኔትወርክ:** \`${network}\`\n` +
      `⏱️ **ሰዓት:** \`${new Date().toLocaleTimeString()}\`\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ *ክፍያዎ ያለ ምንም hash በራስ-ሰር ተረጋግጦ ወደ ሂሳብዎ ገብቷል! እናመሰግናለን።*`;

    bot.sendMessage(user.userId, userMsg, { parse_mode: 'Markdown' }).catch(() => {});
  }

  // 2. Notify the Admin in Telegram
  if (bot && TELEGRAM_ADMIN_CHAT_ID) {
    const adminMsg = `💰 **አዲስ ክፍያ ደርሷል! (Deposit Alert)**\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 **ተጠቃሚ:** @${user.username || 'ያልታወቀ'} (ID: \`${user.userId}\`)\n` +
      `💵 **መጠን:** \`$${amount.toFixed(2)} USDT\`\n` +
      `🌐 **ኔትወርክ:** \`${network}\`\n` +
      `📍 **የገባበት አድራሻ:** \`${address}\`\n` +
      `⏱️ **ሰዓት:** \`${new Date().toLocaleTimeString()}\`\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ *ገንዘቡ በቀጥታ ወደ እርስዎ Trust Wallet ገብቷል!*`;

    bot.sendMessage(TELEGRAM_ADMIN_CHAT_ID, adminMsg, { parse_mode: 'Markdown' }).catch(() => {});
  }
}

setInterval(runAutoVerifier, WATCHER_INTERVAL_MS);

// --- 4. 🤖 Telegram Bot (Direct In-Chat Deposit Engine) ---
let bot = null;

if (TELEGRAM_BOT_TOKEN) {
  try {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
    console.log("🤖 Telegram Payment Bot initialized!");

    bot.on('polling_error', (error) => {
      console.log('Telegram note:', error.code || error.message);
    });

    const userKeyboard = {
      reply_markup: {
        keyboard: [
          [{ text: '💳 የክፍያ አድራሻ አውጣ (Deposit)' }],
          [{ text: '💰 የኔ ሂሳብ (My Balance)' }, { text: 'ℹ️ መመሪያ (Help)' }]
        ],
        resize_keyboard: true
      }
    };

    // /start command
    bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const username = msg.from.username || msg.from.first_name || 'User';

      // Pre-generate addresses for this user
      await getOrCreateUserAccount(chatId, username);

      const welcome = `👋 ሰላም ${username}፣ እንኳን ወደ ክሪፕቶ ክፍያ ቦት በደህና መጡ!\n\n` +
        `እዚህ ቦት ላይ **የፈለጉትን የገንዘብ መጠን በፈለጉት ሰዓት** መላክ ይችላሉ።\n\n` +
        `📌 **ዋና ዋና ጥቅሞች፡**\n` +
        `• ምንም አይነት ድረ-ገጽ ወይም ሊንክ መክፈት አያስፈልግዎትም!\n` +
        `• የግብይት ቁጥር (Tx Hash) መላክ አይጠበቅብዎትም፤ በራሱ ያረጋግጣል።\n` +
        `• በ **Solana, Polygon, BEP-20 (BSC), እና TON** መቀበል ይችላሉ።\n\n` +
        `የመክፈያ አድራሻዎን ለማግኘት ከታች ያለውን **"💳 የክፍያ አድራሻ አውጣ (Deposit)"** የሚለውን አዝራር ይጫኑ።`;

      bot.sendMessage(chatId, welcome, userKeyboard);
    });

    // Handle button clicks and text
    bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const text = msg.text || '';
      const username = msg.from.username || msg.from.first_name || 'User';

      if (text.startsWith('/start') || text.startsWith('/stats')) return;

      if (text === '💳 የክፍያ አድራሻ አውጣ (Deposit)' || text === '/deposit' || text === '/pay') {
        await sendDepositAddresses(chatId, username);
      } else if (text === '💰 የኔ ሂሳብ (My Balance)' || text === '/balance') {
        const user = await getOrCreateUserAccount(chatId, username);
        const reply = `💰 **የእርስዎ የክፍያ ሂሳብ (Balance)**\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `💵 **አጠቃላይ የከፈሉት መጠን:** \`$${user.totalDeposited.toFixed(2)} USDT\`\n` +
          `📦 **የክፍያዎች ብዛት:** ${user.depositHistory.length}\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `አዲስ ክፍያ ለመላክ "💳 የክፍያ አድራሻ አውጣ" የሚለውን ይጫኑ።`;
        bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
      } else if (text === 'ℹ️ መመሪያ (Help)' || text === '/help') {
        const help = `ℹ️ **ክፍያ እንዴት እንደሚፈጽሙ፡**\n\n` +
          `1. "💳 የክፍያ አድራሻ አውጣ" የሚለውን ይጫኑ።\n` +
          `2. የሚመጣውን አድራሻ በመንካት ኮፒ ያድርጉ (Tap to Copy)።\n` +
          `3. ከዋሌትዎ (Binance, Bybit, Trust Wallet...) የፈለጉትን መጠን ይላኩ።\n` +
          `4. ገንዘቡ እንደደረሰ ቦቱ በሰከንዶች ውስጥ "ክፍያዎ ደርሷል" የሚል ማረጋገጫ ይልክልዎታል። ምንም Hash መላክ አያስፈልግም!`;
        bot.sendMessage(chatId, help);
      }
    });

    // Send Deposit Addresses DIRECTLY in Telegram (No external link!)
    async function sendDepositAddresses(chatId, username) {
      const user = await getOrCreateUserAccount(chatId, username);

      const msg = `💳 **የእርስዎ ቋሚ የክፍያ አድራሻዎች (Deposit Addresses)**\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📌 *የፈለጉትን መጠን በፈለጉት ሰዓት መላክ ይችላሉ። ክፍያው ሲገባ በሰከንዶች ውስጥ በራሱ ያረጋግጣል (ያለ Hash)*\n\n` +
        `🟣 **Polygon (USDT / POL):**\n` +
        `\`${user.addresses.polygon}\`\n` +
        `*(ለመገልበጥ አድራሻውን ይጫኑ)*\n\n` +
        `🟡 **BNB Smart Chain BEP-20 (USDT):**\n` +
        `\`${user.addresses.bep20}\`\n` +
        `*(ለመገልበጥ አድራሻውን ይጫኑ)*\n\n` +
        `🟣 **Solana (USDT / SOL):**\n` +
        `\`${user.addresses.solana}\`\n` +
        `*(ለመገልበጥ አድራሻውን ይጫኑ)*\n\n` +
        `💎 **TON (TON Coin):**\n` +
        `\`${user.addresses.ton}\`\n` +
        `*(ለመገልበጥ አድራሻውን ይጫኑ)*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `⚡ *ክፍያዎ እንደደረሰ ወዲያውኑ ማሳወቂያ ይደርስዎታል!*`;

      bot.sendMessage(chatId, msg, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📷 Polygon QR', callback_data: `qr_polygon_${chatId}` },
              { text: '📷 Solana QR', callback_data: `qr_solana_${chatId}` }
            ],
            [
              { text: '📷 BSC QR', callback_data: `qr_bep20_${chatId}` },
              { text: '📷 TON QR', callback_data: `qr_ton_${chatId}` }
            ]
          ]
        }
      });
    }

    // QR Code callbacks
    bot.on('callback_query', async (query) => {
      const data = query.data;
      const chatId = query.message.chat.id;

      if (data.startsWith('qr_')) {
        const parts = data.split('_');
        const net = parts[1];
        const user = userAccounts.get(chatId);

        if (user && user.addresses[net]) {
          const addr = user.addresses[net];
          const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(addr)}`;

          bot.sendPhoto(chatId, qrUrl, {
            caption: `📷 **${net.toUpperCase()} Deposit QR Code**\n\n\`${addr}\`\n\n*(ይህንን ስካን በማድረግ የፈለጉትን መጠን ይላኩ)*`,
            parse_mode: 'Markdown'
          });
        }
      }
      bot.answerCallbackQuery(query.id);
    });

    // Admin /stats command
    bot.onText(/\/stats/, (msg) => {
      if (String(msg.chat.id) !== String(TELEGRAM_ADMIN_CHAT_ID)) return;

      let totalCollected = 0;
      let totalTxCount = 0;

      for (const u of userAccounts.values()) {
        totalCollected += u.totalDeposited;
        totalTxCount += u.depositHistory.length;
      }

      const report = `📊 **የአድሚን አጠቃላይ ሪፖርት (Stats)**\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👥 **ጠቅላላ ተጠቃሚዎች:** ${userAccounts.size}\n` +
        `✅ **የተሳኩ ክፍያዎች ብዛት:** ${totalTxCount}\n` +
        `💰 **አጠቃላይ ገቢ:** \`$${totalCollected.toFixed(2)} USDT\`\n` +
        `━━━━━━━━━━━━━━━━━━━━`;

      bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' });
    });

  } catch (err) {
    console.error("Bot error:", err.message);
  }
}

// --- 5. Web Service Routes (Health check & optional dashboard) ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', users: userAccounts.size, time: new Date() });
});

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h2>⚡ Telegram Crypto Payment Auto-Verifier</h2>
        <p>Status: <b style="color: green;">ACTIVE</b></p>
        <p>Active Users: <b>${userAccounts.size}</b></p>
        <p>Connect with the bot directly on Telegram!</p>
      </body>
    </html>
  `);
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Crypto Verifier started on port ${PORT}`);
});
