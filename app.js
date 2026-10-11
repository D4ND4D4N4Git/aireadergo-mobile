/* AIReaderGO モバイル版（iPhone・iPad）
 * 本の内容はこのプログラムに含まない。原本 PDF・問答データ・音声・動画は
 * 利用者が「ファイル」アプリから取り込み、端末の中（IndexedDB）に保存する。
 */
'use strict';
const APP_VERSION = '0.1.1';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
marked.setOptions({ mangle: false, headerIds: false });

// ───────── 保存（IndexedDB） ─────────
const DB = {
  db: null,
  open() {
    return new Promise((ok, ng) => {
      const r = indexedDB.open('aireadergo', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => { this.db = r.result; ok(); };
      r.onerror = () => ng(r.error);
    });
  },
  get(k) {
    return new Promise((ok, ng) => {
      const r = this.db.transaction('files').objectStore('files').get(k);
      r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error);
    });
  },
  put(k, v) {
    return new Promise((ok, ng) => {
      const t = this.db.transaction('files', 'readwrite');
      t.objectStore('files').put(v, k);
      t.oncomplete = () => ok(); t.onerror = () => ng(t.error); t.onabort = () => ng(t.error);
    });
  },
  del(k) {
    return new Promise((ok, ng) => {
      const t = this.db.transaction('files', 'readwrite');
      t.objectStore('files').delete(k);
      t.oncomplete = () => ok(); t.onerror = () => ng(t.error);
    });
  },
  keys() {
    return new Promise((ok, ng) => {
      const r = this.db.transaction('files').objectStore('files').getAllKeys();
      r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error);
    });
  },
};

