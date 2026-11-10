const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'transactions.json');

// Pastikan direktori data ada
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Inisialisasi file DB jika belum ada
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2), 'utf-8');
}

function readAll() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error('Error membaca database transaksi:', err);
    return [];
  }
}

function writeAll(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error menulis database transaksi:', err);
  }
}

function createTransaction(txData) {
  const transactions = readAll();
  const now = new Date();
  const expiryMinutes = txData.expiry_minutes || 15;
  const expiredAt = new Date(now.getTime() + expiryMinutes * 60000);

  const newTx = {
    trx_id: txData.trx_id || 'TRX-' + Date.now() + '-' + Math.floor(Math.random() * 899 + 100),
    order_id: txData.order_id || 'ORD-' + Date.now(),
    amount: parseInt(txData.amount, 10),
    merchant_name: txData.merchant_name || 'GoPay Merchant',
    merchant_city: txData.merchant_city || 'Indonesia',
    dynamic_qris: txData.dynamic_qris,
    qr_image: txData.qr_image,
    status: 'PENDING', // PENDING | SUCCESS | EXPIRED
    callback_url: txData.callback_url || null,
    created_at: now.toISOString(),
    expired_at: expiredAt.toISOString(),
    paid_at: null
  };

  transactions.unshift(newTx); // Simpan di urutan teratas
  writeAll(transactions);
  return newTx;
}

function getTransaction(trx_id) {
  const transactions = readAll();
  const tx = transactions.find(t => t.trx_id === trx_id || t.order_id === trx_id);
  if (!tx) return null;

  // Cek apakah sudah expired otomatis
  if (tx.status === 'PENDING' && new Date() > new Date(tx.expired_at)) {
    tx.status = 'EXPIRED';
    writeAll(transactions);
  }

  return tx;
}

function updateTransactionStatus(trx_id, status, extra = {}) {
  const transactions = readAll();
  const tx = transactions.find(t => t.trx_id === trx_id || t.order_id === trx_id);
  if (!tx) return null;

  tx.status = status;
  if (status === 'SUCCESS') {
    tx.paid_at = new Date().toISOString();
  }
  Object.assign(tx, extra);
  writeAll(transactions);
  return tx;
}

function findPendingByAmount(amount) {
  const transactions = readAll();
  const now = new Date();
  // Cari transaksi PENDING dengan nominal yang sama yang belum expired
  return transactions.find(t => 
    t.status === 'PENDING' && 
    parseInt(t.amount, 10) === parseInt(amount, 10) &&
    new Date(t.expired_at) > now
  );
}

function deleteTransactions(trxIds) {
  const transactions = readAll();
  const filtered = transactions.filter(t => !trxIds.includes(t.trx_id));
  writeAll(filtered);
  return { deleted_count: transactions.length - filtered.length };
}

function clearAllTransactions() {
  const transactions = readAll();
  writeAll([]);
  return { deleted_count: transactions.length };
}

module.exports = {
  createTransaction,
  getTransaction,
  updateTransactionStatus,
  findPendingByAmount,
  deleteTransactions,
  clearAllTransactions,
  getAllTransactions: readAll
};
