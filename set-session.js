/**
 * Helper untuk Menyimpan Session GoBiz Merchant dari Browser
 * Jalankan: node set-session.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SESSION_FILE = path.join(__dirname, '.GOPAY_SESI_JANGAN_DIHAPUS.json');
const ENV_FILE = path.join(__dirname, '.env');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('===========================================================');
console.log('   PENGATURAN TOKEN GOBIZ / GOFOOD MERCHANT (SERVER-SIDE)  ');
console.log('===========================================================');
console.log('Untuk menarik mutasi secara otomatis langsung dari API Gojek,');
console.log('silakan login 1x via browser di: https://portal.gofoodmerchant.co.id\n');
console.log('Lalu buka Developer Tools (F12) -> Console, dan ketik:');
console.log('  document.cookie');
console.log('atau copy access_token dari tab Application -> Cookies.\n');

rl.question('>> Tempelkan teks cookie / token dari browser di sini: \n> ', (input) => {
  const text = input.trim();
  if (!text) {
    console.log('[-] Input kosong.');
    rl.close();
    return;
  }

  let accessToken = '';
  let refreshToken = '';

  // 1. Cek apakah format JSON
  try {
    const parsed = JSON.parse(text);
    accessToken = parsed.access_token || parsed.accessToken || '';
    refreshToken = parsed.refresh_token || parsed.refreshToken || '';
  } catch (e) {
    // 2. Parse format cookie string (access_token=...; refresh_token=...)
    const atMatch = text.match(/access_token=([^;]+)/);
    const rtMatch = text.match(/refresh_token=([^;]+)/);
    if (atMatch) accessToken = atMatch[1].trim();
    if (rtMatch) refreshToken = rtMatch[1].trim();
    if (!accessToken && !text.includes('=')) {
      // Asumsikan user menempelkan access_token mentah
      accessToken = text;
    }
  }

  if (!accessToken) {
    console.log('[-] Gagal mengekstrak access_token. Pastikan teks yang ditempelkan benar.');
    rl.close();
    return;
  }

  rl.question('\n>> Masukkan Merchant ID GoBiz Anda (contoh: G123456789) [Opsional, tekan Enter jika belum tahu]: ', (mId) => {
    const merchantId = mId.trim() || process.env.GOPAY_MERCHANT_ID || '';

    const sessionData = {
      access_token: accessToken,
      refresh_token: refreshToken || accessToken,
      merchant_id: merchantId,
      phone_number: 'Terhubung via Web Portal',
      expires_at: new Date(Date.now() + 3600 * 1000 * 24).toISOString(),
      updated_at: new Date().toISOString()
    };

    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2), 'utf-8');
    console.log('\n[+] ✅ Sesi GoBiz berhasil disimpan ke .GOPAY_SESI_JANGAN_DIHAPUS.json!');

    // Update .env jika ada GOPAY_COOKIE
    if (fs.existsSync(ENV_FILE)) {
      let envContent = fs.readFileSync(ENV_FILE, 'utf-8');
      if (refreshToken) {
        const cookieStr = `access_token=${accessToken}; refresh_token=${refreshToken};`;
        if (envContent.includes('GOPAY_COOKIE=')) {
          envContent = envContent.replace(/GOPAY_COOKIE=.*/, `GOPAY_COOKIE="${cookieStr}"`);
        } else {
          envContent += `\nGOPAY_COOKIE="${cookieStr}"\n`;
        }
      }
      if (merchantId) {
        if (envContent.includes('GOPAY_MERCHANT_ID=')) {
          envContent = envContent.replace(/GOPAY_MERCHANT_ID=.*/, `GOPAY_MERCHANT_ID=${merchantId}`);
        } else {
          envContent += `\nGOPAY_MERCHANT_ID=${merchantId}\n`;
        }
      }
      fs.writeFileSync(ENV_FILE, envContent, 'utf-8');
      console.log('[+] ✅ File .env berhasil diperbarui.');
    }

    console.log('\n🚀 Sekarang server Anda sudah bisa menarik mutasi API Gojek otomatis!');
    console.log('   Buka: http://localhost:5050 untuk mengujinya.');
    rl.close();
  });
});
