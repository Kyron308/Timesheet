'use strict';

const DB_NAME = 'offline-photo-timesheet';
const DB_VERSION = 1;
const PRESET_EQUIPMENT = [
  'Posi track',
  'Kasandi Truck',
  'Manitou',
  'Small Excavator - 5 tonne Kubota',
  'Small Excavator - Micks',
  '20 Tonne Excavator',
  'Generator - Big',
  'Generator - Small',
  'Poly Welder 315',
  'Poly Welder 500',
  'Poly Welder 630'
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let db;
let entries = [];
let settings = { employee: '', defaultLocation: '' };
let activeDraft = {
  key: 'current',
  startedAt: null,
  photos: [],
  title: '',
  description: '',
  location: '',
  lat: '',
  lng: '',
  equipment: ''
};
let activeTimer = null;
let editPhotos = [];
let currentSheetOverrides = null;
let draftSaveTimer = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('sheets')) d.createObjectStore('sheets', { keyPath: 'weekEnding' });
      if (!d.objectStoreNames.contains('drafts')) d.createObjectStore('drafts', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = 'readonly') {
  return db.transaction(store, mode).objectStore(store);
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = tx(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readwrite').put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readwrite').delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function localDateString(dateOrMs = Date.now()) {
  const d = new Date(dateOrMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localTimeString(dateOrMs = Date.now()) {
  const d = new Date(dateOrMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function parseLocalDate(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(dateString, amount) {
  const d = parseLocalDate(dateString);
  d.setDate(d.getDate() + amount);
  return localDateString(d);
}

function upcomingFriday(dateString = localDateString()) {
  const d = parseLocalDate(dateString);
  const day = d.getDay();
  const delta = (5 - day + 7) % 7;
  d.setDate(d.getDate() + delta);
  return localDateString(d);
}

function formatDate(dateString) {
  if (!dateString) return '';
  const d = parseLocalDate(dateString);
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function timeToMinutes(t) {
  if (!t || !/^\d{2}:\d{2}$/.test(t)) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function entryMinutes(entry) {
  const override = Number(entry.overrideHours);
  if (entry.overrideHours !== '' && Number.isFinite(override) && override >= 0) return Math.round(override * 60);
  let start = timeToMinutes(entry.startTime);
  let finish = timeToMinutes(entry.finishTime);
  if (finish < start) finish += 24 * 60;
  const breakMins = Math.max(0, Number(entry.breakMinutes) || 0);
  return Math.max(0, finish - start - breakMins);
}

function durationClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function durationLabel(minutes) {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function decimalHours(minutes) {
  if (!minutes) return '';
  return (minutes / 60).toFixed(2);
}

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function compressImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return await new Promise(resolve => canvas.toBlob(blob => resolve(blob || file), 'image/jpeg', 0.78));
  } catch {
    return file;
  }
}

async function filesToBlobs(fileList) {
  const files = Array.from(fileList || []).slice(0, 12);
  const blobs = [];
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    blobs.push(await compressImage(f));
  }
  return blobs;
}

function revokeStripUrls(root) {
  $$('.photo-item img', root).forEach(img => {
    const src = img.dataset.blobUrl;
    if (src) URL.revokeObjectURL(src);
  });
}

function renderPhotoStrip(root, photos, removable, onRemove) {
  revokeStripUrls(root);
  root.innerHTML = '';
  photos.forEach((blob, index) => {
    const item = document.createElement('div');
    item.className = 'photo-item';
    const img = document.createElement('img');
    const url = URL.createObjectURL(blob);
    img.src = url;
    img.dataset.blobUrl = url;
    img.alt = `Work photo ${index + 1}`;
    item.appendChild(img);
    if (removable) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'photo-remove';
      btn.setAttribute('aria-label', `Remove photo ${index + 1}`);
      btn.textContent = '×';
      btn.addEventListener('click', () => onRemove(index));
      item.appendChild(btn);
    }
    root.appendChild(item);
  });
}

async function saveDraftNow() {
  syncDraftFromInputs();
  await idbPut('drafts', activeDraft);
  $('#saveStatus').textContent = 'Saved on this iPhone';
}

function queueDraftSave() {
  clearTimeout(draftSaveTimer);
  $('#saveStatus').textContent = 'Saving…';
  draftSaveTimer = setTimeout(() => saveDraftNow().catch(console.error), 250);
}

function syncDraftFromInputs() {
  activeDraft.title = $('#currentTitle').value;
  activeDraft.description = $('#currentDescription').value;
  activeDraft.location = $('#currentLocation').value;
  activeDraft.equipment = $('#currentEquipment').value;
}

function renderCurrentPhotos() {
  renderPhotoStrip($('#currentPhotoStrip'), activeDraft.photos || [], true, async index => {
    activeDraft.photos.splice(index, 1);
    renderCurrentPhotos();
    await saveDraftNow();
  });
}

function syncInputsFromDraft() {
  $('#currentTitle').value = activeDraft.title || '';
  $('#currentDescription').value = activeDraft.description || '';
  $('#currentLocation').value = activeDraft.location || settings.defaultLocation || '';
  $('#currentEquipment').value = activeDraft.equipment || '';
  renderCurrentPhotos();
  updateGpsReadout();
}

function updateGpsReadout() {
  const el = $('#gpsReadout');
  if (activeDraft.lat !== '' && activeDraft.lng !== '') {
    el.textContent = `GPS: ${Number(activeDraft.lat).toFixed(6)}, ${Number(activeDraft.lng).toFixed(6)}`;
  } else {
    el.textContent = 'GPS not saved for this job.';
  }
}

function startActiveJob() {
  if (activeDraft.startedAt) return;
  activeDraft.startedAt = Date.now();
  startTimer();
  queueDraftSave();
}

function startTimer() {
  clearInterval(activeTimer);
  if (!activeDraft.startedAt) {
    $('#liveTimer').textContent = '00:00:00';
    $('#currentStatus').textContent = 'Take a photo or tap Start.';
    $('#startBtn').disabled = false;
    $('#finishBtn').disabled = true;
    $('#cancelBtn').disabled = true;
    return;
  }
  const update = () => {
    $('#liveTimer').textContent = durationClock(Date.now() - activeDraft.startedAt);
  };
  update();
  activeTimer = setInterval(update, 1000);
  const started = new Date(activeDraft.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#currentStatus').textContent = `Started ${started}`;
  $('#startBtn').disabled = true;
  $('#finishBtn').disabled = false;
  $('#cancelBtn').disabled = false;
}

async function clearDraft() {
  clearInterval(activeTimer);
  revokeStripUrls($('#currentPhotoStrip'));
  activeDraft = {
    key: 'current',
    startedAt: null,
    photos: [],
    title: '',
    description: '',
    location: settings.defaultLocation || '',
    lat: '',
    lng: '',
    equipment: ''
  };
  $('#currentPhotos').value = '';
  $('#currentMessage').textContent = '';
  syncInputsFromDraft();
  startTimer();
  await idbPut('drafts', activeDraft);
}

async function finishActiveJob() {
  syncDraftFromInputs();
  const title = activeDraft.title.trim();
  if (!activeDraft.startedAt) {
    $('#currentMessage').textContent = 'Start the job first.';
    return;
  }
  if (!title) {
    $('#currentMessage').textContent = 'Add a title before saving.';
    $('#currentTitle').focus();
    return;
  }
  const end = Date.now();
  const entry = {
    id: uid(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    date: localDateString(activeDraft.startedAt),
    startTime: localTimeString(activeDraft.startedAt),
    finishTime: localTimeString(end),
    breakMinutes: 0,
    overrideHours: '',
    title,
    description: activeDraft.description.trim(),
    location: activeDraft.location.trim(),
    lat: activeDraft.lat,
    lng: activeDraft.lng,
    equipment: activeDraft.equipment.trim(),
    photos: activeDraft.photos || []
  };
  await idbPut('entries', entry);
  entries.push(entry);
  await clearDraft();
  await renderAllEntries();
  $('#currentMessage').textContent = 'Saved.';
}

async function useCurrentGps() {
  const btn = $('#gpsBtn');
  const msg = $('#currentMessage');
  if (!navigator.geolocation) {
    msg.textContent = 'GPS is not available in this browser.';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Getting GPS…';
  msg.textContent = 'Waiting for iPhone location…';
  navigator.geolocation.getCurrentPosition(async pos => {
    activeDraft.lat = Number(pos.coords.latitude);
    activeDraft.lng = Number(pos.coords.longitude);
    updateGpsReadout();
    await saveDraftNow();
    msg.textContent = `GPS saved (accuracy about ${Math.round(pos.coords.accuracy)} m).`;
    btn.disabled = false;
    btn.textContent = 'Use current GPS';
  }, err => {
    msg.textContent = err.code === 1 ? 'Location permission was not allowed.' : 'Could not get GPS. You can still type the location manually.';
    btn.disabled = false;
    btn.textContent = 'Use current GPS';
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
}

function entryCard(entry) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = `entry-card${entry.photos?.length ? '' : ' no-photo'}`;
  card.setAttribute('aria-label', `Edit ${entry.title}`);

  if (entry.photos?.length) {
    const img = document.createElement('img');
    const url = URL.createObjectURL(entry.photos[0]);
    img.src = url;
    img.dataset.blobUrl = url;
    img.className = 'entry-thumb';
    img.alt = '';
    card.appendChild(img);
  }

  const middle = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'entry-title';
  title.textContent = entry.title || 'Untitled';
  const meta = document.createElement('div');
  meta.className = 'entry-meta';
  const bits = [formatDate(entry.date), `${entry.startTime}–${entry.finishTime}`];
  if (entry.location) bits.push(entry.location);
  if (entry.equipment) bits.push(entry.equipment);
  meta.textContent = bits.join(' • ');
  middle.append(title, meta);
  if (entry.description) {
    const desc = document.createElement('div');
    desc.className = 'entry-desc';
    desc.textContent = entry.description;
    middle.appendChild(desc);
  }
  card.appendChild(middle);

  const hours = document.createElement('div');
  hours.className = 'entry-hours';
  hours.textContent = durationLabel(entryMinutes(entry));
  card.appendChild(hours);
  card.addEventListener('click', () => openEdit(entry.id));
  return card;
}

function clearEntryList(root) {
  $$('.entry-card img', root).forEach(img => {
    if (img.dataset.blobUrl) URL.revokeObjectURL(img.dataset.blobUrl);
  });
  root.innerHTML = '';
}

async function renderAllEntries() {
  entries.sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`));
  const today = localDateString();
  $('#todayLabel').textContent = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const todays = entries.filter(e => e.date === today);
  clearEntryList($('#todayEntries'));
  if (!todays.length) {
    const empty = document.createElement('div');
    empty.className = 'card muted';
    empty.textContent = 'No work recorded today.';
    $('#todayEntries').appendChild(empty);
  } else {
    todays.forEach(e => $('#todayEntries').appendChild(entryCard(e)));
  }
  $('#todayTotal').textContent = durationLabel(todays.reduce((n, e) => n + entryMinutes(e), 0));
  renderHistory();
  if ($('#view-sheet').classList.contains('active')) await renderSheet();
}

function renderHistory() {
  const root = $('#historyEntries');
  clearEntryList(root);
  const from = $('#historyFrom').value;
  const to = $('#historyTo').value;
  const filtered = entries.filter(e => (!from || e.date >= from) && (!to || e.date <= to));
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'card muted';
    empty.textContent = 'No entries in this date range.';
    root.appendChild(empty);
    return;
  }
  filtered.forEach(e => root.appendChild(entryCard(e)));
}

async function openEdit(id) {
  const entry = entries.find(e => e.id === id);
  if (!entry) return;
  $('#editId').value = entry.id;
  $('#editDate').value = entry.date || '';
  $('#editStart').value = entry.startTime || '';
  $('#editFinish').value = entry.finishTime || '';
  $('#editBreak').value = Number(entry.breakMinutes) || 0;
  $('#editOverride').value = entry.overrideHours ?? '';
  $('#editTitle').value = entry.title || '';
  $('#editDescription').value = entry.description || '';
  $('#editLocation').value = entry.location || '';
  $('#editLat').value = entry.lat ?? '';
  $('#editLng').value = entry.lng ?? '';
  $('#editEquipment').value = entry.equipment || '';
  $('#editNewPhotos').value = '';
  $('#editMessage').textContent = '';
  editPhotos = [...(entry.photos || [])];
  renderEditPhotos();
  $('#editDialog').showModal();
}

function renderEditPhotos() {
  renderPhotoStrip($('#editPhotoStrip'), editPhotos, true, index => {
    editPhotos.splice(index, 1);
    renderEditPhotos();
  });
}

async function saveEdit(event) {
  event.preventDefault();
  const id = $('#editId').value;
  const entry = entries.find(e => e.id === id);
  if (!entry) return;
  const title = $('#editTitle').value.trim();
  if (!title) {
    $('#editMessage').textContent = 'Title is required.';
    return;
  }
  const updated = {
    ...entry,
    updatedAt: Date.now(),
    date: $('#editDate').value,
    startTime: $('#editStart').value,
    finishTime: $('#editFinish').value,
    breakMinutes: Math.max(0, Number($('#editBreak').value) || 0),
    overrideHours: $('#editOverride').value === '' ? '' : Math.max(0, Number($('#editOverride').value) || 0),
    title,
    description: $('#editDescription').value.trim(),
    location: $('#editLocation').value.trim(),
    lat: $('#editLat').value === '' ? '' : Number($('#editLat').value),
    lng: $('#editLng').value === '' ? '' : Number($('#editLng').value),
    equipment: $('#editEquipment').value.trim(),
    photos: editPhotos
  };
  await idbPut('entries', updated);
  const idx = entries.findIndex(e => e.id === id);
  entries[idx] = updated;
  $('#editDialog').close();
  await renderAllEntries();
}

async function deleteEditedEntry() {
  const id = $('#editId').value;
  const entry = entries.find(e => e.id === id);
  if (!entry) return;
  if (!confirm(`Delete “${entry.title}”?`)) return;
  await idbDelete('entries', id);
  entries = entries.filter(e => e.id !== id);
  $('#editDialog').close();
  await renderAllEntries();
}

function weekDates(weekEnding) {
  return [-4, -3, -2, -1, 0].map(delta => addDays(weekEnding, delta));
}

function createCell(text = '', key = '', opts = {}) {
  const td = document.createElement(opts.header ? 'th' : 'td');
  td.textContent = text;
  if (opts.className) td.className = opts.className;
  if (opts.editable !== false) {
    td.contentEditable = 'true';
    td.classList.add('editable');
    if (key) td.dataset.cellKey = key;
  }
  return td;
}

function appendDataRow(tbody, label, notes, values, keyBase, totalText = '', className = '') {
  const tr = document.createElement('tr');
  if (className) tr.className = className;
  tr.appendChild(createCell(label, `${keyBase}-label`));
  tr.appendChild(createCell(notes, `${keyBase}-notes`));
  values.forEach((v, i) => tr.appendChild(createCell(v, `${keyBase}-d${i}`)));
  tr.appendChild(createCell(totalText, `${keyBase}-total`));
  tbody.appendChild(tr);
}

function sheetEntriesForWeek(weekEnding) {
  const dates = weekDates(weekEnding);
  const set = new Set(dates);
  return entries.filter(e => set.has(e.date));
}

async function renderSheet(ignoreOverrides = false) {
  const weekEnding = $('#weekEnding').value || upcomingFriday();
  const week = sheetEntriesForWeek(weekEnding);
  const dates = weekDates(weekEnding);
  const tbody = $('#timesheetBody');
  tbody.innerHTML = '';
  $('#sheetEmployee').textContent = $('#employeeName').value || settings.employee || 'Employee';
  $('#sheetEmployee').dataset.cellKey = 'employee';

  const daily = dates.map(date => week.filter(e => e.date === date));
  const starts = daily.map(list => list.length ? list.map(e => e.startTime).sort()[0] : '');
  const finishes = daily.map(list => list.length ? list.map(e => e.finishTime).sort().slice(-1)[0] : '');
  const breaks = daily.map(list => list.reduce((n, e) => n + (Number(e.breakMinutes) || 0), 0));
  const totals = daily.map(list => list.reduce((n, e) => n + entryMinutes(e), 0));

  appendDataRow(tbody, 'START', '', starts, 'start', '');
  appendDataRow(tbody, 'FINISH', '', finishes, 'finish', '');
  appendDataRow(tbody, 'TIME OFF', '', breaks.map(m => m ? `${m} min` : ''), 'timeoff', breaks.reduce((a, b) => a + b, 0) ? `${breaks.reduce((a,b)=>a+b,0)} min` : '');
  appendDataRow(tbody, 'TOTAL', '', totals.map(decimalHours), 'daily-total', decimalHours(totals.reduce((a,b)=>a+b,0)), 'total-row');

  const taskHead = document.createElement('tr');
  taskHead.className = 'section-row';
  ['WEEKS PLANNED TASKS', 'NOTES', 'HRS', 'HRS', 'HRS', 'HRS', 'HRS', 'TOTAL'].forEach(text => taskHead.appendChild(createCell(text, '', { editable: false })));
  tbody.appendChild(taskHead);

  const grouped = new Map();
  week.forEach(e => {
    const key = e.title || 'General work';
    if (!grouped.has(key)) grouped.set(key, { notes: new Set(), vals: [0,0,0,0,0] });
    const g = grouped.get(key);
    const idx = dates.indexOf(e.date);
    if (idx >= 0) g.vals[idx] += entryMinutes(e);
    const noteBits = [];
    if (e.description) noteBits.push(e.description);
    if (e.location) noteBits.push(`Location: ${e.location}`);
    if (noteBits.length) g.notes.add(noteBits.join(' — '));
  });
  const tasks = Array.from(grouped.entries());
  const minTaskRows = 10;
  for (let i = 0; i < Math.max(minTaskRows, tasks.length); i++) {
    if (tasks[i]) {
      const [label, g] = tasks[i];
      appendDataRow(tbody, label, Array.from(g.notes).join('; '), g.vals.map(decimalHours), `task-${i}`, decimalHours(g.vals.reduce((a,b)=>a+b,0)));
    } else {
      appendDataRow(tbody, '', '', ['', '', '', '', ''], `task-${i}`, '');
    }
  }

  const machineHead = document.createElement('tr');
  machineHead.className = 'section-row';
  ['MACHINERY & EQUIPMENT HIRE', 'INFO TO RECORD FOR EACH DAY USED', '', '', '', '', '', ''].forEach(text => machineHead.appendChild(createCell(text, '', { editable: false })));
  tbody.appendChild(machineHead);

  const usedCustom = Array.from(new Set(week.map(e => e.equipment).filter(Boolean).filter(e => !PRESET_EQUIPMENT.includes(e))));
  const machineRows = [...PRESET_EQUIPMENT, ...usedCustom];
  machineRows.forEach((machine, rowIndex) => {
    const vals = dates.map(date => {
      const items = week.filter(e => e.date === date && e.equipment === machine);
      if (!items.length) return '';
      return decimalHours(items.reduce((n, e) => n + entryMinutes(e), 0));
    });
    appendDataRow(tbody, machine, '', vals, `machine-${rowIndex}`, decimalHours(vals.reduce((n, v) => n + (Number(v) || 0), 0)));
  });

  const grand = totals.reduce((a, b) => a + b, 0);
  appendDataRow(tbody, 'TOTALS', '', totals.map(decimalHours), 'bottom-total', decimalHours(grand), 'total-row');

  currentSheetOverrides = ignoreOverrides ? null : await idbGet('sheets', weekEnding);
  if (currentSheetOverrides?.cells) applySheetOverrides(currentSheetOverrides.cells);
}

function captureSheetCells() {
  const cells = {};
  $$('[data-cell-key]', $('#timesheetPrint')).forEach(cell => {
    cells[cell.dataset.cellKey] = cell.textContent;
  });
  return cells;
}

function applySheetOverrides(cells) {
  Object.entries(cells || {}).forEach(([key, value]) => {
    const cell = $(`[data-cell-key="${CSS.escape(key)}"]`, $('#timesheetPrint'));
    if (cell) cell.textContent = value;
  });
}

async function saveSheetEdits() {
  const weekEnding = $('#weekEnding').value;
  if (!weekEnding) return;
  const cells = captureSheetCells();
  await idbPut('sheets', { weekEnding, cells, updatedAt: Date.now() });
  currentSheetOverrides = { weekEnding, cells };
  $('#saveStatus').textContent = 'Weekly sheet edits saved';
}

async function resetSheetFromEntries() {
  const weekEnding = $('#weekEnding').value;
  if (!weekEnding) return;
  if (confirm('Reset this weekly sheet from saved work entries? Any direct edits to the sheet will be cleared.')) {
    await idbDelete('sheets', weekEnding);
    await renderSheet(true);
  }
}

function setView(name) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $$('.tab').forEach(t => t.classList.remove('active'));
  $(`#view-${name}`).classList.add('active');
  $(`.tab[data-view="${name}"]`).classList.add('active');
  if (name === 'history') renderHistory();
  if (name === 'sheet') renderSheet().catch(console.error);
}

function updateOnlineBadge() {
  const badge = $('#offlineBadge');
  if (navigator.onLine) {
    badge.textContent = 'Online • offline ready';
    badge.classList.add('online');
  } else {
    badge.textContent = 'Offline';
    badge.classList.remove('online');
  }
}

async function loadSettings() {
  const rec = await idbGet('settings', 'main');
  if (rec) settings = { employee: rec.employee || '', defaultLocation: rec.defaultLocation || '' };
  $('#employeeName').value = settings.employee || '';
  $('#settingsEmployee').value = settings.employee || '';
  $('#settingsDefaultLocation').value = settings.defaultLocation || '';
}

async function saveSettings(event) {
  event.preventDefault();
  settings = {
    employee: $('#settingsEmployee').value.trim(),
    defaultLocation: $('#settingsDefaultLocation').value.trim()
  };
  await idbPut('settings', { key: 'main', ...settings });
  $('#employeeName').value = settings.employee;
  if (!activeDraft.location) {
    activeDraft.location = settings.defaultLocation;
    $('#currentLocation').value = activeDraft.location;
    await saveDraftNow();
  }
  $('#settingsDialog').close();
  await renderSheet();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [meta, data] = dataUrl.split(',');
  const mime = /data:(.*?);base64/.exec(meta)?.[1] || 'application/octet-stream';
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function exportBackup() {
  $('#saveStatus').textContent = 'Preparing backup…';
  const sheets = await idbGetAll('sheets');
  const outEntries = [];
  for (const e of entries) {
    const photos = [];
    for (const p of (e.photos || [])) photos.push(await blobToDataUrl(p));
    outEntries.push({ ...e, photos });
  }
  const data = {
    format: 'offline-photo-timesheet-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    entries: outEntries,
    sheets
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `timesheet-backup-${localDateString()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  $('#saveStatus').textContent = 'Backup exported';
}

async function importBackup(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (data.format !== 'offline-photo-timesheet-backup' || !Array.isArray(data.entries)) throw new Error('Not a valid timesheet backup');
  if (!confirm(`Import ${data.entries.length} entries? Existing entries with the same IDs will be replaced.`)) return;
  for (const raw of data.entries) {
    const photos = (raw.photos || []).map(dataUrlToBlob);
    await idbPut('entries', { ...raw, photos });
  }
  if (data.settings) {
    settings = { employee: data.settings.employee || '', defaultLocation: data.settings.defaultLocation || '' };
    await idbPut('settings', { key: 'main', ...settings });
  }
  for (const sheet of (data.sheets || [])) await idbPut('sheets', sheet);
  entries = await idbGetAll('entries');
  await loadSettings();
  await renderAllEntries();
  $('#settingsDialog').close();
  $('#saveStatus').textContent = 'Backup imported';
}

async function init() {
  db = await openDb();
  await loadSettings();
  entries = await idbGetAll('entries');
  const draft = await idbGet('drafts', 'current');
  if (draft) activeDraft = { ...activeDraft, ...draft, photos: draft.photos || [] };
  else activeDraft.location = settings.defaultLocation || '';

  $('#weekEnding').value = upcomingFriday();
  syncInputsFromDraft();
  startTimer();
  await renderAllEntries();
  updateOnlineBadge();

  window.addEventListener('online', updateOnlineBadge);
  window.addEventListener('offline', updateOnlineBadge);

  $$('.tab').forEach(tab => tab.addEventListener('click', () => setView(tab.dataset.view)));
  $('#startBtn').addEventListener('click', startActiveJob);
  $('#finishBtn').addEventListener('click', () => finishActiveJob().catch(console.error));
  $('#cancelBtn').addEventListener('click', () => {
    if (confirm('Cancel the current job? The unsaved draft and its photos will be cleared.')) clearDraft().catch(console.error);
  });
  $('#gpsBtn').addEventListener('click', useCurrentGps);

  ['currentTitle', 'currentDescription', 'currentLocation', 'currentEquipment'].forEach(id => {
    $(`#${id}`).addEventListener('input', queueDraftSave);
  });

  $('#currentPhotos').addEventListener('change', async event => {
    const newPhotos = await filesToBlobs(event.target.files);
    if (newPhotos.length) {
      activeDraft.photos.push(...newPhotos);
      renderCurrentPhotos();
      if (!activeDraft.startedAt) startActiveJob();
      await saveDraftNow();
    }
    event.target.value = '';
  });

  $('#historyFrom').addEventListener('change', renderHistory);
  $('#historyTo').addEventListener('change', renderHistory);
  $('#clearHistoryFilter').addEventListener('click', () => {
    $('#historyFrom').value = '';
    $('#historyTo').value = '';
    renderHistory();
  });

  $('#editForm').addEventListener('submit', saveEdit);
  $('#closeEditBtn').addEventListener('click', () => $('#editDialog').close());
  $('#cancelEditBtn').addEventListener('click', () => $('#editDialog').close());
  $('#deleteEntryBtn').addEventListener('click', () => deleteEditedEntry().catch(console.error));
  $('#editNewPhotos').addEventListener('change', async event => {
    const blobs = await filesToBlobs(event.target.files);
    editPhotos.push(...blobs);
    renderEditPhotos();
    event.target.value = '';
  });

  $('#weekEnding').addEventListener('change', () => renderSheet().catch(console.error));
  $('#employeeName').addEventListener('input', () => {
    $('#sheetEmployee').textContent = $('#employeeName').value || 'Employee';
  });
  $('#refreshSheetBtn').addEventListener('click', () => resetSheetFromEntries().catch(console.error));
  $('#saveSheetEditsBtn').addEventListener('click', () => saveSheetEdits().catch(console.error));
  $('#printBtn').addEventListener('click', async () => {
    await saveSheetEdits();
    window.print();
  });

  $('#openSettingsBtn').addEventListener('click', () => {
    $('#settingsEmployee').value = settings.employee || '';
    $('#settingsDefaultLocation').value = settings.defaultLocation || '';
    $('#settingsDialog').showModal();
  });
  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#closeSettingsBtn').addEventListener('click', () => $('#settingsDialog').close());
  $('#exportBtn').addEventListener('click', () => exportBackup().catch(err => alert(err.message)));
  $('#importFile').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { await importBackup(file); }
    catch (err) { alert(`Import failed: ${err.message}`); }
    event.target.value = '';
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('Service worker registration failed', err));
  }
}

init().catch(err => {
  console.error(err);
  alert('The timesheet app could not start. Try closing and reopening it.');
});