// ───────── 設定・記録（端末内） ─────────
const LS = {
  get(k, d) { try { const v = localStorage.getItem('arg.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('arg.' + k, JSON.stringify(v)); } catch (e) {} },
};
const S = Object.assign({
  fontSize: 17, nextBy: 'left', holdMode: 'hold', apiKey: '', model: 'claude-sonnet-4-5', page: 27,
}, LS.get('settings', {}));
function saveSettings() { LS.set('settings', S); }

// ───────── 状態 ─────────
const st = {
  data: null,        // 問答データ（companion）
  pdfBlob: null, pdf: null, pdfPages: 0,
  audio: null,       // {blob, index:{"note/pN": [start,end]}}
  videos: {},        // note_id -> true
  pdfNo: S.page,
  locked: false, showingPdf: false,
  rendered: { pdfNo: 0, canvas: null },
  sheetStack: [],
  objectUrls: [],
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const md = (s) => marked.parse(String(s || ''));
function toast(t, ms = 2200) { const e = $('toast'); e.textContent = t; e.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (e.hidden = true), ms); }
function revokeUrls() { st.objectUrls.forEach((u) => URL.revokeObjectURL(u)); st.objectUrls = []; }
function objUrl(blob) { const u = URL.createObjectURL(blob); st.objectUrls.push(u); return u; }

// ───────── 取り込み済みデータの読み込み ─────────
async function loadStored() {
  const d = await DB.get('data');
  st.data = d ? d.value : null;
  const p = await DB.get('pdf');
  st.pdfBlob = p ? p.blob : null;
  st.pdf = null; st.pdfPages = p ? p.pages : 0;
  const a = await DB.get('audio');
  st.audio = a || null;
  st.videos = {};
  for (const k of await DB.keys()) if (String(k).startsWith('video:')) st.videos[k.slice(6)] = true;
}

// 全体をメモリに読み込まず、必要な部分だけ取り出して PDF.js に渡す
function pdfFromBlob(blob) {
  const transport = new pdfjsLib.PDFDataRangeTransport(blob.size, null);
  transport.requestDataRange = (begin, end) => {
    blob.slice(begin, end).arrayBuffer().then((buf) => transport.onDataRange(begin, new Uint8Array(buf)));
  };
  return pdfjsLib.getDocument({ range: transport, length: blob.size, disableAutoFetch: true, disableStream: true,
    rangeChunkSize: 262144, isEvalSupported: false }).promise;
}
async function openPdf() {
  if (st.pdf || !st.pdfBlob) return st.pdf;
  st.pdf = await pdfFromBlob(st.pdfBlob);
  st.pdfPages = st.pdf.numPages;
  return st.pdf;
}

// ───────── ページ ─────────
function maxPage() { return st.pdfPages || (st.data && st.data.pdf_pages) || 736; }
function entry(pdfNo = st.pdfNo) { return st.data ? st.data.pages[String(pdfNo)] : null; }
function noteOf(e) { return e && st.data ? st.data.notes.find((n) => n.note_id === e.note_id) : null; }
function sectionOf(e) {
  const n = noteOf(e); if (!n) return null;
  let hit = null;
  for (const s of n.sections || []) { const [a, b] = s.pages || [0, 0]; if (a <= e.page && e.page <= b) hit = s; }
  return hit;
}
function button(e, id) { return e ? (e.buttons || []).find((b) => b.id === id) : null; }

function goto(pdfNo) {
  pdfNo = Math.max(1, Math.min(maxPage(), pdfNo | 0));
  st.pdfNo = pdfNo; S.page = pdfNo; saveSettings(); st.quizPicked = null;
  renderSummary();
  if (st.showingPdf) renderPdf(); else prerenderPdf();
  if ($('sheet').classList.contains('open')) openMenu();
}

function renderSummary() {
  const e = entry();
  $('pg').textContent = e ? `p.${e.page}（PDF ${st.pdfNo}）` : `PDF ${st.pdfNo}`;
  $('sec').textContent = e ? (e.section || '') : '';
  const box = $('summary');
  if (!st.data) {
    box.innerHTML = `<div class="empty">データがまだありません。<br>右上の ⚙ から「データの取り込み」を開いてください。</div>`;
  } else if (!e) {
    box.innerHTML = `<div class="empty">このページには解説がありません（表紙・目次など）。<br>「原本」を押すと本のページを表示します。</div>`;
  } else {
    const ex = button(e, 'explain');
    box.innerHTML = `<div class="md">${md(ex ? ex.answer : '（解説なし）')}</div>`;
  }
  box.scrollTop = 0;
  $('btnOrig').disabled = !st.pdfBlob;
}

// ───────── 原本（PDF）の表示 ─────────
let renderSeq = 0;
async function drawPage(pdfNo, canvas) {
  const pdf = await openPdf();
  if (!pdf || pdfNo > pdf.numPages) return false;
  const page = await pdf.getPage(pdfNo);
  const box = $('pdfBox').getBoundingClientRect();
  const w = box.width || window.innerWidth, h = box.height || (window.innerHeight - 100);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(w / vp1.width, h / vp1.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale: scale * dpr });
  canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
  canvas.style.width = Math.floor(vp.width / dpr) + 'px'; canvas.style.height = Math.floor(vp.height / dpr) + 'px';
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return true;
}
async function prerenderPdf() {
  if (!st.pdfBlob) return;
  const seq = ++renderSeq, no = st.pdfNo;
  const c = document.createElement('canvas');
  try {
    if (await drawPage(no, c) && seq === renderSeq) st.rendered = { pdfNo: no, canvas: c };
  } catch (e) { /* 表示時に再試行 */ }
}
async function renderPdf() {
  const msg = $('pdfMsg'), cv = $('pdfCanvas');
  if (!st.pdfBlob) { msg.textContent = '原本の PDF がまだ取り込まれていません。'; cv.hidden = true; return; }
  if (st.rendered.pdfNo === st.pdfNo && st.rendered.canvas) {
    const src = st.rendered.canvas;
    cv.width = src.width; cv.height = src.height; cv.style.width = src.style.width; cv.style.height = src.style.height;
    cv.getContext('2d').drawImage(src, 0, 0); cv.hidden = false; msg.textContent = ''; return;
  }
  msg.textContent = '読み込み中…';
  try {
    const seq = ++renderSeq;
    const c = document.createElement('canvas');
    const ok = await drawPage(st.pdfNo, c);
    if (seq !== renderSeq) return;
    if (!ok) { msg.textContent = 'このページは PDF にありません。'; cv.hidden = true; return; }
    st.rendered = { pdfNo: st.pdfNo, canvas: c };
    renderPdf();
  } catch (e) { msg.textContent = 'PDF を表示できませんでした：' + e.message; }
}
function showPdf(on) {
  st.showingPdf = on;
  $('pdfView').hidden = !on;
  $('btnOrig').classList.toggle('on', on && !st.locked);
  if (on) renderPdf();
}
function setLock(on) {
  st.locked = on;
  $('lockBar').hidden = !on;
  $('btnOrig').classList.toggle('locked', on);
  showPdf(on);
  toast(on ? '原本の表示を固定しました' : '要約に戻りました', 1400);
}

// 「原本」ボタン：押している間だけ表示。ダブルタップで固定・解除
(function setupOrigButton() {
  const b = $('btnOrig');
  let lastUp = 0, downAt = 0;
  const down = (ev) => {
    ev.preventDefault();
    if (b.disabled) return;
    downAt = Date.now();
    if (!st.locked) {
      if (S.holdMode === 'tap') return;
      showPdf(true);
    }
  };
  const up = (ev) => {
    ev.preventDefault();
    if (b.disabled) return;
    const now = Date.now();
    if (now - lastUp < 320) { lastUp = 0; setLock(!st.locked); return; }
    lastUp = now;
    if (st.locked) return;
    if (S.holdMode === 'tap') {
      // タップで切り替える設定：ダブルタップと区別するため少し待つ
      setTimeout(() => { if (lastUp === now && !st.locked) showPdf(!st.showingPdf); }, 330);
      return;
    }
    showPdf(false);
  };
  b.addEventListener('pointerdown', down);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', () => { if (!st.locked && S.holdMode !== 'tap') showPdf(false); });
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  $('btnUnlock').addEventListener('click', () => setLock(false));
})();

// ───────── 左右のスワイプでページ送り ─────────
function setupSwipe(el) {
  let x0 = 0, y0 = 0, t0 = 0, active = false;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { active = false; return; }
    active = true; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!active) return; active = false;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6 && Date.now() - t0 < 800) {
      const toLeft = dx < 0;
      const next = S.nextBy === 'left' ? toLeft : !toLeft;
      goto(st.pdfNo + (next ? 1 : -1));
    }
  }, { passive: true });
}
setupSwipe($('summary'));
setupSwipe($('pdfView'));
document.addEventListener('keydown', (e) => {
  if ($('panel').hidden === false || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight') goto(st.pdfNo + 1);
  if (e.key === 'ArrowLeft') goto(st.pdfNo - 1);
});

// ───────── 下から引き出すメニュー（つまみ） ─────────
(function setupHandle() {
  const h = $('handle');
  let y0 = null;
  h.addEventListener('pointerdown', (e) => { y0 = e.clientY; });
  h.addEventListener('pointermove', (e) => { if (y0 != null && y0 - e.clientY > 24) { y0 = null; openMenu(); } });
  h.addEventListener('pointerup', () => { if (y0 != null) { y0 = null; openMenu(); } });
  h.addEventListener('pointercancel', () => (y0 = null));
  const head = $('sheetHead');
  let hy = null;
  head.addEventListener('pointerdown', (e) => { if (e.target.tagName !== 'BUTTON') hy = e.clientY; });
  head.addEventListener('pointermove', (e) => { if (hy != null && e.clientY - hy > 40) { hy = null; closeSheet(); } });
  head.addEventListener('pointerup', () => (hy = null));
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheetShade').addEventListener('click', closeSheet);
  $('sheetBack').addEventListener('click', () => { st.sheetStack.pop(); const f = st.sheetStack.pop(); (f || openMenu)(); });
})();

function sheetShow(title, html, { full = false, back = false } = {}) {
  document.querySelectorAll('#sheetBody video, #sheetBody audio').forEach((m) => m.pause());
  $('sheetTitle').textContent = title;
  $('sheetBody').innerHTML = html;
  $('sheetBody').scrollTop = 0;
  $('sheetBack').hidden = !back;
  const s = $('sheet');
  s.classList.add('open'); s.classList.toggle('full', full); s.setAttribute('aria-hidden', 'false');
  $('sheetShade').hidden = false;
}
function closeSheet() {
  const s = $('sheet');
  s.classList.remove('open', 'full'); s.setAttribute('aria-hidden', 'true');
  $('sheetShade').hidden = true; st.sheetStack = [];
  document.querySelectorAll('#sheetBody video, #sheetBody audio').forEach((m) => m.pause());
  revokeUrls();
}

const BTN_ORDER = ['formula', 'calc', 'terms', 'compare', 'exam', 'context', 'quiz', 'caution'];
function audioKey(e) { return e ? `${e.note_id}/p${e.page}` : ''; }
function hasAudio(e) { return !!(st.audio && e && st.audio.index[audioKey(e)]); }
function hasVideo(e) { return !!(e && st.videos[e.note_id]); }

function openMenu() {
  st.sheetStack = [openMenu];
  const e = entry();
  if (!st.data) { sheetShow('メニュー', '<p>データがまだありません。⚙ の「データの取り込み」から始めてください。</p>'); return; }
  if (!e) { sheetShow('メニュー', '<p>このページには解説がありません。</p>'); return; }
  const parts = ['<div class="grid">', '<h3>このページ</h3>'];
  for (const id of BTN_ORDER) {
    const b = button(e, id);
    if (b) parts.push(`<button data-act="btn" data-id="${id}">${esc(b.label)}</button>`);
  }
  parts.push('<h3>章・節</h3>');
  parts.push(`<button data-act="overview">この章の全体像</button>`);
  if (sectionOf(e)) parts.push(`<button data-act="section">この節の要点</button>`);
  parts.push('<h3>講義</h3>');
  const ha = hasAudio(e), hv = hasVideo(e);
  parts.push(`<button data-act="${ha ? 'audio' : ''}" class="${ha ? '' : 'dis'}" aria-disabled="${!ha}">講義音声</button>`);
  parts.push(`<button data-act="${hv ? 'video' : ''}" class="${hv ? '' : 'dis'}" aria-disabled="${!hv}">講義動画</button>`);
  if (!ha || !hv) parts.push(`<div class="note">${!ha ? '講義音声は取り込まれていません。' : ''}${!hv ? 'このノートの講義動画は保存されていません。' : ''}</div>`);
  parts.push('<h3>質問</h3>');
  parts.push(`<button data-act="claude">Claude に質問</button>`);
  parts.push('</div>');
  sheetShow('メニュー', parts.join(''));
}

$('sheetBody').addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act; if (!act) return;   // 押せないボタン（灰色）は何もしない
  const e = entry();
  if (act === 'btn') showButton(t.dataset.id);
  else if (act === 'overview') showOverview();
  else if (act === 'section') showSection();
  else if (act === 'audio') showAudio();
  else if (act === 'video') showVideo();
  else if (act === 'claude') showClaude();
  else if (act === 'term') showTerm(+t.dataset.i);
  else if (act === 'choice') answerQuiz(+t.dataset.q, t.dataset.c);
  else if (act === 'ask') askClaude();
});

