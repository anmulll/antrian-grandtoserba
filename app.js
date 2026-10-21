(() => {
  "use strict";

  const TABLE = "cashier_observations";
  const CASHIERS = ["K1", "K2", "K3", "K4"];
  const STATION_STORAGE_KEY = "desCashierAssignedStationV2";
  const $ = (id) => document.getElementById(id);

  let supabaseClient = null;
  let session = null;
  let records = [];
  let realtimeChannel = null;
  let toastTimer = null;
  let loadingRecords = false;
  let reloadRequested = false;
  let selectedCashier = loadStation();

  function loadStation() {
    try {
      const value = localStorage.getItem(STATION_STORAGE_KEY);
      return CASHIERS.includes(value) ? value : "";
    } catch (_) {
      return "";
    }
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function showToast(message) {
    const toast = $("toast");
    if (!toast) return;
    toast.textContent = String(message || "Terjadi kesalahan.");
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 4200);
  }

  function setBadge(message, state = "") {
    const badge = $("connection-badge");
    if (!badge) return;
    badge.className = "sync-badge" + (state ? " " + state : "");
    badge.innerHTML = `<span class="dot"></span>${escapeHtml(message)}`;
  }

  function setScreen(screenId) {
    ["setup-screen", "login-screen", "app-screen"].forEach((id) => {
      $(id)?.classList.toggle("hidden", id !== screenId);
    });
    $("logout-button")?.classList.toggle("hidden", screenId !== "app-screen");
  }

  function isConfigured() {
    const rawUrl = String(window.DES_SUPABASE_URL || "").trim();
    const key = String(window.DES_SUPABASE_ANON_KEY || "").trim();
    let validUrl = false;
    try {
      const url = new URL(rawUrl);
      validUrl = url.protocol === "https:" && !!url.hostname &&
        !url.pathname.replace(/\/$/, "") &&
        !rawUrl.includes("PROJECT_REF_KAMU") && !rawUrl.includes("PASTE_");
    } catch (_) { validUrl = false; }
    const validKey = key.length > 20 && !key.includes("PASTE_") && !key.includes("KEY_KAMU");
    return validUrl && validKey;
  }

  function showSetupError(message) {
    setScreen("setup-screen");
    $("setup-message").textContent = message;
    setBadge("Konfigurasi dibutuhkan", "offline");
  }

  function timestamp(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("id-ID", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).format(date);
  }

  function toLocalInput(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function fromLocalInput(value) {
    if (!value) return null;
    const result = new Date(value).getTime();
    return Number.isFinite(result) ? new Date(result).toISOString() : null;
  }

  function duration(milliseconds) {
    if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds < 0) return "—";
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return [hours, minutes, remainder].map((n) => String(n).padStart(2, "0")).join(":");
  }

  function waitMs(row) {
    if (!row.arrival_at || !row.service_start_at) return null;
    const value = new Date(row.service_start_at).getTime() - new Date(row.arrival_at).getTime();
    return value >= 0 ? value : null;
  }

  function serviceMs(row) {
    if (!row.service_start_at || !row.service_finish_at) return null;
    const value = new Date(row.service_finish_at).getTime() - new Date(row.service_start_at).getTime();
    return value >= 0 ? value : null;
  }

  function systemMs(row) {
    if (!row.arrival_at || !row.service_finish_at) return null;
    const value = new Date(row.service_finish_at).getTime() - new Date(row.arrival_at).getTime();
    return value >= 0 ? value : null;
  }

  function average(values) {
    const valid = values.filter((value) => value !== null && Number.isFinite(value) && value >= 0);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
  }

  function statusOf(row) {
    if (row.service_finish_at) return "complete";
    if (row.service_start_at) return "serving";
    return "waiting";
  }

  function statusLabel(status) {
    return ({ waiting: "Belum mulai", serving: "Sedang dilayani", complete: "Selesai" })[status] || status;
  }

  function stationRecords() {
    return selectedCashier ? records.filter((row) => row.cashier === selectedCashier) : [];
  }

  // Nomor customer ditampilkan terpisah per kasir, bukan memakai ID database global.
  // Urutan ditentukan dari waktu kedatangan; ID database hanya dipakai internal untuk aksi CRUD.
  let customerNumbers = new Map();

  function rebuildCustomerNumbers() {
    const nextMap = new Map();

    for (const cashier of CASHIERS) {
      const cashierRows = records
        .filter((row) => row.cashier === cashier)
        .slice()
        .sort((a, b) => {
          const timeA = Date.parse(a.arrival_at) || 0;
          const timeB = Date.parse(b.arrival_at) || 0;
          if (timeA !== timeB) return timeA - timeB;
          return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
        });

      cashierRows.forEach((row, index) => {
        nextMap.set(String(row.id), index + 1);
      });
    }

    customerNumbers = nextMap;
  }

  function customerNumberOf(row) {
    return customerNumbers.get(String(row?.id)) ?? "—";
  }

  function busyRecordForCashier(cashier, exceptId = null) {
    return records.find((row) => String(row.id) !== String(exceptId) && row.cashier === cashier && row.service_start_at && !row.service_finish_at) || null;
  }

  function stationLabel(cashier) {
    const number = CASHIERS.indexOf(cashier) + 1;
    return cashier ? `Kasir ${number} (${cashier})` : "Belum dipilih";
  }

  // ---------- UI rendering ----------

  function renderStats() {
    const current = stationRecords();
    const complete = current.filter((row) => row.service_start_at && row.service_finish_at);
    const avgWait = average(current.map(waitMs));
    const avgService = average(complete.map(serviceMs));
    $("stat-total").textContent = String(current.length);
    $("stat-complete").textContent = String(complete.length);
    $("stat-wait").textContent = avgWait == null ? "—" : duration(avgWait);
    $("stat-service").textContent = avgService == null ? "—" : duration(avgService);
    $("stat-pending").textContent = String(current.filter((row) => statusOf(row) !== "complete").length);
  }

  function renderProgress() {
    for (const cashier of CASHIERS) {
      const count = records.filter((row) => row.cashier === cashier).length;
      $(`count-${cashier.toLowerCase()}`).textContent = String(count);
    }
    $("all-record-count").textContent = `${records.length} total`;
  }

  function renderPending() {
    const list = $("pending-list");
    const pending = stationRecords().filter((row) => statusOf(row) !== "complete")
      .sort((a, b) => new Date(a.arrival_at) - new Date(b.arrival_at));

    if (!pending.length) {
      list.innerHTML = '<div class="empty-state compact"><strong>Tidak ada pelayanan tertunda</strong><span>Customer yang belum selesai akan muncul di sini.</span></div>';
      return;
    }

    list.innerHTML = pending.map((row) => {
      const status = statusOf(row);
      const busy = status === "waiting" ? busyRecordForCashier(row.cashier, row.id) : null;
      const actionButton = status === "waiting"
        ? `<button class="btn btn-primary btn-mini" data-action="start" data-id="${escapeHtml(row.id)}" ${busy ? 'disabled title="Kasir masih melayani customer lain"' : ""}>Mulai pelayanan</button>`
        : `<button class="btn btn-primary btn-mini" data-action="finish" data-id="${escapeHtml(row.id)}">Selesai pelayanan</button>`;
      const timing = status === "waiting" ? "Menunggu mulai pelayanan" : `Mulai ${escapeHtml(timestamp(row.service_start_at))}`;
      const busyNote = busy ? ` · Kasir sedang melayani customer #${escapeHtml(customerNumberOf(busy))}` : "";
      return `<div class="pending-item"><div class="pending-main"><div class="pending-title">Customer #${escapeHtml(customerNumberOf(row))} · ${escapeHtml(row.cashier)}</div><div class="pending-meta">Datang ${escapeHtml(timestamp(row.arrival_at))} · ${timing}${busyNote}</div></div><div class="pending-actions">${actionButton}<button class="btn btn-secondary btn-mini" data-action="edit" data-id="${escapeHtml(row.id)}">Edit</button></div></div>`;
    }).join("");
  }

  function renderTable() {
    const body = $("records-body");
    const current = stationRecords();
    const search = $("search-input").value.trim().toLowerCase();
    const statusFilter = $("status-filter").value;
    const filtered = [...current].sort((a, b) => new Date(b.arrival_at) - new Date(a.arrival_at)).filter((row) => {
      if (statusFilter !== "all" && statusOf(row) !== statusFilter) return false;
      const searchable = [customerNumberOf(row), row.id, row.cashier, row.note, timestamp(row.arrival_at)].join(" ").toLowerCase();
      return !search || searchable.includes(search);
    });
    $("visible-count").textContent = `Menampilkan ${filtered.length} dari ${current.length} data ${selectedCashier || "kasir"}`;

    if (!selectedCashier) {
      body.innerHTML = '<tr><td colspan="8" class="table-empty">Pilih kasir terlebih dahulu.</td></tr>';
      return;
    }
    if (!filtered.length) {
      body.innerHTML = `<tr><td colspan="8" class="table-empty">${current.length ? "Tidak ada data yang cocok dengan pencarian/filter." : `Belum ada data untuk ${escapeHtml(selectedCashier)}. Catat pelanggan pertama melalui formulir.`}</td></tr>`;
      return;
    }

    body.innerHTML = filtered.map((row) => {
      const status = statusOf(row);
      const busy = status === "waiting" ? busyRecordForCashier(row.cashier, row.id) : null;
      let actions = "";
      if (status === "waiting") actions += `<button class="action-link" data-action="start" data-id="${escapeHtml(row.id)}" ${busy ? 'disabled title="Kasir masih sibuk"' : ""}>Mulai</button>`;
      if (status === "serving") actions += `<button class="action-link" data-action="finish" data-id="${escapeHtml(row.id)}">Selesai</button>`;
      actions += `<button class="action-link" data-action="edit" data-id="${escapeHtml(row.id)}">Edit</button>`;
      if (session && row.created_by === session.user.id) actions += `<button class="action-link delete" data-action="delete" data-id="${escapeHtml(row.id)}">Hapus</button>`;
      return `<tr><td><span class="customer-id">#${escapeHtml(customerNumberOf(row))}</span></td><td><strong>${escapeHtml(row.cashier)}</strong></td><td>${escapeHtml(timestamp(row.arrival_at))}</td><td>${escapeHtml(duration(waitMs(row)))}</td><td>${escapeHtml(timestamp(row.service_start_at))}</td><td>${escapeHtml(timestamp(row.service_finish_at))}</td><td>${escapeHtml(duration(serviceMs(row)))}</td><td><span class="status status-${status}">${escapeHtml(statusLabel(status))}</span><span class="row-actions">${actions}</span></td></tr>`;
    }).join("");
  }

  function renderStation() {
    const chosen = CASHIERS.includes(selectedCashier);
    $("cashier-station").value = chosen ? selectedCashier : "";
    $("station-required").classList.toggle("hidden", chosen);
    $("station-workspace").classList.toggle("hidden", !chosen);
    if (chosen) {
      $("active-station-title").textContent = stationLabel(selectedCashier);
      $("active-station-pill").textContent = selectedCashier;
      $("form-cashier-label").textContent = selectedCashier;
      $("records-heading").textContent = `Daftar pelanggan ${selectedCashier}`;
    }
  }

  function render() {
    renderStation();
    renderStats();
    renderPending();
    renderTable();
    renderProgress();
    $("customer-number").value = selectedCashier ? `Berikutnya: #${stationRecords().length + 1} · ${selectedCashier}` : "Pilih kasir terlebih dahulu";
  }

  // ---------- Database ----------

  async function loadRecords({ quiet = false } = {}) {
    if (!supabaseClient || !session) return;
    if (loadingRecords) {
      reloadRequested = true;
      return;
    }
    loadingRecords = true;
    try {
      const { data, error } = await supabaseClient.from(TABLE).select("*").order("arrival_at", { ascending: false }).limit(10000);
      if (error) throw error;
      records = Array.isArray(data) ? data : [];
      rebuildCustomerNumbers();
      render();
      setBadge("Database tersambung", "online");
    } catch (error) {
      console.error("Gagal memuat data observasi:", error);
      setBadge("Koneksi database bermasalah", "offline");
      if (!quiet) showToast(`Gagal mengambil data: ${error.message || "Periksa tabel dan kebijakan RLS Supabase."}`);
    } finally {
      loadingRecords = false;
      if (reloadRequested) {
        reloadRequested = false;
        void loadRecords({ quiet: true });
      }
    }
  }

  function stopRealtime() {
    if (realtimeChannel && supabaseClient) {
      supabaseClient.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
  }

  function startRealtime() {
    stopRealtime();
    if (!supabaseClient || !session) return;
    realtimeChannel = supabaseClient.channel("cashier-observations-per-station")
      .on("postgres_changes", { event: "*", schema: "public", table: TABLE }, () => void loadRecords({ quiet: true }))
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setBadge("Tersinkron langsung", "online");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setBadge("Realtime tidak aktif", "offline");
          console.warn("Realtime belum aktif. Gunakan tombol Segarkan untuk mengambil data terbaru.");
        }
      });
  }

  async function refreshAfterWrite(message) {
    await loadRecords({ quiet: true });
    if (message) showToast(message);
  }

  async function startService(id) {
    if (!selectedCashier) return showToast("Pilih kasir terlebih dahulu.");
    const row = records.find((item) => String(item.id) === String(id));
    if (!row || row.cashier !== selectedCashier) return showToast("Customer bukan bagian dari kasir aktif.");
    if (row.service_start_at) return showToast("Waktu mulai sudah tercatat. Gunakan Edit jika perlu koreksi.");

    try {
      const { data: activeRows, error: checkError } = await supabaseClient.from(TABLE)
        .select("id,cashier,service_start_at,service_finish_at")
        .eq("cashier", selectedCashier).not("service_start_at", "is", null).is("service_finish_at", null).limit(10);
      if (checkError) throw checkError;
      const otherActive = (activeRows || []).find((item) => String(item.id) !== String(id));
      if (otherActive) return showToast(`${selectedCashier} masih tercatat melayani customer #${customerNumberOf(otherActive)}. Selesaikan dahulu jika memang pelayanan itu sudah berakhir.`);

      const stamp = new Date().toISOString();
      const { error } = await supabaseClient.from(TABLE).update({ service_start_at: stamp, updated_at: stamp }).eq("id", id).is("service_start_at", null);
      if (error) throw error;
      await refreshAfterWrite(`Waktu mulai customer #${customerNumberOf(row)} tersimpan.`);
    } catch (error) {
      console.error("Gagal mencatat mulai pelayanan:", error);
      showToast(`Gagal mencatat mulai pelayanan: ${error.message || "periksa koneksi"}`);
    }
  }

  async function finishService(id) {
    if (!selectedCashier) return showToast("Pilih kasir terlebih dahulu.");
    const row = records.find((item) => String(item.id) === String(id));
    if (!row || row.cashier !== selectedCashier) return showToast("Customer bukan bagian dari kasir aktif.");
    if (!row.service_start_at) return showToast("Catat waktu mulai pelayanan terlebih dahulu.");
    if (row.service_finish_at) return showToast("Waktu selesai sudah tercatat.");
    const stamp = new Date().toISOString();
    try {
      const { error } = await supabaseClient.from(TABLE).update({ service_finish_at: stamp, updated_at: stamp }).eq("id", id).is("service_finish_at", null);
      if (error) throw error;
      await refreshAfterWrite(`Pelayanan customer #${customerNumberOf(row)} selesai dicatat.`);
    } catch (error) {
      console.error("Gagal mencatat selesai pelayanan:", error);
      showToast(`Gagal mencatat selesai pelayanan: ${error.message || "periksa koneksi"}`);
    }
  }

  async function deleteRecord(id) {
    const row = records.find((item) => String(item.id) === String(id));
    if (!row) return;
    if (row.cashier !== selectedCashier) return showToast("Data ini bukan bagian dari kasir aktif.");
    if (row.created_by !== session?.user?.id) return showToast("Hanya pembuat catatan yang dapat menghapus data ini.");
    if (!confirm(`Hapus data customer #${customerNumberOf(row)} dari ${row.cashier}? Tindakan ini tidak dapat dibatalkan.`)) return;
    try {
      const { error } = await supabaseClient.from(TABLE).delete().eq("id", id).eq("created_by", session.user.id);
      if (error) throw error;
      await refreshAfterWrite(`Data customer #${id} dihapus.`);
    } catch (error) {
      console.error("Gagal menghapus data:", error);
      showToast(`Gagal menghapus data: ${error.message || "periksa izin database"}`);
    }
  }

  // ---------- Edit record ----------

  function openEdit(id) {
    const row = records.find((item) => String(item.id) === String(id));
    if (!row || row.cashier !== selectedCashier) return showToast("Pilih data dari kasir aktif.");
    $("edit-id").value = String(row.id);
    $("edit-customer-label").textContent = `#${customerNumberOf(row)} · ${row.cashier}`;
    $("edit-arrival").value = toLocalInput(row.arrival_at);
    $("edit-start").value = toLocalInput(row.service_start_at);
    $("edit-finish").value = toLocalInput(row.service_finish_at);
    $("edit-note").value = row.note || "";
    $("edit-dialog").showModal();
  }

  async function saveEdit(event) {
    event.preventDefault();
    const id = $("edit-id").value;
    const row = records.find((item) => String(item.id) === String(id));
    if (!row || row.cashier !== selectedCashier) return showToast("Data tidak ditemukan pada kasir aktif.");

    const arrival = fromLocalInput($("edit-arrival").value);
    const start = fromLocalInput($("edit-start").value);
    const finish = fromLocalInput($("edit-finish").value);
    if (!arrival) return showToast("Waktu kedatangan wajib diisi.");
    if (start && new Date(start) < new Date(arrival)) return showToast("Waktu mulai tidak boleh sebelum kedatangan.");
    if (finish && !start) return showToast("Isi waktu mulai sebelum mengisi waktu selesai.");
    if (finish && start && new Date(finish) < new Date(start)) return showToast("Waktu selesai tidak boleh sebelum waktu mulai.");

    const stamp = new Date().toISOString();
    const payload = {
      arrival_at: arrival,
      service_start_at: start,
      service_finish_at: finish,
      note: $("edit-note").value.trim(),
      updated_at: stamp
    };
    try {
      const { error } = await supabaseClient.from(TABLE).update(payload).eq("id", id);
      if (error) throw error;
      $("edit-dialog").close();
      await refreshAfterWrite(`Koreksi customer #${customerNumberOf(row)} tersimpan.`);
    } catch (error) {
      console.error("Gagal menyimpan koreksi:", error);
      showToast(`Gagal menyimpan koreksi: ${error.message || "periksa izin database"}`);
    }
  }

  // ---------- Export ----------

  function csvCell(value) {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
  }

  function dateStamp() {
    const date = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  }

  function download(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function exportCsv(all = false) {
    const rows = all ? [...records] : stationRecords();
    if (!rows.length) return showToast(all ? "Belum ada data untuk diekspor." : `Belum ada data untuk ${selectedCashier || "kasir aktif"}.`);
    const headers = ["Nomor Customer (per kasir)", "ID Database", "Kasir", "Waktu Kedatangan", "Durasi Tunggu (detik)", "Waktu Mulai Pelayanan", "Waktu Selesai Pelayanan", "Durasi Pelayanan (detik)", "Waktu Dalam Sistem (detik)", "Status", "Catatan", "Dibuat Oleh"];
    const dataRows = rows.sort((a, b) => new Date(a.arrival_at) - new Date(b.arrival_at)).map((row) => [
      customerNumberOf(row), row.id, row.cashier, timestamp(row.arrival_at), waitMs(row) == null ? "" : Math.round(waitMs(row) / 1000),
      timestamp(row.service_start_at), timestamp(row.service_finish_at), serviceMs(row) == null ? "" : Math.round(serviceMs(row) / 1000),
      systemMs(row) == null ? "" : Math.round(systemMs(row) / 1000), statusLabel(statusOf(row)), row.note || "", row.created_by || ""
    ]);
    const csv = "\uFEFF" + [headers, ...dataRows].map((line) => line.map(csvCell).join(";")).join("\r\n");
    const filename = all ? `observasi-semua-kasir-${dateStamp()}.csv` : `observasi-${selectedCashier}-${dateStamp()}.csv`;
    download(csv, filename, "text/csv;charset=utf-8");
    showToast(all ? "CSV gabungan empat kasir berhasil dibuat." : `CSV ${selectedCashier} berhasil dibuat.`);
  }

  function exportJson() {
    if (!records.length) return showToast("Belum ada data untuk dibackup.");
    const payload = { app: "DES Cashier", schemaVersion: 2, exportedAt: new Date().toISOString(), records };
    download(JSON.stringify(payload, null, 2), `backup-des-cashier-${dateStamp()}.json`, "application/json");
    showToast("Backup JSON gabungan berhasil dibuat.");
  }

  // ---------- Authentication ----------

  function loginErrorMessage(error) {
    const message = String(error?.message || "Tidak ada detail error dari Supabase.");
    const lower = message.toLowerCase();
    if (lower.includes("invalid login credentials")) return "Login gagal: email atau password tidak cocok. Periksa akun Supabase.";
    if (lower.includes("email not confirmed")) return "Login gagal: email akun belum dikonfirmasi di Supabase.";
    if (lower.includes("invalid api key") || lower.includes("api key")) return "Login gagal: API key tidak cocok dengan Project URL. Periksa config.js.";
    if (lower.includes("invalid path specified")) return "URL Supabase tidak tepat. Gunakan Project URL dasar, tanpa /rest/v1 atau /auth/v1.";
    if (lower.includes("failed to fetch") || lower.includes("networkerror")) return "Tidak dapat menghubungi Supabase. Periksa Project URL dan koneksi internet.";
    if (lower.includes("too many requests") || error?.status === 429) return "Terlalu banyak percobaan login. Tunggu beberapa saat.";
    return `Login gagal${error?.status ? ` (HTTP ${error.status})` : ""}: ${message}`;
  }

  async function handleLogin(event) {
    event.preventDefault();
    const errorBox = $("login-error");
    const button = $("login-button");
    errorBox.textContent = "";
    if (!supabaseClient) return errorBox.textContent = "Supabase belum terinisialisasi. Periksa config.js.";
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    if (!email || !password) return errorBox.textContent = "Masukkan email dan password.";
    button.disabled = true;
    button.textContent = "Memeriksa akun…";
    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) {
        console.error("Supabase sign-in error:", { message: error.message, status: error.status, code: error.code });
        errorBox.textContent = loginErrorMessage(error);
        return;
      }
      session = data?.session || null;
      if (!session) return errorBox.textContent = "Login tidak menghasilkan sesi. Coba lagi.";
      await showAuthenticatedState();
    } catch (error) {
      console.error("Login request failed:", error);
      errorBox.textContent = loginErrorMessage(error);
    } finally {
      button.disabled = false;
      button.textContent = "Masuk";
    }
  }

  async function showAuthenticatedState() {
    if (!session) {
      stopRealtime();
      records = [];
      render();
      setScreen("login-screen");
      setBadge("Belum login", "offline");
      return;
    }
    setScreen("app-screen");
    renderStation();
    setBadge("Menghubungkan database…");
    await loadRecords();
    startRealtime();
  }

  async function logout() {
    if (!supabaseClient) return;
    const { error } = await supabaseClient.auth.signOut();
    if (error) return showToast(`Gagal keluar: ${error.message}`);
    session = null;
    stopRealtime();
    records = [];
    render();
    await showAuthenticatedState();
    showToast("Kamu sudah keluar.");
  }

  // ---------- Event listeners ----------

  $("login-form").addEventListener("submit", handleLogin);
  $("logout-button").addEventListener("click", logout);

  $("cashier-station").addEventListener("change", (event) => {
    const next = event.target.value;
    if (next && !CASHIERS.includes(next)) return;
    if (selectedCashier && next && selectedCashier !== next) {
      const ok = confirm(`Beralih dari ${selectedCashier} ke ${next}? Data lama tetap tersimpan di ${selectedCashier}; catatan baru akan masuk ke ${next}.`);
      if (!ok) {
        event.target.value = selectedCashier;
        return;
      }
    }
    selectedCashier = next;
    try {
      if (selectedCashier) localStorage.setItem(STATION_STORAGE_KEY, selectedCashier);
      else localStorage.removeItem(STATION_STORAGE_KEY);
    } catch (_) { /* Browser may block localStorage; selection still works for this page. */ }
    render();
  });

  $("arrival-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!session) return showToast("Sesi login tidak ditemukan. Silakan login kembali.");
    if (!selectedCashier) return showToast("Pilih kasir yang menjadi tugas perangkat ini.");
    const button = $("arrival-submit");
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Menyimpan ke database…";
    const stamp = new Date().toISOString();
    try {
      const payload = {
        arrival_at: stamp,
        cashier: selectedCashier,
        // Kolom lama tetap memakai nilai default. Pengamat tidak perlu mengukur antrean kasir lain.
        note: $("arrival-note").value.trim(),
        created_by: session.user.id,
        updated_at: stamp
      };
      const { data, error } = await supabaseClient.from(TABLE).insert(payload).select("id,cashier").single();
      if (error) throw error;
      $("arrival-form").reset();
      await loadRecords({ quiet: true });
      const savedRow = records.find((row) => String(row.id) === String(data.id));
      const displayNumber = savedRow ? customerNumberOf(savedRow) : "tersimpan";
      showToast(`Kedatangan customer #${displayNumber} tersimpan sebagai ${data.cashier}.`);
    } catch (error) {
      console.error("Gagal menyimpan kedatangan:", error);
      showToast(`Gagal menyimpan data: ${error.message || "Periksa tabel dan izin database."}`);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const { action, id } = button.dataset;
    if (action === "start") void startService(id);
    else if (action === "finish") void finishService(id);
    else if (action === "edit") openEdit(id);
    else if (action === "delete") void deleteRecord(id);
  });

  $("search-input").addEventListener("input", renderTable);
  $("status-filter").addEventListener("change", renderTable);
  $("refresh-data").addEventListener("click", async () => {
    await loadRecords();
    showToast("Data terbaru diminta dari database.");
  });
  $("export-csv").addEventListener("click", () => exportCsv(false));
  $("export-all-csv").addEventListener("click", () => exportCsv(true));
  $("export-json").addEventListener("click", exportJson);
  $("edit-form").addEventListener("submit", saveEdit);
  $("close-edit").addEventListener("click", () => $("edit-dialog").close());
  $("cancel-edit").addEventListener("click", () => $("edit-dialog").close());

  async function initialize() {
    if (!isConfigured()) {
      showSetupError("Konfigurasi belum benar. Isi config.js dengan Project URL dasar dan publishable/anon key dari proyek Supabase yang sama.");
      return;
    }
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      showSetupError("Library Supabase JS gagal dimuat. Periksa koneksi internet atau CDN, lalu muat ulang aplikasi.");
      return;
    }
    try {
      supabaseClient = window.supabase.createClient(
        String(window.DES_SUPABASE_URL).trim().replace(/\/$/, ""),
        String(window.DES_SUPABASE_ANON_KEY).trim(),
        { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
      );
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      session = data?.session || null;
      await showAuthenticatedState();
    } catch (error) {
      console.error("Gagal menginisialisasi Supabase:", error);
      showSetupError(`Gagal menghubungkan aplikasi: ${error.message || "Periksa Project URL, API key, dan koneksi internet."}`);
    }
  }

  initialize().catch((error) => {
    console.error("Kesalahan awal aplikasi:", error);
    setBadge("Gagal memulai aplikasi", "offline");
    setScreen("login-screen");
    $("login-error").textContent = `Aplikasi gagal dimulai: ${error.message || "Periksa config.js dan koneksi internet."}`;
  });
})();
