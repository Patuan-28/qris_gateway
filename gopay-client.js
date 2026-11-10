/**
 * GoPay / GoBiz Merchant Client & Session Token Manager
 * Mendukung Auto-Refresh Token & Monitoring Mutasi Transaksi
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const SESSION_FILE = path.join(__dirname, 'data', 'session.json');

function getSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    }
  } catch (e) {}
  return {
    phone_number: '',
    access_token: '',
    refresh_token: '',
    expires_at: null,
    merchant_id: '',
    is_connected: false
  };
}

function saveSession(data) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('Gagal menyimpan session GoPay:', e);
  }
}

/**
 * Otomatis memperbarui token jika sudah mendekati waktu kedaluwarsa
 */
async function autoRefreshToken() {
  const session = getSession();
  if (!session.access_token || !session.refresh_token) {
    return { status: 'NO_TOKEN', message: 'Belum ada session token GoPay' };
  }

  // Cek apakah token masih berlaku (dengan buffer 10 menit)
  if (session.expires_at) {
    const expires = new Date(session.expires_at).getTime();
    const now = Date.now();
    if (expires - now > 10 * 60 * 1000) {
      return { status: 'VALID', message: 'Token masih aktif' };
    }
  }

  console.log('[GOPAY TOKEN] Token mendekati kedaluwarsa, melakukan refresh token otomatis...');

  try {
    // Endpoint GoTo / GoBiz Token Refresh
    const res = await fetch('https://api.gobiz.co.id/v1/auth/tokens/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`
      },
      body: JSON.stringify({
        refresh_token: session.refresh_token
      })
    });

    if (res.ok) {
      const data = await res.json();
      session.access_token = data.access_token || session.access_token;
      session.refresh_token = data.refresh_token || session.refresh_token;
      session.expires_at = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
      session.is_connected = true;
      saveSession(session);
      console.log('[GOPAY TOKEN] ✅ Token berhasil diperbarui secara otomatis!');
      return { status: 'REFRESHED', token: session.access_token };
    } else {
      console.warn('[GOPAY TOKEN] ⚠️ Gagal refresh token, status HTTP:', res.status);
      return { status: 'FAILED', message: `HTTP ${res.status}` };
    }
  } catch (err) {
    console.error('[GOPAY TOKEN] Error auto refresh token:', err.message);
    return { status: 'ERROR', error: err.message };
  }
}

/**
 * Memproses notifikasi mutasi uang masuk (dari polling API GoPay atau forwarder HP)
 */
async function processIncomingMutation(amount, reference = '') {
  console.log(`[MUTASI MASUK] Mendeteksi dana masuk: Rp ${Number(amount).toLocaleString('id-ID')} (Ref: ${reference})`);

  // Cari transaksi pending yang cocok dengan nominal
  const tx = db.findPendingByAmount(amount);

  if (tx) {
    console.log(`[MATCH FOUND] Transaksi cocok: ${tx.trx_id} (Order: ${tx.order_id})`);
    
    // Update status transaksi menjadi SUCCESS
    const updated = db.updateTransactionStatus(tx.trx_id, 'SUCCESS', {
      settlement_ref: reference,
      paid_at: new Date().toISOString()
    });

    // Tembak Webhook Callback jika ada
    if (updated.callback_url) {
      try {
        console.log(`[WEBHOOK CALLBACK] Mengirim notifikasi lunas ke: ${updated.callback_url}`);
        fetch(updated.callback_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'payment.success',
            trx_id: updated.trx_id,
            order_id: updated.order_id,
            amount: updated.amount,
            status: 'SUCCESS',
            paid_at: updated.paid_at
          })
        }).catch(e => console.error('Gagal menembak callback merchant:', e.message));
      } catch (e) {}
    }

    return { matched: true, transaction: updated };
  } else {
    console.log(`[MUTASI MASUK] Tidak ada transaksi pending yang cocok dengan nominal Rp ${amount}`);
    return { matched: false, amount };
  }
}

module.exports = {
  getSession,
  saveSession,
  autoRefreshToken,
  processIncomingMutation
};