function push(fn) { st.sheetStack.push(fn); }
function showButton(id) {
  const e = entry(), b = button(e, id); if (!b) return;
  push(() => showButton(id));
  if (id === 'terms') {
    const items = (b.items || []).map((it, i) => `<button data-act="term" data-i="${i}">${esc(it.term)}</button>`).join('');
    sheetShow(b.label, `<p class="status">用語を押すと説明が出ます。</p><div class="termlist">${items}</div>`, { full: true, back: true });
  } else if (id === 'quiz') {
    sheetShow(b.label, quizHtml(e, b), { full: true, back: true });
  } else {
    sheetShow(b.label, `<div class="md">${md(b.answer)}</div>`, { full: true, back: true });
  }
}
function showTerm(i) {
  const b = button(entry(), 'terms'); const it = b.items[i];
  push(() => showTerm(i));
  sheetShow(it.term, `<div class="md">${md(it.answer)}</div>`, { full: true, back: true });
}
function showOverview() {
  const n = noteOf(entry()); if (!n) return;
  push(showOverview);
  sheetShow('この章の全体像', `<p class="status">${esc(n.title)}</p><div class="md">${md(n.overview && n.overview.answer)}</div>`, { full: true, back: true });
}
function showSection() {
  const s = sectionOf(entry()); if (!s) return;
  push(showSection);
  sheetShow(`${s.section} ${s.title}`, `<div class="md">${md(s.answer)}</div>`, { full: true, back: true });
}

