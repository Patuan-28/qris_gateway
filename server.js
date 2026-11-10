require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const axios = require('axios');
const QRCode = require('qrcode');
const { parseQris, convertStaticToDynamic } = require('./qris-util');
const db = require('./db');
const gopayClient = require('./gopay-client');
const sessionManager = require('./sessionManager');

const GOJEK_TRANSACTIONS_URL = 'https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions';

const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = {
  api_key: process.env.API_KEY || 'your_secret_api_key_here',
  port: parseInt(process.env.PORT || 5050, 10),
  expiry_minutes: parseInt(process.env.EXPIRY_MINUTES || 15, 10),
  auto_unique_code: process.env.AUTO_UNIQUE_CODE !== 'false',
  default_static_qris: process.env.QRIS_STATIC || ''
};

try {
  if (fs.existsSync(CONFIG_PATH)) {
    config = Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')));
  }
} catch (e) {}

const PORT = process.env.PORT || config.port || 5050;
const PUBLIC_DIR = path.join(__dirname, 'public');

// 1. Background Task: Auto-refresh token berkala
setInterval(async () => {
  try {
    const session = sessionManager.loadSession();
    if (session && session.refresh_token) {
      if (sessionManager.isExpired(session)) {
        console.log('[AUTO-REFRESH] Memperbarui token GoBiz di background...');
        await sessionManager.refreshSession();
      }
    }
  } catch (e) {}
}, 15 * 60 * 1000);

// 2. Background Task: Polling Mutasi Transaksi GoPay Otomatis (Tiap 5 Detik)
let isPolling = false;
async function pollGoPayMutations() {
  if (isPolling) return;
  const session = sessionManager.loadSession();
  if (!session) return; // Belum login via node login.js

  // Hanya poll jika ada transaksi yang masih PENDING
  const allTxs = db.getAllTransactions();
  const pendingTxs = allTxs.filter(t => t.status === 'PENDING');
  if (pendingTxs.length === 0) return;

  isPolling = true;
  try {
    const headers = await sessionManager.getValidHeaders('GoBiz/3.54.0 (Android; 13)');
    if (!headers) return;

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3600 * 1000).toISOString();

    const response = await axios.get(GOJEK_TRANSACTIONS_URL, {
      headers: headers,
      params: {
        from: 0,
        size: 20,
        statuses: 'SETTLEMENT,CAPTURE,REFUND,PARTIAL_REFUND',
        payment_types: 'QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD',
        start_time: oneHourAgo,
        end_time: now.toISOString(),
        merchant_ids: session.merchant_id || ''
      },
      timeout: 8000
    });

    const items = response.data?.transactions || response.data?.data?.transactions || response.data?.data?.items || response.data?.items || [];
    for (const item of items) {
      const amount = parseInt(item.gross_amount || item.real_gross_amount || item.amount?.value || item.amount || 0, 10);
      const ref = String(item.id || item.transaction_id || item.reference_id || item.order_id || item.wallstreet_transaction_id || '');
      const txTime = new Date(item.transaction_time || item.created_at || item.settlement_time || Date.now()).getTime();

      if (amount <= 0) continue;

      // Cek apakah ref mutasi ini sudah pernah diklaim transaksi lain
      const latestAllTxs = db.getAllTransactions();
      const alreadyClaimed = latestAllTxs.some(t => t.settlement_ref === ref || t.provider_ref === ref);
      if (ref && alreadyClaimed) continue;

      // Cari transaksi PENDING yang nominalnya cocok dan waktu pembuatannya <= waktu transaksi GoPay (toleransi 2 menit)
      let matchedTx = pendingTxs.find(pt => 
        parseInt(pt.amount, 10) === amount &&
        (new Date(pt.created_at).getTime() - 120000) <= txTime
      );

      // Fallback Cerdas: Jika nominal tidak persis sama (misal invoice Rp 1 tapi SeaBank/BCA membatasi minimal Rp 100)
      if (!matchedTx && pendingTxs.length > 0) {
        matchedTx = pendingTxs.find(pt => {
          const ptCreatedMs = new Date(pt.created_at).getTime();
          return Math.abs(txTime - ptCreatedMs) <= 300000;
        });
        if (matchedTx) {
          console.log(`[POLL MATCH TOLERAN] ✅ Dana masuk Rp ${amount} dicocokkan ke transaksi ${matchedTx.trx_id} (tagihan awal Rp ${matchedTx.amount})`);
        }
      }

      if (matchedTx) {
        console.log(`[POLL MATCH] ✅ Dana masuk Rp ${amount.toLocaleString('id-ID')} cocok untuk ${matchedTx.trx_id} (Ref: ${ref})`);
        const updated = db.updateTransactionStatus(matchedTx.trx_id, 'SUCCESS', {
          settlement_ref: ref,
          payer_issuer: item.qris_provider_aspi_issuer || 'GoPay / Bank',
          paid_at: new Date(txTime).toISOString()
        });

        if (updated && updated.callback_url) {
          axios.post(updated.callback_url, {
            event: 'payment.success',
            trx_id: updated.trx_id,
            order_id: updated.order_id,
            amount: updated.amount,
            status: 'SUCCESS',
            paid_at: updated.paid_at
          }).catch(e => console.error('[CALLBACK ERR]', e.message));
        }
      }
    }
  } catch (err) {
    if (err.response && err.response.status === 401) {
      console.warn('[GOPAY POLL] Token 401, mencoba refresh session...');
      await sessionManager.refreshSession();
    }
  } finally {
    isPolling = false;
  }
}
setInterval(pollGoPayMutations, 5000);

