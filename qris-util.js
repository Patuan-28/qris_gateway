/**
 * QRIS Converter Utility (Statis ke Dinamis)
 * Berdasarkan standar resmi EMVCo / ASPI QRIS Bank Indonesia
 */

function crc16(str) {
  let crc = 0xFFFF;
  for (let c = 0; c < str.length; c++) {
    crc ^= str.charCodeAt(c) << 8;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function parseQris(rawQris) {
  const str = rawQris.trim();
  let merchantName = 'Toko Merchant';
  let merchantCity = 'Indonesia';
  let currency = 'IDR';
  let isStatic = str.includes('010211');
  let isDynamic = str.includes('010212');

  const idx58 = str.indexOf('5802ID');
  if (idx58 !== -1) {
    const after58 = str.substring(idx58);
    const m59 = after58.match(/59([0-9]{2})/);
    if (m59) {
      const len59 = parseInt(m59[1], 10);
      merchantName = after58.substr(m59.index + 4, len59);
    }
    const m60 = after58.match(/60([0-9]{2})/);
    if (m60) {
      const len60 = parseInt(m60[1], 10);
      merchantCity = after58.substr(m60.index + 4, len60);
    }
  }

  return {
    raw: str,
    merchantName: merchantName.trim(),
    merchantCity: merchantCity.trim(),
    currency: currency,
    isStatic: isStatic,
    isDynamic: isDynamic
  };
}

function convertStaticToDynamic(staticQris, nominal) {
  let clean = staticQris.trim();

  if (!clean.startsWith('000201')) {
    throw new Error('Format QRIS tidak valid. Standar QRIS Indonesia wajib diawali dengan 000201');
  }

  // 1. Potong bagian CRC16 lama di akhir string (tag 6304XXXX)
  const crcIndex = clean.lastIndexOf('6304');
  if (crcIndex !== -1) {
    clean = clean.substring(0, crcIndex);
  }

  // 2. Ubah Point of Initiation (Tag 01) dari '11' (statis) ke '12' (dinamis)
  clean = clean.replace('010211', '010212');

  // 3. Format Tag 54 (Nominal Transaksi)
  const amountStr = Math.round(Number(nominal)).toString();
  const tag54 = '54' + amountStr.length.toString().padStart(2, '0') + amountStr;

  // 4. Sisipkan Tag 54 sebelum Tag 58 (Kode Negara 5802ID) atau update jika sudah ada
  const tag54Regex = /54([0-9]{2})([0-9]+)/;
  if (tag54Regex.test(clean)) {
    clean = clean.replace(tag54Regex, tag54);
  } else {
    const idx58 = clean.indexOf('5802');
    if (idx58 !== -1) {
      clean = clean.slice(0, idx58) + tag54 + clean.slice(idx58);
    } else {
      const idx53 = clean.indexOf('5303360');
      if (idx53 !== -1) {
        clean = clean.slice(0, idx53 + 7) + tag54 + clean.slice(idx53 + 7);
      } else {
        clean = clean + tag54;
      }
    }
  }

  // 5. Tambahkan tag 6304 dan hitung ulang CRC16
  const toHash = clean + '6304';
  const newCrc = crc16(toHash);

  return toHash + newCrc;
}

module.exports = {
  crc16,
  parseQris,
  convertStaticToDynamic
};