// 確認問題（結果は端末に記録）
function quizKey(qi) { return `${st.pdfNo}-${qi}`; }
function quizHtml(e, b) {
  const rec = LS.get('quiz', {});
  return (b.items || []).map((q, qi) => {
    const r = rec[quizKey(qi)], picked = st.quizPicked && st.quizPicked[qi];
    const ch = (q.choices || []).map((c) => {
      const L = c.trim().charAt(0);
      let cls = 'choice';
      if (picked) { if (L === q.answer) cls += ' right'; else if (L === picked) cls += ' wrong'; }
      return `<button class="${cls}" data-act="choice" data-q="${qi}" data-c="${esc(L)}">${esc(c)}</button>`;
    }).join('');
    let res = '';
    if (picked) {
      const ok = picked === q.answer;
      res = `<div class="result ${ok ? 'ok' : 'ng'}">${ok ? '正解です' : '不正解です。正解は ' + esc(q.answer)}</div><div class="md">${md(q.explanation)}</div>`;
    } else if (r) {
      res = `<div class="prev">前回：${r.ok ? '正解' : '不正解'}（${new Date(r.t).toLocaleDateString('ja-JP')}）</div>`;
    }
    return `<div class="qbox"><div><strong>問${qi + 1}</strong> ${md(q.question).replace(/^<p>|<\/p>\s*$/g, '')}</div>${ch}${res}</div>`;
  }).join('');
}
function answerQuiz(qi, letter) {
  const e = entry(), b = button(e, 'quiz');
  st.quizPicked = st.quizPicked || {};
  st.quizPicked[qi] = letter;
  const ok = letter === b.items[qi].answer;
  const rec = LS.get('quiz', {}); rec[quizKey(qi)] = { ans: letter, ok, t: Date.now() }; LS.set('quiz', rec);
  const y = $('sheetBody').scrollTop;
  $('sheetBody').innerHTML = quizHtml(e, b);
  $('sheetBody').scrollTop = y;
}