// Helper untuk Cek Satu Transaksi Spesifik secara On-Demand
async function checkSingleTxWithGoPay(tx) {
  if (!tx || tx.status !== 'PENDING') return tx;
  const session = sessionManager.loadSession();
  if (!session) return tx;

  try {
    const headers = await sessionManager.getValidHeaders('GoBiz/3.54.0 (Android; 13)');
    if (!headers) return tx;

    const now = new Date();
    const startTimeISO = tx.created_at ? new Date(new Date(tx.created_at).getTime() - 120000).toISOString() : new Date(now.getTime() - 3600 * 1000).toISOString();

    const response = await axios.get(GOJEK_TRANSACTIONS_URL, {
      headers: headers,
      params: {
        from: 0,
        size: 20,
        statuses: 'SETTLEMENT,CAPTURE,REFUND,PARTIAL_REFUND',
        payment_types: 'QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD',
        start_time: startTimeISO,
        end_time: now.toISOString(),
        merchant_ids: session.merchant_id || ''
      },
      timeout: 8000
    });

    const items = response.data?.transactions || response.data?.data?.transactions || response.data?.data?.items || response.data?.items || [];
    const targetAmount = parseInt(tx.amount, 10);
    const filterTimeMs = new Date(tx.created_at).getTime() - 120000;

    for (const item of items) {
      const amount = parseInt(item.gross_amount || item.real_gross_amount || item.amount?.value || item.amount || 0, 10);
      const ref = String(item.id || item.transaction_id || item.reference_id || item.order_id || item.wallstreet_transaction_id || '');
      const txTime = new Date(item.transaction_time || item.created_at || item.settlement_time || Date.now()).getTime();

      const isExactMatch = amount === targetAmount && txTime >= filterTimeMs;
      const isNearTimeMatch = Math.abs(txTime - new Date(tx.created_at).getTime()) <= 300000;

      if ((isExactMatch || isNearTimeMatch)) {
        const all = db.getAllTransactions();
        const alreadyClaimed = all.some(t => (t.settlement_ref === ref || t.provider_ref === ref) && t.trx_id !== tx.trx_id);
        if (!alreadyClaimed) {
          console.log(`[ON-DEMAND MATCH] ✅ Transaksi ${tx.trx_id} diverifikasi sukses via GoPay API! Ref: ${ref}`);
          const updated = db.updateTransactionStatus(tx.trx_id, 'SUCCESS', {
            settlement_ref: ref,
            payer_issuer: item.qris_provider_aspi_issuer || 'GoPay / Bank',
            paid_at: new Date(txTime).toISOString()
          });

          if (updated && updated.callback_url) {
            axios.post(updated.callback_url, {
              event: 'payment.success',
              trx_id: updated.trx_id,
              order_id: updated.order_id,
              amount: updated.amount,
              status: 'SUCCESS',
              paid_at: updated.paid_at
            }).catch(e => console.error('[CALLBACK ERR]', e.message));
          }

          return updated;
        }
      }
    }
  } catch (err) {
    if (err.response && err.response.status === 401) {
      sessionManager.refreshSession().catch(() => {});
    }
  }
  return tx;
}

