/* Dispatch — personal dashboard
   Data model lives in localStorage under DATA_KEY.
   Optional sync pushes/pulls the same JSON blob to a GitHub repo file
   using a personal access token stored only in this browser's localStorage.
*/

(() => {
  "use strict";

  const DATA_KEY = "dispatch_data_v1";
  const SYNC_KEY = "dispatch_sync_v1";

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // Local-timezone date formatting — deliberately NOT toISOString(), which
  // converts to UTC and shifts the date backward for anyone east of
  // Greenwich (e.g. Sydney), making "today" resolve to yesterday.
  function toLocalISO(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  const todayISO = () => toLocalISO(new Date());

  // Combines a reminder's date + optional time into a real Date for
  // precise overdue/due-today comparisons. Reminders with no time default
  // to end-of-day, so they count as "due today" all day rather than
  // going overdue at midnight.
  function reminderMoment(r) {
    if (!r.date) return null;
    const time = r.time || "23:59";
    return new Date(`${r.date}T${time}:00`);
  }

  function formatTime(hhmm) {
    if (!hhmm) return "";
    const d = new Date(`2000-01-01T${hhmm}:00`);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  // ---------- state ----------
  let state = loadState();
  let syncCfg = loadSyncCfg();
  let syncTimer = null;

  function loadState() {
    try {
      const raw = localStorage.getItem(DATA_KEY);
      if (!raw) throw new Error("empty");
      const parsed = JSON.parse(raw);
      return {
        reminders: parsed.reminders || [],
        shopping: parsed.shopping || [],
        dates: parsed.dates || [],
        notes: parsed.notes || [],
      };
    } catch {
      return { reminders: [], shopping: [], dates: [], notes: [] };
    }
  }

  function saveState({ sync = true } = {}) {
    localStorage.setItem(DATA_KEY, JSON.stringify(state));
    renderAll();
    if (sync && syncCfg) scheduleSync();
  }

  function loadSyncCfg() {
    try {
      const raw = localStorage.getItem(SYNC_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveSyncCfg(cfg) {
    syncCfg = cfg;
    if (cfg) localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(SYNC_KEY);
  }

  // ---------- toast ----------
  const toastEl = document.getElementById("toast");
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  // ---------- tabs ----------
  const pages = document.querySelectorAll(".page");
  const tabButtons = document.querySelectorAll("#tabsNav button, #tabbarBottom button");

  function showPage(name) {
    pages.forEach((p) => p.classList.toggle("active", p.id === `page-${name}`));
    tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.dataset.page));
  });

  // ---------- dateline ----------
  function renderDateline() {
    const now = new Date();
    const dateStr = now.toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    document.getElementById("datelineDate").textContent = dateStr;

    const place = document.getElementById("datelinePlace");
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    place.textContent = tz.split("/").pop()?.replace(/_/g, " ") || "—";
  }

  // ---------- helpers for dates ----------
  function fmtDate(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  function daysBetween(aISO, bISO) {
    const a = new Date(aISO + "T00:00:00");
    const b = new Date(bISO + "T00:00:00");
    return Math.round((b - a) / 86400000);
  }

  // next occurrence of a "significant date" — if recurring, project into
  // this year or next; if not recurring, use the date as-is.
  function nextOccurrence(dateItem) {
    if (!dateItem.recurring) return dateItem.date;
    const today = new Date();
    const [, m, d] = dateItem.date.split("-").map(Number);
    let year = today.getFullYear();
    let candidate = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (daysBetween(todayISO(), candidate) < 0) {
      year += 1;
      candidate = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    return candidate;
  }

  // ---------- REMINDERS ----------
  const remindersList = document.getElementById("remindersList");
  const remindersCount = document.getElementById("remindersCount");
  const reminderInput = document.getElementById("reminderInput");
  const reminderDate = document.getElementById("reminderDate");
  const reminderTime = document.getElementById("reminderTime");

  document.getElementById("addReminderBtn").addEventListener("click", addReminder);
  reminderInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addReminder(); });

  function addReminder() {
    const text = reminderInput.value.trim();
    if (!text) return;
    state.reminders.push({
      id: uid(),
      text,
      date: reminderDate.value || null,
      time: reminderDate.value ? (reminderTime.value || null) : null,
      done: false,
    });
    reminderInput.value = "";
    reminderDate.value = "";
    reminderTime.value = "";
    saveState();
    toast("Filed.");
  }

  function renderReminders() {
    const open = state.reminders.filter((r) => !r.done);
    remindersCount.textContent = open.length ? `· ${open.length}` : "";

    const sorted = [...state.reminders].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.date && b.date) {
        const cmp = a.date.localeCompare(b.date);
        if (cmp !== 0) return cmp;
        return (a.time || "").localeCompare(b.time || "");
      }
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });

    if (!sorted.length) {
      remindersList.innerHTML = `<div class="empty">Nothing filed yet.</div>`;
      return;
    }

    const now = new Date();
    remindersList.innerHTML = sorted.map((r) => {
      const moment = reminderMoment(r);
      const overdue = !!moment && !r.done && moment < now;
      const isToday = r.date === todayISO();
      let meta = "";
      if (r.date) {
        const dateLabel = overdue ? `overdue · ${fmtDate(r.date)}` : isToday ? "today" : fmtDate(r.date);
        const timeLabel = r.time ? formatTime(r.time) : "";
        meta = [dateLabel, timeLabel].filter(Boolean).join(" · ");
      }
      return `
        <div class="item ${r.done ? "done" : ""}" data-id="${r.id}">
          <button class="check ${r.done ? "checked" : ""}" data-action="toggle-reminder" aria-label="Toggle done"></button>
          <div class="item-body">
            <div class="item-text">${escapeHtml(r.text)}</div>
            ${meta ? `<div class="item-meta ${overdue ? "overdue" : ""}">${meta}</div>` : ""}
          </div>
          <button class="item-del" data-action="delete-reminder" aria-label="Delete">&times;</button>
        </div>`;
    }).join("");
  }

  remindersList.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.closest(".item").dataset.id;
    if (btn.dataset.action === "toggle-reminder") {
      const r = state.reminders.find((x) => x.id === id);
      if (r) r.done = !r.done;
      saveState();
    } else if (btn.dataset.action === "delete-reminder") {
      state.reminders = state.reminders.filter((x) => x.id !== id);
      saveState();
    }
  });

  // ---------- SHOPPING ----------
  const shoppingList = document.getElementById("shoppingList");
  const shoppingCount = document.getElementById("shoppingCount");
  const shoppingInput = document.getElementById("shoppingInput");

  document.getElementById("addShoppingBtn").addEventListener("click", addShopping);
  shoppingInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addShopping(); });

  function addShopping() {
    const text = shoppingInput.value.trim();
    if (!text) return;
    state.shopping.push({ id: uid(), text, done: false });
    shoppingInput.value = "";
    saveState();
  }

  function renderShopping() {
    const open = state.shopping.filter((s) => !s.done);
    shoppingCount.textContent = open.length ? `· ${open.length}` : "";

    const sorted = [...state.shopping].sort((a, b) => (a.done === b.done ? 0 : a.done ? 1 : -1));

    if (!sorted.length) {
      shoppingList.innerHTML = `<div class="empty">List's empty.</div>`;
      return;
    }

    shoppingList.innerHTML = sorted.map((s) => `
      <div class="item ${s.done ? "done" : ""}" data-id="${s.id}">
        <button class="check ${s.done ? "checked" : ""}" data-action="toggle-shopping" aria-label="Toggle done"></button>
        <div class="item-body"><div class="item-text">${escapeHtml(s.text)}</div></div>
        <button class="item-del" data-action="delete-shopping" aria-label="Delete">&times;</button>
      </div>`).join("");
  }

  shoppingList.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.closest(".item").dataset.id;
    if (btn.dataset.action === "toggle-shopping") {
      const s = state.shopping.find((x) => x.id === id);
      if (s) s.done = !s.done;
      saveState();
    } else if (btn.dataset.action === "delete-shopping") {
      state.shopping = state.shopping.filter((x) => x.id !== id);
      saveState();
    }
  });

  // ---------- SIGNIFICANT DATES ----------
  const datesList = document.getElementById("datesList");
  const datesCount = document.getElementById("datesCount");
  const dateLabelInput = document.getElementById("dateLabelInput");
  const dateValueInput = document.getElementById("dateValueInput");
  const dateRecurring = document.getElementById("dateRecurring");

  document.getElementById("addDateBtn").addEventListener("click", addDate);

  function addDate() {
    const label = dateLabelInput.value.trim();
    const value = dateValueInput.value;
    if (!label || !value) return;
    state.dates.push({
      id: uid(),
      label,
      date: value,
      recurring: dateRecurring.checked,
    });
    dateLabelInput.value = "";
    dateValueInput.value = "";
    dateRecurring.checked = true;
    saveState();
    toast("Marked.");
  }

  function renderDates() {
    datesCount.textContent = state.dates.length ? `· ${state.dates.length}` : "";

    const withNext = state.dates.map((d) => ({ ...d, _next: nextOccurrence(d) }));
    withNext.sort((a, b) => a._next.localeCompare(b._next));

    if (!withNext.length) {
      datesList.innerHTML = `<div class="empty">No dates marked yet.</div>`;
      return;
    }

    datesList.innerHTML = withNext.map((d) => {
      const days = daysBetween(todayISO(), d._next);
      let meta;
      if (days === 0) meta = "today";
      else if (days === 1) meta = "tomorrow";
      else meta = `in ${days} days · ${fmtDate(d._next)}`;
      return `
        <div class="item" data-id="${d.id}">
          <div class="item-body">
            <div class="item-text">${escapeHtml(d.label)}</div>
            <div class="item-meta">${meta}${d.recurring ? " · yearly" : ""}</div>
          </div>
          <button class="item-del" data-action="delete-date" aria-label="Delete">&times;</button>
        </div>`;
    }).join("");
  }

  datesList.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.closest(".item").dataset.id;
    state.dates = state.dates.filter((x) => x.id !== id);
    saveState();
  });

  // ---------- NOTES ----------
  const notesList = document.getElementById("notesList");
  const notesCount = document.getElementById("notesCount");
  const noteInput = document.getElementById("noteInput");

  document.getElementById("addNoteBtn").addEventListener("click", addNote);

  function addNote() {
    const text = noteInput.value.trim();
    if (!text) return;
    state.notes.unshift({ id: uid(), text, createdAt: Date.now() });
    noteInput.value = "";
    saveState();
    toast("Saved.");
  }

  function renderNotes() {
    notesCount.textContent = state.notes.length ? `· ${state.notes.length}` : "";

    if (!state.notes.length) {
      notesList.innerHTML = `<div class="empty">No notes yet.</div>`;
      return;
    }

    notesList.innerHTML = state.notes.map((n) => {
      const d = new Date(n.createdAt);
      const meta = d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
      return `
        <div class="card note-card" data-id="${n.id}">
          <div class="item-meta">${meta}</div>
          <div class="note-text">${escapeHtml(n.text)}</div>
          <div class="note-actions">
            <button data-action="delete-note">Delete</button>
          </div>
        </div>`;
    }).join("");
  }

  notesList.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.closest(".note-card").dataset.id;
    if (btn.dataset.action === "delete-note") {
      state.notes = state.notes.filter((x) => x.id !== id);
      saveState();
    }
  });

  // ---------- TODAY (agenda) ----------
  const pageToday = document.getElementById("page-today");

  function renderToday() {
    const t = todayISO();
    const now = new Date();

    const overdue = state.reminders
      .filter((r) => !r.done && r.date && reminderMoment(r) < now)
      .sort((a, b) => reminderMoment(a) - reminderMoment(b));
    const dueToday = state.reminders
      .filter((r) => !r.done && r.date === t && reminderMoment(r) >= now)
      .sort((a, b) => reminderMoment(a) - reminderMoment(b));
    const upcomingDates = state.dates
      .map((d) => ({ ...d, _next: nextOccurrence(d) }))
      .filter((d) => daysBetween(t, d._next) >= 0 && daysBetween(t, d._next) <= 14)
      .sort((a, b) => a._next.localeCompare(b._next));
    const openShopping = state.shopping.filter((s) => !s.done).length;

    const groups = [];

    if (overdue.length) {
      groups.push(agendaGroup("Overdue", overdue.map((r) => reminderRow(r, true))));
    }
    if (dueToday.length) {
      groups.push(agendaGroup("Due today", dueToday.map((r) => reminderRow(r, false))));
    }
    if (upcomingDates.length) {
      groups.push(agendaGroup("Coming up", upcomingDates.map((d) => {
        const days = daysBetween(t, d._next);
        const meta = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
        return `<div class="item"><div class="item-body"><div class="item-text">${escapeHtml(d.label)}</div><div class="item-meta">${meta}</div></div></div>`;
      })));
    }

    let html = groups.join("");

    if (!overdue.length && !dueToday.length && !upcomingDates.length) {
      html += `<div class="empty">Nothing pressing today.</div>`;
    }

    if (openShopping) {
      html += `<div class="section-label" style="margin-top:28px;">Shopping list <span class="count">· ${openShopping} open</span></div>`;
    }

    pageToday.innerHTML = html;
  }

  function agendaGroup(label, rowsHtml) {
    return `
      <div class="agenda-day">
        <div class="agenda-day-label">${label}</div>
        <div class="card">${rowsHtml.join("")}</div>
      </div>`;
  }

  function reminderRow(r, overdue) {
    let meta = "";
    if (r.date) {
      const dateLabel = overdue ? `overdue · ${fmtDate(r.date)}` : "today";
      const timeLabel = r.time ? formatTime(r.time) : "";
      meta = [dateLabel, timeLabel].filter(Boolean).join(" · ");
    }
    return `
      <div class="item" data-id="${r.id}">
        <button class="check" data-action="toggle-today-reminder" aria-label="Toggle done"></button>
        <div class="item-body">
          <div class="item-text">${escapeHtml(r.text)}</div>
          ${meta ? `<div class="item-meta ${overdue ? "overdue" : ""}">${meta}</div>` : ""}
        </div>
      </div>`;
  }

  pageToday.addEventListener("click", (e) => {
    const btn = e.target.closest('button[data-action="toggle-today-reminder"]');
    if (!btn) return;
    const id = btn.closest(".item").dataset.id;
    const r = state.reminders.find((x) => x.id === id);
    if (r) r.done = true;
    saveState();
  });

  // ---------- escape ----------
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- render all ----------
  function renderAll() {
    renderReminders();
    renderShopping();
    renderDates();
    renderNotes();
    renderToday();
  }

  // ---------- SETTINGS / SYNC ----------
  const syncIndicator = document.getElementById("syncIndicator");
  const syncLabel = document.getElementById("syncLabel");
  const settingsBackdrop = document.getElementById("settingsBackdrop");
  const ghOwner = document.getElementById("ghOwner");
  const ghRepo = document.getElementById("ghRepo");
  const ghPath = document.getElementById("ghPath");
  const ghToken = document.getElementById("ghToken");

  syncIndicator.addEventListener("click", () => {
    if (syncCfg) {
      ghOwner.value = syncCfg.owner || "";
      ghRepo.value = syncCfg.repo || "";
      ghPath.value = syncCfg.path || "data.json";
      ghToken.value = syncCfg.token || "";
    }
    settingsBackdrop.classList.add("open");
  });

  document.getElementById("closeSettings").addEventListener("click", () => {
    settingsBackdrop.classList.remove("open");
  });
  settingsBackdrop.addEventListener("click", (e) => {
    if (e.target === settingsBackdrop) settingsBackdrop.classList.remove("open");
  });

  document.getElementById("clearSyncBtn").addEventListener("click", () => {
    saveSyncCfg(null);
    setSyncStatus("local", "local only");
    settingsBackdrop.classList.remove("open");
    toast("Sync disconnected.");
  });

  document.getElementById("testSyncBtn").addEventListener("click", async () => {
    const cfg = readCfgForm();
    if (!cfg) return toast("Fill in all sync fields first.");
    setSyncStatus("pending", "testing…");
    try {
      await githubGetFile(cfg);
      setSyncStatus("ok", "connection ok");
      toast("Connection works.");
    } catch (err) {
      setSyncStatus("err", "error");
      toast(err.message || "Connection failed.");
    }
  });

  document.getElementById("saveSyncBtn").addEventListener("click", async () => {
    const cfg = readCfgForm();
    if (!cfg) {
      saveSyncCfg(null);
      setSyncStatus("local", "local only");
      settingsBackdrop.classList.remove("open");
      return;
    }
    saveSyncCfg(cfg);
    settingsBackdrop.classList.remove("open");
    toast("Saved. Syncing…");
    await runSync();
  });

  function readCfgForm() {
    const owner = ghOwner.value.trim();
    const repo = ghRepo.value.trim();
    const path = ghPath.value.trim() || "data.json";
    const token = ghToken.value.trim();
    if (!owner || !repo || !token) return null;
    return { owner, repo, path, token };
  }

  function setSyncStatus(kind, label) {
    syncIndicator.classList.remove("ok", "pending", "err");
    if (kind === "ok") syncIndicator.classList.add("ok");
    else if (kind === "pending") syncIndicator.classList.add("pending");
    else if (kind === "err") syncIndicator.classList.add("err");
    syncLabel.textContent = label;
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    setSyncStatus("pending", "syncing…");
    syncTimer = setTimeout(runSync, 1200);
  }

  async function runSync() {
    if (!syncCfg) return;
    try {
      await githubPutFile(syncCfg, state);
      setSyncStatus("ok", "synced");
    } catch (err) {
      setSyncStatus("err", "sync failed");
      console.error(err);
    }
  }

  async function pullSyncOnLoad() {
    if (!syncCfg) return;
    setSyncStatus("pending", "loading…");
    try {
      const remote = await githubGetFile(syncCfg);
      if (remote && remote.content) {
        const decoded = JSON.parse(decodeURIComponent(escape(atob(remote.content))));
        state = {
          reminders: decoded.reminders || [],
          shopping: decoded.shopping || [],
          dates: decoded.dates || [],
          notes: decoded.notes || [],
        };
        localStorage.setItem(DATA_KEY, JSON.stringify(state));
      }
      setSyncStatus("ok", "synced");
      renderAll();
    } catch (err) {
      setSyncStatus("err", "sync failed");
      console.error(err);
    }
  }

  // GitHub contents API helpers
  async function githubGetFile(cfg) {
    const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(cfg.path)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (res.status === 404) return null; // file doesn't exist yet — fine
    if (!res.ok) throw new Error(`GitHub error (${res.status})`);
    return res.json();
  }

  async function githubPutFile(cfg, data) {
    const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(cfg.path)}`;
    let sha;
    try {
      const existing = await githubGetFile(cfg);
      sha = existing ? existing.sha : undefined;
    } catch {
      // continue without sha — will fail clearly below if file exists
    }
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
    const body = {
      message: `Dispatch sync ${new Date().toISOString()}`,
      content,
      ...(sha ? { sha } : {}),
    };
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.message || `GitHub error (${res.status})`);
    }
    return res.json();
  }

  // ---------- service worker ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((err) => console.error("SW registration failed", err));
    });
  }

  // ---------- init ----------
  renderDateline();
  renderAll();
  if (syncCfg) {
    setSyncStatus("pending", "loading…");
    pullSyncOnLoad();
  } else {
    setSyncStatus("local", "local only");
  }
})();