// 講義音声：音声の zip から、このページの部分だけを取り出して再生
function showAudio() {
  const e = entry(); if (!hasAudio(e)) return;
  revokeUrls();
  const [a, z] = st.audio.index[audioKey(e)];
  const url = objUrl(st.audio.blob.slice(a, z, 'audio/mpeg'));
  push(showAudio);
  sheetShow('講義音声', `<p class="status">p.${e.page} の講義音声です。</p><audio controls preload="metadata" src="${url}"></audio>`, { back: true });
}
// 講義動画：このページのチャプター位置から再生
async function showVideo() {
  const e = entry(); if (!hasVideo(e)) return;
  const v = await DB.get('video:' + e.note_id);
  if (!v) { toast('動画が見つかりません'); return; }
  const n = noteOf(e);
  revokeUrls();
  const start = (n && n.video_chapters && n.video_chapters[String(st.pdfNo)]) || 0;
  const url = objUrl(v.blob);
  push(showVideo);
  sheetShow('講義動画', `<p class="status">${esc(n ? n.title : e.note_id)}／p.${e.page} の位置から再生します。</p>
    <video id="vid" controls playsinline preload="metadata" src="${url}"></video>`, { full: true, back: true });
  const vid = $('vid');
  const seek = () => { try { if (start && vid.currentTime < 0.5) vid.currentTime = start; } catch (err) {} };
  vid.addEventListener('loadedmetadata', seek, { once: true });
  vid.addEventListener('play', seek, { once: true });   // iPhone では再生を押すまで読み込まないことがあるため
  if (vid.readyState >= 1) seek();
  vid.addEventListener('error', () => toast('動画を再生できませんでした'), { once: true });
}

// Claude に質問（通信できるときだけ）
function showClaude() {
  push(showClaude);
  const keyNote = S.apiKey ? '' : '<p class="status ng">APIキーが未設定です（⚙ → 設定）。</p>';
  sheetShow('Claude に質問', `${keyNote}<p class="status">表示中のページの解説を根拠として添えて送ります。</p>
    <textarea id="q" placeholder="質問を入力"></textarea>
    <p><button class="btn" data-act="ask" ${S.apiKey ? '' : 'disabled'}>送信</button></p><div id="ans" class="md"></div>`, { full: true, back: true });
}
const CLAUDE_SYSTEM = 'あなたは証券アナリスト1次試験の学習を助けるアシスタントです。利用者は『パーフェクト 証券アナリスト 第1次レベル』を読んでいます。' +
  '与えた【このページの清書ノート】と【節の要点】を主な根拠に、日本語で短く、結論を先に答えてください。根拠に無い説明を足すときは、その部分の先頭に「補足：」と書いてください。' +
  '数値は本のとおりに使い、計算は途中の式も示してください。回答の最後に、根拠にした印刷ページを (p.X) の形で示してください。';
async function askClaude() {
  const q = ($('q').value || '').trim(); if (!q) return;
  if (!navigator.onLine) { $('ans').innerHTML = '<p class="status ng">オフラインです。通信できるときに質問してください。</p>'; return; }
  const e = entry(), n = noteOf(e), s = sectionOf(e);
  const ctx = [`【本】${st.data.title}`, `【範囲】${n ? n.title : ''}`, `【表示中のページ】印刷 p.${e ? e.page : '-'}（PDF ${st.pdfNo}）｜${e ? e.section : ''}`,
    '【このページの清書ノート】', e ? e.v2 || '' : '', s ? `【節の要点】${s.section} ${s.title}\n${s.answer}` : ''].join('\n');
  $('ans').innerHTML = '<p class="status">考え中…</p>';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': S.apiKey, 'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: S.model, max_tokens: 1500, system: CLAUDE_SYSTEM,
        messages: [{ role: 'user', content: `${ctx}\n\n【質問】\n${q}` }] }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || r.status);
    $('ans').innerHTML = md((d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
  } catch (err) {
    $('ans').innerHTML = `<p class="status ng">Claude に接続できませんでした：${esc(err.message)}</p>`;
  }
}

