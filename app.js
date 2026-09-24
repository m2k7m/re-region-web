/* Re-region Saves — 100% front-end.
 *
 * Flow: upload zipped DECRYPTED save -> find + parse param.sfo
 * (same parser as htos-web/templates/tools_sfo_viewer.html) ->
 * look up current region in titles.db via sql.js -> offer sibling
 * TitleIDs (same concept_id) with region flags -> patch TITLE_ID
 * (+ SAVEDATA_DIRECTORY special cases, mirroring
 * htos-web/utils/orbis.py::reregion_write) -> re-zip -> download.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const dropZip = $('drop-zip');
const fileInput = $('file-input');
const fileSelected = $('file-selected');
const btnAnalyze = $('btn-analyze');
const regionStep = $('region-step');
const currentInfo = $('current-info');
const titleInput = $('title-input');
const suggestList = $('suggest-list');
const targetMeta = $('target-meta');
const targetFlag = $('target-flag');
const patchNote = $('patch-note');
const btnReregion = $('btn-reregion');
const statusEl = $('status');

const TE = new TextEncoder();
const TD = new TextDecoder();

// Region -> SVG flag file in SVGs/ (allowlist; unknown regions get no image).
const REGION_SVG = { US: 'US', EU: 'EU', JP: 'JP', AS: 'AS', KR: 'KR', Internal: 'IP' };
const flagImg = (r) => REGION_SVG[r]
  ? `<img class="flag" src="SVGs/${REGION_SVG[r]}.svg" alt="${r} flag">`
  : '';

// Special-case SAVEDATA_DIRECTORY rules (mirror utils/orbis.py + constants.py)
const XENO2 = new Set(['CUSA05350', 'CUSA05088', 'CUSA04904', 'CUSA05085', 'CUSA05774']);
const MGSV_NAMES = {
  CUSA01140: 'MGSVTPPSaveDataNA', CUSA01154: 'MGSVTPPSaveDataEU', CUSA01099: 'MGSVTPPSaveDataJP',
  CUSA00218: 'MGSVGZSaveDataNA', CUSA00211: 'MGSVGZSaveDataEU', CUSA00225: 'MGSVGZSaveDataJP',
};
const MINECRAFT = new Set([
  'CUSA17401', 'CUSA20050', 'CUSA17472', 'CUSA19622', 'CUSA17382',
  'CUSA00744', 'CUSA00265', 'CUSA00283', 'CUSA02169', 'CUSA17908',
]);

let SQL = null;      // sql.js instance
let db = null;       // titles.db
let zipFile = null;  // uploaded File
let zip = null;      // loaded JSZip
let sfoPaths = [];   // zip paths of param.sfo files
let sfoList = [];    // parsed SFOs: { path, buf, entries, fields }
let currentTitleId = '';
let currentRow = null;
let siblingRows = [];

function setStatus(kind, msg) {
  if (!msg) { statusEl.hidden = true; statusEl.textContent = ''; return; }
  statusEl.hidden = false;
  statusEl.className = 'status ' + kind;
  statusEl.innerHTML = msg;
}
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

/* ── SFO parsing (ported from tools_sfo_viewer.html) ── */
const FMT_UTF8 = 0x0204, FMT_INT = 0x0404;

