# ⚡ Autonomous GoPay & QRIS Payment Gateway (Node.js)

<p align="left">
  <img src="https://img.shields.io/badge/Node.js-v18%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/QRIS-EMVCo%20Standard-crimson" alt="QRIS" />
  <img src="https://img.shields.io/badge/Gateway-Self--Hosted-blue" alt="Self-Hosted" />
  <img src="https://img.shields.io/badge/Auth-API%20Key%20Protected-green" alt="Auth" />
</p>

Payment gateway mandiri (self-hosted) berbasis **Node.js** untuk membuat **QRIS Dinamis** secara instan dari QRIS statis merchant, lengkap dengan **halaman checkout interaktif**, **pengecekan mutasi otomatis (Auto-Polling GoBiz API)**, dan **REST API** siap integrasi ke web store / aplikasi Anda — **tanpa potongan biaya pihak ketiga (0% gateway fee)** dan **tanpa perlu langganan Midtrans/Xendit**.

---

## ✨ Fitur Utama

- 🧾 **Generator QRIS Dinamis Presisi Tinggi (EMVCo ASPI):** Mengubah QRIS statis merchant menjadi QRIS dinamis dengan nominal terkunci (Tag `54`) dan checksum CRC16-CCITT standar Bank Indonesia.
- 📱 **Halaman Checkout Interaktif Siap Pakai:** Dilengkapi hitung mundur timer (15 menit), tampilan QR dinamis resolusi tinggi, dan polling otomatis yang mendeteksi pelunasan seketika.
- 🔄 **Auto-Polling Mutasi Transaksi (GoBiz API):** Mendeteksi dana masuk secara real-time langsung dari server Gojek/GoBiz. Status pembayaran di browser seketika berubah hijau (LUNAS) begitu pembeli scan & bayar dari HP.
- 🔐 **Login OTP Terminal & Token Auto-Refresh:** Autentikasi akun GoBiz aman cukup 1 kali lewat terminal (`node login.js`). Token sesi diperbarui otomatis di background setiap 6 jam.
- 🛡️ **Anti-Duplicate Claim:** Setiap pembayaran memiliki referensi unik sehingga pembayaran dengan nominal yang sama tidak akan saling klaim.
- 📊 **Dashboard Console & Riwayat Transaksi:** Antarmuka web lokal untuk memantau transaksi, menguji nominal, serta fitur seleksi hapus (checkbox) dan Clear All.
- 🔌 **REST API Lengkap:** Endpoint pembuatan tagihan (`/api/v1/charge`) diproteksi API Key, serta endpoint publik aman (`/api/v1/qr-status/:trx_id`) untuk frontend checkout.

---

## 📁 Struktur Direktori

```text
├── .env.example          # Template konfigurasi environment (aman di-commit)
├── config.example.json   # Template alternatif config JSON
├── .gitignore            # Mengamankan token, cookie, dan database lokal
├── server.js             # Core HTTP server REST API & background poller
├── qris-util.js          # Parser TLV & converter QRIS statis ke dinamis
├── db.js                 # Database transaksi file-based (JSON)
├── gopay-client.js       # Client pemroses mutasi & callback
├── login.js              # Script login interaktif OTP GoBiz terminal
├── sessionManager.js     # Manager token session & auto-refresh
├── public/
│   ├── index.html        # Dashboard console & API documentation
│   └── checkout.html     # Halaman checkout pembeli
└── data/
    └── .gitkeep          # Direktori penyimpanan database transaksi lokal
```

---

## 🚀 Panduan Instalasi & Menjalankan

### 1. Clone Repositori & Install Dependencies

```bash
git clone https://github.com/username/qris_gateway.git
cd qris_gateway
npm install
```

### 2. Konfigurasi Environment (`.env`)

Salin template konfigurasi `.env.example` ke `.env`:

```bash
# Windows Command Prompt:
copy .env.example .env

# Linux / MacOS / PowerShell:
cp .env.example .env
```

Buka file `.env` dan sesuaikan nilainya:

```env
PORT=5050
API_KEY=gopay_sec_your_secret_key_here
QRIS_STATIC=00020101021126610014COM.GO-JEK.WWW0118...YOUR_QRIS_STATIC_HERE...
GOPAY_MERCHANT_ID=G_YOUR_MERCHANT_ID_HERE
EXPIRY_MINUTES=15
AUTO_UNIQUE_CODE=true
```

> [!TIP]
> **Di mana mendapatkan QRIS_STATIC?**  
> Buka aplikasi GoBiz di HP Anda -> Menu QRIS Toko -> Unduh/Tampilkan QR -> Scan menggunakan aplikasi QR Scanner untuk menyalin teks string QRIS lengkapnya.