// ───────── 画面（目次・設定・取り込み） ─────────
function panel(title, html) {
  $('panelTitle').textContent = title; $('panelBody').innerHTML = html; $('panel').hidden = false; $('panelBody').scrollTop = 0;
}
$('panelClose').addEventListener('click', () => { $('panel').hidden = true; renderSummary(); });

$('btnToc').addEventListener('click', () => {
  if (!st.data) { openImport(); return; }
  const off = st.data.pdf_offset || 26;
  const parts = [`<div class="row"><label>印刷ページへ移動</label><input id="jump" type="number" inputmode="numeric" style="width:90px" placeholder="p."><button class="btn sub" id="jumpGo">移動</button></div>`];
  for (const n of st.data.notes) {
    parts.push(`<div class="toc-note">${esc(n.title)}</div>`);
    for (const s of n.sections || []) {
      parts.push(`<button class="toc-sec" data-p="${s.pages[0] + off}">${esc(s.section)} ${esc(s.title)}<span>p.${s.pages[0]}</span></button>`);
    }
  }
  panel('目次', parts.join(''));
  $('jumpGo').onclick = () => { const p = +$('jump').value; if (p) { $('panel').hidden = true; goto(p + off); } };
  $('panelBody').querySelectorAll('.toc-sec').forEach((b) => (b.onclick = () => { $('panel').hidden = true; goto(+b.dataset.p); }));
  const cur = $('panelBody').querySelector(`.toc-sec[data-p="${st.pdfNo}"]`); if (cur) cur.scrollIntoView();
});

