/*
 * 이레 노트 — PDF를 바탕에 깔고 그 위에 펜·형광펜으로 쓰고 그리기
 * - PDF는 pdf.js(assets/vendor)로 그리고, 필기는 쪽마다 선(획) 목록으로 이 기기(IndexedDB)에 저장
 *   선의 좌표는 PDF 크기 기준(확대해도 그대로)이라 확대·축소해도 선명하고, PDF로 내보낼 때도 그대로 옮겨짐
 * - 손가락: 펜(애플펜슬·S펜)을 한 번이라도 쓰면 손가락은 화면 옮기기만 함(손바닥 무시). 두 손가락은 언제나 확대·이동
 * - 선생님 학습지: sheets.js(선생님이 고치는 파일)의 목록 → 학생이 열어 쓰고 [선생님께 보내기]로 필기한 PDF를 카톡에 보냄
 * - 수업 화면: 한 쪽씩 화면 가득, 도구는 아래 작은 막대
 */
(function () {
  'use strict';
  const CFG = window.NOTE_CFG || {};
  const SHEETS = ((window.SHEETS && Array.isArray(window.SHEETS)) ? window.SHEETS : []).filter(s => s && s.id && s.file);
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const DPR = () => Math.min(window.devicePixelRatio || 1, 3);
  const MAX_PX = 5e6;   // 캔버스 한 장의 최대 픽셀 (아이패드 메모리 한도 안쪽)

  // ── 저장 ──
  const ls = {
    get(k, f) { try { const v = localStorage.getItem(k); return v == null ? f : JSON.parse(v); } catch (e) { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const K = { name: 'irae-note-name', set: 'irae-note-settings', pen: 'irae-note-pen-seen' };
  // 문서 정보(meta), PDF 원본(pdf), 필기(ink)를 따로 둬서 목록을 볼 때 큰 PDF를 읽지 않음
  const DB = (() => {
    let opening;
    const open = () => opening || (opening = new Promise((res, rej) => {
      const r = indexedDB.open('yireh-note', 1);
      r.onupgradeneeded = () => { const d = r.result; for (const n of ['meta', 'pdf', 'ink']) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const run = (store, mode, fn) => open().then(d => new Promise((res, rej) => {
      const t = d.transaction(store, mode), req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = t.onabort = () => rej(t.error);
    }));
    return {
      get: (s, k) => run(s, 'readonly', st => st.get(k)),
      all: s => run(s, 'readonly', st => st.getAll()),
      put: (s, v) => run(s, 'readwrite', st => st.put(v)),
      del: (s, k) => run(s, 'readwrite', st => st.delete(k)),
    };
  })();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ── 도구 ──
  const PENS = [
    { k: 'pen', c: '#1B2430', label: '검은 펜' },
    { k: 'pen', c: '#D2372A', label: '빨간 펜' },
    { k: 'pen', c: '#2257C9', label: '파란 펜' },
    { k: 'hl', c: '#FFD400', label: '노란 형광펜' },
    { k: 'hl', c: '#7CE07C', label: '연두 형광펜' },
  ];
  const SIZES = { pen: [1.1, 2, 3.4], hl: [9, 14, 20] };   // PDF 단위(pt)
  const SIZE_NAMES = ['가늘게', '보통', '굵게'];
  const HL_ALPHA = 0.38;
  const set0 = ls.get(K.set, {});
  const S = {
    tool: set0.tool === 'erase' ? 'erase' : 'draw', pen: Number.isInteger(set0.pen) && PENS[set0.pen] ? set0.pen : 0, size: [0, 1, 2].includes(set0.size) ? set0.size : 1,
    finger: set0.finger || 'auto',   // auto(펜을 쓰면 이동) | draw | pan
    penSeen: !!ls.get(K.pen, false),
    meta: null, pdf: null, pages: [], ink: {}, hist: [], redo: [],
    zoom: 1, scale: 1, cur: 0, present: false, view: 'home',
  };
  const saveSettings = () => ls.set(K.set, { tool: S.tool, pen: S.pen, size: S.size, finger: S.finger });
  const fingerDraws = () => S.finger === 'draw' || (S.finger === 'auto' && !S.penSeen);

  // ── 아이콘 ──
  const I = {
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    erase: '<svg viewBox="0 0 24 24"><path d="M4 16l9-9 6 6-6 6H8z"/><path d="M13 19h7"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M9 7L4 12l5 5"/><path d="M4 12h10a5 5 0 0 1 0 10h-3"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="M15 7l5 5-5 5"/><path d="M20 12H10a5 5 0 0 0 0 10h3"/></svg>',
    hand: '<svg viewBox="0 0 24 24"><path d="M8 13V6a1.5 1.5 0 0 1 3 0v6M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7-6 7-2.5 0-4-1.2-5.4-3.4L3.8 13.6a1.5 1.5 0 0 1 2.4-1.7L8 14"/></svg>',
    finger: '<svg viewBox="0 0 24 24"><path d="M10 14V5a1.6 1.6 0 0 1 3.2 0v7"/><path d="M13.2 11.5a1.6 1.6 0 0 1 3.2 0V13a1.6 1.6 0 0 1 3.2 0V16c0 3.5-2.6 6-6 6-2.4 0-4-1-5.3-3L5.6 15.8a1.6 1.6 0 0 1 2.6-1.9L10 16"/></svg>',
    minus: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M8 11h6M16 16l4 4"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M8 11h6M11 8v6M16 16l4 4"/></svg>',
    fit: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    full: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 9H6.5v1.5M16 9h1.5v1.5M8 15H6.5v-1.5M16 15h1.5v-1.5"/></svg>',
    grid: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="7" rx="1"/><rect x="14" y="4" width="6" height="7" rx="1"/><rect x="4" y="14" width="6" height="7" rx="1"/><rect x="14" y="14" width="6" height="7" rx="1"/></svg>',
    board: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5L20 4"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 19h14"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  // ── 날짜·버전 ──
  const fmtDate = t => { try { return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(t)); } catch (e) { return ''; } };
  const dueText = d => { if (!d) return ''; const [y, m, dd] = d.split('-').map(Number); return `${m}월 ${dd}일까지`; };
  const VER_TAG = (() => {
    const m = ((document.currentScript && document.currentScript.src) || '').match(/[?&]v=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m) return '';
    const t = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) + 9 * 36e5), p = n => String(n).padStart(2, '0');
    return `<br><span class="ver">버전 ${p(t.getUTCMonth() + 1)}.${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}</span>`;
  })();

  // ── 뼈대 ──
  const app = $('#app');
  app.innerHTML = `
    <div class="home" id="home"></div>
    <div class="viewer" id="viewer" hidden>
      <div class="bar">
        <div class="bar-row">
          <button class="tb" type="button" data-a="home" aria-label="목록으로">${I.back}<span class="lbl">목록</span></button>
          <span class="doc-title" id="doc-title"></span>
          <span class="pageno" id="pageno"></span>
          <span class="bar-actions" id="bar-actions"></span>
        </div>
        <div class="tools" id="tools" role="toolbar" aria-label="필기 도구"></div>
      </div>
      <div class="doc" id="doc"><div class="pages" id="pages"></div></div>
      <div class="thumbs" id="thumbs" hidden><div class="thumbs-grid" id="thumbs-grid"></div></div>
      <div class="pbar" id="pbar" role="toolbar" aria-label="수업 화면 도구"></div>
    </div>
    <div class="modal" id="modal" hidden><div class="card" role="dialog" aria-modal="true" id="modal-card"></div></div>
    <div class="toast" id="toast" role="status" hidden></div>
    <input type="file" id="file-in" accept="application/pdf,.pdf" hidden>`;
  const home = $('#home'), viewer = $('#viewer'), docEl = $('#doc'), pagesEl = $('#pages');
  let toastTimer;
  function toast(text, ms = 2600) {
    const t = $('#toast'); t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ── 라이브러리 불러오기 (처음 PDF를 열 때만) ──
  const scripts = {};
  function loadScript(src) {
    return scripts[src] || (scripts[src] = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { delete scripts[src]; rej(new Error('script')); };
      document.head.appendChild(s);
    }));
  }
  const V = CFG.ver ? `?v=${CFG.ver}` : '';
  async function pdfjs() {
    if (!window.pdfjsLib) await loadScript(`assets/vendor/pdf.min.js${V}`);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = `assets/vendor/pdf.worker.min.js${V}`;
    return window.pdfjsLib;
  }

  // ════════════════ 첫 화면 ════════════════
  let delArmed = null;
  async function renderHome() {
    S.view = 'home';
    const metas = (await DB.all('meta').catch(() => [])).sort((a, b) => (b.opened || 0) - (a.opened || 0));
    const byId = new Map(metas.map(m => [m.id, m]));
    const sheetRows = SHEETS.map(s => {
      const m = byId.get('sheet:' + s.id);
      const state = m && m.sentAt ? `<span class="state sent">보냄 ${fmtDate(m.sentAt)}</span>` : m && m.inkCount ? '<span class="state doing">쓰는 중</span>' : '';
      return `<div class="item"><button class="main" type="button" data-sheet="${esc(s.id)}"><span class="name">${esc(s.title || s.id)}</span>
        <span class="sub">${[dueText(s.due), s.note].filter(Boolean).map(esc).join(' · ') || '눌러서 열기'}</span></button>${state}</div>`;
    }).join('');
    const mine = metas.filter(m => m.kind === 'file');
    const fileRows = mine.map(m => `<div class="item"><button class="main" type="button" data-open="${esc(m.id)}"><span class="name">${esc(m.name)}</span>
      <span class="sub">${m.pages ? m.pages + '쪽 · ' : ''}${m.inkCount ? '필기 있음 · ' : ''}${fmtDate(m.opened || m.added)}</span></button>
      <button class="del${delArmed === m.id ? ' armed' : ''}" type="button" data-del="${esc(m.id)}">${delArmed === m.id ? '한 번 더 누르면 삭제' : '삭제'}</button></div>`).join('');
    home.innerHTML = `
      <header>
        <h1>${esc(CFG.title || '이레 노트')}</h1>
        <p class="lead">PDF를 열어 그 위에 펜으로 쓰고 그려요. 쓴 내용은 이 기기에 저장돼서 다시 열면 그대로 있어요.</p>
      </header>
      ${SHEETS.length || CFG.alwaysSheets ? `<h2>선생님 학습지</h2><div class="list">${sheetRows || '<p class="empty">아직 올라온 학습지가 없어요.</p>'}</div>` : ''}
      <h2>내 PDF <button class="btn" type="button" data-a="pick">PDF 열기</button></h2>
      <div class="list">${fileRows || '<p class="empty">아직 연 PDF가 없어요. [PDF 열기]로 휴대폰·태블릿에 있는 PDF를 골라 보세요.<br>PDF는 인터넷에 올라가지 않고 이 기기 안에서만 열려요.</p>'}</div>
      <footer>애플펜슬·S펜으로 쓰면 손바닥이 닿아도 괜찮아요 · 두 손가락으로 확대하고 옮겨요<br>휴대폰 앱처럼 쓰기 · 아이패드: 사파리 공유 → ‘홈 화면에 추가’ · 갤럭시탭: 크롬 메뉴(⋮) → ‘앱 설치’${VER_TAG}</footer>`;
  }

  home.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.a === 'pick') { $('#file-in').click(); return; }
    if (b.dataset.sheet) { openSheet(SHEETS.find(s => s.id === b.dataset.sheet)); return; }
    if (b.dataset.open) { openDoc(b.dataset.open); return; }
    if (b.dataset.del) {
      const id = b.dataset.del;
      if (delArmed !== id) { delArmed = id; renderHome(); return; }
      delArmed = null;
      await Promise.all(['meta', 'pdf', 'ink'].map(s => DB.del(s, id).catch(() => {})));
      toast('삭제했어요.'); renderHome();
    }
  });
  $('#file-in').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { toast('PDF 파일만 열 수 있어요.'); return; }
    try {
      const buf = await f.arrayBuffer();
      // 같은 파일(이름·크기 같음)을 다시 고르면 예전 필기를 이어서
      const metas = await DB.all('meta').catch(() => []);
      const same = metas.find(m => m.kind === 'file' && m.name === f.name && m.size === f.size);
      const id = same ? same.id : 'file:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await DB.put('pdf', { id, data: buf });
      await DB.put('meta', Object.assign(same || { id, kind: 'file', added: Date.now() }, { name: f.name, size: f.size }));
      openDoc(id);
    } catch (err) { toast('PDF를 저장하지 못했어요. 저장 공간이 부족한지 확인해 주세요.', 4000); }
  });

  async function openSheet(sheet) {
    if (!sheet) return;
    const id = 'sheet:' + sheet.id;
    const url = sheet.file + (sheet.v ? `?v=${encodeURIComponent(sheet.v)}` : '');
    let meta = await DB.get('meta', id).catch(() => null);
    const cached = meta && meta.file === url && await DB.get('pdf', id).catch(() => null);
    if (!cached) {
      toast('학습지를 받는 중…', 0);
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(res.status);
        await DB.put('pdf', { id, data: await res.arrayBuffer() });
      } catch (err) { toast('학습지를 받지 못했어요. 인터넷 연결을 확인해 주세요.', 4000); return; }
      meta = Object.assign(meta || { id, kind: 'sheet', added: Date.now() }, { file: url });
    }
    meta.name = sheet.title || sheet.id; meta.sheetId = sheet.id;
    await DB.put('meta', meta);
    $('#toast').hidden = true;
    openDoc(id);
  }

  // ════════════════ 문서 열기 ════════════════
  let loadToken = 0;
  async function openDoc(id) {
    const token = ++loadToken;
    const [meta, pdfRec, inkRec] = await Promise.all([DB.get('meta', id), DB.get('pdf', id), DB.get('ink', id)].map(p => p.catch(() => null)));
    if (!meta || !pdfRec) { toast('파일을 찾지 못했어요.'); return; }
    let lib;
    try { lib = await pdfjs(); } catch (e) { toast('PDF 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.', 4000); return; }
    let pdf;
    try {
      // 원본은 내보낼 때 다시 쓰므로 복사본을 넘김 (pdf.js가 넘겨받은 데이터를 비워 버림)
      pdf = await lib.getDocument({ data: new Uint8Array(pdfRec.data.slice(0)), isEvalSupported: false }).promise;
    } catch (e) { toast(e && e.name === 'PasswordException' ? '암호가 걸린 PDF는 열 수 없어요.' : 'PDF를 열지 못했어요. 파일이 손상됐을 수 있어요.', 4000); return; }
    if (token !== loadToken) return;
    resetRender();
    if (S.pdf && S.pdf !== pdf) { try { S.pdf.destroy(); } catch (e) {} }
    S.pdf = pdf; S.meta = meta; S.ink = (inkRec && inkRec.pages) || {}; S.hist = []; S.redo = [];
    S.pages = [];
    const first = await pdf.getPage(1), v1 = first.getViewport({ scale: 1 });
    for (let i = 0; i < pdf.numPages; i++) S.pages.push({ w: v1.width, h: v1.height, vp: null, el: null, pdfScale: 0, inkScale: 0 });
    S.pages[0].vp = v1;
    meta.pages = pdf.numPages; meta.opened = Date.now(); DB.put('meta', meta).catch(() => {});
    // 열 때는 늘 화면 폭에 맞춤 (휴대폰·태블릿을 오가도 어긋나지 않게). 마지막에 보던 쪽만 기억
    S.zoom = 1; S.cur = Math.min(meta.lastPage || 0, pdf.numPages - 1);
    buildPages();
    showViewer();
    // 나머지 쪽 크기는 뒤에서 차례로 읽어 맞춤 (쪽마다 크기가 다른 PDF)
    (async () => {
      for (let i = 1; i < pdf.numPages; i++) {
        if (token !== loadToken) return;
        const pg = await pdf.getPage(i + 1), v = pg.getViewport({ scale: 1 });
        S.pages[i].vp = v;
        if (Math.abs(v.width - S.pages[i].w) > 0.5 || Math.abs(v.height - S.pages[i].h) > 0.5) { S.pages[i].w = v.width; S.pages[i].h = v.height; scheduleLayout(); }
      }
    })().catch(() => {});
  }

  function buildPages() {
    pagesEl.innerHTML = '';
    S.pages.forEach((pg, i) => {
      const el = document.createElement('div');
      el.className = 'page loading'; el.dataset.i = i;
      el.innerHTML = `<canvas class="pdfc"></canvas><canvas class="inkc"></canvas><span class="pnum">${i + 1}</span>`;
      pg.el = el; pg.pdfScale = 0; pg.inkScale = 0;
      pagesEl.appendChild(el);
    });
  }

  function showViewer() {
    S.view = 'doc';
    home.hidden = true; viewer.hidden = false;
    $('#doc-title').textContent = S.meta.name;
    renderTools();
    layout();
    goPage(S.cur, false);
    updateVisible();
  }

  async function closeDoc() {
    await flushInk();
    if (S.present) exitPresent();
    if (S.meta) { S.meta.lastPage = S.cur; await DB.put('meta', S.meta).catch(() => {}); }
    loadToken++; resetRender();
    viewer.hidden = true; home.hidden = false; $('#thumbs').hidden = true;
    pagesEl.innerHTML = '';
    if (S.pdf) { try { S.pdf.destroy(); } catch (e) {} S.pdf = null; }
    renderHome();
  }

  // ════════════════ 배치·확대 ════════════════
  function baseScale() {
    const W = docEl.clientWidth, H = docEl.clientHeight;
    if (S.present) { const pg = S.pages[S.cur]; return Math.max(0.1, Math.min((W - 24) / pg.w, (H - 24) / pg.h)); }
    const maxW = Math.max(...S.pages.map(p => p.w));
    return Math.max(0.1, Math.min((W - 24) / maxW, 1100 / maxW));
  }
  function layout() {
    if (!S.pages.length) return;
    S.scale = baseScale() * S.zoom;
    const gap = Math.round(22 * Math.min(1.5, Math.max(0.6, S.zoom)));
    S.pages.forEach((pg, i) => {
      const st = pg.el.style;
      st.width = Math.round(pg.w * S.scale) + 'px'; st.height = Math.round(pg.h * S.scale) + 'px';
      st.marginBottom = gap + 'px';
      st.display = S.present && i !== S.cur ? 'none' : '';
    });
  }
  let layoutQueued = false;
  function scheduleLayout() { if (layoutQueued) return; layoutQueued = true; requestAnimationFrame(() => { layoutQueued = false; const a = anchor(); layout(); restore(a); updateVisible(); }); }
  // 확대해도 보던 곳이 그대로 있도록: 기준점 아래의 쪽과 그 안의 위치를 기억했다가 맞춤
  function anchor(cx, cy) {
    const r = docEl.getBoundingClientRect();
    if (cx == null) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
    let best = null, bd = Infinity;
    for (const pg of S.pages) {
      if (pg.el.style.display === 'none') continue;
      const pr = pg.el.getBoundingClientRect();
      const d = cy < pr.top ? pr.top - cy : cy > pr.bottom ? cy - pr.bottom : 0;
      if (d < bd) { bd = d; best = { pg, fx: (cx - pr.left) / pr.width, fy: (cy - pr.top) / pr.height, cx, cy }; }
      if (d === 0) break;
    }
    return best;
  }
  function restore(a, cx, cy) {
    if (!a) return;
    const pr = a.pg.el.getBoundingClientRect();
    docEl.scrollLeft += pr.left + a.fx * pr.width - (cx ?? a.cx);
    docEl.scrollTop += pr.top + a.fy * pr.height - (cy ?? a.cy);
  }
  function setZoom(z, cx, cy) {
    z = Math.max(0.5, Math.min(6, z));
    if (Math.abs(z - S.zoom) < 1e-3) return;
    const a = anchor(cx, cy);
    S.zoom = z; layout(); restore(a);
    updatePageNo();
    clearTimeout(setZoom.t); setZoom.t = setTimeout(updateVisible, 160);
  }
  window.addEventListener('resize', () => { if (S.view === 'doc') scheduleLayout(); });

  // ════════════════ 그리기 (PDF·필기) ════════════════
  const queue = new Set();
  let rendering = false, renderGen = 0;   // 문서를 바꾸면 renderGen이 올라가서, 그리던 중인 옛 작업은 손을 뗌
  function resetRender() { renderGen++; rendering = false; queue.clear(); }
  function updateVisible() {
    if (S.view !== 'doc') return;
    const r = docEl.getBoundingClientRect();
    const vis = [];
    S.pages.forEach((pg, i) => {
      if (pg.el.style.display === 'none') return;
      const pr = pg.el.getBoundingClientRect();
      if (pr.bottom > r.top - r.height * 0.6 && pr.top < r.bottom + r.height * 0.6) vis.push(i);
    });
    const keep = new Set();
    vis.forEach(i => { for (let j = i - 1; j <= i + 1; j++) if (j >= 0 && j < S.pages.length) keep.add(j); });
    // 멀리 있는 쪽은 그림을 비워 메모리를 아낌
    S.pages.forEach((pg, i) => {
      if (keep.has(i)) return;
      if (Math.abs(i - (vis[0] ?? S.cur)) > 3 && pg.pdfScale) {
        const c = pg.el.querySelector('.pdfc'), k = pg.el.querySelector('.inkc');
        c.width = c.height = 0; k.width = k.height = 0; pg.pdfScale = 0; pg.inkScale = 0; pg.el.classList.add('loading');
      }
    });
    for (const i of keep) { if (S.pages[i].inkScale !== S.scale) drawInk(i); if (S.pages[i].pdfScale !== S.scale) queue.add(i); }
    pump(vis);
    updatePageNo(vis);
  }
  async function pump(prefer = []) {
    if (rendering) return;
    rendering = true;
    const gen = renderGen;
    try {
      while (queue.size && S.view === 'doc' && gen === renderGen) {
        const list = [...queue];
        const i = list.find(x => prefer.includes(x)) ?? list[0];
        queue.delete(i);
        const pg = S.pages[i];
        if (!pg || pg.pdfScale === S.scale) continue;
        const scale = S.scale, pdf = S.pdf;
        const page = await pdf.getPage(i + 1);
        const cssW = pg.w * scale, cssH = pg.h * scale;
        let px = DPR(); if (cssW * cssH * px * px > MAX_PX) px = Math.sqrt(MAX_PX / (cssW * cssH));
        const vp = page.getViewport({ scale: scale * px });
        const c = document.createElement('canvas');
        c.className = 'pdfc'; c.width = Math.max(1, Math.floor(vp.width)); c.height = Math.max(1, Math.floor(vp.height));
        await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
        if (gen !== renderGen || pdf !== S.pdf) return;
        // 다 그린 뒤에 바꿔 끼워서, 확대할 때 하얗게 비는 순간이 없게
        const old = pg.el.querySelector('.pdfc'); pg.el.replaceChild(c, old); old.width = old.height = 0;
        pg.pdfScale = scale; pg.el.classList.remove('loading');
        if (scale !== S.scale) queue.add(i);
      }
    } catch (e) { /* 문서를 닫는 중에 생긴 오류는 무시 */ }
    if (gen !== renderGen) return;
    rendering = false;
    if (queue.size && S.view === 'doc') pump(prefer);
  }

  // 필기 캔버스: 쪽 크기 × 화면 배율. 선 좌표(pt) × k = 캔버스 픽셀
  function inkK(pg) {
    const cssW = pg.w * S.scale, cssH = pg.h * S.scale;
    let px = DPR(); if (cssW * cssH * px * px > MAX_PX) px = Math.sqrt(MAX_PX / (cssW * cssH));
    return S.scale * px;
  }
  function drawInk(i) {
    const pg = S.pages[i], c = pg.el.querySelector('.inkc'), k = inkK(pg);
    const w = Math.max(1, Math.floor(pg.w * k)), h = Math.max(1, Math.floor(pg.h * k));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    for (const s of S.ink[i] || []) paintStroke(ctx, s, k);
    pg.inkScale = S.scale;
  }
  const widthAt = (s, pr) => s.w * (0.45 + 1.1 * Math.max(0, Math.min(1, pr)));
  // 선 그리기: 점 사이를 부드러운 곡선으로. 펜 압력이 있으면 마디마다 굵기를 바꿈
  function paintStroke(ctx, s, k) {
    const P = s.p, n = P.length;
    if (!n) return;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = s.c;
    if (s.k === 'hl') { ctx.globalAlpha = HL_ALPHA; ctx.globalCompositeOperation = 'multiply'; }
    if (s.k === 'hl' || !s.pr || n < 3) {
      ctx.lineWidth = (s.k === 'hl' || !s.pr ? s.w : widthAt(s, P[0][2])) * k;
      ctx.beginPath(); ctx.moveTo(P[0][0] * k, P[0][1] * k);
      if (n === 1) ctx.lineTo(P[0][0] * k + 0.01, P[0][1] * k);
      else if (n === 2) ctx.lineTo(P[1][0] * k, P[1][1] * k);
      else {
        for (let i = 1; i < n - 1; i++) ctx.quadraticCurveTo(P[i][0] * k, P[i][1] * k, (P[i][0] + P[i + 1][0]) / 2 * k, (P[i][1] + P[i + 1][1]) / 2 * k);
        ctx.lineTo(P[n - 1][0] * k, P[n - 1][1] * k);
      }
      ctx.stroke();
    } else {
      segments(P, (a, c, b, pr) => {
        ctx.lineWidth = widthAt(s, pr) * k;
        ctx.beginPath(); ctx.moveTo(a[0] * k, a[1] * k); ctx.quadraticCurveTo(c[0] * k, c[1] * k, b[0] * k, b[1] * k); ctx.stroke();
      });
    }
    ctx.restore();
  }
  // 압력 선의 마디: (앞 중점) → 점 i(조절점) → (뒤 중점)
  function segments(P, fn) {
    const n = P.length, mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (let i = 0; i < n - 1; i++) {
      const a = i === 0 ? P[0] : mid(P[i - 1], P[i]);
      const b = i === n - 2 ? P[n - 1] : mid(P[i], P[i + 1]);
      const c = i === 0 ? mid(P[0], P[1]) : P[i];
      fn(a, c, b, (P[i][2] + P[i + 1][2]) / 2);
    }
  }

  // ════════════════ 손·펜 입력 ════════════════
  const ptrs = new Map();   // pointerId → { x, y, type }
  let mode = null;          // draw | erase | pan | pinch
  let live = null;          // 그리는 중: { i, s, canvas, k }
  let pan = null, pinch = null, erased = null, swipe = null;
  const liveCanvas = document.createElement('canvas');
  liveCanvas.className = 'livec';
  liveCanvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none';

  function pageAt(x, y) {
    for (let i = 0; i < S.pages.length; i++) {
      const pg = S.pages[i];
      if (pg.el.style.display === 'none') continue;
      const r = pg.el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { i, r };
    }
    return null;
  }
  const toPt = (e, r) => [(e.clientX - r.left) / S.scale, (e.clientY - r.top) / S.scale];
  const touchList = () => [...ptrs.values()].filter(p => p.type === 'touch');
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  docEl.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { docEl.setPointerCapture(e.pointerId); } catch (x) {}
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    stopFling();
    // 펜으로 쓰는 중에 닿는 손(손바닥)은 모두 무시. 반대로 손이 닿아 있어도 펜을 대면 펜이 이김
    const penBusy = (mode === 'draw' && live && live.type === 'pen') || (mode === 'erase' && erased && erased.type === 'pen');
    if (e.pointerType === 'touch' && penBusy) return;
    if (e.pointerType === 'pen' && (mode === 'pan' || mode === 'pinch')) { mode = null; pan = pinch = swipe = null; }
    if (e.pointerType === 'pen' && !S.penSeen) {
      S.penSeen = true; ls.set(K.pen, true);
      if (S.finger === 'auto') { renderTools(); toast('펜을 쓰고 있어서 손가락은 화면 옮기기로 바뀌었어요. (손바닥이 닿아도 안 써져요)', 3600); }
    }
    // 두 손가락 → 확대·이동 (손가락으로 막 긋던 선은 취소)
    if (e.pointerType === 'touch' && touchList().length >= 2) {
      if (live && live.type === 'touch') cancelLive();
      if (mode === 'erase' && erased && erased.type === 'touch') endErase();
      const [a, b] = touchList();
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      mode = 'pinch'; pinch = { d0: Math.max(10, dist(a, b)), z0: S.zoom, a: anchor(mx, my) };
      swipe = null;
      return;
    }
    if (mode === 'draw' || mode === 'erase' || mode === 'pinch') return;   // 펜으로 쓰는 중에 닿은 손바닥 무시
    const byFinger = e.pointerType === 'touch';
    if (byFinger && !fingerDraws()) {
      mode = 'pan'; pan = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), vx: 0, vy: 0 };
      swipe = S.present && S.zoom <= 1.02 ? { x0: e.clientX, y0: e.clientY } : null;
      return;
    }
    const hit = pageAt(e.clientX, e.clientY);
    if (!hit) {
      if (byFinger) { mode = 'pan'; pan = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), vx: 0, vy: 0 }; }
      return;
    }
    // S펜 옆 버튼·애플펜슬 지우개 끝(버튼 32) → 지우개
    const erase = S.tool === 'erase' || (e.pointerType === 'pen' && (e.buttons & 32));
    if (erase) { mode = 'erase'; erased = { type: e.pointerType, id: e.pointerId, items: [] }; eraseAt(hit.i, toPt(e, hit.r)); return; }
    const pen = PENS[S.pen];
    const pr = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
    const s = { k: pen.k, c: pen.c, w: SIZES[pen.k][S.size], p: [[...toPt(e, hit.r), pr]] };
    if (e.pointerType === 'pen' && pen.k === 'pen') s.pr = 1;
    mode = 'draw';
    const pg = S.pages[hit.i];
    liveCanvas.width = Math.max(1, Math.floor(pg.w * inkK(pg))); liveCanvas.height = Math.max(1, Math.floor(pg.h * inkK(pg)));
    pg.el.appendChild(liveCanvas);
    live = { i: hit.i, s, k: inkK(pg), type: e.pointerType, id: e.pointerId, r: hit.r, smooth: pr };
    paintLive();
  });

  docEl.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (mode === 'pinch') {
      const t = touchList(); if (t.length < 2) return;
      const [a, b] = t, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      S.zoom = Math.max(0.5, Math.min(6, pinch.z0 * dist(a, b) / pinch.d0));
      layout(); restore(pinch.a, mx, my);
      updatePageNo();
      return;
    }
    if (mode === 'pan' && pan && e.pointerId === pan.id) {
      const dx = e.clientX - pan.x, dy = e.clientY - pan.y, now = performance.now(), dt = Math.max(1, now - pan.t);
      docEl.scrollLeft -= dx; docEl.scrollTop -= dy;
      pan.vx = 0.8 * (dx / dt) + 0.2 * pan.vx; pan.vy = 0.8 * (dy / dt) + 0.2 * pan.vy;
      pan.x = e.clientX; pan.y = e.clientY; pan.t = now;
      return;
    }
    if (mode === 'draw' && live && e.pointerId === live.id) {
      // 빠르게 움직일 때 빠진 점까지 모두 받아서 펜 끝을 정확히 따라감
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ev of (evs.length ? evs : [e])) {
        const raw = live.type === 'pen' && ev.pressure > 0 ? ev.pressure : 0.5;
        live.smooth = live.smooth * 0.6 + raw * 0.4;
        const pt = toPt(ev, live.r), last = live.s.p[live.s.p.length - 1];
        if (Math.abs(pt[0] - last[0]) + Math.abs(pt[1] - last[1]) < 0.25) continue;
        live.s.p.push([pt[0], pt[1], live.smooth]);
      }
      if (!live.raf) live.raf = requestAnimationFrame(() => { live && (live.raf = 0, paintLive()); });
      return;
    }
    if (mode === 'erase' && erased && e.pointerId === erased.id) {
      const hit = pageAt(e.clientX, e.clientY);
      if (hit) for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : []).concat([e])) eraseAt(hit.i, toPt(ev, hit.r));
    }
  });

  function endPointer(e) {
    ptrs.delete(e.pointerId);
    if (mode === 'pinch') {
      if (touchList().length < 2) { mode = null; pinch = null; updateVisible(); }
      return;
    }
    if (mode === 'pan' && pan && e.pointerId === pan.id) {
      mode = null;
      if (swipe) {
        const dx = e.clientX - swipe.x0, dy = e.clientY - swipe.y0;
        swipe = null;
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) { goPage(S.cur + (dx < 0 ? 1 : -1)); pan = null; return; }
      }
      fling(pan.vx, pan.vy); pan = null;
      updateVisible();
      return;
    }
    if (mode === 'draw' && live && e.pointerId === live.id) { commitLive(); mode = null; return; }
    if (mode === 'erase' && erased && e.pointerId === erased.id) { endErase(); mode = null; }
  }
  docEl.addEventListener('pointerup', endPointer);
  docEl.addEventListener('pointercancel', e => { if (mode === 'draw' && live && e.pointerId === live.id) { cancelLive(); mode = null; } endPointer(e); });
  docEl.addEventListener('scroll', () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateVisible(); }); }, { passive: true });
  let scrollRaf = 0;
  // 마우스·트랙패드: Ctrl+휠(또는 두 손가락 오므리기)로 확대
  docEl.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(S.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
  }, { passive: false });
  // 사파리 두 손가락 확대(제스처)가 화면 전체를 키우지 않게
  for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, e => e.preventDefault(), { passive: false });

  let flingRaf = 0;
  function fling(vx, vy) {
    let v = [vx * 16, vy * 16];
    if (Math.hypot(...v) < 2) return;
    const step = () => {
      docEl.scrollLeft -= v[0]; docEl.scrollTop -= v[1];
      v = [v[0] * 0.93, v[1] * 0.93];
      flingRaf = Math.hypot(...v) > 0.4 ? requestAnimationFrame(step) : 0;
    };
    flingRaf = requestAnimationFrame(step);
  }
  function stopFling() { if (flingRaf) cancelAnimationFrame(flingRaf); flingRaf = 0; }

  function paintLive() {
    if (!live) return;
    const ctx = liveCanvas.getContext('2d');
    ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
    paintStroke(ctx, live.s, live.k);
  }
  function cancelLive() {
    if (!live) return;
    if (live.raf) cancelAnimationFrame(live.raf);
    liveCanvas.remove(); live = null;
  }
  function commitLive() {
    const { i, s } = live;
    if (live.raf) cancelAnimationFrame(live.raf);
    liveCanvas.remove(); live = null;
    s.p = s.p.map(([x, y, pr]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(pr * 100) / 100]);
    (S.ink[i] = S.ink[i] || []).push(s);
    S.hist.push({ t: 'add', i, s }); S.redo = [];
    const pg = S.pages[i];
    if (pg.inkScale === S.scale) paintStroke(pg.el.querySelector('.inkc').getContext('2d'), s, inkK(pg)); else drawInk(i);
    changed();
  }

  // 지우개: 닿은 선을 통째로 지움
  function eraseAt(i, [x, y]) {
    const list = S.ink[i]; if (!list || !list.length) return;
    const R = 6 / Math.min(S.scale, 3) + 2;   // 화면에서 손끝 정도 크기
    let hit = false;
    for (let j = list.length - 1; j >= 0; j--) {
      const s = list[j], pad = R + s.w / 2;
      if (s.p.some((q, n) => {
        if (n === 0) return Math.hypot(q[0] - x, q[1] - y) < pad;
        const a = s.p[n - 1];
        return segDist(x, y, a[0], a[1], q[0], q[1]) < pad;
      })) { erased.items.push({ i, s, at: j }); list.splice(j, 1); hit = true; }
    }
    if (hit) drawInk(i);
  }
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function endErase() {
    if (erased && erased.items.length) { S.hist.push({ t: 'erase', items: erased.items }); S.redo = []; changed(); }
    erased = null;
  }

  function undo() {
    const h = S.hist.pop(); if (!h) return;
    applyHist(h, true); S.redo.push(h); changed();
  }
  function redo() {
    const h = S.redo.pop(); if (!h) return;
    applyHist(h, false); S.hist.push(h); changed();
  }
  function applyHist(h, back) {
    const touched = new Set();
    if (h.t === 'add') {
      const list = S.ink[h.i] = S.ink[h.i] || [];
      if (back) { const j = list.lastIndexOf(h.s); if (j >= 0) list.splice(j, 1); } else list.push(h.s);
      touched.add(h.i);
    } else {
      // 지우기·쪽 지우기: 되돌릴 때는 원래 자리로
      const items = back ? h.items.slice().reverse() : h.items;
      for (const it of items) {
        const list = S.ink[it.i] = S.ink[it.i] || [];
        if (back) list.splice(Math.min(it.at, list.length), 0, it.s);
        else { const j = list.indexOf(it.s); if (j >= 0) list.splice(j, 1); }
        touched.add(it.i);
      }
    }
    for (const i of touched) if (S.pages[i]) drawInk(i);
    const first = [...touched][0];
    if (first != null && !onScreen(first)) goPage(first);
  }
  function clearPage(i) {
    const list = S.ink[i] || []; if (!list.length) return;
    const items = list.map((s, at) => ({ i, s, at })).reverse();
    S.ink[i] = [];
    S.hist.push({ t: 'erase', items }); S.redo = [];
    drawInk(i); changed();
  }

  // 저장: 바뀌면 잠시 뒤 한 번에
  let saveTimer = null;
  function changed() {
    updateUndo();
    clearTimeout(saveTimer); saveTimer = setTimeout(flushInk, 500);
  }
  async function flushInk() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!S.meta) return;
    const pages = {};
    let n = 0;
    for (const [i, list] of Object.entries(S.ink)) if (list && list.length) { pages[i] = list; n += list.length; }
    try {
      await DB.put('ink', { id: S.meta.id, pages, updated: Date.now() });
      if ((S.meta.inkCount || 0) !== n) { S.meta.inkCount = n; await DB.put('meta', S.meta); }
    } catch (e) { toast('필기를 저장하지 못했어요. 저장 공간을 확인해 주세요.', 4000); }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && S.meta) { flushInk(); S.meta.lastPage = S.cur; DB.put('meta', S.meta).catch(() => {}); } });
  window.addEventListener('pagehide', () => { if (S.meta) flushInk(); });

  // ════════════════ 쪽 이동 ════════════════
  function onScreen(i) {
    const r = docEl.getBoundingClientRect(), pr = S.pages[i].el.getBoundingClientRect();
    return pr.bottom > r.top && pr.top < r.bottom;
  }
  function goPage(i, smooth = false) {
    i = Math.max(0, Math.min(S.pages.length - 1, i));
    const changedPage = i !== S.cur;
    S.cur = i;
    if (S.present) {
      if (changedPage) S.zoom = 1;   // 새 쪽은 화면에 꽉 차게
      layout(); docEl.scrollTop = 0; docEl.scrollLeft = 0;
    }
    else {
      const el = S.pages[i].el;
      docEl.scrollTo({ top: el.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
    }
    updateVisible();
  }
  function updatePageNo(vis) {
    if (!S.pages.length) return;
    if (!S.present) {
      const r = docEl.getBoundingClientRect(), mid = r.top + r.height * 0.4;
      let best = S.cur, bd = Infinity;
      (vis && vis.length ? vis : S.pages.map((_, i) => i)).forEach(i => {
        const pr = S.pages[i].el.getBoundingClientRect();
        const d = mid < pr.top ? pr.top - mid : mid > pr.bottom ? mid - pr.bottom : 0;
        if (d < bd) { bd = d; best = i; }
      });
      S.cur = best;
    }
    const t = `${S.cur + 1} / ${S.pages.length}`;
    $('#pageno').textContent = t;
    const pn = $('#pbar .pageno'); if (pn) pn.textContent = t;
  }

  // ════════════════ 도구 막대 ════════════════
  function penButtons() {
    return PENS.map((p, n) => `<button class="tb" type="button" data-pen="${n}" aria-pressed="${S.tool === 'draw' && S.pen === n}" aria-label="${p.label}" title="${p.label}">
      <span class="dot${p.k === 'hl' ? ' hl' : ''}" style="background:${p.c}"></span></button>`).join('');
  }
  function renderTools() {
    const sheet = S.meta && S.meta.kind === 'sheet';
    const fd = fingerDraws();
    const sizeH = [2, 4, 7][S.size];
    $('#tools').innerHTML = `
      ${penButtons()}
      <button class="tb" type="button" data-a="erase" aria-pressed="${S.tool === 'erase'}">${I.erase}<span class="lbl">지우개</span></button>
      <button class="tb" type="button" data-a="size" title="굵기">${`<span class="size-line" style="height:${sizeH}px"></span>`}<span class="lbl">${SIZE_NAMES[S.size]}</span></button>
      <span class="sep"></span>
      <button class="tb" type="button" data-a="undo" aria-label="되돌리기">${I.undo}</button>
      <button class="tb" type="button" data-a="redo" aria-label="다시 하기">${I.redo}</button>
      <span class="sep"></span>
      <button class="tb" type="button" data-a="finger" aria-pressed="${fd}" title="손가락으로 쓰기">${fd ? I.finger : I.hand}<span class="lbl">${fd ? '손가락: 쓰기' : '손가락: 이동'}</span></button>
      <button class="tb" type="button" data-a="zoom-out" aria-label="축소">${I.minus}</button>
      <button class="tb" type="button" data-a="fit" aria-label="폭 맞춤">${I.fit}</button>
      <button class="tb" type="button" data-a="zoom-in" aria-label="확대">${I.plus}</button>
      ${FS_OK ? `<button class="tb" type="button" data-a="fullscreen" aria-pressed="${!!fsElement()}">${I.full}<span class="lbl">전체 화면</span></button>` : ''}
      <span class="sep"></span>
      <button class="tb" type="button" data-a="thumbs">${I.grid}<span class="lbl">쪽 목록</span></button>
      <button class="tb" type="button" data-a="clear-page">${I.trash}<span class="lbl">이 쪽 지우기</span></button>`;
    // 자주 찾는 [수업 화면]·[보내기]는 위 줄에 늘 보이게
    $('#bar-actions').innerHTML = `
      <button class="tb" type="button" data-a="present">${I.board}<span class="lbl">수업 화면</span></button>
      <button class="tb primary" type="button" data-a="send">${sheet ? I.send : I.save}<span class="lbl">${sheet ? '선생님께 보내기' : 'PDF로 저장'}</span></button>`;
    $('#pbar').innerHTML = `
      <button class="tb" type="button" data-a="prev" aria-label="이전 쪽">${I.prev}</button>
      <span class="pageno"></span>
      <button class="tb" type="button" data-a="next" aria-label="다음 쪽">${I.next}</button>
      <span class="sep"></span>
      ${penButtons()}
      <button class="tb" type="button" data-a="erase" aria-pressed="${S.tool === 'erase'}" aria-label="지우개">${I.erase}</button>
      <button class="tb" type="button" data-a="undo" aria-label="되돌리기">${I.undo}</button>
      <button class="tb" type="button" data-a="clear-page" aria-label="이 쪽 지우기">${I.trash}</button>
      <span class="sep"></span>
      <button class="tb" type="button" data-a="exit-present">${I.close}<span class="lbl">끝내기</span></button>`;
    updateUndo(); updatePageNo();
  }
  function updateUndo() {
    viewer.querySelectorAll('[data-a="undo"]').forEach(b => { b.disabled = !S.hist.length; });
    viewer.querySelectorAll('[data-a="redo"]').forEach(b => { b.disabled = !S.redo.length; });
  }
  let clearArmed = false;
  viewer.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !viewer.contains(b)) return;
    if (b.dataset.pen) { S.pen = Number(b.dataset.pen); S.tool = 'draw'; saveSettings(); renderTools(); return; }
    const a = b.dataset.a;
    if (a !== 'clear-page' && clearArmed) { clearArmed = false; }
    switch (a) {
      case 'home': closeDoc(); break;
      case 'erase': S.tool = 'erase'; saveSettings(); renderTools(); break;
      case 'size': S.size = (S.size + 1) % 3; saveSettings(); renderTools(); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'finger': S.finger = fingerDraws() ? 'pan' : 'draw'; saveSettings(); renderTools(); toast(fingerDraws() ? '손가락 하나로 쓸 수 있어요. 화면은 두 손가락으로 옮겨요.' : '손가락 하나로 화면을 옮겨요. 펜으로만 써져요.'); break;
      case 'zoom-in': setZoom(S.zoom * 1.25); break;
      case 'zoom-out': setZoom(S.zoom / 1.25); break;
      case 'fit': { const i = S.cur; S.zoom = 1; layout(); goPage(i); break; }
      case 'thumbs': openThumbs(); break;
      case 'clear-page':
        if (!(S.ink[S.cur] || []).length) { toast('이 쪽에는 지울 필기가 없어요.'); break; }
        if (!clearArmed) { clearArmed = true; toast(`한 번 더 누르면 ${S.cur + 1}쪽 필기를 모두 지워요. (되돌리기로 살릴 수 있어요)`, 3000); break; }
        clearArmed = false; clearPage(S.cur); toast(`${S.cur + 1}쪽 필기를 지웠어요.`); break;
      case 'fullscreen': fsElement() ? exitFullscreen() : enterFullscreen(); break;
      case 'present': enterPresent(); break;
      case 'exit-present': exitPresent(); break;
      case 'prev': goPage(S.cur - 1); break;
      case 'next': goPage(S.cur + 1); break;
      case 'send': openSend(); break;
    }
  });
  document.addEventListener('keydown', e => {
    if (S.view !== 'doc' || !$('#modal').hidden || e.target.tagName === 'INPUT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (S.present) {
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); goPage(S.cur + 1); }
      else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); goPage(S.cur - 1); }
      else if (e.key === 'Escape') exitPresent();
    } else if (e.key === 'PageDown') { e.preventDefault(); goPage(S.cur + 1, true); }
    else if (e.key === 'PageUp') { e.preventDefault(); goPage(S.cur - 1, true); }
  });

  // ════════════════ 전체 화면 ════════════════
  // 시계·배터리 줄까지 가리기. 아이패드 사파리·갤럭시탭 크롬·PC는 되고, 아이폰은 기기가 허용하지 않음 → 버튼을 아예 안 보여 줌
  const FS_OK = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  function enterFullscreen() {
    const el = document.documentElement, fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn) return;
    try { const p = fn.call(el); p && p.catch && p.catch(() => {}); } catch (e) {}
  }
  function exitFullscreen() {
    if (!fsElement()) return;
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    try { const p = fn.call(document); p && p.catch && p.catch(() => {}); } catch (e) {}
  }
  function onFullscreenChange() {
    viewer.querySelectorAll('[data-a="fullscreen"]').forEach(b => b.setAttribute('aria-pressed', String(!!fsElement())));
    // 수업 화면이 켠 전체 화면을 기기 쪽(스와이프·Esc)에서 끄면 수업 화면도 끝냄
    if (!fsElement() && S.present && S.fsByPresent) { S.fsByPresent = false; exitPresent(); return; }
    if (S.view === 'doc') scheduleLayout();
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // ════════════════ 수업 화면 ════════════════
  function enterPresent() {
    S.present = true; S.zoomBefore = S.zoom; S.zoom = 1;
    viewer.classList.add('present'); document.body.classList.add('presenting');
    // 이미 전체 화면이면 그대로, 아니면 수업 화면이 켜고 끝날 때 함께 끔
    S.fsByPresent = FS_OK && !fsElement();
    if (S.fsByPresent) enterFullscreen();
    layout(); goPage(S.cur);
    toast('수업 화면이에요. ◀ ▶ 버튼이나 키보드 화살표로 쪽을 넘겨요.', 2600);
  }
  function exitPresent() {
    if (!S.present) return;
    S.present = false; S.zoom = S.zoomBefore || 1;
    viewer.classList.remove('present'); document.body.classList.remove('presenting');
    if (S.fsByPresent) { S.fsByPresent = false; exitFullscreen(); }
    layout(); goPage(S.cur);
  }

  // ════════════════ 쪽 목록 ════════════════
  let thumbObs = null;
  function openThumbs() {
    const box = $('#thumbs'), grid = $('#thumbs-grid');
    grid.innerHTML = S.pages.map((pg, i) => `<button class="thumb${i === S.cur ? ' cur' : ''}" type="button" data-go="${i}">
      <span class="tp" style="aspect-ratio:${pg.w} / ${pg.h}"></span><span class="${(S.ink[i] || []).length ? 'has-ink' : ''}">${i + 1}${(S.ink[i] || []).length ? ' ✎' : ''}</span></button>`).join('');
    box.hidden = false;
    if (thumbObs) thumbObs.disconnect();
    thumbObs = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) { thumbObs.unobserve(en.target); drawThumb(en.target); } }), { root: box, rootMargin: '200px' });
    grid.querySelectorAll('.thumb').forEach(t => thumbObs.observe(t));
    const cur = grid.querySelector('.thumb.cur'); if (cur) cur.scrollIntoView({ block: 'center' });
  }
  async function drawThumb(btn) {
    const i = Number(btn.dataset.go), pg = S.pages[i], tp = btn.querySelector('.tp');
    try {
      const page = await S.pdf.getPage(i + 1);
      const w = 240, k = w / pg.w;
      const vp = page.getViewport({ scale: k });
      const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
      const ctx = c.getContext('2d');
      for (const s of S.ink[i] || []) paintStroke(ctx, s, k);
      tp.appendChild(c);
    } catch (e) {}
  }
  $('#thumbs').addEventListener('click', e => {
    const t = e.target.closest('[data-go]');
    $('#thumbs').hidden = true;
    if (t) goPage(Number(t.dataset.go));
  });

  // ════════════════ PDF로 내보내기 ════════════════
  // 원본 PDF에 필기를 선(벡터)으로 덧그림 → 글자는 그대로 선명하고 파일도 작음
  // 원본이 암호 등으로 고칠 수 없는 PDF면 쪽마다 그림으로 만들어 새 PDF로
  async function exportPdf() {
    await flushInk();
    await loadScript(`assets/vendor/pdf-lib.min.js${V}`);
    const { PDFDocument, rgb, LineCapStyle } = window.PDFLib;
    const rec = await DB.get('pdf', S.meta.id);
    const hex = c => rgb(parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255);
    const vps = [];
    for (let i = 0; i < S.pages.length; i++) vps[i] = S.pages[i].vp || (await S.pdf.getPage(i + 1)).getViewport({ scale: 1 });
    try {
      const doc = await PDFDocument.load(rec.data.slice(0), { ignoreEncryption: false, updateMetadata: false });
      const pages = doc.getPages();
      for (const [key, list] of Object.entries(S.ink)) {
        const i = Number(key), page = pages[i], vp = vps[i];
        if (!page || !list || !list.length) continue;
        const P = (x, y) => { const q = vp.convertToPdfPoint(x, y); return `${q[0].toFixed(2)} ${(-q[1]).toFixed(2)}`; };
        for (const s of list) {
          const opt = { x: 0, y: 0, borderColor: hex(s.c), borderLineCap: LineCapStyle.Round, borderOpacity: s.k === 'hl' ? HL_ALPHA : 1 };
          const pts = s.p;
          if (s.k === 'hl' || !s.pr || pts.length < 3) {
            let d = `M ${P(pts[0][0], pts[0][1])}`;
            if (pts.length === 1) d += ` L ${P(pts[0][0] + 0.01, pts[0][1])}`;
            else if (pts.length === 2) d += ` L ${P(pts[1][0], pts[1][1])}`;
            else {
              for (let n = 1; n < pts.length - 1; n++) d += ` Q ${P(pts[n][0], pts[n][1])} ${P((pts[n][0] + pts[n + 1][0]) / 2, (pts[n][1] + pts[n + 1][1]) / 2)}`;
              d += ` L ${P(pts[pts.length - 1][0], pts[pts.length - 1][1])}`;
            }
            page.drawSvgPath(d, Object.assign(opt, { borderWidth: s.k === 'hl' || !s.pr ? s.w : widthAt(s, pts[0][2]) }));
          } else {
            segments(pts, (a, c, b, pr) => page.drawSvgPath(`M ${P(a[0], a[1])} Q ${P(c[0], c[1])} ${P(b[0], b[1])}`, Object.assign({}, opt, { borderWidth: widthAt(s, pr) })));
          }
        }
      }
      return new Blob([await doc.save()], { type: 'application/pdf' });
    } catch (err) {
      const doc = await PDFDocument.create();
      for (let i = 0; i < S.pages.length; i++) {
        const page = await S.pdf.getPage(i + 1), vp1 = vps[i], k = Math.min(2, 2400 / Math.max(vp1.width, vp1.height));
        const vp = page.getViewport({ scale: k });
        const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        const ctx = c.getContext('2d', { alpha: false });
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        for (const s of S.ink[i] || []) paintStroke(ctx, s, k);
        const jpg = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
        const img = await doc.embedJpg(await jpg.arrayBuffer());
        doc.addPage([vp1.width, vp1.height]).drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        c.width = c.height = 0;
      }
      return new Blob([await doc.save()], { type: 'application/pdf' });
    }
  }

  // 보내기·저장 창. 공유하기는 버튼을 누른 그 순간에만 열 수 있어서, 파일을 먼저 만들어 두고 [보내기]를 누르게 함
  let prepared = null;
  const safeName = s => String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  function openSend() {
    if (S.present) exitPresent();
    const sheet = S.meta.kind === 'sheet';
    const name = ls.get(K.name, '') || ls.get('irae-homework-name', '') || '';
    const base = safeName(S.meta.name.replace(/\.pdf$/i, ''));
    const m = $('#modal'), card = $('#modal-card');
    card.innerHTML = sheet ? `
      <h2>선생님께 보내기</h2>
      <ol>
        <li><b>이름</b>을 확인해요.</li>
        <li><b>[카톡으로 보내기]</b> → 나오는 목록에서 <b>카카오톡</b> → <b>선생님</b>(또는 반 단톡방)을 골라 보내요.</li>
        <li>목록에 카톡이 없으면 <b>[파일로 저장]</b>한 뒤, 카톡 채팅방의 <b>+ → 파일</b>에서 골라 보내요.</li>
      </ol>
      <label for="send-name">이름</label><input id="send-name" autocomplete="name" value="${esc(name)}" placeholder="이름을 적어 주세요">
      <p class="msg" id="send-msg" role="status"></p>
      <div class="row"><button class="btn ghost" type="button" data-m="close">닫기</button><button class="btn ghost" type="button" data-m="download" disabled>파일로 저장</button><button class="btn" type="button" data-m="share" disabled>카톡으로 보내기</button></div>`
      : `
      <h2>PDF로 저장</h2>
      <p>필기가 들어간 PDF를 만들어요. 인쇄하거나 다른 사람에게 보낼 수 있어요.</p>
      <p class="msg" id="send-msg" role="status"></p>
      <div class="row"><button class="btn ghost" type="button" data-m="close">닫기</button><button class="btn ghost" type="button" data-m="share" disabled>공유하기</button><button class="btn" type="button" data-m="download" disabled>파일로 저장</button></div>`;
    m.hidden = false;
    prepared = null;
    const msg = $('#send-msg');
    msg.className = 'msg'; msg.textContent = '필기를 넣은 PDF를 만드는 중이에요…';
    const fileName = () => sheet ? `${safeName($('#send-name').value) || '이름없음'}-${base}.pdf` : `${base}-필기.pdf`;
    exportPdf().then(blob => {
      prepared = { blob, fileName };
      msg.textContent = `준비됐어요. (${Math.max(1, Math.round(blob.size / 1024))}KB)`;
      card.querySelectorAll('[data-m="share"],[data-m="download"]').forEach(b => { b.disabled = false; });
      if (!canShareFiles()) { const sb = card.querySelector('[data-m="share"]'); if (sb && !sheet) sb.hidden = true; }
    }).catch(() => { msg.className = 'msg err'; msg.textContent = 'PDF를 만들지 못했어요. 다시 시도해 주세요.'; });
    const ni = $('#send-name'); if (ni) ni.focus({ preventScroll: true });
  }
  function canShareFiles() {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'])], 'x.pdf', { type: 'application/pdf' })] })); } catch (e) { return false; }
  }
  $('#modal').addEventListener('click', e => {
    const b = e.target.closest('[data-m]');
    if (e.target.id === 'modal' || (b && b.dataset.m === 'close')) { $('#modal').hidden = true; return; }
    if (!b || !prepared) return;
    const sheet = S.meta.kind === 'sheet', msg = $('#send-msg');
    if (sheet) {
      const nm = $('#send-name').value.trim();
      if (!nm) { msg.className = 'msg err'; msg.textContent = '이름을 먼저 적어 주세요.'; $('#send-name').focus({ preventScroll: true }); return; }
      ls.set(K.name, nm);
    }
    const name = prepared.fileName();
    const file = new File([prepared.blob], name, { type: 'application/pdf' });
    const done = () => {
      if (!sheet) return;
      S.meta.sentAt = Date.now(); DB.put('meta', S.meta).catch(() => {});
    };
    if (b.dataset.m === 'share') {
      if (!canShareFiles()) { download(file); msg.className = 'msg'; msg.textContent = '이 기기에서는 바로 보내기가 안 돼서 파일로 저장했어요. 카톡 채팅방의 + → 파일에서 보내 주세요.'; done(); return; }
      navigator.share(Object.assign({ files: [file], title: name }, sheet ? { text: `[이레 노트] ${$('#send-name').value.trim()} - ${S.meta.name}` } : {}))
        .then(() => { msg.className = 'msg'; msg.textContent = sheet ? '보냈어요. 선생님 채팅방에 잘 갔는지 확인해 주세요.' : '공유했어요.'; done(); })
        .catch(err => { if (err && err.name === 'AbortError') return; download(file); msg.textContent = '공유가 안 돼서 파일로 저장했어요.'; done(); });
    } else if (b.dataset.m === 'download') {
      download(file); msg.className = 'msg'; msg.textContent = `‘${name}’ 파일로 저장했어요.${sheet ? ' 카톡 채팅방의 + → 파일에서 보내 주세요.' : ''}`; done();
    }
  });
  function download(file) {
    const url = URL.createObjectURL(file), a = document.createElement('a');
    a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // 점검용
  window.NOTE_DEBUG = { S, DB, exportPdf, flushInk, openDoc, openSheet, layout, updateVisible };
  renderHome();
})();
