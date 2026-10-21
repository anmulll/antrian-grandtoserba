(() => {
  "use strict";

  const TABLE = "cashier_observations";
  const CASHIERS = ["K1", "K2", "K3", "K4"];
  const $ = (id) => document.getElementById(id);
  let supabaseClient = null;
  let session = null;
  let records = [];
  let realtimeChannel = null;
  let toastTimer = null;
  let loadInProgress = false;

  function isConfigured() {
    const url = String(window.DES_SUPABASE_URL || "").trim();
    const key = String(window.DES_SUPABASE_ANON_KEY || "").trim();
    return url.startsWith("https://") && !url.includes("PASTE_") && key.length > 20 && !key.includes("PASTE_");
  }

  function setBadge(text, state = "") {
    const badge = $("connection-badge");
    badge.className = "sync-badge" + (state ? " " + state : "");
    badge.innerHTML = `<span class="dot"></span>${escapeHtml(text)}`;
  }

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[ch]);
  }

  function statusOf(row) {
    if (row.service_finish_at) return "complete";
    if (row.service_start_at) return "serving";
    return "waiting";
  }

  function statusLabel(status) {
    return ({ waiting: "Belum mulai", serving: "Sedang dilayani", complete: "Selesai" })[status] || status;
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

  function duration(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h, m, s].map(n => String(n).padStart(2, "0")).join(":");
  }

  function waitMs(row) {
    if (!row.arrival_at || !row.service_start_at) return null;
    const ms = new Date(row.service_start_at).getTime() - new Date(row.arrival_at).getTime();
    return ms >= 0 ? ms : null;
  }

  function serviceMs(row) {
    if (!row.service_start_at || !row.service_finish_at) return null;
    const ms = new Date(row.service_finish_at).getTime() - new Date(row.service_start_at).getTime();
    return ms >= 0 ? ms : null;
  }

  function systemMs(row) {
    if (!row.arrival_at || !row.service_finish_at) return null;
    const ms = new Date(row.service_finish_at).getTime() - new Date(row.arrival_at).getTime();
    return ms >= 0 ? ms : null;
  }

  function average(values) {
    const valid = values.filter(v => v !== null && Number.isFinite(v) && v >= 0);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
  }

  function setScreen(screen) {
    ["setup-screen", "login-screen", "app-screen"].forEach(id => $(id).classList.add("hidden"));
    $(screen).classList.remove("hidden");
    $("logout-button").classList.toggle("hidden", screen !== "app-screen");
  }

  function renderStats() {
    const complete = records.filter(r => r.service_start_at && r.service_finish_at);
    $("stat-total").textContent = String(records.length);
    $("stat-complete").textContent = String(complete.length);
    const avgWait = average(records.map(waitMs));
    const avgService = average(complete.map(serviceMs));
    $("stat-wait").textContent = avgWait == null ? "—" : duration(avgWait);
    $("stat-service").textContent = avgService == null ? "—" : duration(avgService);
    $("stat-pending").textContent = String(records.filter(r => statusOf(r) !== "complete").length);
  }

  function busyRecordForCashier(cashier, exceptId = null) {
    return records.find(r => String(r.id) !== String(exceptId) && r.cashier === cashier && r.service_start_at && !r.service_finish_at) || null;
  }

  function renderPending() {
    const list = $("pending-list");
    const pending = [...records].filter(r => statusOf(r) !== "complete").sort((a, b) => new Date(a.arrival_at) - new Date(b.arrival_at));
    if (!pending.length) {
      list.innerHTML = `<div class="empty-state compact"><strong>Tidak ada pelayanan tertunda</strong><span>Customer yang belum selesai akan muncul di sini.</span></div>`;
      return;
    }
    list.innerHTML = pending.map(row => {
      const status = statusOf(row);
      const busy = status === "waiting" ? busyRecordForCashier(row.cashier, row.id) : null;
      const action = status === "waiting"
        ? `<button class="btn btn-primary btn-mini" data-action="start" data-id="${escapeHtml(row.id)}" ${busy ? "disabled title='Kasir masih melayani customer lain'" : ""}>Mulai pelayanan</button>`
        : `<button class="btn btn-primary btn-mini" data-action="finish" data-id="${escapeHtml(row.id)}">Selesai pelayanan</button>`;
      const extra = busy ? ` · ${row.cashier} masih melayani #${escapeHtml(busy.id)}` : "";
      return `<div class="pending-item"><div class="pending-main"><div class="pending-title">Customer #${escapeHtml(row.id)} · ${escapeHtml(row.cashier)}</div><div class="pending-meta">Datang ${escapeHtml(timestamp(row.arrival_at))} · ${status === "waiting" ? "Menunggu mulai pelayanan" : "Mulai " + escapeHtml(timestamp(row.service_start_at))}${extra}</div></div><div class="pending-actions">${action}<button class="btn btn-secondary btn-mini" data-action="edit" data-id="${escapeHtml(row.id)}">Edit</button></div></div>`;
    }).join("");
  }

  function renderTable() {
    const body = $("records-body");
    const search = $("search-input").value.trim().toLowerCase();
    const statusFilter = $("status-filter").value;
    const cashierFilter = $("cashier-filter").value;
    const filtered = [...records].sort((a, b) => new Date(b.arrival_at) - new Date(a.arrival_at)).filter(row => {
      if (statusFilter !== "all" && statusOf(row) !== statusFilter) return false;
      if (cashierFilter !== "all" && row.cashier !== cashierFilter) return false;
      const haystack = [row.id, row.cashier, row.note, timestamp(row.arrival_at)].join(" ").toLowerCase();
      return !search || haystack.includes(search);
    });
    $("visible-count").textContent = `Menampilkan ${filtered.length} dari ${records.length} data`;
    if (!filtered.length) {
      body.innerHTML = `<tr><td colspan="9" class="table-empty">${records.length ? "Tidak ada data yang cocok dengan filter." : "Belum ada data. Catat pelanggan pertama melalui formulir di atas."}</td></tr>`;
      return;
    }
    body.innerHTML = filtered.map(row => {
      const status = statusOf(row);
      const queues = [row.q_k1, row.q_k2, row.q_k3, row.q_k4].map(v => Number(v ?? 0)).join(" · ");
      const busy = status === "waiting" ? busyRecordForCashier(row.cashier, row.id) : null;
      let actions = "";
      if (status === "waiting") actions += `<button class="action-link" data-action="start" data-id="${escapeHtml(row.id)}" ${busy ? "disabled title='Kasir masih sibuk'" : ""}>Mulai</button>`;
      if (status === "serving") actions += `<button class="action-link" data-action="finish" data-id="${escapeHtml(row.id)}">Selesai</button>`;
      actions += `<button class="action-link" data-action="edit" data-id="${escapeHtml(row.id)}">Edit</button>`;
      if (session && row.created_by === session.user.id) actions += `<button class="action-link delete" data-action="delete" data-id="${escapeHtml(row.id)}">Hapus</button>`;
      return `<tr><td><span class="customer-id">#${escapeHtml(row.id)}</span></td><td>${escapeHtml(timestamp(row.arrival_at))}</td><td><strong>${escapeHtml(row.cashier)}</strong></td><td><span class="queue-snapshot">${escapeHtml(queues)}</span></td><td>${escapeHtml(duration(waitMs(row)))}</td><td>${escapeHtml(timestamp(row.service_start_at))}</td><td>${escapeHtml(timestamp(row.service_finish_at))}</td><td>${escapeHtml(duration(serviceMs(row)))}</td><td><span class="status status-${status}">${escapeHtml(statusLabel(status))}</span><span class="row-actions">${actions}</span></td></tr>`;
    }).join("");
  }

  function render() {
    renderStats();
    renderPending();
    renderTable();
    $("customer-number").value = records.length ? "Otomatis saat disimpan" : "Customer pertama";
  }

  async function loadRecords({ quiet = false } = {}) {
    if (!supabaseClient || !session || loadInProgress) return;
    loadInProgress = true;
    try {
      const { data, error } = await supabaseClient.from(TABLE).select("*").order("arrival_at", { ascending: false }).limit(5000);
      if (error) throw error;
      records = data || [];
      render();
      setBadge("Database tersambung", "online");
    } catch (error) {
      console.error(error);
      setBadge("Koneksi database bermasalah", "offline");
      if (!quiet) showToast("Gagal mengambil data dari Supabase: " + (error.message || "periksa koneksi dan RLS"));
    } finally {
      loadInProgress = false;
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
    realtimeChannel = supabaseClient.channel("cashier-observations-live")
      .on("postgres_changes", { event: "*", schema: "public", table: TABLE }, () => loadRecords({ quiet: true }))
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setBadge("Tersinkron langsung", "online");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setBadge("Realtime tidak aktif", "offline");
      });
  }

  async function refreshAfterWrite(message) {
    await loadRecords({ quiet: true });
    if (message) showToast(message);
  }

  async function startService(id) {
    const row = records.find(r => String(r.id) === String(id));
    if (!row) return;
    if (row.service_start_at) return showToast("Waktu mulai sudah tercatat. Gunakan Edit untuk koreksi.");
    // Query server again so another device's active service is considered.
    const { data: active, error: checkError } = await supabaseClient.from(TABLE).select("id,cashier").eq("cashier", row.cashier).not("service_start_at", "is", null).is("service_finish_at", null).neq("id", row.id).limit(1);
    if (checkError) return showToast("Tidak dapat memeriksa status kasir: " + checkError.message);
    if (active && active.length) {
      await loadRecords({ quiet: true });
      return showToast(`${row.cashier} masih melayani customer #${active[0].id}. Catat waktu mulai setelah kasir tersedia.`);
    }
    const start = new Date().toISOString();
    if (new Date(start) < new Date(row.arrival_at)) return showToast("Waktu mulai tidak boleh sebelum waktu kedatangan.");
    const { error } = await supabaseClient.from(TABLE).update({ service_start_at: start, updated_at: start }).eq("id", row.id);
    if (error) return showToast("Gagal menyimpan waktu mulai: " + error.message);
    await refreshAfterWrite(`Waktu mulai customer #${row.id} tersimpan.`);
  }

  async function finishService(id) {
    const row = records.find(r => String(r.id) === String(id));
    if (!row) return;
    if (!row.service_start_at) return showToast("Catat waktu mulai pelayanan terlebih dahulu.");
    if (row.service_finish_at) return showToast("Waktu selesai sudah tercatat.");
    const finish = new Date().toISOString();
    if (new Date(finish) < new Date(row.service_start_at)) return showToast("Waktu selesai tidak boleh sebelum waktu mulai.");
    const { error } = await supabaseClient.from(TABLE).update({ service_finish_at: finish, updated_at: finish }).eq("id", row.id);
    if (error) return showToast("Gagal menyimpan waktu selesai: " + error.message);
    await refreshAfterWrite(`Pelayanan customer #${row.id} selesai dicatat.`);
  }

  async function deleteRecord(id) {
    const row = records.find(r => String(r.id) === String(id));
    if (!row) return;
    if (!confirm(`Hapus data customer #${row.id}? Hanya data yang kamu buat yang dapat dihapus.`)) return;
    const { error } = await supabaseClient.from(TABLE).delete().eq("id", row.id);
    if (error) return showToast("Data tidak dapat dihapus. Pastikan kamu pembuat data tersebut. " + error.message);
    await refreshAfterWrite(`Data customer #${row.id} dihapus.`);
  }

  function localInputValue(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function isoFromLocal(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  function openEdit(id) {
    const row = records.find(r => String(r.id) === String(id));
    if (!row) return;
    $("edit-id").value = row.id;
    $("edit-customer-label").textContent = row.id;
    $("edit-arrival").value = localInputValue(row.arrival_at);
    $("edit-cashier").value = row.cashier;
    $("edit-q-k1").value = row.q_k1;
    $("edit-q-k2").value = row.q_k2;
    $("edit-q-k3").value = row.q_k3;
    $("edit-q-k4").value = row.q_k4;
    $("edit-start").value = localInputValue(row.service_start_at);
    $("edit-finish").value = localInputValue(row.service_finish_at);
    $("edit-note").value = row.note || "";
    $("edit-dialog").showModal();
  }

  async function saveEdit(event) {
    event.preventDefault();
    const id = $("edit-id").value;
    const arrival = isoFromLocal($("edit-arrival").value);
    const start = isoFromLocal($("edit-start").value);
    const finish = isoFromLocal($("edit-finish").value);
    if (!arrival) return showToast("Waktu kedatangan wajib diisi.");
    if (start && new Date(start) < new Date(arrival)) return showToast("Waktu mulai tidak boleh sebelum kedatangan.");
    if (finish && !start) return showToast("Isi waktu mulai sebelum waktu selesai.");
    if (finish && start && new Date(finish) < new Date(start)) return showToast("Waktu selesai tidak boleh sebelum waktu mulai.");
    const queues = {};
    for (const k of CASHIERS) {
      const raw = $("edit-q-" + k.toLowerCase()).value;
      const n = Number(raw);
      if (raw === "" || !Number.isInteger(n) || n < 0) return showToast(`Panjang antrean ${k} harus bilangan bulat nol atau lebih.`);
      queues["q_" + k.toLowerCase()] = n;
    }
    const payload = {
      arrival_at: arrival,
      cashier: $("edit-cashier").value,
      ...queues,
      service_start_at: start,
      service_finish_at: finish,
      note: $("edit-note").value.trim(),
      updated_at: new Date().toISOString()
    };
    const { error } = await supabaseClient.from(TABLE).update(payload).eq("id", Number(id));
    if (error) return showToast("Gagal menyimpan koreksi: " + error.message);
    $("edit-dialog").close();
    await refreshAfterWrite(`Koreksi customer #${id} tersimpan.`);
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function download(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function dateStamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  function exportCsv() {
    if (!records.length) return showToast("Belum ada data untuk diekspor.");
    const headers = ["Customer ID", "Waktu Kedatangan", "Kasir Aktual", "Panjang Antrean K1", "Panjang Antrean K2", "Panjang Antrean K3", "Panjang Antrean K4", "Waktu Mulai Pelayanan", "Waktu Selesai Pelayanan", "Durasi Tunggu (detik)", "Durasi Pelayanan (detik)", "Waktu Dalam Sistem (detik)", "Status", "Catatan", "Dibuat Oleh"];
    const rows = [...records].sort((a,b) => new Date(a.arrival_at) - new Date(b.arrival_at)).map(r => [
      r.id, timestamp(r.arrival_at), r.cashier, r.q_k1, r.q_k2, r.q_k3, r.q_k4,
      timestamp(r.service_start_at), timestamp(r.service_finish_at),
      waitMs(r) == null ? "" : Math.round(waitMs(r)/1000),
      serviceMs(r) == null ? "" : Math.round(serviceMs(r)/1000),
      systemMs(r) == null ? "" : Math.round(systemMs(r)/1000),
      statusLabel(statusOf(r)), r.note || "", r.created_by || ""
    ]);
    const content = "\uFEFF" + [headers, ...rows].map(row => row.map(csvCell).join(";")).join("\r\n");
    download(content, `observasi-antrean-kasir-${dateStamp()}.csv`, "text/csv;charset=utf-8");
    showToast("CSV dibuat. Simpan sebagai backup dan olah di Excel.");
  }

  function exportJson() {
    if (!records.length) return showToast("Belum ada data untuk dibackup.");
    const payload = { app: "DES Cashier Supabase", exported_at: new Date().toISOString(), records };
    download(JSON.stringify(payload, null, 2), `backup-des-cashier-${dateStamp()}.json`, "application/json");
    showToast("Backup JSON berhasil dibuat.");
  }

  async function handleLogin(event) {
    event.preventDefault();
    $("login-error").textContent = "";
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    const button = $("login-button");
    button.disabled = true;
    button.textContent = "Memeriksa akun…";
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    button.disabled = false;
    button.textContent = "Masuk";
    if (error) {
      $("login-error").textContent = "Login gagal. Periksa email/password atau pastikan akun sudah dibuat oleh admin Supabase.";
      console.error(error);
      return;
    }
    session = data.session;
    await showAuthenticatedState();
  }

  async function showAuthenticatedState() {
    if (!session) {
      stopRealtime();
      records = [];
      setScreen("login-screen");
      setBadge("Belum login", "offline");
      return;
    }
    setScreen("app-screen");
    setBadge("Menghubungkan database…");
    await loadRecords();
    startRealtime();
  }

  async function initialize() {
    if (!isConfigured()) {
      setScreen("setup-screen");
      setBadge("Konfigurasi dibutuhkan", "offline");
      return;
    }
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      setScreen("setup-screen");
      $("setup-screen").querySelector("p:not(.eyebrow)").textContent = "Library Supabase JS gagal dimuat. Periksa koneksi internet atau coba lagi.";
      setBadge("Library gagal dimuat", "offline");
      return;
    }
    supabaseClient = window.supabase.createClient(window.DES_SUPABASE_URL, window.DES_SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) console.error(error);
    session = data?.session || null;
    await showAuthenticatedState();
    supabaseClient.auth.onAuthStateChange((_event, nextSession) => {
      session = nextSession;
      // Avoid awaiting Supabase API calls inside this callback; defer state refresh.
      setTimeout(() => showAuthenticatedState(), 0);
    });
  }

  $("login-form").addEventListener("submit", handleLogin);
  $("logout-button").addEventListener("click", async () => {
    if (!supabaseClient) return;
    const { error } = await supabaseClient.auth.signOut();
    if (error) return showToast("Gagal keluar: " + error.message);
    session = null;
    await showAuthenticatedState();
    showToast("Kamu sudah keluar.");
  });

  $("arrival-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!session) return showToast("Silakan login kembali.");
    const cashier = $("cashier-choice").value;
    if (!CASHIERS.includes(cashier)) return showToast("Pilih kasir aktual yang dipilih pelanggan.");
    const queues = {};
    for (const k of CASHIERS) {
      const input = $("q-" + k.toLowerCase());
      const raw = input.value;
      const value = Number(raw);
      if (raw === "" || !Number.isInteger(value) || value < 0) {
        showToast(`Isi panjang antrean ${k} dengan bilangan bulat nol atau lebih.`);
        input.focus();
        return;
      }
      queues["q_" + k.toLowerCase()] = value;
    }
    const button = $("arrival-submit");
    button.disabled = true;
    button.textContent = "Menyimpan ke database…";
    const arrival = new Date().toISOString();
    const payload = {
      arrival_at: arrival,
      cashier,
      ...queues,
      service_start_at: null,
      service_finish_at: null,
      note: $("arrival-note").value.trim(),
      created_by: session.user.id,
      updated_at: arrival
    };
    const { data, error } = await supabaseClient.from(TABLE).insert(payload).select("id").single();
    button.disabled = false;
    button.textContent = "＋ Catat kedatangan sekarang";
    if (error) {
      console.error(error);
      showToast("Gagal menyimpan data: " + error.message);
      return;
    }
    $("arrival-form").reset();
    await refreshAfterWrite(`Kedatangan customer #${data.id} tersimpan di database.`);
  });

  document.addEventListener("click", event => {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const { action, id } = button.dataset;
    if (action === "start") startService(id);
    else if (action === "finish") finishService(id);
    else if (action === "edit") openEdit(id);
    else if (action === "delete") deleteRecord(id);
  });

  ["search-input", "status-filter", "cashier-filter"].forEach(id => {
    $(id).addEventListener("input", renderTable);
    $(id).addEventListener("change", renderTable);
  });
  $("refresh-data").addEventListener("click", () => loadRecords().then(() => showToast("Data diperbarui dari database.")));
  $("export-csv").addEventListener("click", exportCsv);
  $("export-json").addEventListener("click", exportJson);
  $("edit-form").addEventListener("submit", saveEdit);
  $("close-edit").addEventListener("click", () => $("edit-dialog").close());
  $("cancel-edit").addEventListener("click", () => $("edit-dialog").close());

  initialize().catch(error => {
    console.error(error);
    setBadge("Gagal memulai aplikasi", "offline");
    setScreen("login-screen");
    $("login-error").textContent = "Aplikasi gagal diinisialisasi. Periksa config.js dan koneksi internet.";
  });
})();