$('btnSettings').addEventListener('click', openSettings);
function seg(name, opts, cur) {
  return `<div class="seg" data-name="${name}">` + opts.map(([v, t]) => `<button data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${t}</button>`).join('') + '</div>';
}
function openSettings() {
  panel('設定', `
    <div class="row"><label>文字の大きさ</label>${seg('fontSize', [[15, '小'], [17, '中'], [19, '大'], [22, '特大']], S.fontSize)}</div>
    <div class="row"><label>次のページへ</label>${seg('nextBy', [['left', '左へスワイプ'], ['right', '右へスワイプ']], S.nextBy)}</div>
    <div class="row"><label>「原本」ボタン</label>${seg('holdMode', [['hold', '押している間'], ['tap', 'タップで切替']], S.holdMode)}</div>
    <p class="status">「原本」ボタンをダブルタップすると、原本の表示を固定します。</p>
    <div class="row"><label>Claude の APIキー<br><span class="status">端末の中だけに保存します</span></label></div>
    <input id="apiKey" type="password" autocomplete="off" value="${esc(S.apiKey)}" placeholder="sk-ant-…">
    <div class="row"><label>Claude のモデル名</label></div>
    <input id="model" type="text" autocomplete="off" value="${esc(S.model)}">
    <p><button class="btn" id="saveKey">保存</button></p>
    <div class="row"><label>データの取り込み・状況</label><button class="btn sub" id="goImport">開く</button></div>
    <div class="row"><label>学習の記録（確認問題の正誤・設定）</label></div>
    <p><button class="btn sub" id="expRec">書き出す</button> <label class="btn sub filebtn">読み込む<input type="file" id="impRec" accept=".json,application/json"></label></p>
    <p class="status">書き出したファイルは「ファイル」アプリに保存しておくと、データが消えたときに戻せます。${LS.get('lastExport', 0) ? '前回の書き出し：' + new Date(LS.get('lastExport', 0)).toLocaleString('ja-JP') : 'まだ書き出していません。'}</p>
    <p class="status">AIReaderGO モバイル版 ${APP_VERSION}</p>`);
  $('panelBody').querySelectorAll('.seg').forEach((g) => g.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    const name = g.dataset.name; let v = b.dataset.v; if (name === 'fontSize') v = +v;
    S[name] = v; saveSettings(); applySettings();
    g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('saveKey').onclick = () => { S.apiKey = $('apiKey').value.trim(); S.model = $('model').value.trim() || 'claude-sonnet-4-5'; saveSettings(); toast('保存しました'); };
  $('goImport').onclick = openImport;
  $('expRec').onclick = exportRecords;
  $('impRec').onchange = (e) => importRecords(e.target.files[0]);
}
// 学習の記録の書き出し・読み込み（APIキーは書き出さない）
async function exportRecords() {
  const settings = Object.assign({}, S); delete settings.apiKey;
  const rec = { format: 'aireadergo-records', version: 1, t: Date.now(), settings, quiz: LS.get('quiz', {}) };
  const blob = new Blob([JSON.stringify(rec)], { type: 'application/json' });
  const name = `AIReaderGO_記録_${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); }
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
    LS.set('lastExport', Date.now()); toast('書き出しました。「ファイルに保存」を選んでください');
  } catch (e) { if (e.name !== 'AbortError') toast('書き出せませんでした：' + e.message); }
}
async function importRecords(f) {
  if (!f) return;
  try {
    const r = JSON.parse(await f.text());
    if (r.format !== 'aireadergo-records') throw new Error('記録のファイルではありません');
    const cur = LS.get('quiz', {});
    for (const [k, v] of Object.entries(r.quiz || {})) if (!cur[k] || (v.t || 0) > (cur[k].t || 0)) cur[k] = v;
    LS.set('quiz', cur);
    const key = S.apiKey; Object.assign(S, r.settings || {}); S.apiKey = key; saveSettings(); applySettings();
    toast('記録を読み込みました'); openSettings();
  } catch (e) { toast('読み込めませんでした：' + e.message); }
}
function applySettings() { document.documentElement.style.setProperty('--fs', S.fontSize + 'px'); }

// 取り込み
async function openImport() {
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
  const nVideo = Object.keys(st.videos).length, nNotes = st.data ? st.data.notes.length : 35;
  const audioN = st.audio ? Object.keys(st.audio.index).length : 0;
  panel('データの取り込み', `
    <p class="status">「ファイル」アプリに置いたファイルを選びます。選んだファイルは端末の中にコピーされ、以後はネットなしで使えます。</p>
    <div class="step"><h3>1. 問答データ（B0016_mobile_data.json）</h3>
      <div class="status ${st.data ? 'ok' : ''}">${st.data ? '取り込み済み：' + st.data.notes.length + 'ノート／' + Object.keys(st.data.pages).length + 'ページ（版 ' + esc(st.data.version || '-') + '）' : '未取り込み'}</div>
      <label class="btn filebtn">選ぶ<input type="file" id="fData" accept=".json,application/json"></label></div>
    <div class="step"><h3>2. 原本 PDF（圧縮版）</h3>
      <div class="status ${st.pdfBlob ? 'ok' : ''}">${st.pdfBlob ? '取り込み済み：' + st.pdfPages + 'ページ／' + (st.pdfBlob.size / 1048576).toFixed(0) + 'MB' : '未取り込み'}</div>
      <label class="btn filebtn">選ぶ<input type="file" id="fPdf" accept=".pdf,application/pdf"></label></div>
    <div class="step"><h3>3. 講義音声（B0016_mobile_audio.zip）※任意</h3>
      <div class="status ${audioN ? 'ok' : ''}">${audioN ? '取り込み済み：' + audioN + '本' : '未取り込み（講義音声のボタンは押せません）'}</div>
      <label class="btn filebtn">選ぶ<input type="file" id="fAudio" accept=".zip,application/zip"></label></div>
    <div class="step"><h3>4. 講義動画（ノート名.mp4、複数選べます）※任意</h3>
      <div class="status ${nVideo ? 'ok' : ''}">保存済み：${nVideo} / ${nNotes} 本${nVideo ? '（' + Object.keys(st.videos).sort().join('、') + '）' : ''}</div>
      <label class="btn filebtn">選ぶ<input type="file" id="fVideo" accept="video/mp4,.mp4" multiple></label>
      ${nVideo ? '<button class="btn sub" id="delVideo" style="margin-left:8px">動画をすべて削除</button>' : ''}</div>
    <div id="impMsg" class="status"></div><div class="progress"><div id="impBar"></div></div>
    <p class="status">${est ? '使用中：' + (est.usage / 1048576).toFixed(0) + 'MB／上限の目安：' + (est.quota / 1073741824).toFixed(1) + 'GB' : ''}</p>`);
  $('fData').onchange = (e) => importData(e.target.files[0]);
  $('fPdf').onchange = (e) => importPdf(e.target.files[0]);
  $('fAudio').onchange = (e) => importAudio(e.target.files[0]);
  $('fVideo').onchange = (e) => importVideos([...e.target.files]);
  if ($('delVideo')) $('delVideo').onclick = async () => {
    for (const k of Object.keys(st.videos)) await DB.del('video:' + k);
    st.videos = {}; openImport();
  };
}
function impMsg(t, p) { if ($('impMsg')) $('impMsg').textContent = t; if ($('impBar') && p != null) $('impBar').style.width = (p * 100).toFixed(0) + '%'; }
async function persist() { try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {} }

async function importData(f) {
  if (!f) return;
  try {
    impMsg('読み込み中…', 0.2);
    const d = JSON.parse(await f.text());
    if (!d.pages || !d.notes || d.format !== 1) throw new Error('AIReaderGO の問答データではありません');
    await DB.put('data', { value: d, name: f.name, t: Date.now() });
    await persist(); await loadStored(); impMsg('取り込みました', 1); renderSummary(); openImport();
  } catch (e) { impMsg('取り込めませんでした：' + e.message, 0); }
}
async function importPdf(f) {
  if (!f) return;
  try {
    impMsg('PDF を確かめています…', 0.1);
    const buf = await f.slice(0, Math.min(f.size, 1024)).text();
    if (!buf.startsWith('%PDF')) throw new Error('PDF ではありません');
    const doc = await pdfFromBlob(f);
    const n = doc.numPages; await doc.destroy();
    const expect = st.data ? st.data.pdf_pages : 736;
    if (expect && n !== expect && !confirm(`この PDF は ${n} ページです（問答データは ${expect} ページ前提）。ページがずれる可能性があります。取り込みますか？`)) { impMsg('中止しました', 0); return; }
    impMsg('端末に保存しています…', 0.5);
    await DB.put('pdf', { blob: f, name: f.name, pages: n, t: Date.now() });
    if (st.pdf) { try { await st.pdf.destroy(); } catch (e) {} }
    await persist(); await loadStored(); st.rendered = { pdfNo: 0, canvas: null };
    impMsg(`取り込みました（${n}ページ）`, 1); openImport();
  } catch (e) { impMsg('取り込めませんでした：' + e.message, 0); }
}
// zip（無圧縮）の目次を読み、各音声の位置だけを記録する（中身はそのまま保存）
async function readZipIndex(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip の目次が見つかりません');
  let count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const items = [];
  for (let p = 0, i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('zip の形式が違います');
    const method = cd.getUint16(p + 10, true), csize = cd.getUint32(p + 20, true);
    const nlen = cd.getUint16(p + 28, true), xlen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true);
    const lho = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
    if (method !== 0 && csize) throw new Error('圧縮された zip は使えません（無圧縮で作ってください）');
    items.push({ name, lho, csize });
    p += 46 + nlen + xlen + clen;
  }
  const index = {};
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.name.endsWith('.mp3')) continue;
    const lh = new DataView(await blob.slice(it.lho, it.lho + 30).arrayBuffer());
    const start = it.lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    index[it.name.replace(/\.mp3$/, '')] = [start, start + it.csize];
    if (i % 50 === 0) impMsg(`音声の目次を読んでいます… ${i}/${items.length}`, 0.1 + 0.4 * i / items.length);
  }
  return index;
}
async function importAudio(f) {
  if (!f) return;
  try {
    impMsg('音声の目次を読んでいます…', 0.05);
    const index = await readZipIndex(f);
    const n = Object.keys(index).length; if (!n) throw new Error('音声（mp3）が入っていません');
    impMsg(`端末に保存しています…（${(f.size / 1048576).toFixed(0)}MB）`, 0.6);
    await DB.put('audio', { blob: f, index, name: f.name, t: Date.now() });
    await persist(); await loadStored(); impMsg(`取り込みました（${n}本）`, 1); openImport();
  } catch (e) { impMsg('取り込めませんでした：' + e.message, 0); }
}
async function importVideos(files) {
  if (!files.length) return;
  const ids = st.data ? new Set(st.data.notes.map((n) => n.note_id)) : null;
  let ok = 0; const skipped = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i], id = f.name.replace(/\.mp4$/i, '');
    if (ids && !ids.has(id)) { skipped.push(f.name); continue; }
    impMsg(`動画を保存しています… ${i + 1}/${files.length}（${f.name}）`, i / files.length);
    try { await DB.put('video:' + id, { blob: f, name: f.name, t: Date.now() }); ok++; }
    catch (e) { skipped.push(f.name + '（' + e.message + '）'); }
  }
  await persist(); await loadStored();
  impMsg(`${ok}本を保存しました${skipped.length ? '。取り込めなかったもの：' + skipped.join('、') : ''}`, 1);
  setTimeout(openImport, 1200);
}

// ───────── 起動 ─────────
(async function start() {
  applySettings();
  try { await DB.open(); await loadStored(); } catch (e) { toast('端末の保存領域を開けませんでした：' + e.message, 5000); }
  renderSummary(); prerenderPdf();
  if (!st.data) openImport();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('resize', () => { st.rendered = { pdfNo: 0, canvas: null }; if (st.showingPdf) renderPdf(); else prerenderPdf(); });
})();