function parseSfo(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 20 || dv.getUint32(0, false) !== 0x00505346) return null;
  const keyOff = dv.getUint32(8, true);
  const dataOff = dv.getUint32(12, true);
  const count = dv.getUint32(16, true);
  if (20 + count * 16 > buf.byteLength) return null;

  const entries = [];
  for (let i = 0; i < count; i++) {
    const base = 20 + i * 16;
    const kOff = dv.getUint16(base, true);
    const fmt = dv.getUint16(base + 2, true);
    const usedLen = dv.getUint32(base + 4, true);
    const maxLen = dv.getUint32(base + 8, true);
    const dOff = dv.getUint32(base + 12, true);

    let key = '';
    for (let j = keyOff + kOff; j < buf.byteLength; j++) {
      const c = dv.getUint8(j);
      if (c === 0) break;
      key += String.fromCharCode(c);
    }

    const raw = new Uint8Array(buf, dataOff + dOff, maxLen);
    let value = '', display = '';
    if (fmt === FMT_UTF8) {
      const end = raw.indexOf(0) < 0 ? usedLen : Math.min(raw.indexOf(0), usedLen);
      value = TD.decode(raw.subarray(0, end));
      display = value;
    } else if (fmt === FMT_INT) {
      value = dv.getUint32(dataOff + dOff, true);
      display = String(value);
    } else {
      display = Array.from(raw.subarray(0, usedLen))
        .map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      value = display;
    }
    // Keep a private copy of the full-width field bytes for the patcher.
    // indexPos/dataPos allow byte-exact in-place patching (see buildSfo).
    entries.push({
      key, fmt, usedLen, maxLen, fieldWidth: maxLen,
      valueBytes: raw.slice(), value, display,
      indexPos: base, dataPos: dataOff + dOff, dirty: false,
    });
  }
  const fields = {};
  for (const e of entries) fields[e.key] = e.value;
  return { entries, fields };
}

/* ── SFO patcher — byte-exact in-place update.
 *
 * Deliberately NOT a full re-serializer: the backend's SFOContext.sfo_write
 * has a latent off-by-one (its key-table padding line
 * `key_table_size += (sfo_size + 7) & ~7 - sfo_size` parses as
 * `x & ~(x)` = 0 due to operator precedence, so `data_table_offset`
 * lands 1 byte past the buffer on real files like Bloodborne's and
 * struct.pack_into raises). Since our patches never change field widths,
 * we keep the original header/offsets/size and only overwrite the patched
 * params' value bytes (zero-padded to the existing width) and their
 * used-length index field. Output is byte-identical except for the patch.
 */
function buildSfo(entries, originalBuf) {
  const out = new Uint8Array(originalBuf.slice(0));
  const dv = new DataView(out.buffer);
  for (const e of entries) {
    if (!e.dirty) continue;
    dv.setUint32(e.indexPos + 4, e.usedLen, true);
    const v = e.valueBytes.length > e.fieldWidth
      ? e.valueBytes.subarray(0, e.fieldWidth)
      : e.valueBytes;
    out.set(v, e.dataPos);
    // Zero any tail bytes of the field beyond the value (clean padding).
    if (v.length < e.fieldWidth) out.fill(0, e.dataPos + v.length, e.dataPos + e.fieldWidth);
  }
  return out.buffer;
}

function patchStringParam(entry, str) {
  const enc = TE.encode(str);
  // Backend (utf_8 CHARACTER type) requires room for the null terminator.
  if (enc.length + 1 > entry.maxLen) {
    throw new Error(`${entry.key}: "${str}" needs ${enc.length + 1} bytes, max is ${entry.maxLen}.`);
  }
  const v = new Uint8Array(entry.fieldWidth);
  v.set(enc);
  entry.valueBytes = v;
  entry.usedLen = enc.length + 1;
  entry.value = str;
  entry.display = str;
  entry.dirty = true;
}

/** Compute the SAVEDATA_DIRECTORY for the target ID (null = leave unchanged). */
function savedirFor(targetId, currentSavedir) {
  if (XENO2.has(targetId)) return targetId + '01';
  if (MGSV_NAMES[targetId]) return MGSV_NAMES[targetId];
  if (MINECRAFT.has(targetId) && currentSavedir) {
    const parts = currentSavedir.split('-');
    if (MINECRAFT.has(parts[0])) { parts[0] = targetId; return parts.join('-'); }
  }
  return null;
}