### 3. Login Akun GoBiz (1 Kali Saja)

Jalankan perintah ini di terminal untuk menghubungkan gateway dengan akun GoBiz Anda:

```bash
node login.js
```

1. Masukkan **Nomor HP** yang terdaftar di akun GoBiz/GoPay Merchant Anda.
2. Masukkan **4 digit kode OTP** yang dikirimkan via SMS/WhatsApp.
3. Sesi login akan tersimpan secara otomatis dan token akan terus diperbarui oleh server tanpa perlu login ulang.

### 4. Jalankan Server Gateway

```bash
node server.js
```

Buka browser Anda dan akses:
👉 **http://localhost:5050**

---

## 🔌 Dokumentasi REST API

### 1. Buat Tagihan QRIS Dinamis (`POST /api/v1/charge`)
Endpoint untuk aplikasi/website toko Anda membuat QRIS dinamis.

- **Headers:**
  - `Content-Type: application/json`
  - `X-API-Key: <API_KEY_ANDA>`
- **Request Body (JSON):**
  ```json
  {
    "amount": 50000,
    "order_id": "ORDER-1001",
    "add_unique_code": true
  }
  ```
- **Response (201 Created):**
  ```json
  {
    "success": true,
    "trx_id": "TRX-1794223103579-788",
    "order_id": "ORDER-1001",
    "amount": 50142,
    "merchant_name": "NAMA TOKO ANDA",
    "dynamic_qris": "00020101021226610014COM.GO-JEK...",
    "qr_image": "data:image/png;base64,...",
    "checkout_url": "http://localhost:5050/checkout/TRX-1794223103579-788",
    "status": "PENDING",
    "expired_at": "2026-11-10T12:00:00.000Z"
  }
  ```

---

### 2. Cek Status Pembayaran Real-Time (`GET /api/v1/qr-status/:trx_id`)
Endpoint publik (aman dipanggil dari halaman web checkout pembeli tanpa API Key).

- **URL:** `http://localhost:5050/api/v1/qr-status/TRX-1794223103579-788`
- **Response (200 OK):**
  ```json
  {
    "trx_id": "TRX-1794223103579-788",
    "order_id": "ORDER-1001",
    "amount": 50142,
    "merchant_name": "NAMA TOKO ANDA",
    "status": "SUCCESS",
    "created_at": "2026-11-10T11:45:00.000Z",
    "paid_at": "2026-11-10T11:46:12.000Z",
    "payer_issuer": "GoPay / Bank",
    "settlement_ref": "GOJEK-TX-998811"
  }
  ```

---

### 3. Riwayat Transaksi (`GET /api/v1/transactions`)
- **Headers:** `X-API-Key: <API_KEY_ANDA>`
- **Response (200 OK):** Mengembalikan daftar seluruh transaksi lokal.

---

### 4. Hapus Transaksi (`POST /api/v1/transactions/delete`)
- **Headers:** `X-API-Key: <API_KEY_ANDA>`
- **Request Body (Hapus Terpilih):**
  ```json
  { "trx_ids": ["TRX-12345", "TRX-67890"] }
  ```
- **Request Body (Clear All):**
  ```json
  { "all": true }
  ```

---

### 5. Smart Webhook Notifier (`POST /api/v1/webhook/notify`)
Menerima forwarder notifikasi dana masuk dari aplikasi Android (misal: MacroDroid, Tasker, SMS Forwarder). Mendukung payload JSON maupun format teks notifikasi mentah.

---

## 🔒 Catatan Keamanan (Security Guidelines)

> [!CAUTION]
> **JANGAN PERNAH MENGUNGGAH FILE BERIKUT KE GITHUB ATAU PUBLIK:**
> - File `.env` (berisi API Key & QRIS Statis Anda).
> - File `.GOPAY_SESI_JANGAN_DIHAPUS.json` (berisi cookie autentikasi & token GoBiz aktif).
> - File `config.json` (jika menggunakan konfigurasi file lokal).
> - File `data/transactions.json` (berisi riwayat transaksi dan data pembeli Anda).
>
> Seluruh file sensitif di atas **sudah otomatis dilindungi dan dimasukkan ke dalam `.gitignore`**, sehingga tidak akan ikut ter-upload saat Anda melakukan `git push`.

---

## ⚖️ Lisensi & Disclaimer

Proyek ini dibuat untuk keperluan pengujian dan otomasi internal merchant. Tidak berafiliasi secara resmi dengan PT GoTo Gojek Tokopedia Tbk. Gunakan secara bijak dan patuhi ketentuan layanan GoBiz/GoPay Merchant.
