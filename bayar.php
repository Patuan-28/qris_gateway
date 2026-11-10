<?php
// Konfigurasi
$serverKey = 'PASTE_SERVER_KEY_SANDBOX_ANDA_DI_SINI'; // Ganti dengan Server Key Anda
$orderId = 'ORDER-' . time();
$totalBayar = 50000;

// Request ke Midtrans Core API
$url = 'https://api.sandbox.midtrans.com/v2/charge';

$payload = [
    'payment_type' => 'qris',
    'transaction_details' => [
        'order_id' => $orderId,
        'gross_amount' => $totalBayar
    ],
    'qris' => [
        'acquirer' => 'gopay'
    ]
];

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_POST, 1);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Content-Type: application/json',
    'Accept: application/json',
    'Authorization: Basic ' . base64_encode($serverKey . ':')
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false); // Aman untuk testing lokal

$response = curl_exec($ch);
curl_close($ch);

$result = json_decode($response, true);

$qrImageUrl = '';
$qrString = $result['qr_string'] ?? '';

if (isset($result['actions'])) {
    foreach ($result['actions'] as $action) {
        if ($action['name'] === 'generate-qr-code') {
            $qrImageUrl = $action['url'];
            break;
        }
    }
}
?>

<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <title>Pembayaran QRIS GoPay (PHP)</title>
    <style>
        body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #f4f6f9; margin: 0; }
        .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); text-align: center; max-width: 380px; }
        .nominal { font-size: 26px; font-weight: bold; color: #00880C; margin: 10px 0; }
        .qr-box img { width: 230px; height: 230px; border: 1px solid #ddd; padding: 10px; border-radius: 8px; }
        .note { font-size: 13px; color: #666; margin-top: 15px; }
    </style>
</head>
<body>

<div class="card">
    <h3>Selesaikan Pembayaran</h3>
    <p>ID Pesanan: <strong><?= htmlspecialchars($orderId) ?></strong></p>
    <div class="nominal">Rp <?= number_format($totalBayar, 0, ',', '.') ?></div>
    
    <div class="qr-box">
        <?php if ($qrImageUrl): ?>
            <img src="<?= htmlspecialchars($qrImageUrl) ?>" alt="QRIS GoPay">
        <?php else: ?>
            <p style="color:red;">Gagal memuat QR Code.<br><small><?= htmlspecialchars($result['status_message'] ?? 'Periksa Server Key Anda') ?></small></p>
        <?php endif; ?>
    </div>

    <p class="note">
        Scan QRIS di atas menggunakan aplikasi <strong>GoPay</strong>, BCA, OVO, atau mobile banking apa saja.
    </p>
</div>

</body>
</html>