/* ── titles.db via sql.js ── */
async function ensureDb() {
  if (db) return db;
  if (!SQL) {
    SQL = await initSqlJs({
      locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${f}`,
    });
  }
  const res = await fetch('titles.db');
  if (!res.ok) throw new Error('Could not load titles.db (serve over HTTP, not file://).');
  db = new SQL.Database(new Uint8Array(await res.arrayBuffer()));
  return db;
}

function lookupTitle(d, titleId) {
  const stmt = d.prepare('SELECT title_id, name, platform, region, concept_id FROM titles WHERE title_id = ? LIMIT 1');
  try {
    stmt.bind([titleId.toUpperCase()]);
    return stmt.step() ? stmt.getAsObject() : null;
  } finally { stmt.free(); }
}

function siblingTitles(d, row) {
  let stmt;
  if (row.concept_id != null) {
    stmt = d.prepare(
      'SELECT title_id, name, platform, region FROM titles WHERE concept_id = ? AND title_id != ? ORDER BY region, title_id'
    );
    stmt.bind([row.concept_id, row.title_id]);
  } else {
    // Fallback for rows without concept_id: group by exact name.
    stmt = d.prepare(
      'SELECT title_id, name, platform, region FROM titles WHERE name = ? AND title_id != ? ORDER BY region, title_id LIMIT 50'
    );
    stmt.bind([row.name, row.title_id]);
  }
  try {
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    return out;
  } finally { stmt.free(); }
}

function detectPlatform(fields, titleId) {
  const fmt = fields.FORMAT || '';
  if (fmt === 'ppr') return 'PS5';
  if (fmt === 'obs') return 'PS4';
  const p = (titleId || '').substring(0, 4).toUpperCase();
  if (p === 'PPSA') return 'PS5';
  if (p === 'CUSA') return 'PS4';
  return p || '—';
}

/* ── Upload box wiring (same feel as resign.html) ── */
dropZip.addEventListener('click', (e) => { if (e.target !== fileInput) fileInput.click(); });
dropZip.addEventListener('dragover', (e) => { e.preventDefault(); dropZip.classList.add('dragover'); });
dropZip.addEventListener('dragleave', (e) => { if (!dropZip.contains(e.relatedTarget)) dropZip.classList.remove('dragover'); });
dropZip.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZip.classList.remove('dragover');
  if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) setFile(fileInput.files[0]); });

function setFile(f) {
  resetAll();
  zipFile = f;
  fileSelected.textContent = f.name;
  dropZip.style.borderColor = 'var(--cyan)';
  dropZip.style.borderStyle = 'solid';
  setTimeout(() => { dropZip.style.borderColor = ''; dropZip.style.borderStyle = ''; }, 800);
  btnAnalyze.disabled = !/\.zip$/i.test(f.name);
  if (btnAnalyze.disabled) setStatus('error', 'Please choose a <strong>.zip</strong> file (decrypted save).');
}

function resetAll() {
  regionStep.hidden = true;
  currentInfo.innerHTML = '';
  titleInput.value = '';
  suggestList.innerHTML = '';
  suggestList.hidden = true;
  targetMeta.hidden = true;
  targetMeta.textContent = '';
  targetMeta.className = 'hint';
  patchNote.hidden = true;
  btnReregion.disabled = true;
  sfoPaths = []; sfoList = [];
  currentTitleId = ''; currentRow = null; siblingRows = [];
  targetFlag.hidden = true;
  targetFlag.removeAttribute('src');
  setStatus(null);
}

btnAnalyze.addEventListener('click', analyze);

/* ── Target combobox: typable input + SVG suggestions ── */
let activeSug = -1;
let lastFiltered = [];

const typedTargetId = () => titleInput.value.trim().toUpperCase();

function filteredSibs(q) {
  q = (q || '').trim().toUpperCase();
  if (!q) return siblingRows;
  return siblingRows.filter((s) =>
    s.title_id.toUpperCase().includes(q) || (s.name || '').toUpperCase().includes(q));
}

function renderSuggestions(q) {
  activeSug = -1;
  if (!siblingRows.length) { suggestList.hidden = true; return; }
  lastFiltered = filteredSibs(q);
  suggestList.innerHTML = lastFiltered.length
    ? lastFiltered.map((s, i) =>
        `<li class="suggest-item" data-i="${i}">${flagImg(s.region)}<span class="sug-id">${esc(s.title_id)}</span><span class="sug-name">${esc(s.name)}</span></li>`).join('')
    : '<li class="suggest-empty">No matching suggestions — you can still type a valid ID manually.</li>';
  suggestList.hidden = false;
}

function setTargetFlag(region) {
  if (region && REGION_SVG[region]) {
    targetFlag.src = `SVGs/${REGION_SVG[region]}.svg`;
    targetFlag.alt = `${region} flag`;
    targetFlag.hidden = false;
  } else {
    targetFlag.hidden = true;
    targetFlag.removeAttribute('src');
  }
}

function showMeta(html, isWarn) {
  targetMeta.innerHTML = html;
  targetMeta.className = 'hint' + (isWarn ? ' warn' : '');
  targetMeta.hidden = false;
}

function validateTarget() {
  const tid = typedTargetId();
  btnReregion.disabled = true;
  setTargetFlag(null);
  if (!tid) { targetMeta.hidden = true; return; }
  if (!/^(CUSA|PPSA)\d{5}$/.test(tid)) {
    showMeta(`“${esc(tid)}” is not a valid ID — expected CUSA/PPSA + 5 digits.`, false);
    return;
  }
  const prefix = (currentTitleId || '').substring(0, 4).toUpperCase();
  if (!prefix || tid.substring(0, 4) !== prefix) {
    showMeta(`Stays in the ${esc(prefix || 'same')} family — the save won't load otherwise.`, false);
    return;
  }
  if (tid === currentTitleId) {
    showMeta('That is the current region already.', false);
    return;
  }
  let row = null;
  try { row = db ? lookupTitle(db, tid) : null; } catch { row = null; }
  if (row) {
    setTargetFlag(row.region);
    showMeta(`${flagImg(row.region)} ${esc(row.name)}`, false);
  } else {
    showMeta('Not in titles.db — region unknown. Patch at your own risk.', true);
  }
  btnReregion.disabled = false;
}

titleInput.addEventListener('input', () => { renderSuggestions(titleInput.value); validateTarget(); });
titleInput.addEventListener('focus', () => renderSuggestions(titleInput.value));
titleInput.addEventListener('keydown', (e) => {
  const items = [...suggestList.querySelectorAll('.suggest-item')];
  if (e.key === 'Escape') { suggestList.hidden = true; return; }
  if (suggestList.hidden || !items.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    activeSug = e.key === 'ArrowDown'
      ? (activeSug + 1) % items.length
      : (activeSug - 1 + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle('active', i === activeSug));
    items[activeSug].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && activeSug >= 0 && items[activeSug]) {
    e.preventDefault();
    titleInput.value = lastFiltered[activeSug].title_id;
    suggestList.hidden = true;
    validateTarget();
  }
});
suggestList.addEventListener('click', (e) => {
  const li = e.target.closest('.suggest-item');
  if (!li || lastFiltered[+li.dataset.i] === undefined) return;
  titleInput.value = lastFiltered[+li.dataset.i].title_id;
  suggestList.hidden = true;
  validateTarget();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.combo-wrap')) suggestList.hidden = true;
});
btnReregion.addEventListener('click', reregion);

async function analyze() {
  if (!zipFile) return;
  btnAnalyze.disabled = true;
  setStatus('info', 'Reading zip…');
  try {
    const d = await ensureDb();
    zip = await JSZip.loadAsync(zipFile);
    sfoPaths = Object.keys(zip.files).filter(
      (p) => !zip.files[p].dir && /(^|\/)param\.sfo$/i.test(p)
    );
    if (!sfoPaths.length) throw new Error('No <strong>param.sfo</strong> found in this zip. Is it a decrypted save?');

    sfoList = [];
    for (const p of sfoPaths) {
      const buf = await zip.files[p].async('arraybuffer');
      const sfo = parseSfo(buf);
      if (!sfo) throw new Error(`<strong>${esc(p)}</strong> is not a valid param.sfo (bad magic).`);
      sfoList.push({ path: p, buf, entries: sfo.entries, fields: sfo.fields });
    }

    const ids = [...new Set(sfoList.map((s) => s.fields.TITLE_ID).filter(Boolean))];
    if (!ids.length) throw new Error('No <strong>TITLE_ID</strong> found in param.sfo.');
    if (ids.length > 1) throw new Error(`Multiple TitleIDs in one zip (${esc(ids.join(', '))}) — re-region one save at a time.`);
    currentTitleId = ids[0];

    currentRow = lookupTitle(d, currentTitleId);
    const sfo0 = sfoList[0];
    const platform = detectPlatform(sfo0.fields, currentTitleId);
    const region = currentRow ? (currentRow.region || 'unknown') : 'unknown';
    const game = currentRow ? currentRow.name : (sfo0.fields.MAINTITLE || sfo0.fields.TITLE || 'Unknown game');

    if (!currentRow) {
      setStatus('error', `<strong>${esc(currentTitleId)}</strong> is not in titles.db — cannot offer target regions.`);
      return;
    }

    currentInfo.innerHTML =
      `<div class="row"><span class="k">Game</span><span class="v">${esc(game)}</span></div>` +
      `<div class="row"><span class="k">Current</span><span class="v mono">${esc(currentTitleId)} ${flagImg(region)} · ${esc(platform)}</span></div>` +
      (sfoPaths.length > 1 ? `<div class="row"><span class="k">Files</span><span class="v">${sfoPaths.length} param.sfo files (all will be patched)</span></div>` : '');

    // Sibling TitleIDs = same game, other regions. Keep the same prefix family
    // (CUSA stays CUSA, PPSA stays PPSA) so the save stays loadable.
    const prefix = currentTitleId.substring(0, 4).toUpperCase();
    const sibs = siblingTitles(d, currentRow).filter((s) => s.title_id.substring(0, 4).toUpperCase() === prefix);
    if (!sibs.length) throw new Error(`No other-region TitleIDs found for <strong>${esc(game)}</strong> (${esc(prefix)} family).`);

    // Suggestions + free typing (the list shows SVG flags; the input
    // accepts any same-family ID, known or not).
    siblingRows = sibs;
    titleInput.value = '';
    renderSuggestions('');
    validateTarget();

    regionStep.hidden = false;
    setStatus('ok', `Detected <strong>${esc(currentTitleId)}</strong> ${flagImg(region)}. Type the target TitleID or pick a suggestion below.`);
  } catch (err) {
    setStatus('error', err.message);
  } finally {
    btnAnalyze.disabled = false;
  }
}

async function reregion() {
  const targetId = typedTargetId();
  if (!targetId || !sfoList.length) return;
  btnReregion.disabled = true;
  setStatus('info', `Patching to <strong>${esc(targetId)}</strong>…`);
  try {
    let savedirNote = '';
    let mgsv = false;
    for (const s of sfoList) {
      const entries = s.entries;
      const titleParam = entries.find((e) => e.key === 'TITLE_ID');
      if (!titleParam) throw new Error(`No TITLE_ID param in <strong>${esc(s.path)}</strong>.`);
      patchStringParam(titleParam, targetId);

      const newSavedir = savedirFor(targetId, s.fields.SAVEDATA_DIRECTORY);
      if (newSavedir && newSavedir !== s.fields.SAVEDATA_DIRECTORY) {
        const sdParam = entries.find((e) => e.key === 'SAVEDATA_DIRECTORY');
        if (sdParam) {
          patchStringParam(sdParam, newSavedir);
          savedirNote = ` SAVEDATA_DIRECTORY → <strong>${esc(newSavedir)}</strong>.`;
        }
      }
      if (MGSV_NAMES[targetId]) mgsv = true;
      zip.file(s.path, buildSfo(s.entries, s.buf));
    }

    patchNote.hidden = false;
    patchNote.className = 'hint' + (mgsv ? ' warn' : '');
    patchNote.innerHTML = mgsv
      ? '⚠️ MGSV: SFO strings patched, but the save-data crypt re-key needs the full backend (encrypted sample save). This zip alone may not load.'
      : `Patched ${sfoPaths.length} param.sfo file(s).${savedirNote || ' SAVEDATA_DIRECTORY unchanged (not needed for this game).'}`;

    const base = zipFile.name.replace(/\.zip$/i, '');
    const outName = `${base}_to_${targetId}.zip`;
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = outName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);

    setStatus('ok', `Done — downloading <strong>${esc(outName)}</strong>.`);
  } catch (err) {
    setStatus('error', err.message);
  } finally {
    btnReregion.disabled = false;
  }
}