// Helper: Cek Proteksi API Key
function isAuthorized(req, parsedUrl) {
  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];
  const queryKey = parsedUrl.query.api_key;

  let providedKey = apiKeyHeader || queryKey;
  if (!providedKey && authHeader && authHeader.startsWith('Bearer ')) {
    providedKey = authHeader.substring(7).trim();
  }

  return providedKey === config.api_key;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Set CORS Header agar API bisa dipanggil dari web mana pun
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // ==========================================
  // ROUTE 1: [PROTECTED API] Generate QRIS Dinamis (Create Transaction)
  // ==========================================
  if (req.method === 'POST' && pathname === '/api/v1/charge') {
    if (!isAuthorized(req, parsedUrl)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized. API Key tidak valid atau tidak disertakan.' }));
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const staticQris = (payload.static_qris || config.default_static_qris || '').trim();
        let nominal = parseInt(payload.amount, 10);
        const orderId = payload.order_id || 'ORD-' + Date.now();
        const callbackUrl = payload.callback_url || null;

        if (!staticQris) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'QRIS statis belum diatur di config.json atau payload.' }));
        }

        if (isNaN(nominal) || nominal < 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Nominal tidak valid (minimal Rp 1).' }));
        }

        // Trik Kode Unik 3 Digit (jika diaktifkan)
        let uniqueCode = 0;
        if (payload.add_unique_code ?? config.auto_unique_code) {
          uniqueCode = Math.floor(Math.random() * 899) + 100;
          nominal = nominal + uniqueCode;
        }

        const merchantInfo = parseQris(staticQris);
        const dynamicQris = convertStaticToDynamic(staticQris, nominal);

        // Generate QR Code PNG Base64
        const qrImage = await QRCode.toDataURL(dynamicQris, {
          margin: 2,
          width: 320
        });

        // Simpan transaksi ke Database lokal
        const tx = db.createTransaction({
          order_id: orderId,
          amount: nominal,
          merchant_name: merchantInfo.merchantName,
          merchant_city: merchantInfo.merchantCity,
          dynamic_qris: dynamicQris,
          qr_image: qrImage,
          callback_url: callbackUrl,
          expiry_minutes: config.expiry_minutes || 15
        });

        console.log(`[API CHARGE] TRX dibuat: ${tx.trx_id} | Rp ${nominal} | Order: ${orderId}`);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          trx_id: tx.trx_id,
          order_id: tx.order_id,
          amount: tx.amount,
          unique_code: uniqueCode,
          merchant_name: tx.merchant_name,
          merchant_city: tx.merchant_city,
          dynamic_qris: tx.dynamic_qris,
          qr_image: tx.qr_image,
          checkout_url: `http://localhost:${PORT}/checkout/${tx.trx_id}`,
          status: tx.status,
          expired_at: tx.expired_at
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ==========================================
  // ROUTE 2: [PUBLIC API] Cek Status Pembayaran Real-Time (Tanpa API Key)
  // Digunakan oleh frontend / halaman checkout pembeli secara aman
  // ==========================================
  if (req.method === 'GET' && pathname.startsWith('/api/v1/qr-status/')) {
    const trxId = pathname.replace('/api/v1/qr-status/', '').trim();
    let tx = db.getTransaction(trxId);

    if (!tx) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Transaksi tidak ditemukan' }));
    }

    // Jika masih PENDING, periksa secara aktif ke GoPay API
    if (tx.status === 'PENDING') {
      try {
        tx = await checkSingleTxWithGoPay(tx);
      } catch (e) {}
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      trx_id: tx.trx_id,
      order_id: tx.order_id,
      amount: tx.amount,
      merchant_name: tx.merchant_name,
      merchant_city: tx.merchant_city,
      status: tx.status,
      qr_image: tx.qr_image,
      created_at: tx.created_at,
      expired_at: tx.expired_at,
      paid_at: tx.paid_at,
      payer_issuer: tx.payer_issuer || null,
      settlement_ref: tx.settlement_ref || null
    }));
  }

  // ==========================================
  // ROUTE 3: [PROTECTED API] Riwayat Transaksi (Transaction History)
  // ==========================================
  if (req.method === 'GET' && pathname === '/api/v1/transactions') {
    if (!isAuthorized(req, parsedUrl)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized. API Key tidak valid.' }));
    }

    const transactions = db.getAllTransactions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      total: transactions.length,
      data: transactions
    }));
  }

  // ==========================================
  // ROUTE 3B: [PROTECTED API] Hapus Transaksi (Checkbox / Clear All)
  // ==========================================
  if (req.method === 'POST' && pathname === '/api/v1/transactions/delete') {
    if (!isAuthorized(req, parsedUrl)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized. API Key tidak valid.' }));
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');

        // Jika Clear All
        if (payload.all) {
          const result = db.clearAllTransactions();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, message: 'Semua transaksi berhasil dihapus', ...result }));
        }

        // Jika Hapus Berdasarkan Checkbox
        const trxIds = payload.trx_ids || [];
        if (!Array.isArray(trxIds) || trxIds.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Pilih minimal satu transaksi untuk dihapus.' }));
        }

        const result = db.deleteTransactions(trxIds);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, message: `${result.deleted_count} transaksi berhasil dihapus`, ...result }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ==========================================
  // ROUTE 4: [WEBHOOK / NOTIFIER] Menerima Notifikasi Mutasi Masuk
  // Pintar & Fleksibel: Menerima JSON, format teks mentah, atau notifikasi Android
  // ==========================================
  if (req.method === 'POST' && pathname === '/api/v1/webhook/notify') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        let payload = {};
        
        // 1. Coba parse sebagai JSON biasa
        try {
          payload = JSON.parse(body || '{}');
        } catch (e1) {
          // 2. Coba perbaiki jika ada kutip tunggal
          try {
            payload = JSON.parse(body.replace(/'/g, '"'));
          } catch (e2) {
            // 3. Fallback: Ekstrak angka dari teks mentah notifikasi (contoh: "Menerima Rp 50.142")
            const match = body.match(/(\d[\d.,]*\d|\d+)/);
            if (match) {
              const cleanNumber = match[0].replace(/[.,]/g, '');
              payload = { amount: parseInt(cleanNumber, 10) };
            }
          }
        }

        let amount = parseInt(payload.amount || payload.nominal, 10);

        // Jika amount masih berupa teks (misal: "Rp 50.142")
        if (isNaN(amount) && typeof (payload.amount || payload.nominal) === 'string') {
          const rawNum = (payload.amount || payload.nominal).replace(/[^0-9]/g, '');
          amount = parseInt(rawNum, 10);
        }

        const ref = payload.reference || payload.order_id || 'NOTIF-BRIDGE-' + Date.now();

        if (!amount || isNaN(amount)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Nominal tidak ditemukan atau format tidak valid.' }));
        }

        const result = await gopayClient.processIncomingMutation(amount, ref);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ==========================================
  // ROUTE 5: [SIMULATOR] Simulasi Bayar Cepat (Tester)
  // ==========================================
  if (req.method === 'POST' && pathname.startsWith('/api/v1/simulate-pay/')) {
    const trxId = pathname.replace('/api/v1/simulate-pay/', '').trim();
    const tx = db.getTransaction(trxId);

    if (!tx) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Transaksi tidak ditemukan' }));
    }

    const updated = db.updateTransactionStatus(trxId, 'SUCCESS', {
      settlement_ref: 'SIMULASI-TESTER-' + Date.now()
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, transaction: updated }));
  }

  // ==========================================
  // ROUTE 6: [STATUS AKUN] Info Akun & Token GoPay Merchant
  // ==========================================
  if (req.method === 'GET' && pathname === '/api/v1/account-status') {
    const smSession = sessionManager.loadSession();
    const gpSession = gopayClient.getSession();
    const isConn = Boolean(smSession && smSession.access_token) || gpSession.is_connected;

    function maskInfo(str) {
      if (!str || str.length < 5) return '•••••';
      return str.substring(0, 3) + '••••' + str.substring(str.length - 2);
    }

    const rawPhone = (smSession && (smSession.phone_number || smSession.phone)) || gpSession.phone_number;
    const rawMerchantId = (smSession && smSession.merchant_id) || gpSession.merchant_id || process.env.GOPAY_MERCHANT_ID;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      is_connected: isConn,
      phone_number: rawPhone ? maskInfo(rawPhone) : 'Belum ditautkan',
      merchant_id: rawMerchantId ? maskInfo(rawMerchantId) : null,
      token_expires_at: (smSession && (smSession.expires_at || smSession.updated_at)) || gpSession.expires_at || null,
      api_key_configured: Boolean(config.api_key && config.api_key !== 'your_secret_api_key_here'),
      default_static_qris_exists: Boolean(config.default_static_qris)
    }));
  }

  // ==========================================
  // ROUTE 7: Halaman Checkout Interaktif untuk Pembeli
  // Format URL: /checkout/:trx_id
  // ==========================================
  if (pathname.startsWith('/checkout/')) {
    const checkoutHtmlPath = path.join(PUBLIC_DIR, 'checkout.html');
    fs.readFile(checkoutHtmlPath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Checkout Page Not Found');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      }
    });
    return;
  }

  // ==========================================
  // ROUTE 8: Endpoint jsQR.js untuk scanner gambar
  // ==========================================
  if (pathname === '/js/jsQR.js') {
    const jsQrPath = path.join(__dirname, 'node_modules', 'jsqr', 'dist', 'jsQR.js');
    fs.readFile(jsQrPath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(content);
      }
    });
    return;
  }

  // ==========================================
  // ROUTE 9: Layani Dashboard Frontend (index.html)
  // ==========================================
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    } else {
      let ext = path.extname(filePath);
      let contentType = 'text/html';
      if (ext === '.js') contentType = 'text/javascript';
      if (ext === '.css') contentType = 'text/css';
      if (ext === '.json') contentType = 'application/json';
      if (ext === '.png') contentType = 'image/png';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🚀 GoPay API Gateway Mandiri Berjalan!`);
  console.log(`🌐 Dashboard Console: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
