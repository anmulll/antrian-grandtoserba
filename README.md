# DES Cashier — Supabase + Vercel (free tiers)

Aplikasi pencatatan observasi DES untuk supermarket dengan empat kasir dan empat antrean terpisah. Beberapa pengamat dapat login dari perangkat masing-masing dan mengakses data yang sama.

## Fitur
- Login email/password melalui Supabase Auth.
- Database PostgreSQL bersama dengan Row Level Security (RLS).
- Catat waktu kedatangan, kasir aktual yang dipilih, dan snapshot panjang antrean K1–K4.
- Tombol waktu mulai dan selesai pelayanan.
- Durasi tunggu, durasi pelayanan, dan ringkasan rata-rata otomatis.
- Update lintas perangkat melalui Supabase Realtime jika diaktifkan.
- Edit/koreksi data, filter, ekspor CSV, dan backup JSON.
- Tampilan responsif untuk ponsel dan desktop.

## 1. Buat proyek Supabase
1. Buka https://supabase.com/ dan buat proyek pada paket Free.
2. Simpan password database di tempat aman. Aplikasi ini memakai API, jadi password database tidak dimasukkan ke kode frontend.
3. Buka **SQL Editor** di dashboard Supabase.
4. Salin seluruh isi `schema.sql`, lalu jalankan.
5. Buka **Project Settings → API** (atau halaman API Keys). Salin **Project URL** dan **publishable key** atau **anon public key**.
6. Buka `config.js`, ganti nilai `PASTE_SUPABASE_PROJECT_URL_HERE` dan `PASTE_SUPABASE_PUBLISHABLE_OR_ANON_KEY_HERE` dengan nilai dari proyekmu.

**Jangan masukkan `service_role` key atau secret key ke `config.js`.** Frontend menggunakan publishable/anon key; perlindungan data diterapkan lewat RLS pada database.

## 2. Buat akun anggota kelompok
Versi ini sengaja tidak menyediakan pendaftaran publik.
1. Di Supabase buka **Authentication → Users**.
2. Buat akun email/password untuk setiap anggota kelompok yang akan mencatat data.
3. Di pengaturan Authentication, nonaktifkan **Allow new users to sign up** agar orang lain tidak dapat membuat akun sendiri dari API.
4. Bagikan URL aplikasi dan kredensial secara aman kepada anggota kelompok. Sebaiknya setiap orang memakai akun sendiri.

Semua akun yang dibuat admin dapat membaca, menambah, mengoreksi, dan menghapus semua data observasi. Karena itu, hanya buat akun untuk anggota yang dipercaya.

## 3. Aktifkan Realtime (disarankan)
Buka bagian Database > Publications/Replication pada dashboard Supabase, lalu aktifkan tabel `public.cashier_observations` di publication `supabase_realtime`. Jika Realtime tidak diaktifkan, data tetap tersimpan di database dan tombol **Segarkan** bisa mengambil data terbaru, tetapi perubahan tidak langsung muncul otomatis di perangkat lain.

## 4. Deploy gratis ke Vercel
1. Ekstrak ZIP.
2. Buat repository GitHub, lalu unggah file `index.html`, `styles.css`, `app.js`, `config.js`, `schema.sql`, `README.md`, dan `vercel.json`.
3. Buka https://vercel.com/new lalu impor repository.
4. Framework Preset: **Other**. Build Command: kosongkan. Output Directory: `.`.
5. Klik **Deploy**.
6. Setelah deployment berhasil, buka URL Vercel dan login menggunakan akun Supabase yang dibuat admin.

File `config.js` berisi URL proyek dan publishable/anon key yang memang digunakan di browser. RLS harus tetap aktif; jangan pernah mengganti key tersebut dengan service-role/secret key. Repository private tetap disarankan, walaupun publishable/anon key bukan password rahasia.

## 5. Cara melakukan observasi
1. Semua pengamat membuka URL aplikasi dan login.
2. Sebelum pelanggan bergabung, hitung jumlah pelanggan di tiap antrean K1–K4, termasuk yang sedang dilayani.
3. Pilih kasir yang benar-benar dipilih pelanggan dan tekan **Catat kedatangan sekarang**.
4. Saat kasir mulai melayani customer itu, tekan **Mulai** pada baris/customer yang benar.
5. Saat transaksi selesai, tekan **Selesai**.
6. Jika waktu tombol terlambat ditekan atau ada salah input, gunakan **Edit** untuk mengoreksi waktu sesuai catatan observasi yang sebenarnya.
7. Ekspor CSV secara berkala untuk backup dan pengolahan di Excel.

## Data dan definisi
- Waktu disimpan sebagai timestamp dengan zona waktu dan ditampilkan dalam zona waktu lokal perangkat.
- Durasi tunggu = waktu mulai pelayanan − waktu kedatangan.
- Durasi pelayanan = waktu selesai pelayanan − waktu mulai pelayanan.
- Snapshot antrean adalah jumlah yang menunggu + yang sedang dilayani, sebelum customer baru bergabung.
- `id` database menjadi nomor customer unik bersama di seluruh perangkat.

## Catatan batasan paket gratis
- Supabase Free menyediakan database hingga 500 MB per proyek dan dapat menjeda proyek setelah sekitar satu minggu tidak aktif. Untuk observasi kelas berukuran kecil, kebutuhan data biasanya sangat rendah, tetapi ekspor CSV/JSON sebagai backup tetap wajib.
- Vercel Hobby ditujukan untuk proyek personal/nonkomersial. Pastikan pemakaian mengikuti ketentuan layanan yang berlaku.
- Paket gratis dan kuotanya dapat berubah. Periksa dashboard kedua layanan bila aplikasi dipakai untuk jangka panjang.
