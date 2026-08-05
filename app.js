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

  // ---------- multi-line text fields ----------
  // Every free-text field in the app (reminder text, things-to-do text,
  // significant-date label, notes, and all their inline "edit" versions)
  // is a <textarea> so Enter can insert a line break rather than being
  // swallowed by a single-line <input>. Adding always happens via the
  // explicit File/Add/Save button, never via Enter.
  //
  // `beforeinput` reliably reports what a virtual/mobile keyboard is about
  // to do (inputType: "insertLineBreak") even in cases where keydown
  // reports an unreliable/placeholder key for on-screen keyboards, which is
  // why we intercept it here rather than relying on keydown alone.
  const MULTILINE_FIELD_SELECTOR =
    "#noteInput, #reminderInput, #shoppingInput, #dateLabelInput, .note-edit-input, .edit-text-input";

  function isMultilineField(el) {
    return !!(el && el.matches && el.matches(MULTILINE_FIELD_SELECTOR));
  }

  function insertNewlineAtCursor(textarea) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    textarea.value = value.slice(0, start) + "\n" + value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + 1;
    autoGrowTextarea(textarea);
  }

  function autoGrowTextarea(el) {
    // offsetParent is null when the element (or an ancestor) is
    // display:none — e.g. it sits on a tab that isn't active right now.
    // Measuring height in that state always returns 0, which would get
    // baked in as a fixed inline height and collapse the field the next
    // time its tab becomes visible. Skip it and leave sizing alone until
    // it's actually on screen (the next render or input event will catch
    // it correctly).
    if (el.offsetParent === null) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  document.addEventListener("beforeinput", (e) => {
    if (!isMultilineField(e.target)) return;
    if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
      e.preventDefault();
      insertNewlineAtCursor(e.target);
    }
  });

  // Fallback for the rare browser without beforeinput inputType support.
  const supportsBeforeInputTypes =
    typeof window.InputEvent === "function" && "inputType" in window.InputEvent.prototype;
  document.addEventListener("keydown", (e) => {
    if (supportsBeforeInputTypes) return;
    if (!isMultilineField(e.target)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      insertNewlineAtCursor(e.target);
    }
  });

  document.addEventListener("input", (e) => {
    if (isMultilineField(e.target)) autoGrowTextarea(e.target);
  });

  function autoGrowAllMultilineFields() {
    document.querySelectorAll(MULTILINE_FIELD_SELECTOR).forEach(autoGrowTextarea);
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
    autoGrowAllMultilineFields();
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

  let editingReminderId = null;

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
      if (r.id === editingReminderId) {
        return `
          <div class="item editing" data-id="${r.id}">
            <div class="item-body">
              <div class="add-row" style="margin:0;">
                <textarea class="edit-text-input" rows="1" style="flex:1;" enterkeyhint="enter">${escapeHtml(r.text)}</textarea>
              </div>
              <div class="add-row" style="margin-top:8px;">
                <input type="date" class="edit-date-input" value="${r.date || ""}">
                <input type="time" class="edit-time-input" value="${r.time || ""}">
              </div>
              <div class="note-actions" style="margin-top:8px;">
                <button data-action="save-reminder">Save</button>
                <button data-action="cancel-edit-reminder">Cancel</button>
              </div>
            </div>
          </div>`;
      }

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
          <button class="item-edit" data-action="edit-reminder" aria-label="Edit">&#9998;</button>
          <button class="item-del" data-action="delete-reminder" aria-label="Delete">&times;</button>
        </div>`;
    }).join("");
  }

  remindersList.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const item = btn.closest(".item");
    const id = item.dataset.id;
    const action = btn.dataset.action;

    if (action === "toggle-reminder") {
      const r = state.reminders.find((x) => x.id === id);
      if (r) r.done = !r.done;
      saveState();
    } else if (action === "delete-reminder") {
      state.reminders = state.reminders.filter((x) => x.id !== id);
      if (editingReminderId === id) editingReminderId = null;
      saveState();
    } else if (action === "edit-reminder") {
      editingReminderId = id;
      renderReminders();
    } else if (action === "cancel-edit-reminder") {
      editingReminderId = null;
      renderReminders();
    } else if (action === "save-reminder") {
      const text = item.querySelector(".edit-text-input").value.trim();
      const dateVal = item.querySelector(".edit-date-input").value;
      const timeVal = item.querySelector(".edit-time-input").value;
      if (text) {
        const r = state.reminders.find((x) => x.id === id);
        if (r) {
          r.text = text;
          r.date = dateVal || null;
          r.time = dateVal ? (timeVal || null) : null;
        }
      }
      editingReminderId = null;
      saveState();
    }
  });

  // ---------- SHOPPING ----------
  const shoppingList = document.getElementById("shoppingList");
  const shoppingCount = document.getElementById("shoppingCount");
  const shoppingInput = document.getElementById("shoppingInput");

  document.getElementById("addShoppingBtn").addEventListener("click", addShopping);

  function addShopping() {
    const text = shoppingInput.value.trim();
    if (!text) return;
    state.shopping.push({ id: uid(), text, done: false });
    shoppingInput.value = "";
    saveState();
  }

  let editingShoppingId = null;

  function renderShopping() {
    const open = state.shopping.filter((s) => !s.done);
    shoppingCount.textContent = open.length ? `· ${open.length}` : "";

    const sorted = [...state.shopping].sort((a, b) => (a.done === b.done ? 0 : a.done ? 1 : -1));

    if (!sorted.length) {
      shoppingList.innerHTML = `<div class="empty">List's empty.</div>`;
      return;
    }

    shoppingList.innerHTML = sorted.map((s) => {
      if (s.id === editingShoppingId) {
        return `
          <div class="item editing" data-id="${s.id}">
            <div class="item-body">
              <div class="add-row" style="margin:0;">
                <textarea class="edit-text-input" rows="1" style="flex:1;" enterkeyhint="enter">${escapeHtml(s.text)}</textarea>
              </div>
              <div class="note-actions" style="margin-top:8px;">
                <button data-action="save-shopping">Save</button>
                <button data-action="cancel-edit-shopping">Cancel</button>
              </div>
            </div>
          </div>`;
      }
      return `
        <div class="item ${s.done ? "done" : ""}" data-id="${s.id}">
          <button class="check ${s.done ? "checked" : ""}" data-action="toggle-shopping" aria-label="Toggle done"></button>
          <div class="item-body"><div class="item-text">${escapeHtml(s.text)}</div></div>
          <button class="item-edit" data-action="edit-shopping" aria-label="Edit">&#9998;</button>
          <button class="item-del" data-action="delete-shopping" aria-label="Delete">&times;</button>
        </div>`;
    }).join("");
  }

  shoppingList.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const item = btn.closest(".item");
    const id = item.dataset.id;
    const action = btn.dataset.action;

    if (action === "toggle-shopping") {
      const s = state.shopping.find((x) => x.id === id);
      if (s) s.done = !s.done;
      saveState();
    } else if (action === "delete-shopping") {
      state.shopping = state.shopping.filter((x) => x.id !== id);
      if (editingShoppingId === id) editingShoppingId = null;
      saveState();
    } else if (action === "edit-shopping") {
      editingShoppingId = id;
      renderShopping();
    } else if (action === "cancel-edit-shopping") {
      editingShoppingId = null;
      renderShopping();
    } else if (action === "save-shopping") {
      const val = item.querySelector(".edit-text-input").value.trim();
      if (val) {
        const s = state.shopping.find((x) => x.id === id);
        if (s) s.text = val;
      }
      editingShoppingId = null;
      saveState();
    }
  });

  // ---------- SIGNIFICANT DATES ----------
  const datesList = document.getElementById("datesList");
  const datesCount = document.getElementById("datesCount");
  const dateLabelInput = document.getElementById("dateLabelInput");
  const dateValueInput = document.getElementById("dateValueInput");
  const dateTimeInput = document.getElementById("dateTimeInput");
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
      time: dateTimeInput.value || null,
      recurring: dateRecurring.checked,
    });
    dateLabelInput.value = "";
    dateValueInput.value = "";
    dateTimeInput.value = "";
    dateRecurring.checked = true;
    saveState();
    toast("Marked.");
  }

  let editingDateId = null;

  function renderDates() {
    datesCount.textContent = state.dates.length ? `· ${state.dates.length}` : "";

    const withNext = state.dates.map((d) => ({ ...d, _next: nextOccurrence(d) }));
    withNext.sort((a, b) => a._next.localeCompare(b._next));

    if (!withNext.length) {
      datesList.innerHTML = `<div class="empty">No dates marked yet.</div>`;
      return;
    }

    datesList.innerHTML = withNext.map((d) => {
      if (d.id === editingDateId) {
        return `
          <div class="item editing" data-id="${d.id}">
            <div class="item-body">
              <div class="add-row" style="margin:0; flex-wrap:wrap;">
                <textarea class="edit-text-input" rows="1" style="flex:1 1 100%;" enterkeyhint="enter">${escapeHtml(d.label)}</textarea>
              </div>
              <div class="add-row" style="margin-top:8px;">
                <input type="date" class="edit-date-input" value="${d.date || ""}">
                <input type="time" class="edit-time-input" value="${d.time || ""}">
              </div>
              <div class="add-row" style="margin-top:8px;">
                <div class="recur-toggle">
                  <input type="checkbox" class="edit-recurring-input" ${d.recurring ? "checked" : ""}>
                  <label>Repeats yearly</label>
                </div>
              </div>
              <div class="note-actions" style="margin-top:8px;">
                <button data-action="save-date">Save</button>
                <button data-action="cancel-edit-date">Cancel</button>
              </div>
            </div>
          </div>`;
      }

      const days = daysBetween(todayISO(), d._next);
      let meta;
      if (days === 0) meta = "today";
      else if (days === 1) meta = "tomorrow";
      else meta = `in ${days} days · ${fmtDate(d._next)}`;
      const timeLabel = d.time ? formatTime(d.time) : "";
      const fullMeta = [meta, timeLabel, d.recurring ? "yearly" : ""].filter(Boolean).join(" · ");
      return `
        <div class="item" data-id="${d.id}">
          <div class="item-body">
            <div class="item-text">${escapeHtml(d.label)}</div>
            <div class="item-meta">${fullMeta}</div>
          </div>
          <button class="item-edit" data-action="edit-date" aria-label="Edit">&#9998;</button>
          <button class="item-del" data-action="delete-date" aria-label="Delete">&times;</button>
        </div>`;
    }).join("");
  }

  datesList.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const item = btn.closest(".item");
    const id = item.dataset.id;
    const action = btn.dataset.action;

    if (action === "delete-date") {
      state.dates = state.dates.filter((x) => x.id !== id);
      if (editingDateId === id) editingDateId = null;
      saveState();
    } else if (action === "edit-date") {
      editingDateId = id;
      renderDates();
    } else if (action === "cancel-edit-date") {
      editingDateId = null;
      renderDates();
    } else if (action === "save-date") {
      const label = item.querySelector(".edit-text-input").value.trim();
      const dateVal = item.querySelector(".edit-date-input").value;
      const timeVal = item.querySelector(".edit-time-input").value;
      const recurring = item.querySelector(".edit-recurring-input").checked;
      if (label && dateVal) {
        const d = state.dates.find((x) => x.id === id);
        if (d) {
          d.label = label;
          d.date = dateVal;
          d.time = timeVal || null;
          d.recurring = recurring;
        }
      }
      editingDateId = null;
      saveState();
    }
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

  let editingNoteId = null;

  function renderNotes() {
    notesCount.textContent = state.notes.length ? `· ${state.notes.length}` : "";

    if (!state.notes.length) {
      notesList.innerHTML = `<div class="empty">No notes yet.</div>`;
      return;
    }

    notesList.innerHTML = state.notes.map((n) => {
      const d = new Date(n.createdAt);
      const meta = d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

      if (n.id === editingNoteId) {
        return `
          <div class="card note-card" data-id="${n.id}">
            <div class="item-meta">${meta}</div>
            <textarea class="note-input note-edit-input" style="min-height:60px;" enterkeyhint="enter">${escapeHtml(n.text)}</textarea>
            <div class="note-actions">
              <button data-action="save-note">Save</button>
              <button data-action="cancel-edit-note">Cancel</button>
            </div>
          </div>`;
      }

      return `
        <div class="card note-card" data-id="${n.id}">
          <div class="item-meta">${meta}</div>
          <div class="note-text">${escapeHtml(n.text)}</div>
          <div class="note-actions">
            <button data-action="edit-note">Edit</button>
            <button data-action="delete-note">Delete</button>
          </div>
        </div>`;
    }).join("");
  }

  notesList.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const card = btn.closest(".note-card");
    const id = card.dataset.id;

    if (btn.dataset.action === "delete-note") {
      state.notes = state.notes.filter((x) => x.id !== id);
      if (editingNoteId === id) editingNoteId = null;
      saveState();
    } else if (btn.dataset.action === "edit-note") {
      editingNoteId = id;
      renderNotes();
    } else if (btn.dataset.action === "cancel-edit-note") {
      editingNoteId = null;
      renderNotes();
    } else if (btn.dataset.action === "save-note") {
      const textarea = card.querySelector(".note-edit-input");
      const newText = textarea.value.trim();
      if (newText) {
        const note = state.notes.find((x) => x.id === id);
        if (note) note.text = newText;
      }
      editingNoteId = null;
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
        const dayLabel = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
        const timeLabel = d.time ? formatTime(d.time) : "";
        const meta = [dayLabel, timeLabel].filter(Boolean).join(" · ");
        return `<div class="item"><div class="item-body"><div class="item-text">${escapeHtml(d.label)}</div><div class="item-meta">${meta}</div></div></div>`;
      })));
    }

    let html = groups.join("");

    if (!overdue.length && !dueToday.length && !upcomingDates.length) {
      html += `<div class="empty">Nothing pressing today.</div>`;
    }

    if (openShopping) {
      html += `<div class="section-label" style="margin-top:28px;">Things to do <span class="count">· ${openShopping} open</span></div>`;
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

  // ---------- CALENDAR ----------
  // Renders straight from the same state.reminders/state.dates used
  // everywhere else — there is no separate calendar data, so it's always
  // in sync with Today/Lists/Dates and with whatever comes down from
  // GitHub sync.
  const calTitle = document.getElementById("calTitle");
  const calWeekdays = document.getElementById("calWeekdays");
  const calGrid = document.getElementById("calGrid");
  const calAgendaLabel = document.getElementById("calAgendaLabel");
  const calAgenda = document.getElementById("calAgenda");

  let calendarViewDate = new Date();
  calendarViewDate.setDate(1);
  let selectedCalendarDay = todayISO();

  const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  document.getElementById("calPrevBtn").addEventListener("click", () => {
    calendarViewDate.setMonth(calendarViewDate.getMonth() - 1);
    renderCalendar();
  });
  document.getElementById("calNextBtn").addEventListener("click", () => {
    calendarViewDate.setMonth(calendarViewDate.getMonth() + 1);
    renderCalendar();
  });

  function itemsForDay(iso) {
    const [, im, iday] = iso.split("-");
    const reminders = state.reminders.filter((r) => r.date === iso);
    const dates = state.dates.filter((d) => {
      if (d.recurring) {
        const [, m, day] = d.date.split("-");
        return m === im && day === iday;
      }
      return d.date === iso;
    });
    return { reminders, dates };
  }

  function renderCalendar() {
    if (!calWeekdays.childElementCount) {
      calWeekdays.innerHTML = WEEKDAY_LABELS.map((w) => `<span>${w}</span>`).join("");
    }

    const year = calendarViewDate.getFullYear();
    const month = calendarViewDate.getMonth();
    calTitle.textContent = calendarViewDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });

    const firstOfMonth = new Date(year, month, 1);
    const startOffset = firstOfMonth.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();

    const cells = [];
    for (let i = startOffset - 1; i >= 0; i--) {
      cells.push({ date: new Date(year, month - 1, daysInPrevMonth - i), otherMonth: true });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: new Date(year, month, d), otherMonth: false });
    }
    while (cells.length % 7 !== 0) {
      const last = cells[cells.length - 1].date;
      const next = new Date(last);
      next.setDate(next.getDate() + 1);
      cells.push({ date: next, otherMonth: true });
    }

    const t = todayISO();
    calGrid.innerHTML = cells.map(({ date, otherMonth }) => {
      const iso = toLocalISO(date);
      const { reminders, dates } = itemsForDay(iso);
      const classes = ["cal-day"];
      if (otherMonth) classes.push("other-month");
      if (iso === t) classes.push("today");
      if (iso === selectedCalendarDay) classes.push("selected");
      const dots = [];
      if (reminders.length) dots.push(`<span class="cal-dot reminder"></span>`);
      if (dates.length) dots.push(`<span class="cal-dot date"></span>`);
      return `
        <button class="${classes.join(" ")}" data-date="${iso}">
          <span class="num">${date.getDate()}</span>
          <span class="cal-dots">${dots.join("")}</span>
        </button>`;
    }).join("");

    renderCalendarAgenda();
  }

  function renderCalendarAgenda() {
    if (!selectedCalendarDay) {
      calAgendaLabel.textContent = "Tap a day";
      calAgenda.innerHTML = `<div class="empty">Select a day on the calendar.</div>`;
      return;
    }

    const [y, m, d] = selectedCalendarDay.split("-").map(Number);
    calAgendaLabel.textContent = new Date(y, m - 1, d).toLocaleDateString(undefined, {
      weekday: "long", day: "numeric", month: "long",
    });

    const { reminders, dates } = itemsForDay(selectedCalendarDay);
    const rows = [];

    reminders.forEach((r) => {
      const timeLabel = r.time ? formatTime(r.time) : "";
      rows.push(`
        <div class="item ${r.done ? "done" : ""}">
          <div class="item-body">
            <div class="item-text">${escapeHtml(r.text)}</div>
            ${timeLabel ? `<div class="item-meta">${timeLabel}</div>` : ""}
          </div>
        </div>`);
    });

    dates.forEach((dt) => {
      const timeLabel = dt.time ? formatTime(dt.time) : "";
      const meta = [timeLabel, dt.recurring ? "yearly" : ""].filter(Boolean).join(" · ");
      rows.push(`
        <div class="item">
          <div class="item-body">
            <div class="item-text">${escapeHtml(dt.label)}</div>
            ${meta ? `<div class="item-meta">${meta}</div>` : ""}
          </div>
        </div>`);
    });

    calAgenda.innerHTML = rows.length ? rows.join("") : `<div class="empty">Nothing on this day.</div>`;
  }

  calGrid.addEventListener("click", (e) => {
    const btn = e.target.closest(".cal-day");
    if (!btn) return;
    selectedCalendarDay = btn.dataset.date;
    renderCalendar();
  });

  // ---------- escape ----------
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, "&quot;");
  }

  // ---------- render all ----------
  function renderAll() {
    renderReminders();
    renderShopping();
    renderDates();
    renderNotes();
    renderToday();
    renderCalendar();
    autoGrowAllMultilineFields();
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

  document.getElementById("exportDataBtn").addEventListener("click", () => {
    try {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `dispatch-backup-${todayISO()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast("Backup downloaded.");
    } catch (err) {
      console.error(err);
      toast("Couldn't create backup.");
    }
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
