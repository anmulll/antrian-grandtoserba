(() => {
  "use strict";

  // DES Cashier — frontend Supabase edition
  // Table and columns must match schema.sql.
  const TABLE = "cashier_observations";
  const CASHIERS = ["K1", "K2", "K3", "K4"];
  const $ = (id) => document.getElementById(id);

  let supabaseClient = null;
  let session = null;
  let records = [];
  let realtimeChannel = null;
  let toastTimer = null;
  let loadingRecords = false;

  // ---------- General helpers ----------

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function showToast(message) {
    const toast = $("toast");
    if (!toast) return;
    toast.textContent = String(message || "Terjadi kesalahan.");
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 4500);
  }

  function setBadge(message, state = "") {
    const badge = $("connection-badge");
    if (!badge) return;
    badge.className = "sync-badge" + (state ? " " + state : "");
    badge.innerHTML = `<span class="dot"></span>${escapeHtml(message)}`;
  }

  function setScreen(screenId) {
    ["setup-screen", "login-screen", "app-screen"].forEach((id) => {
      const element = $(id);
      if (element) element.classList.toggle("hidden", id !== screenId);
    });
    const logout = $("logout-button");
    if (logout) logout.classList.toggle("hidden", screenId !== "app-screen");
  }

  function isConfigured() {
    const url = String(window.DES_SUPABASE_URL || "").trim();
    const key = String(window.DES_SUPABASE_ANON_KEY || "").trim();
    const hasValidUrl = /^https:\/\//i.test(url) &&
      !url.includes("PASTE_") &&
      !url.includes("PROJECT_REF_KAMU") &&
      !url.endsWith(".supabase.co/");
    const hasValidKey = key.length > 20 &&
      !key.includes("PASTE_") &&
      !key.includes("KEY_KAMU");
    return hasValidUrl && hasValidKey;
  }

  function showSetupError(message) {
    setScreen("setup-screen");
    const setup = $("setup-screen");
    const paragraph = setup?.querySelector("p:not(.eyebrow)");
    if (paragraph) paragraph.textContent = message;
    setBadge("Konfigurasi dibutuhkan", "offline");
  }

  function timestamp(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).format(date);
  }

  function duration(milliseconds) {
    if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds < 0) return "—";
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map((number) => String(number).padStart(2, "0")).join(":");
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
    return ({
      waiting: "Belum mulai",
      serving: "Sedang dilayani",
      complete: "Selesai"
    })[status] || status;
  }

  function busyRecordForCashier(cashier, exceptId = null) {
    return records.find((row) =>
      String(row.id) !== String(exceptId) &&
      row.cashier === cashier &&
      row.service_start_at &&
      !row.service_finish_at
    ) || null;
  }

  // ---------- Rendering ----------

  function renderStats() {
    const complete = records.filter((row) => row.service_start_at && row.service_finish_at);
    const averageWait = average(records.map(waitMs));
    const averageService = average(complete.map(serviceMs));

    $("stat-total").textContent = String(records.length);
    $("stat-complete").textContent = String(complete.length);
    $("stat-wait").textContent = averageWait == null ? "—" : duration(averageWait);
    $("stat-service").textContent = averageService == null ? "—" : duration(averageService);
    $("stat-pending").textContent = String(records.filter((row) => statusOf(row) !== "complete").length);
  }

  function renderPending() {
    const list = $("pending-list");
    const pending = [...records]
      .filter((row) => statusOf(row) !== "complete")
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
      const extra = busy ? ` · ${escapeHtml(row.cashier)} masih melayani customer #${escapeHtml(busy.id)}` : "";
      const timing = status === "waiting"
        ? "Menunggu mulai pelayanan"
        : `Mulai ${escapeHtml(timestamp(row.service_start_at))}`;

      return `<div class="pending-item">
        <div class="pending-main">
          <div class="pending-title">Customer #${escapeHtml(row.id)} · ${escapeHtml(row.cashier)}</div>
          <div class="pending-meta">Datang ${escapeHtml(timestamp(row.arrival_at))} · ${timing}${extra}</div>
        </div>
        <div class="pending-actions">
          ${actionButton}
          <button class="btn btn-secondary btn-mini" data-action="edit" data-id="${escapeHtml(row.id)}">Edit</button>
        </div>
      </div>`;
    }).join("");
  }

  function renderTable() {
    const body = $("records-body");
    const search = $("search-input").value.trim().toLowerCase();
    const statusFilter = $("status-filter").value;
    const cashierFilter = $("cashier-filter").value;

    const filtered = [...records]
      .sort((a, b) => new Date(b.arrival_at) - new Date(a.arrival_at))
      .filter((row) => {
        if (statusFilter !== "all" && statusOf(row) !== statusFilter) return false;
        if (cashierFilter !== "all" && row.cashier !== cashierFilter) return false;
        const searchable = [row.id, row.cashier, row.note, timestamp(row.arrival_at)].join(" ").toLowerCase();
        return !search || searchable.includes(search);
      });

    $("visible-count").textContent = `Menampilkan ${filtered.length} dari ${records.length} data`;

    if (!filtered.length) {
      body.innerHTML = `<tr><td colspan="9" class="table-empty">${records.length ? "Tidak ada data yang cocok dengan filter." : "Belum ada data. Catat pelanggan pertama melalui formulir di atas."}</td></tr>`;
      return;
    }

    body.innerHTML = filtered.map((row) => {
      const status = statusOf(row);
      const queues = [row.q_k1, row.q_k2, row.q_k3, row.q_k4].map((value) => Number(value ?? 0)).join(" · ");
      const busy = status === "waiting" ? busyRecordForCashier(row.cashier, row.id) : null;
      let actions = "";

      if (status === "waiting") {
        actions += `<button class="action-link" data-action="start" data-id="${escapeHtml(row.id)}" ${busy ? 'disabled title="Kasir masih sibuk"' : ""}>Mulai</button>`;
      }
      if (status === "serving") {
        actions += `<button class="action-link" data-action="finish" data-id="${escapeHtml(row.id)}">Selesai</button>`;
      }
      actions += `<button class="action-link" data-action="edit" data-id="${escapeHtml(row.id)}">Edit</button>`;
      if (session && row.created_by === session.user.id) {
        actions += `<button class="action-link delete" data-action="delete" data-id="${escapeHtml(row.id)}">Hapus</button>`;
      }

      return `<tr>
        <td><span class="customer-id">#${escapeHtml(row.id)}</span></td>
        <td>${escapeHtml(timestamp(row.arrival_at))}</td>
        <td><strong>${escapeHtml(row.cashier)}</strong></td>
        <td><span class="queue-snapshot">${escapeHtml(queues)}</span></td>
        <td>${escapeHtml(duration(waitMs(row)))}</td>
        <td>${escapeHtml(timestamp(row.service_start_at))}</td>
        <td>${escapeHtml(timestamp(row.service_finish_at))}</td>
        <td>${escapeHtml(duration(serviceMs(row)))}</td>
        <td><span class="status status-${status}">${escapeHtml(statusLabel(status))}</span><span class="row-actions">${actions}</span></td>
      </tr>`;
    }).join("");
  }

  function render() {
    renderStats();
    renderPending();
    renderTable();
    $("customer-number").value = records.length ? "Otomatis dari database" : "Customer pertama";
  }

  // ---------- Supabase data ----------

  async function loadRecords({ quiet = false } = {}) {
    if (!supabaseClient || !session || loadingRecords) return;
    loadingRecords = true;
    try {
      const { data, error } = await supabaseClient
        .from(TABLE)
        .select("*")
        .order("arrival_at", { ascending: false })
        .limit(5000);
      if (error) throw error;
      records = Array.isArray(data) ? data : [];
      render();
      setBadge("Database tersambung", "online");
    } catch (error) {
      console.error("Gagal memuat data observasi:", error);
      setBadge("Koneksi database bermasalah", "offline");
      if (!quiet) showToast(`Gagal mengambil data: ${error.message || "Periksa tabel dan kebijakan RLS Supabase."}`);
    } finally {
      loadingRecords = false;
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

    realtimeChannel = supabaseClient
      .channel("cashier-observations-live")
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: TABLE
      }, () => loadRecords({ quiet: true }))
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setBadge("Tersinkron langsung", "online");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setBadge("Realtime tidak aktif", "offline");
          console.warn("Realtime Supabase belum aktif. Tombol Segarkan tetap dapat digunakan.");
        }
      });
  }

  async function refreshAfterWrite(message) {
    await loadRecords({ quiet: true });
    if (message) showToast(message);
  }

  async function startService(id) {
    const row = records.find((item) => String(item.id) === String(id));
    if (!row) return;
    if (row.service_start_at) return showToast("Waktu mulai sudah tercatat. Gunakan Edit jika perlu koreksi.");

    // Check the shared database in case another device is using this cashier.
    const { data: activeRows, error: checkError } = await supabaseClient
      .from(TABLE)
      .select("id,cashier")
      .eq("cashier", row.cashier)
      .not("service_start_at", "is", null)
      .is("service_finish_at", null)
      .neq("id", row.id)
      .limit(1);

    if (checkError) {
      console.error("Gagal memeriksa status kasir:", checkError);
      return showToast(`Tidak dapat memeriksa status kasir: ${checkError.message}`);
    }
    if (activeRows && activeRows.length) {
      await loadRecords({ quiet: true });
      return showToast(`${row.cashier} masih melayani customer #${activeRows[0].id}.`);
    }

    const startedAt = new Date().toISOString();
    if (new Date(startedAt) < new Date(row.arrival_at)) {
      return showToast("Waktu mulai tidak boleh sebelum waktu kedatangan.");
    }

    const { error } = await supabaseClient
      .from(TABLE)
      .update({ service_start_at: startedAt, updated_at: startedAt })
      .eq("id", row.id);
    if (error) {
      console.error("Gagal menyimpan waktu mulai:", error);
      return showToast(`Gagal menyimpan waktu mulai: ${error.message}`);
    }
    await refreshAfterWrite(`Waktu mulai customer #${row.id} tersimpan.`);
  }

  async function finishService(id) {
    const row = records.find((item) => String(item.id) === String(id));
    if (!row) return;
    if (!row.service_start_at) return showToast("Catat waktu mulai pelayanan terlebih dahulu.");
    if (row.service_finish_at) return showToast("Waktu selesai sudah tercatat.");

    const finishedAt = new Date().toISOString();
    if (new Date(finishedAt) < new Date(row.service_start_at)) {
      return showToast("Waktu selesai tidak boleh sebelum waktu mulai.");
    }

    const { error } = await supabaseClient
      .from(TABLE)
      .update({ service_finish_at: finishedAt, updated_at: finishedAt })
      .eq("id", row.id);
    if (error) {
      console.error("Gagal menyimpan waktu selesai:", error);
      return showToast(`Gagal menyimpan waktu selesai: ${error.message}`);
    }
    await refreshAfterWrite(`Pelayanan customer #${row.id} selesai dicatat.`);
  }

  async function deleteRecord(id) {
    const row = records.find((item) => String(item.id) === String(id));
    if (!row) return;
    if (!session || row.created_by !== session.user.id) {
      return showToast("Sesuai aturan database, kamu hanya dapat menghapus data yang kamu buat sendiri.");
    }
    if (!confirm(`Hapus data customer #${row.id}? Tindakan ini tidak dapat dibatalkan.`)) return;

    const { error } = await supabaseClient.from(TABLE).delete().eq("id", row.id);
    if (error) {
      console.error("Gagal menghapus data:", error);
      return showToast(`Data tidak dapat dihapus: ${error.message}`);
    }
    await refreshAfterWrite(`Data customer #${row.id} dihapus.`);
  }

  // ---------- Edit record ----------

  function localInputValue(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function isoFromLocal(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function openEdit(id) {
    const row = records.find((item) => String(item.id) === String(id));
    if (!row) return;

    $("edit-id").value = row.id;
    $("edit-customer-label").textContent = String(row.id);
    $("edit-arrival").value = localInputValue(row.arrival_at);
    $("edit-cashier").value = row.cashier;
    $("edit-q-k1").value = row.q_k1 ?? 0;
    $("edit-q-k2").value = row.q_k2 ?? 0;
    $("edit-q-k3").value = row.q_k3 ?? 0;
    $("edit-q-k4").value = row.q_k4 ?? 0;
    $("edit-start").value = localInputValue(row.service_start_at);
    $("edit-finish").value = localInputValue(row.service_finish_at);
    $("edit-note").value = row.note || "";
    $("edit-dialog").showModal();
  }

  async function saveEdit(event) {
    event.preventDefault();
    const id = $("edit-id").value;
    const arrival = isoFromLocal($("edit-arrival").value);
    const started = isoFromLocal($("edit-start").value);
    const finished = isoFromLocal($("edit-finish").value);

    if (!arrival) return showToast("Waktu kedatangan wajib diisi.");
    if (started && new Date(started) < new Date(arrival)) return showToast("Waktu mulai tidak boleh sebelum kedatangan.");
    if (finished && !started) return showToast("Isi waktu mulai sebelum waktu selesai.");
    if (finished && started && new Date(finished) < new Date(started)) return showToast("Waktu selesai tidak boleh sebelum waktu mulai.");

    const queueColumns = {};
    for (const cashier of CASHIERS) {
      const input = $("edit-q-" + cashier.toLowerCase());
      const raw = input.value;
      const value = Number(raw);
      if (raw === "" || !Number.isInteger(value) || value < 0) {
        return showToast(`Panjang antrean ${cashier} harus bilangan bulat nol atau lebih.`);
      }
      queueColumns["q_" + cashier.toLowerCase()] = value;
    }

    const payload = {
      arrival_at: arrival,
      cashier: $("edit-cashier").value,
      ...queueColumns,
      service_start_at: started,
      service_finish_at: finished,
      note: $("edit-note").value.trim(),
      updated_at: new Date().toISOString()
    };

    const { error } = await supabaseClient.from(TABLE).update(payload).eq("id", Number(id));
    if (error) {
      console.error("Gagal menyimpan koreksi:", error);
      return showToast(`Gagal menyimpan koreksi: ${error.message}`);
    }
    $("edit-dialog").close();
    await refreshAfterWrite(`Koreksi customer #${id} tersimpan.`);
  }

  // ---------- Export ----------

  function csvCell(value) {
    return '"' + String(value ?? "").replace(/"/g, '""') + '"';
  }

  function download(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function dateStamp() {
    const date = new Date();
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  }

  function exportCsv() {
    if (!records.length) return showToast("Belum ada data untuk diekspor.");
    const headers = [
      "Customer ID", "Waktu Kedatangan", "Kasir Aktual",
      "Panjang Antrean K1", "Panjang Antrean K2", "Panjang Antrean K3", "Panjang Antrean K4",
      "Waktu Mulai Pelayanan", "Waktu Selesai Pelayanan",
      "Durasi Tunggu (detik)", "Durasi Pelayanan (detik)", "Waktu Dalam Sistem (detik)",
      "Status", "Catatan", "Dibuat Oleh"
    ];
    const rows = [...records]
      .sort((a, b) => new Date(a.arrival_at) - new Date(b.arrival_at))
      .map((row) => [
        row.id,
        timestamp(row.arrival_at),
        row.cashier,
        row.q_k1,
        row.q_k2,
        row.q_k3,
        row.q_k4,
        timestamp(row.service_start_at),
        timestamp(row.service_finish_at),
        waitMs(row) == null ? "" : Math.round(waitMs(row) / 1000),
        serviceMs(row) == null ? "" : Math.round(serviceMs(row) / 1000),
        systemMs(row) == null ? "" : Math.round(systemMs(row) / 1000),
        statusLabel(statusOf(row)),
        row.note || "",
        row.created_by || ""
      ]);

    const csv = "\uFEFF" + [headers, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n");
    download(csv, `observasi-antrean-kasir-${dateStamp()}.csv`, "text/csv;charset=utf-8");
    showToast("CSV berhasil dibuat. Simpan file sebagai backup dan olah di Excel.");
  }

  function exportJson() {
    if (!records.length) return showToast("Belum ada data untuk dibackup.");
    const payload = {
      app: "DES Cashier Supabase",
      exported_at: new Date().toISOString(),
      records
    };
    download(JSON.stringify(payload, null, 2), `backup-des-cashier-${dateStamp()}.json`, "application/json");
    showToast("Backup JSON berhasil dibuat.");
  }

  // ---------- Authentication ----------

  function loginErrorMessage(error) {
    const message = String(error?.message || "Tidak ada detail error dari Supabase.");
    const lower = message.toLowerCase();

    if (lower.includes("invalid login credentials")) {
      return "Login gagal: email atau password tidak cocok. Pastikan password yang dimasukkan sama dengan password akun di Supabase. Jika ragu, atur ulang password akun tersebut di dashboard Supabase.";
    }
    if (lower.includes("email not confirmed")) {
      return "Login gagal: email akun belum dikonfirmasi. Periksa Authentication → Users dan konfirmasikan email akun jika opsi tersebut tersedia.";
    }
    if (lower.includes("invalid api key") || lower.includes("api key")) {
      return "Login gagal: API key ditolak. Pastikan config.js memakai Project URL dan publishable/anon key dari proyek Supabase yang sama.";
    }
    if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower.includes("fetch")) {
      return "Tidak dapat menghubungi Supabase. Periksa Project URL, koneksi internet, dan apakah URL berasal dari proyek yang benar.";
    }
    if (lower.includes("too many requests") || error?.status === 429) {
      return "Terlalu banyak percobaan login. Tunggu beberapa saat sebelum mencoba kembali.";
    }

    const status = error?.status ? ` (HTTP ${error.status})` : "";
    const code = error?.code ? ` [${error.code}]` : "";
    return `Login gagal${status}${code}: ${message}`;
  }

  async function handleLogin(event) {
    event.preventDefault();
    const errorBox = $("login-error");
    const button = $("login-button");
    errorBox.textContent = "";

    if (!supabaseClient) {
      errorBox.textContent = "Supabase belum terinisialisasi. Periksa config.js dan muat ulang aplikasi.";
      return;
    }

    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    if (!email || !password) {
      errorBox.textContent = "Masukkan email dan password.";
      return;
    }

    button.disabled = true;
    button.textContent = "Memeriksa akun…";

    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) {
        console.error("Supabase sign-in error:", {
          message: error.message,
          status: error.status,
          code: error.code
        });
        errorBox.textContent = loginErrorMessage(error);
        return;
      }

      session = data?.session || null;
      if (!session) {
        errorBox.textContent = "Login tidak menghasilkan sesi. Coba muat ulang aplikasi dan login kembali.";
        return;
      }
      await showAuthenticatedState();
    } catch (error) {
      console.error("Supabase sign-in request failed:", error);
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
    setBadge("Menghubungkan database…");
    await loadRecords();
    startRealtime();
  }

  async function logout() {
    if (!supabaseClient) return;
    const { error } = await supabaseClient.auth.signOut();
    if (error) {
      console.error("Logout gagal:", error);
      return showToast(`Gagal keluar: ${error.message}`);
    }
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

  $("arrival-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!session) return showToast("Sesi login tidak ditemukan. Silakan login kembali.");

    const cashier = $("cashier-choice").value;
    if (!CASHIERS.includes(cashier)) return showToast("Pilih kasir yang benar-benar dipilih pelanggan.");

    const queueColumns = {};
    for (const cashierId of CASHIERS) {
      const input = $("q-" + cashierId.toLowerCase());
      const raw = input.value;
      const value = Number(raw);
      if (raw === "" || !Number.isInteger(value) || value < 0) {
        showToast(`Isi panjang antrean ${cashierId} dengan bilangan bulat nol atau lebih.`);
        input.focus();
        return;
      }
      queueColumns["q_" + cashierId.toLowerCase()] = value;
    }

    const button = $("arrival-submit");
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Menyimpan ke database…";

    try {
      const arrival = new Date().toISOString();
      const payload = {
        arrival_at: arrival,
        cashier,
        ...queueColumns,
        service_start_at: null,
        service_finish_at: null,
        note: $("arrival-note").value.trim(),
        created_by: session.user.id,
        updated_at: arrival
      };

      const { data, error } = await supabaseClient.from(TABLE).insert(payload).select("id").single();
      if (error) {
        console.error("Gagal menyimpan kedatangan:", error);
        showToast(`Gagal menyimpan data: ${error.message}`);
        return;
      }

      $("arrival-form").reset();
      await refreshAfterWrite(`Kedatangan customer #${data.id} tersimpan di database.`);
    } catch (error) {
      console.error("Kesalahan saat menyimpan kedatangan:", error);
      showToast(`Terjadi kesalahan saat menyimpan: ${error.message || "periksa koneksi"}`);
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

  ["search-input", "status-filter", "cashier-filter"].forEach((id) => {
    $(id).addEventListener("input", renderTable);
    $(id).addEventListener("change", renderTable);
  });

  $("refresh-data").addEventListener("click", async () => {
    await loadRecords();
    showToast("Permintaan penyegaran data selesai. Jika gagal, periksa pesan koneksi.");
  });
  $("export-csv").addEventListener("click", exportCsv);
  $("export-json").addEventListener("click", exportJson);
  $("edit-form").addEventListener("submit", saveEdit);
  $("close-edit").addEventListener("click", () => $("edit-dialog").close());
  $("cancel-edit").addEventListener("click", () => $("edit-dialog").close());

  $("clear-all").addEventListener("click", async () => {
    if (!session) return showToast("Silakan login terlebih dahulu.");
    const ownRows = records.filter((row) => row.created_by === session.user.id);
    if (!ownRows.length) return showToast("Tidak ada data milik akunmu untuk dihapus.");
    const confirmed = confirm(`Hapus ${ownRows.length} data yang dibuat oleh akunmu? Data anggota lain tidak akan dihapus. Tindakan ini tidak dapat dibatalkan.`);
    if (!confirmed) return;

    const { error } = await supabaseClient.from(TABLE).delete().eq("created_by", session.user.id);
    if (error) {
      console.error("Gagal menghapus data akun:", error);
      return showToast(`Gagal menghapus data: ${error.message}`);
    }
    await refreshAfterWrite(`${ownRows.length} data milik akunmu berhasil dihapus.`);
  });

  // ---------- Initialize ----------

  async function initialize() {
    if (!isConfigured()) {
      showSetupError("Konfigurasi belum benar. Isi config.js dengan Project URL dan publishable/anon key dari proyek Supabase yang sama, lalu deploy ulang.");
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
        {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
          }
        }
      );

      // Subscribe to auth events; defer UI changes out of the callback.
      supabaseClient.auth.onAuthStateChange((_event, nextSession) => {
        session = nextSession;
        window.setTimeout(() => {
          showAuthenticatedState().catch((error) => {
            console.error("Gagal memperbarui status autentikasi:", error);
            showToast("Gagal memperbarui sesi login. Muat ulang aplikasi.");
          });
        }, 0);
      });

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
