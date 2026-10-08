/*
 * 이레 노트 — PDF를 바탕에 깔고 그 위에 펜·형광펜으로 쓰고 그리기
 * - PDF는 pdf.js(assets/vendor)로 그리고, 필기는 쪽마다 항목(선·글자·가림막) 목록으로 이 기기(IndexedDB)에 저장
 *   좌표는 PDF 크기 기준(확대해도 그대로)이라 확대·축소해도 선명하고, PDF로 내보낼 때도 그대로 옮겨짐
 * - 손가락: 펜(애플펜슬·S펜)을 한 번이라도 쓰면 손가락은 화면 옮기기만 함(손바닥 무시). 두 손가락은 언제나 확대·이동
 * - 선생님 학습지: sheets.js(선생님이 고치는 파일)의 목록 → 학생이 열어 쓰고 [선생님께 보내기]로 필기한 PDF를 카톡에 보냄
 * - 수업 화면: 한 쪽씩 화면 가득, 도구는 아래 작은 막대. 레이저 포인터·가림막·타이머·빈 쪽 넣기
 * - 학생 PDF 채점: 받은 PDF를 열어 빨간 펜·도장(○ ✓ ✗)으로 채점하고 점수를 찍어 돌려보냄 (채점 기록은 이 기기에)
 * - 자·각도기(가장자리를 따라 반듯하게), 좌표평면·수직선 쪽, 필기 다시 보기, 발표자 뽑기, 커튼, 사진 넣기, 쪽 정리, 오답 노트
 */
(function () {
  'use strict';
  const CFG = window.NOTE_CFG || {};
  const SHEETS = ((window.SHEETS && Array.isArray(window.SHEETS)) ? window.SHEETS : []).filter(s => s && s.id && s.file);
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const DPR = () => Math.min(window.devicePixelRatio || 1, 3);
  const MAX_PX = 5e6;   // 캔버스 한 장의 최대 픽셀 (아이패드 메모리 한도 안쪽)
  const r2 = v => Math.round(v * 100) / 100;

  // ── 저장 ──
  const ls = {
    get(k, f) { try { const v = localStorage.getItem(k); return v == null ? f : JSON.parse(v); } catch (e) { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const K = { name: 'irae-note-name', set: 'irae-note-settings', pen: 'irae-note-pen-seen', fav: 'irae-note-fav', roster: 'irae-note-roster', grades: 'irae-note-grades' };
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
  const TEXT_SIZES = [12, 18, 28];
  const STAMP_R = [9, 14, 20], STAMP_W = [1.6, 2.4, 3.2], STAMP_C = '#D2372A';
  const STAMPS = { o: '동그라미', v: '체크', x: '가위표' };
  const HL_ALPHA = 0.38;
  const FONT = '"IBM Plex Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  const TOOLS = ['draw', 'erase', 'laser', 'cover', 'text', 'lasso'];
  const A4 = { w: 595.28, h: 841.89 };
  const WRONG = 'wrong:main';   // 오답 노트 (PDF 없이 넣은 쪽만 있는 문서)
  const josa = (w, a, b) => { const c = String(w).charCodeAt(String(w).length - 1); return w + (c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 ? a : b); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const set0 = ls.get(K.set, {});
  const FAV0 = [{ pen: 0, size: 1 }, { pen: 1, size: 0 }, { pen: 3, size: 1 }];
  const favOk = f => f && PENS[f.pen] && [0, 1, 2].includes(f.size);
  const FAV = (a => Array.isArray(a) && a.length === 3 && a.every(favOk) ? a : FAV0.map(f => Object.assign({}, f)))(ls.get(K.fav, null));
  const S = {
    tool: TOOLS.includes(set0.tool) ? set0.tool : 'draw', pen: Number.isInteger(set0.pen) && PENS[set0.pen] ? set0.pen : 0, size: [0, 1, 2].includes(set0.size) ? set0.size : 1,
    finger: set0.finger || 'auto',   // auto(펜을 쓰면 이동) | draw | pan
    eraseMode: set0.eraseMode === 'part' ? 'part' : 'stroke',   // 선 통째로 | 문지른 부분만
    snap: set0.snap !== false,       // 긋고 멈추면 반듯한 도형으로
    stamp: 'o',
    penSeen: !!ls.get(K.pen, false),
    meta: null, pdf: null, pages: [], hist: [], redo: [],
    zoom: 1, scale: 1, cur: 0, present: false, view: 'home',
  };
  const saveSettings = () => ls.set(K.set, { tool: TOOLS.includes(S.tool) ? S.tool : 'draw', pen: S.pen, size: S.size, finger: S.finger, eraseMode: S.eraseMode, snap: S.snap });
  const fingerDraws = () => S.finger === 'draw' || (S.finger === 'auto' && !S.penSeen);
  const isGrade = () => !!(S.meta && S.meta.kind === 'grade');

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
    laser: '<svg viewBox="0 0 24 24"><circle cx="16.5" cy="7.5" r="2.5"/><path d="M14.7 9.3L4 20M16.5 2.5v1.5M21.5 7.5H20M20 4l-1 1"/></svg>',
    cover: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 18l7-12M13 18l6-10M3.5 14l5-8"/></svg>',
    text: '<svg viewBox="0 0 24 24"><path d="M5 7V5h14v2M12 5v14M9 19h6"/></svg>',
    lasso: '<svg viewBox="0 0 24 24"><path stroke-dasharray="3 2.4" d="M8 16c-3.4-1-5-3.4-4-6.2C5.6 5.6 12 4 16.6 5.6S21.6 12 17.4 14.4c-2.6 1.6-6 1.8-8.6 1.4"/><path d="M8.8 15.8c-1 1.6-.8 3 .6 4.4"/></svg>',
    timer: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.6 2M9.5 2.5h5M12 2.5V6"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/></svg>',
    pageAdd: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M12 10v7M8.5 13.5h7"/></svg>',
    ruler: '<svg viewBox="0 0 24 24"><path d="M3 16.5L16.5 3 21 7.5 7.5 21z"/><path d="M7 12.5l2 2M9.6 9.9l1.4 1.4M12 7.5l2 2M14.6 4.9l1.4 1.4"/></svg>',
    prot: '<svg viewBox="0 0 24 24"><path d="M3 18a9 9 0 0 1 18 0z"/><path d="M12 18l4.6-6.4M6.7 12.8l1 .8M12 9v1.4M17.3 12.8l-1 .8"/></svg>',
    photo: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/></svg>',
    curtain: '<svg viewBox="0 0 24 24"><path d="M3 4h18"/><path d="M5 4v8c2 0 3-1 3.5-3 .5 2 1.5 3 3.5 3s3-1 3.5-3c.5 2 1.5 3 3.5 3V4"/><path d="M5 16h14M5 19.5h14" stroke-dasharray="2 2.2"/></svg>',
  };

  // ── 날짜·버전 ──
  const fmtDate = t => { try { return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(t)); } catch (e) { return ''; } };
  // 마감일: 오늘·내일·며칠 남음·기한 지남 (한국 날짜 기준)
  function dueInfo(d, sent) {
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    const [, m, dd] = d.split('-').map(Number), md = `${m}월 ${dd}일`;
    if (sent) return { t: `${md}까지`, c: '' };
    let today;
    try { today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch (e) { return { t: `${md}까지`, c: '' }; }
    const diff = Math.round((Date.parse(d) - Date.parse(today)) / 864e5);
    if (diff < 0) return { t: `기한 지남 · ${md}까지였어요`, c: 'late' };
    if (diff === 0) return { t: '오늘까지', c: 'late' };
    if (diff === 1) return { t: '내일까지', c: 'soon' };
    if (diff <= 6) return { t: `${diff}일 남음 · ${md}까지`, c: 'soon' };
    return { t: `${md}까지`, c: '' };
  }
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
      <div class="docwrap">
        <div class="doc" id="doc"><div class="pages" id="pages"></div></div>
        <div class="guides" id="guides" aria-hidden="true"></div>
        <div class="replay" id="replay" hidden><button class="tb" type="button" data-a="rp-toggle"></button><button class="tb" type="button" data-a="rp-speed"></button><span class="rp-n" id="rp-n"></span><button class="tb" type="button" data-a="rp-stop">${I.close}<span class="lbl">그만 보기</span></button></div>
        <div class="timer" id="timer" hidden><button type="button" class="tt" data-a="timer-toggle" aria-label="타이머 멈춤·계속"></button><button type="button" class="tx" data-a="timer-close" aria-label="타이머 끄기">${I.close}</button></div>
        <div class="selbar" id="selbar" hidden><span id="sel-n"></span><button class="tb" type="button" data-a="sel-dup">복제</button><button class="tb" type="button" data-a="sel-del">${I.trash}<span class="lbl">지우기</span></button><button class="tb" type="button" data-a="sel-done">선택 끝</button></div>
      </div>
      <div class="thumbs" id="thumbs" hidden><div class="thumbs-bar"><b>쪽 목록</b><span class="thumbs-hint" id="thumbs-hint"></span><button class="btn ghost" type="button" data-t="edit">쪽 정리</button><button class="btn ghost" type="button" data-t="close">닫기</button></div><div class="thumbs-grid" id="thumbs-grid"></div></div>
      <div class="pbar" id="pbar" role="toolbar" aria-label="수업 화면 도구"></div>
      <canvas class="fx" id="fx" aria-hidden="true"></canvas>
    </div>
    <div class="modal" id="modal" hidden><div class="card" role="dialog" aria-modal="true" id="modal-card"></div></div>
    <div class="toast" id="toast" role="status" hidden></div>
    <input type="file" id="file-in" accept="application/pdf,.pdf" hidden>
    <input type="file" id="bk-in" accept=".json,application/json" hidden>
    <input type="file" id="img-in" accept="image/*" hidden>`;
  const home = $('#home'), viewer = $('#viewer'), docEl = $('#doc'), pagesEl = $('#pages');
  let toastTimer;
  function toast(text, ms = 2600) {
    const t = $('#toast'); t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ── 창(모달): 내용과 버튼 처리 함수를 함께 넘김 ──
  // onClose: 창이 닫힐 때(닫기·바깥 누름·처리 끝) 한 번 부름
  let modalFn = null, modalOnClose = null;
  function showModal(html, fn, onClose) { const c = $('#modal-card'); c.innerHTML = html; c.oninput = c.onchange = null; $('#modal').hidden = false; modalFn = fn || null; modalOnClose = onClose || null; }
  function closeModal() { $('#modal').hidden = true; modalFn = null; const f = modalOnClose; modalOnClose = null; if (f) f(); }
  $('#modal').addEventListener('click', e => {
    const b = e.target.closest('[data-m]');
    if (e.target.id === 'modal' || (b && b.dataset.m === 'close')) { closeModal(); return; }
    if (b && modalFn) modalFn(b, e);
  });

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
  let delArmed = null, pickKind = 'file';
  async function renderHome() {
    S.view = 'home';
    const metas = (await DB.all('meta').catch(() => [])).sort((a, b) => (b.opened || 0) - (a.opened || 0));
    const byId = new Map(metas.map(m => [m.id, m]));
    const sheetRows = SHEETS.map(s => {
      const m = byId.get('sheet:' + s.id);
      const sent = !!(m && m.sentAt);
      const state = sent ? `<span class="state sent">보냄 ${fmtDate(m.sentAt)}</span>` : m && m.inkCount ? `<span class="state doing">쓰는 중${m.inkPages && m.pages ? ` · ${m.inkPages}/${m.pages}쪽` : ''}</span>` : '';
      const due = dueInfo(s.due, sent);
      const sub = [due ? `<span class="due ${due.c}">${esc(due.t)}</span>` : '', s.note ? esc(s.note) : ''].filter(Boolean).join(' · ') || '눌러서 열기';
      return `<div class="item"><button class="main" type="button" data-sheet="${esc(s.id)}"><span class="name">${esc(s.title || s.id)}</span>
        <span class="sub">${sub}</span></button>${state}</div>`;
    }).join('');
    const row = m => {
      const gone = m.noPdf ? '<span class="due late">PDF 파일 없음 · 같은 PDF를 다시 열면 필기가 이어져요</span> · ' : '';
      const state = m.kind === 'grade' && m.sentAt ? `<span class="state sent">돌려줌 ${fmtDate(m.sentAt)}</span>` : '';
      const score = m.kind === 'grade' && m.score ? `<b class="score">${m.score.r}/${m.score.t}</b> · ` : '';
      const clips = m.kind === 'wrong' && m.clips ? `문제 ${m.clips}개 · ` : '';
      return `<div class="item"><button class="main" type="button" data-open="${esc(m.id)}"><span class="name">${esc(m.name)}</span>
      <span class="sub">${gone}${score}${clips}${m.pages ? m.pages + '쪽 · ' : ''}${m.inkCount ? '필기 있음 · ' : ''}${fmtDate(m.opened || m.added)}</span></button>${state}
      <button class="del${delArmed === m.id ? ' armed' : ''}" type="button" data-del="${esc(m.id)}">${delArmed === m.id ? '한 번 더 누르면 삭제' : '삭제'}</button></div>`;
    };
    const fileRows = metas.filter(m => m.kind === 'file').map(row).join('');
    const gradeRows = metas.filter(m => m.kind === 'grade').map(row).join('');
    const wrongRow = metas.filter(m => m.kind === 'wrong').map(row).join('');
    home.innerHTML = `
      <header>
        <h1>${esc(CFG.title || '이레 노트')}</h1>
        <p class="lead">PDF를 열어 그 위에 펜으로 쓰고 그려요. 쓴 내용은 이 기기에 저장돼서 다시 열면 그대로 있어요.</p>
      </header>
      ${SHEETS.length || CFG.alwaysSheets ? `<h2>선생님 학습지</h2><div class="list">${sheetRows || '<p class="empty">아직 올라온 학습지가 없어요.</p>'}</div>` : ''}
      <h2>내 PDF <button class="btn" type="button" data-a="pick">PDF 열기</button></h2>
      <div class="list">${fileRows || '<p class="empty">아직 연 PDF가 없어요. [PDF 열기]로 휴대폰·태블릿에 있는 PDF를 골라 보세요.<br>PDF는 인터넷에 올라가지 않고 이 기기 안에서만 열려요.</p>'}</div>
      <h2>오답 노트</h2>
      <div class="list">${wrongRow || '<p class="empty">학습지·PDF를 보다가 [더보기 → 오답 노트에 담기]를 누르고 틀린 문제를 상자로 두르면 여기에 모여요. 빈 곳에 다시 풀어 볼 수 있어요.</p>'}</div>
      <h2>학생 PDF 채점 <span class="h2-btns"><button class="btn ghost" type="button" data-a="grades">채점 기록</button><button class="btn ghost" type="button" data-a="pick-grade">학생 PDF 열기</button></span></h2>
      <div class="list">${gradeRows || '<p class="empty">선생님용이에요. 학생이 카톡으로 보낸 PDF를 열면 빨간 펜과 ○ ✓ ✗ 도장으로 채점하고, [채점 돌려주기]로 다시 보낼 수 있어요.</p>'}</div>
      <h2>필기 백업</h2>
      <div class="bk-row">
        <button class="btn ghost" type="button" data-a="backup">백업 파일 만들기</button>
        <button class="btn ghost" type="button" data-a="restore">백업 불러오기</button>
      </div>
      <p class="hint">필기는 이 기기에만 저장돼요. 기기를 바꾸거나 앱을 지우기 전에 백업 파일을 만들어 두고, 새 기기에서 불러오세요.</p>
      <footer>애플펜슬·S펜으로 쓰면 손바닥이 닿아도 괜찮아요 · 두 손가락으로 확대하고 옮겨요<br>선을 긋고 펜을 떼지 않은 채 잠깐 멈추면 반듯한 직선·원·사각형으로 바뀌어요<br>휴대폰 앱처럼 쓰기 · 아이패드: 사파리 공유 → ‘홈 화면에 추가’ · 갤럭시탭: 크롬 메뉴(⋮) → ‘앱 설치’${VER_TAG}</footer>`;
  }

  home.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.a === 'pick') { pickKind = 'file'; $('#file-in').click(); return; }
    if (b.dataset.a === 'pick-grade') { pickKind = 'grade'; $('#file-in').click(); return; }
    if (b.dataset.a === 'backup') { openBackup(); return; }
    if (b.dataset.a === 'grades') { openGrades(); return; }
    if (b.dataset.a === 'restore') { $('#bk-in').click(); return; }
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
    const kind = pickKind;
    try {
      const buf = await f.arrayBuffer();
      // 같은 파일(이름·크기 같음)을 다시 고르면 예전 필기를 이어서 (백업에서 불러와 PDF가 없던 것도 여기서 다시 이어짐)
      const metas = await DB.all('meta').catch(() => []);
      const same = metas.find(m => m.kind === kind && m.name === f.name && m.size === f.size);
      const id = same ? same.id : kind + ':' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await DB.put('pdf', { id, data: buf });
      const meta = Object.assign(same || { id, kind, added: Date.now() }, { name: f.name, size: f.size });
      delete meta.noPdf;
      await DB.put('meta', meta);
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
    meta.name = sheet.title || sheet.id; meta.sheetId = sheet.id; delete meta.noPdf;
    await DB.put('meta', meta);
    $('#toast').hidden = true;
    openDoc(id);
  }

  // ════════════════ 문서 열기 ════════════════
  // 쪽 = { src: PDF 쪽 번호(0부터) | blank: 'plain'|'lines'|'grid' (넣은 빈 쪽), w, h, ink: [항목…] }
  // 항목: 선 { k:'pen'|'hl', c, w, p:[[x,y,압력]], pr?, sh?(반듯한 도형) } · 글자 { k:'text', x, y, t, c, fs, tw, th } · 가림막 { k:'cover', x, y, cw, ch }
  let loadToken = 0;
  async function openDoc(id) {
    const token = ++loadToken;
    const [meta, pdfRec, inkRec] = await Promise.all([DB.get('meta', id), DB.get('pdf', id), DB.get('ink', id)].map(p => p.catch(() => null)));
    const bare = !!(meta && meta.kind === 'wrong');   // 오답 노트: PDF 없이 넣은 쪽만
    if (meta && !pdfRec && meta.noPdf && !bare) { toast('이 기기에 PDF 파일이 없어요. [PDF 열기]로 같은 PDF를 고르면 필기가 이어져요.', 5000); return; }
    if (!meta || (!pdfRec && !bare)) { toast('파일을 찾지 못했어요.'); return; }
    let pdf = null;
    if (!bare) {
      let lib;
      try { lib = await pdfjs(); } catch (e) { toast('PDF 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.', 4000); return; }
      try {
        // 원본은 내보낼 때 다시 쓰므로 복사본을 넘김 (pdf.js가 넘겨받은 데이터를 비워 버림)
        pdf = await lib.getDocument({ data: new Uint8Array(pdfRec.data.slice(0)), isEvalSupported: false }).promise;
      } catch (e) { toast(e && e.name === 'PasswordException' ? '암호가 걸린 PDF는 열 수 없어요.' : 'PDF를 열지 못했어요. 파일이 손상됐을 수 있어요.', 4000); return; }
    }
    if (token !== loadToken) return;
    resetRender(); clearSel(); stopTimer(); stopReplay(); curtains.clear(); G.ruler = G.prot = null;
    if (S.pdf && S.pdf !== pdf) { try { S.pdf.destroy(); } catch (e) {} }
    S.pdf = pdf; S.meta = meta; S.hist = []; S.redo = [];
    const v1 = pdf ? (await pdf.getPage(1)).getViewport({ scale: 1 }) : { width: A4.w, height: A4.h };
    const n = pdf ? pdf.numPages : 0;
    // 쪽 순서(넣은 빈 쪽·옮긴 쪽·복사한 쪽)가 저장돼 있으면 그대로. 학습지가 바뀌어 쪽 수가 달라지면 없는 쪽은 빼고 빠진 쪽은 뒤에 붙임
    let order = inkRec && Array.isArray(inkRec.order) ? inkRec.order.filter(o => o && (o.b ? o.w > 0 && o.h > 0 : Number.isInteger(o.s) && o.s >= 0 && o.s < n)) : null;
    if (order) {
      const have = new Set(order.filter(o => !o.b).map(o => o.s));
      for (let s = 0; s < n; s++) if (!have.has(s)) order.push({ s });
    }
    if (!order) order = Array.from({ length: n }, (_, s) => ({ s }));
    if (!order.length) order = [{ b: 'plain', w: A4.w, h: A4.h }];
    const saved = (inkRec && inkRec.pages) || {};
    S.pages = order.map((o, i) => o.b ? newPage({ blank: o.b, w: o.w, h: o.h }, saved[i]) : newPage({ src: o.s, w: v1.width, h: v1.height }, saved[i]));
    S.pages.forEach(pg => { if (pg.src === 0) pg.vp = v1; });
    meta.pages = S.pages.length; meta.opened = Date.now(); DB.put('meta', meta).catch(() => {});
    // 채점할 PDF는 빨간 펜으로 시작
    if (meta.kind === 'grade') { S.pen = 1; S.tool = 'draw'; }
    else if (S.tool === 'stamp') S.tool = 'draw';
    // 열 때는 늘 화면 폭에 맞춤 (휴대폰·태블릿을 오가도 어긋나지 않게). 마지막에 보던 쪽만 기억
    S.zoom = 1; S.cur = Math.min(meta.lastPage || 0, S.pages.length - 1);
    buildPages();
    showViewer();
    // 나머지 쪽 크기는 뒤에서 차례로 읽어 맞춤 (쪽마다 크기가 다른 PDF)
    (async () => {
      for (let s = 1; s < n; s++) {
        if (token !== loadToken) return;
        const pgp = await pdf.getPage(s + 1), v = pgp.getViewport({ scale: 1 });
        for (const pg of S.pages.filter(p => p.src === s)) {
          pg.vp = v;
          if (Math.abs(v.width - pg.w) > 0.5 || Math.abs(v.height - pg.h) > 0.5) { pg.w = v.width; pg.h = v.height; scheduleLayout(); }
        }
      }
    })().catch(() => {});
  }
  function newPage(o, ink) {
    return Object.assign({ src: null, blank: null, vp: null, el: null, pdfScale: 0, inkScale: 0, ink: Array.isArray(ink) ? ink : [] }, o);
  }

  function makePageEl(pg) {
    const el = document.createElement('div');
    el.className = 'page loading';
    el.innerHTML = '<canvas class="pdfc"></canvas><canvas class="inkc"></canvas><div class="covers"></div><span class="pnum"></span>';
    pg.el = el; pg.pdfScale = 0; pg.inkScale = 0;
    return el;
  }
  function buildPages() {
    pagesEl.innerHTML = '';
    S.pages.forEach(pg => pagesEl.appendChild(makePageEl(pg)));
    renumber();
  }
  function renumber() {
    S.pages.forEach((pg, i) => { pg.el.dataset.i = i; pg.el.querySelector('.pnum').textContent = (i + 1) + (pg.blank ? ' · 넣은 쪽' : ''); });
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
    stopReplay();
    await flushInk();
    if (S.present) exitPresent();
    clearSel(); stopTimer();
    G.ruler = G.prot = null; renderGuides(); curtains.clear();
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
    renderGuides();
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
  const queue = new Set();   // 다시 그릴 쪽(쪽 객체)
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
    for (const i of keep) { const pg = S.pages[i]; if (pg.inkScale !== S.scale) drawInk(i); if (pg.pdfScale !== S.scale) queue.add(pg); }
    pump(vis.map(i => S.pages[i]));
    updatePageNo(vis);
  }
  async function pump(prefer = []) {
    if (rendering) return;
    rendering = true;
    const gen = renderGen;
    try {
      while (queue.size && S.view === 'doc' && gen === renderGen) {
        const list = [...queue];
        const pg = list.find(x => prefer.includes(x)) ?? list[0];
        queue.delete(pg);
        if (!S.pages.includes(pg) || pg.pdfScale === S.scale) continue;
        const scale = S.scale, pdf = S.pdf;
        const cssW = pg.w * scale, cssH = pg.h * scale;
        let px = DPR(); if (cssW * cssH * px * px > MAX_PX) px = Math.sqrt(MAX_PX / (cssW * cssH));
        const c = document.createElement('canvas');
        c.className = 'pdfc';
        if (pg.blank) {
          c.width = Math.max(1, Math.floor(cssW * px)); c.height = Math.max(1, Math.floor(cssH * px));
          paintPattern(c.getContext('2d', { alpha: false }), pg, scale * px);
        } else {
          const page = await pdf.getPage(pg.src + 1);
          const vp = page.getViewport({ scale: scale * px });
          c.width = Math.max(1, Math.floor(vp.width)); c.height = Math.max(1, Math.floor(vp.height));
          await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
        }
        if (gen !== renderGen || pdf !== S.pdf) return;
        // 다 그린 뒤에 바꿔 끼워서, 확대할 때 하얗게 비는 순간이 없게
        const old = pg.el.querySelector('.pdfc'); pg.el.replaceChild(c, old); old.width = old.height = 0;
        pg.pdfScale = scale; pg.el.classList.remove('loading');
        if (scale !== S.scale) queue.add(pg);
      }
    } catch (e) { /* 문서를 닫는 중에 생긴 오류는 무시 */ }
    if (gen !== renderGen) return;
    rendering = false;
    if (queue.size && S.view === 'doc') pump(prefer);
  }
  // 넣은 빈 쪽의 바탕: 백지·줄 노트·모눈·좌표평면·수직선
  // 선 [x0, y0, x1, y1, 색, 굵기] · 숫자 [x, y, 글, 크기, 맞춤(l|c|r), 기준(top|mid)] — 화면과 PDF가 같은 목록으로 그림
  const PATTERN = { plain: '백지', lines: '줄 노트', grid: '모눈', coord: '좌표평면', numline: '수직선' };
  const PC = { light: '#DCE3EC', line: '#C5D0DE', axis: '#4A5566' };
  const NUM_FONT = 'Helvetica, Arial, sans-serif';
  const num = String;   // 빼기는 PDF 기본 글꼴에 있는 '-'로
  function patternSpec(pg) {
    const L = [], T = [], { w, h } = pg, A = PC.axis;
    const arrow = (x, y, dx, dy) => { const s = 6, n = 3.5; L.push([x, y, x - dx * s - dy * n, y - dy * s + dx * n, A, 1], [x, y, x - dx * s + dy * n, y - dy * s - dx * n, A, 1]); };
    if (pg.blank === 'lines') for (let y = 56; y < h - 24; y += 26) L.push([28, y, w - 28, y, PC.line, 0.6]);
    if (pg.blank === 'grid') { for (let x = 18; x < w; x += 18) L.push([x, 0, x, h, PC.light, 0.6]); for (let y = 18; y < h; y += 18) L.push([0, y, w, y, PC.light, 0.6]); }
    if (pg.blank === 'coord') {
      const c = 20, cx = r2(w / 2), cy = r2(h / 2), nx = Math.floor((w / 2 - 30) / c), ny = Math.floor((h / 2 - 34) / c);
      for (let i = -nx; i <= nx; i++) if (i) L.push([cx + i * c, cy - ny * c, cx + i * c, cy + ny * c, PC.light, 0.6]);
      for (let j = -ny; j <= ny; j++) if (j) L.push([cx - nx * c, cy + j * c, cx + nx * c, cy + j * c, PC.light, 0.6]);
      const xr = cx + nx * c + 14, yt = cy - ny * c - 14;
      L.push([cx - nx * c - 6, cy, xr, cy, A, 1], [cx, cy + ny * c + 6, cx, yt, A, 1]);
      arrow(xr, cy, 1, 0); arrow(cx, yt, 0, -1);
      for (let i = -nx; i <= nx; i++) if (i) { L.push([cx + i * c, cy - 2.5, cx + i * c, cy + 2.5, A, 0.8]); T.push([cx + i * c, cy + 5, num(i), 7, 'c', 'top']); }
      for (let j = -ny; j <= ny; j++) if (j) { L.push([cx - 2.5, cy - j * c, cx + 2.5, cy - j * c, A, 0.8]); T.push([cx - 5, cy - j * c, num(j), 7, 'r', 'mid']); }
      T.push([cx - 4, cy + 4, 'O', 8, 'r', 'top'], [xr + 4, cy, 'x', 10, 'l', 'mid'], [cx + 8, yt + 2, 'y', 10, 'l', 'mid']);
    }
    if (pg.blank === 'numline') {
      const u = (w - 110) / 20, x0 = w / 2 - 10 * u, x1 = w / 2 + 10 * u;
      for (let y = 100; y < h - 50; y += 130) {
        L.push([x0 - 16, y, x1 + 16, y, A, 1]); arrow(x1 + 16, y, 1, 0); arrow(x0 - 16, y, -1, 0);
        for (let i = -10; i <= 10; i++) { const x = r2(w / 2 + i * u), t = i ? 4 : 7; L.push([x, y - t, x, y + t, A, 0.8]); T.push([x, y + 9, num(i), 7.5, 'c', 'top']); }
      }
    }
    return { L, T };
  }
  function paintPattern(ctx, pg, k) {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pg.w * k, pg.h * k);
    const { L, T } = patternSpec(pg);
    ctx.lineCap = 'round';
    for (const [x0, y0, x1, y1, c, w] of L) { ctx.strokeStyle = c; ctx.lineWidth = Math.max(0.5, w * k); ctx.beginPath(); ctx.moveTo(x0 * k, y0 * k); ctx.lineTo(x1 * k, y1 * k); ctx.stroke(); }
    ctx.fillStyle = PC.axis;
    for (const [x, y, t, size, al, base] of T) {
      ctx.font = `${size * k}px ${NUM_FONT}`; ctx.textAlign = { l: 'left', c: 'center', r: 'right' }[al]; ctx.textBaseline = base === 'top' ? 'top' : 'middle';
      ctx.fillText(t, x * k, y * k);
    }
  }

  // 필기 캔버스: 쪽 크기 × 화면 배율. 좌표(pt) × k = 캔버스 픽셀
  function inkK(pg) {
    const cssW = pg.w * S.scale, cssH = pg.h * S.scale;
    let px = DPR(); if (cssW * cssH * px * px > MAX_PX) px = Math.sqrt(MAX_PX / (cssW * cssH));
    return S.scale * px;
  }
  // off: 옮기거나 크기를 바꾸는 중인 선택 항목 { set, dx, dy } | { set, f, ox, oy }
  const xf = (off, x, y) => off.f ? [off.ox + (x - off.ox) * off.f, off.oy + (y - off.oy) * off.f] : [x + off.dx, y + off.dy];
  function drawInk(i, off) {
    const pg = S.pages[i]; if (!pg) return;
    const c = pg.el.querySelector('.inkc'), k = inkK(pg);
    const w = Math.max(1, Math.floor(pg.w * k)), h = Math.max(1, Math.floor(pg.h * k));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    // 다시 보기 중인 쪽은 지금까지 나온 것만
    const list = RP && RP.pg === pg ? RP.items.slice(0, RP.i) : pg.ink;
    for (const s of list) {
      if (off && off.set.has(s)) {
        ctx.save();
        if (off.f) { ctx.translate(off.ox * k, off.oy * k); ctx.scale(off.f, off.f); ctx.translate(-off.ox * k, -off.oy * k); }
        else ctx.translate(off.dx * k, off.dy * k);
        paintItem(ctx, s, k); ctx.restore();
      } else paintItem(ctx, s, k);
    }
    pg.inkScale = S.scale;
    renderCovers(pg, off);
  }
  const drawPg = pg => { const i = S.pages.indexOf(pg); if (i >= 0) drawInk(i); };
  function paintItem(ctx, s, k) {
    if (s.k === 'text') paintText(ctx, s, k);
    else if (s.k === 'img') paintImg(ctx, s, k);
    else if (s.k === 'pen' || s.k === 'hl') paintStroke(ctx, s, k);
  }
  // 사진: 항목에 그림(JPEG 데이터)을 그대로 담아 두고, 처음 그릴 때 한 번 읽어 둠
  const imgCache = new WeakMap();
  function imgOf(s) {
    let im = imgCache.get(s);
    if (!im) {
      im = new Image();
      im.onload = () => { const pg = S.pages.find(p => p.ink.includes(s)); if (pg && pg.inkScale) drawPg(pg); };
      im.src = s.src; imgCache.set(s, im);
    }
    return im;
  }
  const loadImgs = list => Promise.all(list.filter(s => s.k === 'img').map(s => {
    const im = imgOf(s);
    return im.complete && im.naturalWidth ? null : new Promise(r => { im.addEventListener('load', r, { once: true }); im.addEventListener('error', r, { once: true }); });
  }));
  function paintImg(ctx, s, k) {
    const im = imgOf(s);
    if (im.complete && im.naturalWidth) ctx.drawImage(im, s.x * k, s.y * k, s.iw * k, s.ih * k);
    else { ctx.save(); ctx.fillStyle = '#EEF2F7'; ctx.fillRect(s.x * k, s.y * k, s.iw * k, s.ih * k); ctx.restore(); }
  }
  const widthAt = (s, pr) => s.w * (0.45 + 1.1 * Math.max(0, Math.min(1, pr)));
  // 선 그리기: 점 사이를 부드러운 곡선으로. 펜 압력이 있으면 마디마다 굵기를 바꿈. 반듯한 도형(sh)은 꺾인 그대로
  function paintStroke(ctx, s, k) {
    const P = s.p, n = P.length;
    if (!n) return;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = s.c;
    if (s.k === 'hl') { ctx.globalAlpha = HL_ALPHA; ctx.globalCompositeOperation = 'multiply'; }
    if (s.sh) {
      ctx.lineWidth = s.w * k;
      ctx.beginPath(); ctx.moveTo(P[0][0] * k, P[0][1] * k);
      for (let i = 1; i < n; i++) ctx.lineTo(P[i][0] * k, P[i][1] * k);
      if (n === 1) ctx.lineTo(P[0][0] * k + 0.01, P[0][1] * k);
      ctx.stroke();
    } else if (s.k === 'hl' || !s.pr || n < 3) {
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
  // 글자 상자
  const LINE_H = 1.3;
  const measureCtx = document.createElement('canvas').getContext('2d');
  function measureText(s) {
    const lines = String(s.t).split('\n');
    measureCtx.font = `500 100px ${FONT}`;
    s.tw = r2(Math.max(...lines.map(l => measureCtx.measureText(l).width)) / 100 * s.fs + 2);
    s.th = r2(lines.length * s.fs * LINE_H);
    return s;
  }
  function paintText(ctx, s, k) {
    ctx.save();
    ctx.fillStyle = s.c; ctx.textBaseline = 'top'; ctx.font = `500 ${s.fs * k}px ${FONT}`;
    String(s.t).split('\n').forEach((l, n) => ctx.fillText(l, s.x * k, (s.y + n * s.fs * LINE_H + s.fs * 0.12) * k));
    ctx.restore();
  }

  // 가림막: 쪽 위의 상자(DOM). 누르면 열리고 다시 누르면 닫힘. 열린 상태는 저장하지 않음(다시 열면 모두 가려짐)
  const opened = new WeakSet();
  function renderCovers(pg, off) {
    const layer = pg.el && pg.el.querySelector('.covers'); if (!layer) return;
    const list = pg.ink.filter(s => s.k === 'cover');
    layer.innerHTML = list.map(s => {
      const o = off && off.set.has(s) ? off : { dx: 0, dy: 0 }, [x, y] = xf(o, s.x, s.y), f = o.f || 1;
      return `<div class="cover${opened.has(s) ? ' open' : ''}" style="left:${x / pg.w * 100}%;top:${y / pg.h * 100}%;width:${s.cw * f / pg.w * 100}%;height:${s.ch * f / pg.h * 100}%"><span>${opened.has(s) ? '' : '눌러서 보기'}</span></div>`;
    }).join('');
  }
  function coverAt(pg, [x, y]) {
    for (let j = pg.ink.length - 1; j >= 0; j--) {
      const s = pg.ink[j];
      if (s.k === 'cover' && x >= s.x && x <= s.x + s.cw && y >= s.y && y <= s.y + s.ch) return s;
    }
    return null;
  }
  function toggleCoverAt(pg, pt) {
    const s = coverAt(pg, pt); if (!s) return false;
    if (opened.has(s)) opened.delete(s); else opened.add(s);
    renderCovers(pg);
    return true;
  }

  // ── 항목 공통: 범위·닿음·옮기기 ──
  const isBox = s => s.k === 'cover' || s.k === 'text' || s.k === 'img';
  function bounds(s) {
    if (s.k === 'cover') return [s.x, s.y, s.x + s.cw, s.y + s.ch];
    if (s.k === 'text') return [s.x, s.y, s.x + s.tw, s.y + s.th];
    if (s.k === 'img') return [s.x, s.y, s.x + s.iw, s.y + s.ih];
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const q of s.p) { a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[0]); d = Math.max(d, q[1]); }
    const h = s.w / 2;
    return [a - h, b - h, c + h, d + h];
  }
  function hitItem(s, x, y, R) {
    if (isBox(s)) { const [a, b, c, d] = bounds(s); return x >= a - R && x <= c + R && y >= b - R && y <= d + R; }
    const pad = R + s.w / 2;
    return s.p.some((q, n) => n === 0 ? Math.hypot(q[0] - x, q[1] - y) < pad : segDist(x, y, s.p[n - 1][0], s.p[n - 1][1], q[0], q[1]) < pad);
  }
  function translate(s, dx, dy) {
    if (isBox(s)) { s.x = r2(s.x + dx); s.y = r2(s.y + dy); }
    else s.p = s.p.map(([x, y, pr]) => [r2(x + dx), r2(y + dy), pr]);
  }
  // 크기 바꾸기: (ox, oy)를 기준으로 f배. 선은 굵기도 함께
  function scaleItem(s, ox, oy, f) {
    const X = v => r2(ox + (v - ox) * f), Y = v => r2(oy + (v - oy) * f);
    if (isBox(s)) { s.x = X(s.x); s.y = Y(s.y); }
    if (s.k === 'cover') { s.cw = r2(s.cw * f); s.ch = r2(s.ch * f); }
    else if (s.k === 'img') { s.iw = r2(s.iw * f); s.ih = r2(s.ih * f); }
    else if (s.k === 'text') { s.fs = r2(Math.max(4, s.fs * f)); measureText(s); }
    else { s.p = s.p.map(([x, y, pr]) => [X(x), Y(y), pr]); s.w = r2(Math.max(0.3, s.w * f)); }
  }
  // 되돌리기용: 모양에 관한 값만 떠 둠 (사진 데이터는 빼고)
  const GEO = ['x', 'y', 'p', 'w', 'fs', 'tw', 'th', 'cw', 'ch', 'iw', 'ih'];
  const geo = s => { const o = {}; for (const k of GEO) if (k in s) o[k] = s[k]; return JSON.parse(JSON.stringify(o)); };
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // ════════════════ 도형 맞춤: 긋고 잠깐 멈추면 반듯하게 ════════════════
  const pathLen = P => { let L = 0; for (let i = 1; i < P.length; i++) L += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); return L; };
  function rdp(P, eps) {
    if (P.length < 3) return P.slice();
    const a = P[0], b = P[P.length - 1];
    let dm = 0, idx = 0;
    for (let i = 1; i < P.length - 1; i++) { const d = segDist(P[i][0], P[i][1], a[0], a[1], b[0], b[1]); if (d > dm) { dm = d; idx = i; } }
    if (dm <= eps) return [a, b];
    return rdp(P.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(P.slice(idx), eps));
  }
  function polyErr(P, Vx, closed) {
    let sum = 0;
    const m = closed ? Vx.length : Vx.length - 1;
    for (const q of P) {
      let best = Infinity;
      for (let i = 0; i < m; i++) { const a = Vx[i], b = Vx[(i + 1) % Vx.length]; best = Math.min(best, segDist(q[0], q[1], a[0], a[1], b[0], b[1])); }
      sum += best;
    }
    return sum / P.length;
  }
  // 닫힌 모양의 꼭짓점: 시작점에서 가장 먼 점으로 둘로 나눠 각각 줄이고, 꼭짓점이 아닌 시작점은 뺌
  function closedCorners(P, eps) {
    let far = 0, fd = 0;
    P.forEach((q, i) => { const d = Math.hypot(q[0] - P[0][0], q[1] - P[0][1]); if (d > fd) { fd = d; far = i; } });
    let Vx = rdp(P.slice(0, far + 1), eps).slice(0, -1).concat(rdp(P.slice(far), eps).slice(0, -1));
    Vx = Vx.filter((v, i) => i === 0 || Math.hypot(v[0] - Vx[i - 1][0], v[1] - Vx[i - 1][1]) > eps);
    if (Vx.length > 3) {
      const a = Vx[Vx.length - 1], b = Vx[1];
      if (segDist(Vx[0][0], Vx[0][1], a[0], a[1], b[0], b[1]) < eps) Vx.shift();
    }
    return Vx;
  }
  function recognize(P0) {
    const P = P0.map(q => [q[0], q[1]]);
    if (P.length < 3) return null;
    const xs = P.map(q => q[0]), ys = P.map(q => q[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const D = Math.hypot(x1 - x0, y1 - y0), tol = 4 / S.scale;
    if (D < 16 / S.scale) return null;
    const a = P[0], b = P[P.length - 1], L = pathLen(P), ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // 직선: 수평·수직·45°에 가까우면 딱 맞춤
    let dev = 0; for (const q of P) dev = Math.max(dev, segDist(q[0], q[1], a[0], a[1], b[0], b[1]));
    if (ab > 0.85 * L && dev < Math.max(tol, ab * 0.06)) {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), q = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      const e = Math.abs(ang - q) < 0.08 ? [a[0] + ab * Math.cos(q), a[1] + ab * Math.sin(q)] : b;
      return { type: 'line', p: [a, e] };
    }
    if (ab < 0.3 * D) {
      // 삼각형·사각형
      const Vx = closedCorners(P, 0.07 * D);
      if ((Vx.length === 3 || Vx.length === 4) && polyErr(P, Vx, true) / D < 0.035) {
        let poly = Vx;
        const axis = Vx.length === 4 && Vx.every((v, i) => { const w = Vx[(i + 1) % 4], t = Math.abs(Math.atan2(w[1] - v[1], w[0] - v[0])) % (Math.PI / 2); return Math.min(t, Math.PI / 2 - t) < 0.21; });
        if (axis) poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        return { type: Vx.length === 3 ? 'triangle' : 'rect', p: poly.concat([poly[0]]) };
      }
      // 원·타원 (거의 동그라면 원으로)
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      let rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
      if (rx < tol || ry < tol) return null;
      let e = 0; for (const q of P) e += Math.abs(Math.hypot((q[0] - cx) / rx, (q[1] - cy) / ry) - 1);
      if (e / P.length < 0.1) {
        if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.18) rx = ry = (rx + ry) / 2;
        return { type: 'ellipse', p: Array.from({ length: 65 }, (_, i) => { const t = i / 64 * Math.PI * 2; return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]; }) };
      }
      return null;
    }
    // 꺾은선 (각도·꺾인 화살표 몸통)
    const Vx = rdp(P, 0.05 * D);
    if (Vx.length >= 3 && Vx.length <= 4 && polyErr(P, Vx, false) / D < 0.03) return { type: 'poly', p: Vx };
    return null;
  }

  // ════════════════ 레이저 포인터·지우개 동그라미 (화면 위 효과) ════════════════
  const fx = $('#fx');
  const FX = { trail: [], head: null, ring: null, raf: 0 };
  const LASER_LIFE = 700;
  function fxKick() { if (!FX.raf) FX.raf = requestAnimationFrame(fxFrame); }
  function fxFrame() {
    FX.raf = 0;
    const dpr = DPR(), W = window.innerWidth, H = window.innerHeight;
    if (fx.width !== Math.round(W * dpr) || fx.height !== Math.round(H * dpr)) { fx.width = Math.round(W * dpr); fx.height = Math.round(H * dpr); }
    const ctx = fx.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const now = performance.now();
    FX.trail = FX.trail.filter(p => now - p.t < LASER_LIFE);
    ctx.lineCap = 'round';
    for (let n = 1; n < FX.trail.length; n++) {
      const a = FX.trail[n - 1], b = FX.trail[n]; if (b.gap) continue;
      const al = 1 - (now - b.t) / LASER_LIFE;
      ctx.strokeStyle = `rgba(255,45,45,${(al * 0.85).toFixed(3)})`; ctx.lineWidth = 2.5 + 4 * al;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    if (FX.head) {
      ctx.fillStyle = 'rgba(255,45,45,.22)'; ctx.beginPath(); ctx.arc(FX.head.x, FX.head.y, 15, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#FF2D2D'; ctx.beginPath(); ctx.arc(FX.head.x, FX.head.y, 6, 0, Math.PI * 2); ctx.fill();
    }
    if (FX.ring) {
      ctx.strokeStyle = 'rgba(60,70,85,.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.arc(FX.ring.x, FX.ring.y, FX.ring.r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    if (FX.trail.length) FX.raf = requestAnimationFrame(fxFrame);
  }

  // ════════════════ 자·각도기 ════════════════
  // 화면 위에 떠 있는 도구(쪽을 옮겨도 그 자리). 위치 (x, y)는 문서 칸 왼쪽 위 기준 화면 px, a는 돌린 각(라디안)
  // 몸통을 끌면 옮기고, 두 손가락이나 ↻ 손잡이로 돌림(15°마다 살짝 붙음). 펜을 가장자리에 대고 그으면 반듯한 선, 각도기 바깥 둘레는 둥근 선
  const G = { ruler: null, prot: null };
  const guidesEl = $('#guides');
  const RULER_H = 64, CM = 72 / 2.54;
  const rulerLen = () => Math.round(Math.min(Math.max(guidesEl.clientWidth * 0.85, 240), 760));
  const protR = () => Math.round(clamp(Math.min(guidesEl.clientWidth, guidesEl.clientHeight) * 0.3, 110, 190));
  const degOf = a => Math.round(((-a * 180 / Math.PI) % 180 + 180) % 180) % 180;
  function snapAng(a) {
    a = Math.atan2(Math.sin(a), Math.cos(a));
    const d = a * 180 / Math.PI, n = Math.round(d / 15) * 15;
    return Math.abs(d - n) < 2.2 ? n * Math.PI / 180 : a;
  }
  function toggleGuide(kind) {
    if (G[kind]) G[kind] = null;
    else {
      const w = guidesEl.clientWidth, h = guidesEl.clientHeight;
      G[kind] = { x: w / 2, y: kind === 'ruler' ? h * 0.42 : h * 0.62, a: 0 };
      toast(kind === 'ruler' ? '자: 끌어서 옮기고, 두 손가락이나 ↻로 돌려요. 펜을 자 가장자리에 대고 그으면 반듯한 선이에요. 눈금은 종이의 cm예요.'
        : '각도기: 끌어서 옮기고, 두 손가락이나 ↻로 돌려요. 아래 곧은 쪽에 대고 그으면 반듯한 선, 둥근 둘레를 따라 그으면 둥근 선이에요.', 4600);
    }
    renderGuides(); renderTools();
  }
  function renderGuides() {
    for (const kind of ['ruler', 'prot']) {
      let el = guidesEl.querySelector('.' + kind);
      const g = G[kind];
      if (!g || S.view !== 'doc') { if (el) el.remove(); continue; }
      if (!el) { el = document.createElement('div'); el.className = 'guide ' + kind; guidesEl.appendChild(el); }
      if (kind === 'ruler') {
        const L = rulerLen(), H = RULER_H, key = `${L}|${S.scale}|${DPR()}`;
        if (el.dataset.key !== key) {
          el.dataset.key = key; el.style.width = L + 'px'; el.style.height = H + 'px';
          el.innerHTML = '<canvas></canvas><span class="gdeg"></span><span class="gknob">↻</span>';
          drawRulerTicks(el.querySelector('canvas'), L, H);
        }
        el.style.transform = `translate(${g.x - L / 2}px, ${g.y - H / 2}px) rotate(${g.a}rad)`;
      } else {
        const R = protR(), key = String(R);
        if (el.dataset.key !== key) {
          el.dataset.key = key; el.style.width = 2 * R + 'px'; el.style.height = R + 'px'; el.style.transformOrigin = `${R}px ${R}px`;
          el.innerHTML = protSvg(R) + `<span class="gdeg" style="left:${R}px;top:${R * 0.8}px"></span><span class="gknob" style="left:${R}px;top:${R * 0.6}px">↻</span>`;
        }
        el.style.transform = `translate(${g.x - R}px, ${g.y - R}px) rotate(${g.a}rad)`;
      }
      el.querySelector('.gdeg').textContent = degOf(g.a) + '°';
    }
  }
  // 자 눈금: 종이 위 실제 cm (확대하면 눈금도 커짐). 위아래 가장자리 모두
  function drawRulerTicks(c, L, H) {
    const d = DPR(); c.width = Math.round(L * d); c.height = Math.round(H * d);
    const ctx = c.getContext('2d'); ctx.scale(d, d);
    const cm = CM * S.scale, x0 = 14, step = cm / 10 >= 4 ? 1 : cm / 2 >= 5 ? 5 : 10;
    const every = Math.max(1, Math.ceil(26 / cm));
    ctx.strokeStyle = '#2C3E5C'; ctx.fillStyle = '#2C3E5C'; ctx.lineWidth = 1;
    ctx.font = `11px ${NUM_FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.beginPath();
    for (let i = 0; x0 + i * cm / 10 <= L - 10; i += step) {
      const x = Math.round(x0 + i * cm / 10) + 0.5, t = i % 10 === 0 ? 15 : i % 5 === 0 ? 10 : 6;
      ctx.moveTo(x, 0); ctx.lineTo(x, t); ctx.moveTo(x, H); ctx.lineTo(x, H - t);
      if (i % 10 === 0 && (i / 10) % every === 0 && x < L - 50) ctx.fillText(String(i / 10), x, 17);
    }
    ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('cm', 8, H / 2);
  }
  function protSvg(R) {
    let ticks = '', labels = '';
    const fine = R >= 150;
    for (let d = 0; d <= 180; d++) {
      if (!fine && d % 5) continue;
      const t = d * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), l = d % 10 === 0 ? 15 : d % 5 === 0 ? 10 : 5;
      ticks += `M${(R + R * c).toFixed(1)} ${(R - R * s).toFixed(1)}L${(R + (R - l) * c).toFixed(1)} ${(R - (R - l) * s).toFixed(1)}`;
      if (d % 10 === 0) {
        labels += `<text x="${(R + (R - 25) * c).toFixed(1)}" y="${(R - (R - 25) * s).toFixed(1)}" class="lo">${d}</text>`;
        if (R >= 130 && d % 30 === 0) labels += `<text x="${(R + (R - 42) * c).toFixed(1)}" y="${(R - (R - 42) * s).toFixed(1)}" class="li">${180 - d}</text>`;
      }
    }
    return `<svg width="${2 * R}" height="${R}" viewBox="0 0 ${2 * R} ${R}"><path class="pf" d="M0.5 ${R}A${R - 0.5} ${R - 0.5} 0 0 1 ${2 * R - 0.5} ${R}Z"/><path class="pt" d="${ticks}M${R} ${R}V${R - 10}M${R - 9} ${R - 0.5}H${R + 9}"/>${labels}</svg>`;
  }
  // 화면 점 → 도구 기준 (u: 길이 방향, v: 수직, 아래가 +)
  function gLocal(g, cx, cy) {
    const r = guidesEl.getBoundingClientRect(), dx = cx - r.left - g.x, dy = cy - r.top - g.y, c = Math.cos(g.a), s = Math.sin(g.a);
    return [dx * c + dy * s, -dx * s + dy * c];
  }
  function gClient(g, u, v) {
    const r = guidesEl.getBoundingClientRect(), c = Math.cos(g.a), s = Math.sin(g.a);
    return [r.left + g.x + u * c - v * s, r.top + g.y + u * s + v * c];
  }
  // 닿은 곳: knob(돌리기) | body(옮기기) | edge(곧은 가장자리, v0) | arc(둥근 둘레, r). 가장자리는 펜으로 쓸 때만
  function guideHit(cx, cy, drawer) {
    if (G.prot) {
      const g = G.prot, R = protR(), [u, v] = gLocal(g, cx, cy), rr = Math.hypot(u, v);
      if (Math.hypot(u, v + R * 0.4) < 22) return { kind: 'prot', part: 'knob' };
      if (drawer && Math.abs(u) <= R && v >= -8 && v <= 28) return { kind: 'prot', part: 'edge', v0: 0, half: R };
      if (drawer && v < -8 && rr >= R - 8 && rr <= R + 28) return { kind: 'prot', part: 'arc', r: Math.max(R, rr) };
      if (v <= 0 && rr <= R) return { kind: 'prot', part: 'body' };
    }
    if (G.ruler) {
      const g = G.ruler, L = rulerLen(), H = RULER_H, [u, v] = gLocal(g, cx, cy);
      if (Math.hypot(u - (L / 2 - 28), v) < 20) return { kind: 'ruler', part: 'knob' };
      if (Math.abs(u) <= L / 2) {
        const av = Math.abs(v);
        if (drawer && av >= H / 2 - 8 && av <= H / 2 + 28) return { kind: 'ruler', part: 'edge', v0: Math.sign(v || 1) * H / 2, half: L / 2 };
        if (av <= H / 2) return { kind: 'ruler', part: 'body' };
      }
    }
    return null;
  }
  // 펜 위치를 가장자리·둘레에 붙인 화면 점들
  function guidePoints(a, cx, cy) {
    const gh = a.guide, g = G[gh.kind]; if (!g) return null;
    const [u, v] = gLocal(g, cx, cy);
    if (gh.part === 'edge') return [gClient(g, clamp(u, -gh.half, gh.half), gh.v0)];
    const ph = Math.atan2(v, u);
    if (a.phPrev == null) { a.ph0 = ph; a.phPrev = ph; a.acc = 0; }
    let d = ph - a.phPrev; d = Math.atan2(Math.sin(d), Math.cos(d));
    a.acc = clamp(a.acc + d, -Math.PI * 2, Math.PI * 2); a.phPrev = ph;
    const n = Math.max(1, Math.ceil(Math.abs(a.acc) / (Math.PI / 90)));
    return Array.from({ length: n + 1 }, (_, i) => { const t = a.ph0 + a.acc * i / n; return gClient(g, gh.r * Math.cos(t), gh.r * Math.sin(t)); });
  }
  let gd = null;   // 자·각도기를 잡고 옮기는 중
  function startGuide(e, gh) {
    const g = G[gh.kind], r = guidesEl.getBoundingClientRect();
    mode = 'guide';
    gd = { kind: gh.kind, type: e.pointerType, id: e.pointerId, knob: gh.part === 'knob', x0: e.clientX, y0: e.clientY, gx: g.x, gy: g.y, a0: g.a, ang0: Math.atan2(e.clientY - r.top - g.y, e.clientX - r.left - g.x) };
  }
  function moveGuide(e) {
    const g = G[gd.kind]; if (!g) return;
    if (gd.two) {
      const a = ptrs.get(gd.id), b = ptrs.get(gd.two.id); if (!a || !b) return;
      const t = Math.atan2(b.y - a.y, b.x - a.x), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      g.a = snapAng(gd.two.a0 + t - gd.two.t0); g.x = gd.two.gx + mx - gd.two.mx; g.y = gd.two.gy + my - gd.two.my;
    } else if (e.pointerId === gd.id) {
      if (gd.knob) { const r = guidesEl.getBoundingClientRect(); g.a = snapAng(gd.a0 + Math.atan2(e.clientY - r.top - g.y, e.clientX - r.left - g.x) - gd.ang0); }
      else { g.x = gd.gx + e.clientX - gd.x0; g.y = gd.gy + e.clientY - gd.y0; }
    } else return;
    g.x = clamp(g.x, 0, guidesEl.clientWidth); g.y = clamp(g.y, 0, guidesEl.clientHeight);
    renderGuides();
  }
  function guideSecond(e) {
    const g = G[gd.kind], a = ptrs.get(gd.id); if (!g || !a) return;
    gd.two = { id: e.pointerId, t0: Math.atan2(e.clientY - a.y, e.clientX - a.x), mx: (a.x + e.clientX) / 2, my: (a.y + e.clientY) / 2, gx: g.x, gy: g.y, a0: g.a };
  }
  function endGuide(e) {
    const g = G[gd.kind];
    if (gd.two && (e.pointerId === gd.id || e.pointerId === gd.two.id)) {
      // 두 손가락 중 하나를 떼면 남은 손가락으로 계속 옮기기
      const rest = e.pointerId === gd.id ? gd.two.id : gd.id, p = ptrs.get(rest);
      if (p && g) gd = { kind: gd.kind, type: gd.type, id: rest, knob: false, x0: p.x, y0: p.y, gx: g.x, gy: g.y, a0: g.a };
      else { mode = null; gd = null; }
      return;
    }
    if (e.pointerId === gd.id) { mode = null; gd = null; }
  }

  // ════════════════ 커튼: 쪽을 위에서부터 가려 두고 조금씩 내려 보여 주기 (저장하지 않음) ════════════════
  const curtains = new Map();   // 쪽 객체 → 보이는 높이(pt)
  function toggleCurtain() {
    const pg = S.pages[S.cur]; if (!pg) return;
    if (curtains.has(pg)) { curtains.delete(pg); toast('커튼을 걷었어요.'); }
    else { curtains.set(pg, 0); toast('커튼: 아래로 끌거나 톡 누를 때마다 조금씩 보여요. 위로 끌면 다시 가려요.', 3600); }
    renderCurtain(pg);
  }
  function renderCurtain(pg) {
    if (!pg.el) return;
    let el = pg.el.querySelector('.curtain');
    if (!curtains.has(pg)) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div'); el.className = 'curtain';
      el.innerHTML = '<span class="cg">▼ 끌어 내리거나 톡</span>';
      pg.el.appendChild(el); bindCurtain(el, pg);
    }
    const y = curtains.get(pg);
    el.style.top = y / pg.h * 100 + '%'; el.style.height = (1 - y / pg.h) * 100 + '%';
  }
  function bindCurtain(el, pg) {
    let drag = null;
    el.addEventListener('pointerdown', e => {
      e.stopPropagation(); e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      drag = { id: e.pointerId, y0: e.clientY, x0: e.clientX, v0: curtains.get(pg) || 0, t0: performance.now(), moved: false };
    });
    el.addEventListener('pointermove', e => {
      e.stopPropagation();
      if (!drag || e.pointerId !== drag.id) return;
      const dy = (e.clientY - drag.y0) / S.scale;
      if (Math.abs(e.clientY - drag.y0) > 6) drag.moved = true;
      if (drag.moved) { curtains.set(pg, clamp(drag.v0 + dy, 0, pg.h)); renderCurtain(pg); }
    });
    const up = e => {
      e.stopPropagation();
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved) curtains.set(pg, clamp((curtains.get(pg) || 0) + pg.h * 0.12, 0, pg.h));
      drag = null;
      if (curtains.get(pg) >= pg.h - 0.5) { curtains.delete(pg); toast('끝까지 다 보였어요.'); }
      renderCurtain(pg);
    };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  }

  // ════════════════ 필기 다시 보기: 이 쪽에 쓴 순서대로 다시 그림 ════════════════
  let RP = null;
  const rpDur = s => (s.k === 'pen' || s.k === 'hl') ? Math.max(180, s.p.length * (s.sh ? 6 : 9)) : 260;
  function startReplay() {
    stopReplay(); clearSel();
    const pg = S.pages[S.cur], items = pg.ink.filter(s => s.k !== 'cover');
    if (!items.length) { toast('이 쪽에는 다시 볼 필기가 없어요.'); return; }
    RP = { pg, items, i: 0, t: 0, speed: 1, playing: true, last: performance.now(), scale: 0, kk: 0 };
    drawPg(pg);
    $('#replay').hidden = false; replayBar();
    RP.raf = requestAnimationFrame(stepReplay);
  }
  function stepReplay(now) {
    if (!RP) return;
    RP.raf = 0;
    const dt = Math.min(64, now - RP.last); RP.last = now;
    const pg = RP.pg;
    if (RP.scale !== S.scale || !liveCanvas.isConnected) { RP.kk = liveOn(pg); RP.scale = S.scale; drawPg(pg); }
    const ctx = liveCanvas.getContext('2d');
    if (RP.playing) {
      RP.t += dt * RP.speed;
      while (RP.i < RP.items.length && RP.t >= rpDur(RP.items[RP.i]) + 140) {
        RP.t -= rpDur(RP.items[RP.i]) + 140;
        paintItem(pg.el.querySelector('.inkc').getContext('2d'), RP.items[RP.i], inkK(pg));
        RP.i++;
      }
      ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
      const s = RP.items[RP.i];
      if (s && (s.k === 'pen' || s.k === 'hl')) {
        const m = Math.ceil(s.p.length * Math.min(1, RP.t / rpDur(s)));
        if (m >= 1) paintStroke(ctx, Object.assign({}, s, { p: s.p.slice(0, m) }), RP.kk);
      }
      if (RP.i >= RP.items.length) { RP.playing = false; RP.done = true; }
      replayBar();
    }
    if (RP && RP.playing) RP.raf = requestAnimationFrame(stepReplay);
  }
  function replayBar() {
    if (!RP) return;
    const b = $('#replay');
    b.querySelector('[data-a="rp-toggle"]').innerHTML = RP.done ? '처음부터' : RP.playing ? '멈춤' : '계속';
    b.querySelector('[data-a="rp-speed"]').textContent = `빠르기 ×${RP.speed}`;
    $('#rp-n').textContent = `${Math.min(RP.i + (RP.done ? 0 : 1), RP.items.length)} / ${RP.items.length}`;
  }
  function replayToggle() {
    if (!RP) return;
    if (RP.done) { const pg = RP.pg; Object.assign(RP, { i: 0, t: 0, done: false, playing: true }); drawPg(pg); }
    else RP.playing = !RP.playing;
    RP.last = performance.now(); replayBar();
    if (RP.playing && !RP.raf) RP.raf = requestAnimationFrame(stepReplay);
  }
  function stopReplay() {
    if (!RP) return;
    const pg = RP.pg;
    if (RP.raf) cancelAnimationFrame(RP.raf);
    RP = null; liveCanvas.remove();
    $('#replay').hidden = true;
    if (pg.el && S.pages.includes(pg)) drawPg(pg);
  }

  // ════════════════ 손·펜 입력 ════════════════
  const ptrs = new Map();   // pointerId → { x, y, type }
  let mode = null;          // act(한 손가락·펜으로 하는 일) | pan | pinch
  let act = null;           // { k: draw|erase|laser|cover|text|stamp|lasso|move, type, id, … }
  let pan = null, pinch = null, swipe = null;
  const liveCanvas = document.createElement('canvas');
  liveCanvas.className = 'livec';
  liveCanvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:3';

  function pageAt(x, y) {
    for (let i = 0; i < S.pages.length; i++) {
      const pg = S.pages[i];
      if (pg.el.style.display === 'none') continue;
      const r = pg.el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { i, pg, r };
    }
    return null;
  }
  const toPt = (e, r) => [(e.clientX - r.left) / S.scale, (e.clientY - r.top) / S.scale];
  const touchList = () => [...ptrs.values()].filter(p => p.type === 'touch');
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const isTap = (a, e) => Math.hypot(e.clientX - a.x0, e.clientY - a.y0) < 10 && performance.now() - a.t0 < 450;
  function startPan(e) {
    mode = 'pan'; pan = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), t: performance.now(), vx: 0, vy: 0, moved: 0 };
    swipe = S.present && S.zoom <= 1.02 ? { x0: e.clientX, y0: e.clientY } : null;
  }
  function liveOn(pg) {
    const k = inkK(pg);
    liveCanvas.width = Math.max(1, Math.floor(pg.w * k)); liveCanvas.height = Math.max(1, Math.floor(pg.h * k));
    liveCanvas.getContext('2d').clearRect(0, 0, liveCanvas.width, liveCanvas.height);
    pg.el.appendChild(liveCanvas);
    return k;
  }

  docEl.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { docEl.setPointerCapture(e.pointerId); } catch (x) {}
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    stopFling();
    if (RP) stopReplay();
    // 펜으로 쓰는 중에 닿는 손(손바닥)은 모두 무시. 반대로 손이 닿아 있어도 펜을 대면 펜이 이김
    const penBusy = mode === 'act' && act && act.type === 'pen';
    if (e.pointerType === 'touch' && penBusy) return;
    // 자·각도기를 손가락으로 잡고 있을 때: 두 번째 손가락은 돌리기, 펜은 그대로 쓰기
    if (mode === 'guide' && gd) {
      if (e.pointerType === 'touch' && gd.type === 'touch' && !gd.two) { guideSecond(e); return; }
      if (e.pointerType !== 'pen') return;
      mode = null; gd = null;
    }
    if (e.pointerType === 'pen' && (mode === 'pan' || mode === 'pinch')) { mode = null; pan = pinch = swipe = null; }
    if (e.pointerType === 'pen' && mode === 'act' && act && act.type !== 'pen') { cancelAct(); mode = null; }
    if (e.pointerType === 'pen' && !S.penSeen) {
      S.penSeen = true; ls.set(K.pen, true);
      if (S.finger === 'auto') { renderTools(); toast('펜을 쓰고 있어서 손가락은 화면 옮기기로 바뀌었어요. (손바닥이 닿아도 안 써져요)', 3600); }
    }
    // 두 손가락 → 확대·이동 (손가락으로 막 하던 일은 취소)
    if (e.pointerType === 'touch' && touchList().length >= 2) {
      if (mode === 'act' && act && act.type === 'touch') cancelAct();
      const [a, b] = touchList();
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      mode = 'pinch'; pinch = { d0: Math.max(10, dist(a, b)), z0: S.zoom, a: anchor(mx, my) };
      swipe = null;
      return;
    }
    if (mode === 'act' || mode === 'pinch') return;   // 펜으로 쓰는 중에 닿은 손바닥 무시
    const byFinger = e.pointerType === 'touch';
    const base = { type: e.pointerType, id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now() };
    // S펜 옆 버튼·애플펜슬 지우개 끝(버튼 32) → 지우개
    const tool = e.pointerType === 'pen' && (e.buttons & 32) ? 'erase' : S.tool;
    // 자·각도기: 몸통은 잡아 옮기기, 가장자리는 펜으로 따라 긋기
    const gh = (G.ruler || G.prot) ? guideHit(e.clientX, e.clientY, tool === 'draw' && (!byFinger || fingerDraws())) : null;
    if (gh && (gh.part === 'body' || gh.part === 'knob')) { startGuide(e, gh); return; }
    if (byFinger && !fingerDraws()) { startPan(e); return; }
    if (tool === 'laser') {
      mode = 'act'; act = Object.assign(base, { k: 'laser' });
      FX.trail.push({ x: e.clientX, y: e.clientY, t: performance.now(), gap: true }); FX.head = { x: e.clientX, y: e.clientY }; fxKick();
      return;
    }
    const hit = pageAt(e.clientX, e.clientY);
    if (!hit) {
      if (tool === 'lasso') clearSel();
      if (byFinger) startPan(e);
      return;
    }
    const pg = hit.pg, pt = toPt(e, hit.r);
    mode = 'act';
    if (tool === 'erase') {
      act = Object.assign(base, { k: 'erase', part: S.eraseMode === 'part', items: [], adds: [], made: new Set() });
      eraseAt(pg, pt, e);
      return;
    }
    if (tool === 'cover' || tool === 'clip') {
      const el = document.createElement('div'); el.className = tool === 'clip' ? 'cover live clip' : 'cover live';
      pg.el.querySelector('.covers').appendChild(el);
      act = Object.assign(base, { k: tool, pg, r: hit.r, p0: pt, p1: pt, el });
      return;
    }
    if (tool === 'text' || tool === 'stamp') { act = Object.assign(base, { k: tool, pg, pt }); return; }
    if (tool === 'lasso') {
      if (SEL && SEL.pg === pg) {
        const bx = selBox(), raw = selBox(0);
        // 오른쪽 아래 ● 손잡이: 크기 바꾸기
        if (Math.hypot(pt[0] - bx[2], pt[1] - bx[3]) * S.scale < 26) {
          act = Object.assign(base, { k: 'scale', pg, r: hit.r, ox: raw[0], oy: raw[1], d0: Math.max(1e-3, Math.hypot(bx[2] - raw[0], bx[3] - raw[1])), f: 1 });
          return;
        }
        if (inBox(bx, pt)) { act = Object.assign(base, { k: 'move', pg, r: hit.r, p0: pt, dx: 0, dy: 0 }); return; }
      }
      clearSel();
      act = Object.assign(base, { k: 'lasso', pg, r: hit.r, pts: [pt], kk: liveOn(pg) });
      return;
    }
    const pen = PENS[S.pen];
    const pr = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
    const s = { k: pen.k, c: pen.c, w: SIZES[pen.k][S.size], p: [[...pt, pr]] };
    if (e.pointerType === 'pen' && pen.k === 'pen') s.pr = 1;
    act = Object.assign(base, { k: 'draw', pg, s, kk: liveOn(pg), r: hit.r, smooth: pr, hx: e.clientX, hy: e.clientY });
    if (gh && (gh.part === 'edge' || gh.part === 'arc')) {
      // 자·각도기를 따라 긋기: 반듯한 선(도형과 같은 방식으로 저장)
      act.guide = gh; act.snapped = 'guide';
      delete s.pr; s.sh = 1;
      guideStroke(act, e.clientX, e.clientY);
    } else holdArm();
    paintLive();
  });
  function guideStroke(a, cx, cy) {
    const pts = guidePoints(a, cx, cy); if (!pts) return;
    const P = pts.map(([x, y]) => [r2((x - a.r.left) / S.scale), r2((y - a.r.top) / S.scale), 0.5]);
    if (a.guide.part === 'edge') { if (!a.gStart) a.gStart = P[0]; a.s.p = [a.gStart, P[0]]; }
    else a.s.p = P;
  }

  docEl.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (mode === 'guide' && gd) { moveGuide(e); return; }
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
    if (mode !== 'act' || !act || e.pointerId !== act.id) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const all = evs.length ? evs : [e];
    switch (act.k) {
      case 'draw': {
        if (act.snapped) {
          // 직선으로 맞춘 뒤에는 끝점이 펜을 따라감
          if (act.snapped === 'line') { const q = toPt(e, act.r); act.s.p[1] = [r2(q[0]), r2(q[1]), 0.5]; schedLive(); }
          if (act.snapped === 'guide') { guideStroke(act, e.clientX, e.clientY); schedLive(); }
          return;
        }
        // 빠르게 움직일 때 빠진 점까지 모두 받아서 펜 끝을 정확히 따라감
        for (const ev of all) {
          const raw = act.type === 'pen' && ev.pressure > 0 ? ev.pressure : 0.5;
          act.smooth = act.smooth * 0.6 + raw * 0.4;
          const pt = toPt(ev, act.r), last = act.s.p[act.s.p.length - 1];
          if (Math.abs(pt[0] - last[0]) + Math.abs(pt[1] - last[1]) < 0.25) continue;
          act.s.p.push([pt[0], pt[1], act.smooth]);
        }
        if (Math.hypot(e.clientX - act.hx, e.clientY - act.hy) > 4) { act.hx = e.clientX; act.hy = e.clientY; holdArm(); }
        schedLive();
        return;
      }
      case 'erase': {
        const hit = pageAt(e.clientX, e.clientY);
        if (hit) for (const ev of all) eraseAt(hit.pg, toPt(ev, hit.r), ev);
        return;
      }
      case 'laser': {
        const now = performance.now();
        for (const ev of all) FX.trail.push({ x: ev.clientX, y: ev.clientY, t: now });
        FX.head = { x: e.clientX, y: e.clientY }; fxKick();
        return;
      }
      case 'cover': case 'clip': {
        act.p1 = toPt(e, act.r);
        const [x, y, w, h] = rectOf(act.p0, act.p1, act.pg);
        Object.assign(act.el.style, { left: x / act.pg.w * 100 + '%', top: y / act.pg.h * 100 + '%', width: w / act.pg.w * 100 + '%', height: h / act.pg.h * 100 + '%' });
        return;
      }
      case 'lasso': {
        for (const ev of all) act.pts.push(toPt(ev, act.r));
        schedLive();
        return;
      }
      case 'move': {
        const q = toPt(e, act.r);
        act.dx = q[0] - act.p0[0]; act.dy = q[1] - act.p0[1];
        if (!act.raf) act.raf = requestAnimationFrame(() => { if (!act || act.k !== 'move') return; act.raf = 0; const off = { set: SEL.set, dx: act.dx, dy: act.dy }; drawInk(S.pages.indexOf(act.pg), off); showSel(off); });
        return;
      }
      case 'scale': {
        const q = toPt(e, act.r);
        act.f = clamp(Math.hypot(q[0] - act.ox, q[1] - act.oy) / act.d0, 0.1, 12);
        if (!act.raf) act.raf = requestAnimationFrame(() => { if (!act || act.k !== 'scale') return; act.raf = 0; const off = { set: SEL.set, f: act.f, ox: act.ox, oy: act.oy }; drawInk(S.pages.indexOf(act.pg), off); showSel(off); });
        return;
      }
    }
  });

  function endPointer(e) {
    ptrs.delete(e.pointerId);
    if (mode === 'guide' && gd) { endGuide(e); return; }
    if (mode === 'pinch') {
      if (touchList().length < 2) { mode = null; pinch = null; updateVisible(); }
      return;
    }
    if (mode === 'pan' && pan && e.pointerId === pan.id) {
      mode = null;
      // 손가락으로 가림막을 톡 → 열기·닫기
      if (isTap(pan, e)) { const hit = pageAt(e.clientX, e.clientY); if (hit && toggleCoverAt(hit.pg, toPt(e, hit.r))) { pan = swipe = null; return; } }
      if (swipe) {
        const dx = e.clientX - swipe.x0, dy = e.clientY - swipe.y0;
        swipe = null;
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) { goPage(S.cur + (dx < 0 ? 1 : -1)); pan = null; return; }
      }
      fling(pan.vx, pan.vy); pan = null;
      updateVisible();
      return;
    }
    if (mode !== 'act' || !act || e.pointerId !== act.id) return;
    const a = act;
    mode = null;
    switch (a.k) {
      case 'draw': commitLive(a); break;
      case 'erase': endErase(); break;
      case 'laser': {
        FX.head = null; act = null; fxKick();
        if (isTap(a, e)) { const hit = pageAt(e.clientX, e.clientY); if (hit) toggleCoverAt(hit.pg, toPt(e, hit.r)); }
        break;
      }
      case 'cover': commitCover(a); break;
      case 'clip': commitClip(a); break;
      case 'text': act = null; if (isTap(a, e)) openText(a.pg, a.pt); break;
      case 'stamp': act = null; if (isTap(a, e)) placeStamp(a.pg, a.pt); break;
      case 'lasso': commitLasso(a); break;
      case 'move': commitMove(a); break;
      case 'scale': commitScale(a); break;
    }
  }
  docEl.addEventListener('pointerup', endPointer);
  docEl.addEventListener('pointercancel', e => {
    if (mode === 'act' && act && e.pointerId === act.id && ['draw', 'lasso', 'cover', 'clip', 'move', 'scale'].includes(act.k)) { cancelAct(); mode = null; ptrs.delete(e.pointerId); return; }
    endPointer(e);
  });
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

  // 그리는 중인 선·올가미는 위 캔버스에
  function schedLive() { if (act && !act.raf) act.raf = requestAnimationFrame(() => { if (act) { act.raf = 0; paintLive(); } }); }
  function paintLive() {
    if (!act) return;
    const ctx = liveCanvas.getContext('2d');
    ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
    if (act.k === 'draw') paintStroke(ctx, act.s, act.kk);
    else if (act.k === 'lasso') {
      const k = act.kk, d = DPR();
      ctx.save(); ctx.strokeStyle = '#2B4C8C'; ctx.lineWidth = 1.5 * d; ctx.setLineDash([6 * d, 4 * d]);
      ctx.beginPath(); act.pts.forEach((q, n) => n ? ctx.lineTo(q[0] * k, q[1] * k) : ctx.moveTo(q[0] * k, q[1] * k)); ctx.stroke(); ctx.restore();
    }
  }
  function cancelAct() {
    if (!act) return;
    if (act.raf) cancelAnimationFrame(act.raf);
    clearTimeout(holdTimer);
    if ((act.k === 'cover' || act.k === 'clip') && act.el) act.el.remove();
    if (act.k === 'move' || act.k === 'scale') drawPg(act.pg), showSel();
    if (act.k === 'erase') endErase();
    if (act.k === 'laser') { FX.head = null; fxKick(); }
    liveCanvas.remove(); act = null;
  }
  // 펜을 떼지 않고 잠깐 멈추면 도형 맞춤
  let holdTimer = 0;
  function holdArm() {
    clearTimeout(holdTimer);
    if (!S.snap) return;
    holdTimer = setTimeout(() => {
      if (!act || act.k !== 'draw' || act.snapped) return;
      const sh = recognize(act.s.p);
      if (!sh) return;
      act.s.p = sh.p.map(q => [r2(q[0]), r2(q[1]), 0.5]);
      act.s.sh = 1; delete act.s.pr;
      act.snapped = sh.type;
      if (navigator.vibrate) try { navigator.vibrate(8); } catch (e) {}
      paintLive();
    }, 550);
  }
  function commitLive(a) {
    clearTimeout(holdTimer);
    if (a.raf) cancelAnimationFrame(a.raf);
    liveCanvas.remove(); act = null;
    const { pg, s } = a;
    // 가림막 위를 톡 → 선 대신 가림막 열기·닫기
    if (!a.snapped && performance.now() - a.t0 < 350) {
      const [bx0, by0, bx1, by1] = bounds(Object.assign({}, s, { w: 0 }));
      if ((bx1 - bx0) * S.scale < 8 && (by1 - by0) * S.scale < 8 && toggleCoverAt(pg, s.p[0])) return;
    }
    if (!a.snapped) s.p = s.p.map(([x, y, pr]) => [r2(x), r2(y), r2(pr)]);
    pg.ink.push(s);
    record({ t: 'add', items: [{ pg, s }] });
    if (pg.inkScale === S.scale) paintItem(pg.el.querySelector('.inkc').getContext('2d'), s, inkK(pg)); else drawPg(pg);
  }

  // 지우개: 선 통째로 또는 문지른 부분만(선을 둘로 나눔). 글자·가림막은 닿으면 통째로
  const eraseR = () => S.eraseMode === 'part' ? 9 / Math.min(S.scale, 3) + 1.5 : 6 / Math.min(S.scale, 3) + 2;
  function eraseAt(pg, [x, y], ev) {
    const R = eraseR();
    if (act.part && ev) { FX.ring = { x: ev.clientX, y: ev.clientY, r: R * S.scale }; fxKick(); }
    const list = pg.ink; if (!list.length) return;
    let hit = false;
    for (let j = list.length - 1; j >= 0; j--) {
      const s = list[j];
      if (s.k === 'img') continue;   // 사진은 지우개로 안 지워짐 (사진 위 필기만). 사진은 올가미로 골라 지우기
      if (!hitItem(s, x, y, act.part ? R - s.w / 2 : R)) continue;
      let pieces = null;
      if (act.part && (s.k === 'pen' || s.k === 'hl')) { pieces = splitStroke(s, x, y, R); if (!pieces) continue; }
      list.splice(j, 1);
      if (act.made.has(s)) { act.made.delete(s); act.adds.splice(act.adds.findIndex(o => o.s === s), 1); }
      else act.items.push({ pg, s, at: j });
      if (pieces && pieces.length) { list.splice(j, 0, ...pieces); for (const p of pieces) { act.made.add(p); act.adds.push({ pg, s: p }); } }
      hit = true;
    }
    if (hit) drawPg(pg);
  }
  // 문지른 자리(반지름 R + 선 굵기 절반)의 점을 빼고 남은 조각들로 나눔. 점이 성긴 선(도형)은 촘촘히 채운 뒤에
  function splitStroke(s, x, y, R) {
    const pad = R + s.w / 2, step = Math.max(0.4, R / 3), P = s.p, dense = [P[0]];
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.floor(d / step);
      for (let k = 1; k < n; k++) { const t = k / n; dense.push([r2(a[0] + (b[0] - a[0]) * t), r2(a[1] + (b[1] - a[1]) * t), a[2] + (b[2] - a[2]) * t]); }
      dense.push(b);
    }
    const keep = dense.map(q => Math.hypot(q[0] - x, q[1] - y) > pad);
    if (keep.every(Boolean)) return null;
    const pieces = []; let cur = [];
    dense.forEach((q, i) => { if (keep[i]) cur.push(q); else { if (cur.length > 1) pieces.push(cur); cur = []; } });
    if (cur.length > 1) pieces.push(cur);
    return pieces.map(p => { const o = Object.assign({}, s, { p }); delete o.st; return o; });   // 잘린 도장은 점수에 안 셈
  }
  function endErase() {
    const a = act; act = null;
    FX.ring = null; fxKick();
    if (a && (a.items.length || a.adds.length)) record({ t: 'erase', items: a.items, adds: a.adds });
  }

  // 가림막 만들기: 끌어서 상자. 톡 누르면 있던 가림막 열기·닫기
  function rectOf(p0, p1, pg) {
    const x = Math.max(0, Math.min(p0[0], p1[0])), y = Math.max(0, Math.min(p0[1], p1[1]));
    const x1 = Math.min(pg.w, Math.max(p0[0], p1[0])), y1 = Math.min(pg.h, Math.max(p0[1], p1[1]));
    return [x, y, x1 - x, y1 - y];
  }
  function commitCover(a) {
    act = null; a.el.remove();
    const [x, y, w, h] = rectOf(a.p0, a.p1, a.pg);
    if (w * S.scale < 14 || h * S.scale < 14) { if (!toggleCoverAt(a.pg, a.p0)) toast('답이 있는 곳을 끌어서 상자를 그리면 가려져요.'); return; }
    const s = { k: 'cover', x: r2(x), y: r2(y), cw: r2(w), ch: r2(h) };
    a.pg.ink.push(s);
    record({ t: 'add', items: [{ pg: a.pg, s }] });
    renderCovers(a.pg);
  }

  // 채점 도장: 톡 누른 자리에 ○ ✓ ✗ (빨간 선이라 지우개·되돌리기도 그대로 됨)
  function placeStamp(pg, [x, y]) {
    // st: 점수 셀 때 쓰는 표시 (○·✓ 맞음, ✗ 틀림 — 가위표는 첫 획에만)
    const r = STAMP_R[S.size], w = STAMP_W[S.size], mk = (p, st) => Object.assign({ k: 'pen', c: STAMP_C, w, sh: 1, p: p.map(q => [r2(q[0]), r2(q[1]), 0.5]) }, st ? { st } : {});
    let list;
    if (S.stamp === 'o') list = [mk(Array.from({ length: 49 }, (_, i) => { const t = i / 48 * Math.PI * 2; return [x + r * Math.cos(t), y + r * Math.sin(t)]; }), 'o')];
    else if (S.stamp === 'v') list = [mk([[x - r * 0.85, y - r * 0.05], [x - r * 0.25, y + r * 0.65], [x + r * 0.95, y - r * 0.85]], 'v')];
    else list = [mk([[x - r * 0.7, y - r * 0.7], [x + r * 0.7, y + r * 0.7]], 'x'), mk([[x + r * 0.7, y - r * 0.7], [x - r * 0.7, y + r * 0.7]])];
    pg.ink.push(...list);
    record({ t: 'add', items: list.map(s => ({ pg, s })) });
    drawPg(pg);
  }

  // ════════════════ 올가미 선택: 둘러 잡고 옮기기·복제·지우기 ════════════════
  let SEL = null;   // { pg, set }
  function inPoly(x, y, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function commitLasso(a) {
    if (a.raf) cancelAnimationFrame(a.raf);
    liveCanvas.remove(); act = null;
    const set = new Set();
    if (pathLen(a.pts) * S.scale < 12) {
      // 톡 → 그 자리의 맨 위 항목 하나 (사진·글자를 고르기 쉽게)
      const [x, y] = a.pts[0];
      for (let j = a.pg.ink.length - 1; j >= 0; j--) if (hitItem(a.pg.ink[j], x, y, 6 / S.scale)) { set.add(a.pg.ink[j]); break; }
      if (!set.size) return;
    } else {
      if (a.pts.length < 4) return;
      for (const s of a.pg.ink) {
        if (isBox(s)) { const [x0, y0, x1, y1] = bounds(s); if (inPoly((x0 + x1) / 2, (y0 + y1) / 2, a.pts)) set.add(s); }
        else if (s.p.filter(q => inPoly(q[0], q[1], a.pts)).length >= s.p.length / 2) set.add(s);
      }
      if (!set.size) { toast('둘러싼 안에 필기가 없어요.'); return; }
    }
    SEL = { pg: a.pg, set };
    showSel();
  }
  function selBox(padPx = 6) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const s of SEL.set) { const [x0, y0, x1, y1] = bounds(s); a = Math.min(a, x0); b = Math.min(b, y0); c = Math.max(c, x1); d = Math.max(d, y1); }
    const pad = padPx / S.scale;
    return [a - pad, b - pad, c + pad, d + pad];
  }
  const inBox = (bx, [x, y]) => x >= bx[0] && x <= bx[2] && y >= bx[1] && y <= bx[3];
  function showSel(off) {
    const old = document.querySelector('.selbox'); if (old) old.remove();
    if (!SEL) { $('#selbar').hidden = true; return; }
    const pg = SEL.pg, [a0, b0, c0, d0] = selBox(), el = document.createElement('div');
    const [a, b] = off ? xf(off, a0, b0) : [a0, b0], [c, d] = off ? xf(off, c0, d0) : [c0, d0];
    el.className = 'selbox';
    el.innerHTML = '<span class="selh"></span>';
    Object.assign(el.style, { left: a / pg.w * 100 + '%', top: b / pg.h * 100 + '%', width: (c - a) / pg.w * 100 + '%', height: (d - b) / pg.h * 100 + '%' });
    pg.el.appendChild(el);
    $('#sel-n').textContent = `${SEL.set.size}개 골랐어요 · 끌어서 옮기고 ●로 크기`;
    $('#selbar').hidden = false;
  }
  function clearSel() {
    if (!SEL) return;
    SEL = null; showSel();
  }
  function commitMove(a) {
    if (a.raf) cancelAnimationFrame(a.raf);
    act = null;
    if (Math.abs(a.dx) + Math.abs(a.dy) > 0.3) {
      const items = [...SEL.set].map(s => ({ pg: a.pg, s }));
      for (const it of items) translate(it.s, a.dx, a.dy);
      record({ t: 'move', items, dx: a.dx, dy: a.dy });
    }
    drawPg(a.pg); showSel();
  }
  function commitScale(a) {
    if (a.raf) cancelAnimationFrame(a.raf);
    act = null;
    if (Math.abs(a.f - 1) > 0.01) {
      const items = [...SEL.set].map(s => { const before = geo(s); scaleItem(s, a.ox, a.oy, a.f); return { pg: a.pg, s, before, after: geo(s) }; });
      record({ t: 'set', items });
    }
    drawPg(a.pg); showSel();
  }
  function selDelete() {
    const pg = SEL.pg, items = [];
    for (let j = pg.ink.length - 1; j >= 0; j--) if (SEL.set.has(pg.ink[j])) { items.push({ pg, s: pg.ink[j], at: j }); pg.ink.splice(j, 1); }
    clearSel();
    record({ t: 'erase', items });
    drawPg(pg); toast(`${items.length}개를 지웠어요.`);
  }
  function selDup() {
    const pg = SEL.pg, d = 14, copies = [...SEL.set].map(s => { const c = JSON.parse(JSON.stringify(s)); translate(c, d, d); return c; });
    pg.ink.push(...copies);
    record({ t: 'add', items: copies.map(s => ({ pg, s })) });
    SEL = { pg, set: new Set(copies) };
    drawPg(pg); showSel();
  }

  // ════════════════ 되돌리기 ════════════════
  // 기록은 쪽 객체를 가리킴 (빈 쪽을 넣고 빼서 쪽 번호가 바뀌어도 맞음)
  function record(h) { S.hist.push(h); S.redo = []; changed(); }
  function undo() {
    const h = S.hist.pop(); if (!h) return;
    clearSel(); applyHist(h, true); S.redo.push(h); changed();
  }
  function redo() {
    const h = S.redo.pop(); if (!h) return;
    clearSel(); applyHist(h, false); S.hist.push(h); changed();
  }
  function applyHist(h, back) {
    const touched = new Set();
    const rm = it => { const j = it.pg.ink.lastIndexOf(it.s); if (j >= 0) it.pg.ink.splice(j, 1); touched.add(it.pg); };
    const add = it => { it.pg.ink.push(it.s); touched.add(it.pg); };
    if (h.t === 'add') h.items.forEach(back ? rm : add);
    else if (h.t === 'erase') {
      // 지우기·쪽 지우기·부분 지우기: 되돌릴 때는 조각을 빼고 원래 선을 원래 자리로
      if (back) {
        (h.adds || []).forEach(rm);
        for (const it of h.items.slice().reverse()) { it.pg.ink.splice(Math.min(it.at, it.pg.ink.length), 0, it.s); touched.add(it.pg); }
      } else { h.items.forEach(rm); (h.adds || []).forEach(add); }
    } else if (h.t === 'move') {
      const k = back ? -1 : 1;
      for (const it of h.items) { translate(it.s, k * h.dx, k * h.dy); touched.add(it.pg); }
    } else if (h.t === 'text') {
      Object.assign(h.s, back ? h.before : h.after); touched.add(h.pg);
    } else if (h.t === 'set') {
      for (const it of h.items) { Object.assign(it.s, JSON.parse(JSON.stringify(back ? it.before : it.after))); touched.add(it.pg); }
    } else if (h.t === 'order') {
      setOrder(back ? h.before : h.after);
      if (!$('#thumbs').hidden) renderThumbs();
      return;
    } else if (h.t === 'page') {
      if (h.ins !== back) insertPage(h.at, h.pg); else removePage(h.pg);
      goPage(S.pages.indexOf(h.pg) >= 0 ? S.pages.indexOf(h.pg) : Math.min(h.at, S.pages.length - 1));
      return;
    }
    for (const pg of touched) drawPg(pg);
    const first = S.pages.indexOf([...touched][0]);
    if (first >= 0 && !onScreen(first)) goPage(first);
  }
  function clearPage(pg) {
    if (!pg.ink.length) return;
    const items = pg.ink.map((s, at) => ({ pg, s, at })).reverse();
    pg.ink = [];
    record({ t: 'erase', items });
    drawPg(pg);
  }

  // ════════════════ 빈 쪽 넣기·빼기 ════════════════
  function insertPage(at, pg) {
    S.pages.splice(at, 0, pg);
    pagesEl.insertBefore(makePageEl(pg), S.pages[at + 1] ? S.pages[at + 1].el : null);
    renumber(); layout(); updateVisible();
  }
  function removePage(pg) {
    const i = S.pages.indexOf(pg); if (i < 0) return;
    S.pages.splice(i, 1); pg.el.remove(); queue.delete(pg);
    if (S.cur >= S.pages.length) S.cur = S.pages.length - 1;
    renumber(); layout(); updateVisible();
  }
  function addBlank(kind) {
    const ref = S.pages[S.cur], at = S.cur + 1;
    const pg = newPage({ blank: kind, w: r2(ref.w), h: r2(ref.h) });
    insertPage(at, pg);
    record({ t: 'page', ins: true, at, pg });
    goPage(at);
    toast(`${at + 1}쪽에 ${josa(PATTERN[kind], '을', '를')} 넣었어요. 보내기·저장한 PDF에도 들어가요.`);
  }
  // 쪽 정리(옮기기·복사·빼기): 쪽 객체 배열을 통째로 바꿈. 빠진 쪽도 객체는 남아서 되돌리기로 살아남
  function setOrder(arr) {
    for (const pg of S.pages) if (!arr.includes(pg)) { if (pg.el) pg.el.remove(); queue.delete(pg); }
    S.pages = arr.slice();
    for (const pg of S.pages) pagesEl.appendChild(pg.el || makePageEl(pg));
    if (S.cur >= S.pages.length) S.cur = S.pages.length - 1;
    renumber(); layout(); updateVisible();
  }
  const canDrop = pg => S.pages.length > 1 && (pg.blank || S.pages.filter(p => !p.blank && p.src === pg.src).length > 1);
  function pageOp(op, i) {
    const before = S.pages.slice(), arr = S.pages.slice(), pg = arr[i];
    if (!pg) return;
    if (op === 'left' && i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
    else if (op === 'right' && i < arr.length - 1) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
    else if (op === 'copy') arr.splice(i + 1, 0, newPage({ src: pg.src, blank: pg.blank, w: pg.w, h: pg.h, vp: pg.vp }, JSON.parse(JSON.stringify(pg.ink))));
    else if (op === 'del' && canDrop(pg)) arr.splice(i, 1);
    else return;
    setOrder(arr);
    record({ t: 'order', before, after: arr.slice() });
    renderThumbs();
    if (op === 'copy') toast(`${i + 1}쪽을 필기와 함께 복사해 ${i + 2}쪽에 넣었어요.`);
  }
  function removeBlank(pg) {
    const at = S.pages.indexOf(pg);
    removePage(pg);
    record({ t: 'page', ins: false, at, pg });
    goPage(Math.min(at, S.pages.length - 1));
    toast('넣은 쪽을 뺐어요. (되돌리기로 살릴 수 있어요)');
  }

  // 저장: 바뀌면 잠시 뒤 한 번에
  let saveTimer = null;
  function changed() {
    updateUndo();
    clearTimeout(saveTimer); saveTimer = setTimeout(flushInk, 500);
  }
  async function flushInk() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!S.meta || !S.pages.length) return;
    const pages = {};
    let n = 0, np = 0;
    S.pages.forEach((pg, i) => { if (pg.ink.length) { pages[i] = pg.ink; n += pg.ink.length; if (pg.ink.some(s => s.k !== 'cover')) np++; } });
    const rec = { id: S.meta.id, pages, updated: Date.now() };
    if (S.pages.some((pg, i) => pg.blank || pg.src !== i)) rec.order = S.pages.map(pg => pg.blank ? { b: pg.blank, w: pg.w, h: pg.h } : { s: pg.src });
    try {
      await DB.put('ink', rec);
      if ((S.meta.inkCount || 0) !== n || S.meta.pages !== S.pages.length || (S.meta.inkPages || 0) !== np) { S.meta.inkCount = n; S.meta.inkPages = np; S.meta.pages = S.pages.length; await DB.put('meta', S.meta); }
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
    if (changedPage && RP) stopReplay();
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
  const tb = (a, icon, label, pressed, showLabel = true) => `<button class="tb" type="button" data-a="${a}"${pressed == null ? '' : ` aria-pressed="${!!pressed}"`} aria-label="${label}" title="${label}">${icon}${showLabel ? `<span class="lbl">${label}</span>` : ''}</button>`;
  function penButtons() {
    return PENS.map((p, n) => `<button class="tb" type="button" data-pen="${n}" aria-pressed="${S.tool === 'draw' && S.pen === n}" aria-label="${p.label}" title="${p.label}">
      <span class="dot${p.k === 'hl' ? ' hl' : ''}" style="background:${p.c}"></span></button>`).join('');
  }
  // 즐겨찾기 펜 3칸: 누르면 그 색·굵기로, 길게 누르면 지금 펜을 저장
  function favButtons() {
    return FAV.map((f, n) => {
      const p = PENS[f.pen], d = [9, 13, 18][f.size];
      return `<button class="tb fav" type="button" data-fav="${n}" aria-pressed="${S.tool === 'draw' && S.pen === f.pen && S.size === f.size}" aria-label="즐겨찾기 ${n + 1}: ${p.label} ${SIZE_NAMES[f.size]} (길게 누르면 지금 펜 저장)" title="즐겨찾기 ${n + 1} · 길게 누르면 지금 펜 저장">
        <span class="fv"><span class="dot${p.k === 'hl' ? ' hl' : ''}" style="background:${p.c};width:${d}px;height:${d}px"></span></span><sup>${n + 1}</sup></button>`;
    }).join('');
  }
  function stampButtons(showLabel) {
    return Object.entries(STAMPS).map(([k, label]) => `<button class="tb stamp" type="button" data-stamp="${k}" aria-pressed="${S.tool === 'stamp' && S.stamp === k}" aria-label="${label} 도장" title="${label} 도장"><span class="glyph">${{ o: '○', v: '✓', x: '✗' }[k]}</span>${showLabel && k === 'o' ? '<span class="lbl">도장</span>' : ''}</button>`).join('');
  }
  const scoreButton = showLabel => `<button class="tb stamp" type="button" data-a="score" aria-label="점수 매기기" title="점수 매기기"><span class="glyph sc">점</span>${showLabel ? '<span class="lbl">점수</span>' : ''}</button>`;
  function renderTools() {
    const kind = S.meta && S.meta.kind, sheet = kind === 'sheet', grade = kind === 'grade';
    const fd = fingerDraws();
    const sizeH = [2, 4, 7][S.size];
    const eraseLbl = S.eraseMode === 'part' ? '부분 지우개' : '지우개';
    $('#tools').innerHTML = `
      ${favButtons()}
      <span class="sep"></span>
      ${penButtons()}
      ${tb('erase', I.erase, eraseLbl, S.tool === 'erase')}
      <button class="tb" type="button" data-a="size" title="굵기">${`<span class="size-line" style="height:${sizeH}px"></span>`}<span class="lbl">${SIZE_NAMES[S.size]}</span></button>
      <span class="sep"></span>
      ${tb('laser', I.laser, '레이저', S.tool === 'laser')}
      ${tb('cover', I.cover, '가림막', S.tool === 'cover')}
      ${tb('curtain', I.curtain, '커튼')}
      ${tb('text', I.text, '글자', S.tool === 'text')}
      ${tb('lasso', I.lasso, '올가미', S.tool === 'lasso')}
      ${tb('photo', I.photo, '사진')}
      ${tb('ruler', I.ruler, '자', !!G.ruler)}
      ${tb('prot', I.prot, '각도기', !!G.prot)}
      ${grade ? stampButtons(true) + scoreButton(true) : ''}
      ${S.tool === 'clip' ? tb('clip', I.cover, '오답 담기', true) : ''}
      <span class="sep"></span>
      ${tb('undo', I.undo, '되돌리기', null, false)}
      ${tb('redo', I.redo, '다시 하기', null, false)}
      <span class="sep"></span>
      <button class="tb" type="button" data-a="finger" aria-pressed="${fd}" title="손가락으로 쓰기">${fd ? I.finger : I.hand}<span class="lbl">${fd ? '손가락: 쓰기' : '손가락: 이동'}</span></button>
      ${tb('zoom-out', I.minus, '축소', null, false)}
      ${tb('fit', I.fit, '폭 맞춤', null, false)}
      ${tb('zoom-in', I.plus, '확대', null, false)}
      ${FS_OK ? tb('fullscreen', I.full, '전체 화면', !!fsElement()) : ''}
      <span class="sep"></span>
      ${tb('thumbs', I.grid, '쪽 목록')}
      ${tb('timer', I.timer, '타이머')}
      ${tb('more', I.more, '더보기')}`;
    // 자주 찾는 [수업 화면]·[보내기]는 위 줄에 늘 보이게
    const sendIcon = sheet || grade ? I.send : I.save, sendLbl = sheet ? '선생님께 보내기' : grade ? '채점 돌려주기' : 'PDF로 저장';
    $('#bar-actions').innerHTML = `
      <button class="tb" type="button" data-a="present">${I.board}<span class="lbl">수업 화면</span></button>
      <button class="tb primary" type="button" data-a="send">${sendIcon}<span class="lbl">${sendLbl}</span></button>`;
    $('#pbar').innerHTML = `
      ${tb('prev', I.prev, '이전 쪽', null, false)}
      <span class="pageno"></span>
      ${tb('next', I.next, '다음 쪽', null, false)}
      <span class="sep"></span>
      ${favButtons()}
      <span class="sep"></span>
      ${penButtons()}
      ${tb('erase', I.erase, eraseLbl, S.tool === 'erase', false)}
      ${tb('laser', I.laser, '레이저', S.tool === 'laser', false)}
      ${tb('cover', I.cover, '가림막', S.tool === 'cover', false)}
      ${tb('curtain', I.curtain, '커튼', null, false)}
      ${tb('ruler', I.ruler, '자', !!G.ruler, false)}
      ${tb('prot', I.prot, '각도기', !!G.prot, false)}
      ${grade ? stampButtons(false) + scoreButton(false) : ''}
      ${tb('undo', I.undo, '되돌리기', null, false)}
      <span class="sep"></span>
      ${tb('timer', I.timer, '타이머', null, false)}
      ${tb('more', I.more, '더보기', null, false)}
      <span class="sep"></span>
      <button class="tb" type="button" data-a="exit-present">${I.close}<span class="lbl">끝내기</span></button>`;
    updateUndo(); updatePageNo();
  }
  function updateUndo() {
    viewer.querySelectorAll('[data-a="undo"]').forEach(b => { b.disabled = !S.hist.length; });
    viewer.querySelectorAll('[data-a="redo"]').forEach(b => { b.disabled = !S.redo.length; });
  }
  const TOOL_TIPS = {
    laser: '레이저: 펜으로 가리키면 빨간 꼬리가 잠깐 보였다 사라져요. 필기는 남지 않아요.',
    cover: '가림막: 답이 있는 곳을 끌어서 가려요. 수업 중에 톡 누르면 열리고, 다시 누르면 닫혀요.',
    text: '글자: 글자를 넣을 곳을 톡 누르세요. 넣은 글자를 누르면 고칠 수 있어요.',
    lasso: '올가미: 필기를 빙 둘러 그리거나 톡 눌러 골라요. 끌어서 옮기고, 오른쪽 아래 ●로 크기를 바꿔요.',
    clip: '오답 담기: 틀린 문제를 상자로 둘러요. 오답 노트에 그림으로 들어가요. 다 담았으면 펜을 고르세요.',
  };
  function setTool(t) {
    if (S.tool !== t && TOOL_TIPS[t]) toast(TOOL_TIPS[t], 3600);
    if (t !== 'lasso') clearSel();
    S.tool = t; saveSettings(); renderTools();
  }
  let favHold = 0, favLong = false;
  viewer.addEventListener('pointerdown', e => {
    const b = e.target.closest('[data-fav]'); if (!b) return;
    favLong = false; clearTimeout(favHold);
    favHold = setTimeout(() => { favLong = true; saveFav(Number(b.dataset.fav)); }, 600);
  });
  for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, () => clearTimeout(favHold));
  function saveFav(n) {
    if (S.tool !== 'draw') { toast('먼저 펜 색과 굵기를 고른 뒤, 즐겨찾기 칸을 길게 누르세요.'); return; }
    FAV[n] = { pen: S.pen, size: S.size }; ls.set(K.fav, FAV);
    renderTools();
    toast(`즐겨찾기 ${n + 1}번에 ‘${PENS[S.pen].label} · ${SIZE_NAMES[S.size]}’을 저장했어요.`);
  }
  viewer.addEventListener('contextmenu', e => { if (e.target.closest('[data-fav]')) e.preventDefault(); });

  let clearArmed = false;
  viewer.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !viewer.contains(b)) return;
    if (b.dataset.fav) {
      if (favLong) { favLong = false; return; }
      const f = FAV[Number(b.dataset.fav)]; S.pen = f.pen; S.size = f.size; setTool('draw'); return;
    }
    if (b.dataset.pen) { S.pen = Number(b.dataset.pen); setTool('draw'); return; }
    if (b.dataset.stamp) { S.stamp = b.dataset.stamp; if (S.tool !== 'stamp') toast('채점할 곳을 톡 누르면 도장이 찍혀요. 크기는 [굵기]로 바꿔요.'); setTool('stamp'); return; }
    const a = b.dataset.a;
    switch (a) {
      case 'home': closeDoc(); break;
      case 'erase':
        if (S.tool === 'erase') { S.eraseMode = S.eraseMode === 'part' ? 'stroke' : 'part'; toast(S.eraseMode === 'part' ? '부분 지우개: 문지른 부분만 지워요. (한 번 더 누르면 선 통째로)' : '지우개: 닿은 선을 통째로 지워요. (한 번 더 누르면 부분 지우개)', 3200); saveSettings(); renderTools(); }
        else setTool('erase');
        break;
      case 'laser': case 'cover': case 'text': case 'lasso': setTool(a); break;
      case 'clip': setTool('draw'); break;
      case 'curtain': toggleCurtain(); break;
      case 'ruler': case 'prot': toggleGuide(a); break;
      case 'photo': photoPage = S.pages[S.cur]; $('#img-in').click(); break;
      case 'score': openScore(); break;
      case 'rp-toggle': replayToggle(); break;
      case 'rp-speed': if (RP) { RP.speed = RP.speed >= 4 ? 1 : RP.speed * 2; replayBar(); } break;
      case 'rp-stop': stopReplay(); break;
      case 'size': S.size = (S.size + 1) % 3; saveSettings(); renderTools(); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'finger': S.finger = fingerDraws() ? 'pan' : 'draw'; saveSettings(); renderTools(); toast(fingerDraws() ? '손가락 하나로 쓸 수 있어요. 화면은 두 손가락으로 옮겨요.' : '손가락 하나로 화면을 옮겨요. 펜으로만 써져요.'); break;
      case 'zoom-in': setZoom(S.zoom * 1.25); break;
      case 'zoom-out': setZoom(S.zoom / 1.25); break;
      case 'fit': { const i = S.cur; S.zoom = 1; layout(); goPage(i); break; }
      case 'thumbs': openThumbs(); break;
      case 'timer': openTimer(); break;
      case 'timer-toggle': timerToggle(); break;
      case 'timer-close': stopTimer(); break;
      case 'more': openMore(); break;
      case 'sel-dup': if (SEL) selDup(); break;
      case 'sel-del': if (SEL) selDelete(); break;
      case 'sel-done': clearSel(); break;
      case 'fullscreen': fsElement() ? exitFullscreen() : enterFullscreen(); break;
      case 'present': enterPresent(); break;
      case 'exit-present': exitPresent(); break;
      case 'prev': goPage(S.cur - 1); break;
      case 'next': goPage(S.cur + 1); break;
      case 'send': openSend(); break;
    }
  });
  document.addEventListener('keydown', e => {
    if (S.view !== 'doc' || !$('#modal').hidden || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (SEL && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); selDelete(); return; }
    if (SEL && e.key === 'Escape') { clearSel(); return; }
    if (S.present) {
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); goPage(S.cur + 1); }
      else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); goPage(S.cur - 1); }
      else if (e.key === 'Escape') exitPresent();
    } else if (e.key === 'PageDown') { e.preventDefault(); goPage(S.cur + 1, true); }
    else if (e.key === 'PageUp') { e.preventDefault(); goPage(S.cur - 1, true); }
  });

  // ════════════════ 더보기: 빈 쪽 넣기·빼기, 도형 맞춤, 지우개 방식, 쪽 지우기 ════════════════
  function openMore() {
    const pg = S.pages[S.cur], n = S.cur + 1;
    let armed = '';
    const html = () => `
      <h2>더보기</h2>
      <p class="mh">빈 쪽 넣기 <small>${n}쪽 뒤에 들어가요</small></p>
      <div class="grid-btns">${Object.entries(PATTERN).map(([k, v]) => `<button class="btn ghost" type="button" data-m="add" data-v="${k}">${v}</button>`).join('')}</div>
      ${pg.blank ? `<button class="btn ghost wide${armed === 'rm' ? ' armed' : ''}" type="button" data-m="rm">${armed === 'rm' ? '한 번 더 누르면 뺄게요' : `이 넣은 쪽 빼기 (${n}쪽)`}</button>` : ''}
      <p class="mh">수업</p>
      <button class="btn ghost wide" type="button" data-m="pick">발표자 뽑기</button>
      <button class="btn ghost wide" type="button" data-m="replay">필기 다시 보기 <small>(${n}쪽, 쓴 순서대로)</small></button>
      <p class="mh">숙제</p>
      ${isGrade() ? '<button class="btn ghost wide" type="button" data-m="score">점수 매기기 <small>(도장 ○ ✓ ✗ 세기)</small></button>' : ''}
      ${S.meta.kind !== 'wrong' ? '<button class="btn ghost wide" type="button" data-m="clip">오답 노트에 담기 <small>(틀린 문제를 상자로)</small></button>' : '<p class="hint">담은 문제 옆 빈 곳에 다시 풀어 봐요. [PDF로 저장]으로 모아서 인쇄할 수도 있어요.</p>'}
      <p class="mh">쓰기</p>
      <button class="btn ghost wide" type="button" data-m="snap">도형 맞춤: <b>${S.snap ? '켜짐' : '꺼짐'}</b></button>
      <p class="hint">선을 긋고 펜을 떼지 않은 채 잠깐 멈추면 반듯한 직선·원·삼각형·사각형으로 바뀌어요.</p>
      <button class="btn ghost wide" type="button" data-m="emode">지우개: <b>${S.eraseMode === 'part' ? '문지른 부분만' : '선 통째로'}</b></button>
      <button class="btn ghost wide${armed === 'clear' ? ' armed' : ''}" type="button" data-m="clear">${armed === 'clear' ? `한 번 더 누르면 ${n}쪽 필기를 모두 지워요` : `이 쪽 필기 모두 지우기 (${n}쪽)`}</button>
      <div class="row"><button class="btn ghost" type="button" data-m="close">닫기</button></div>`;
    const fn = b => {
      const m = b.dataset.m;
      if (m === 'add') { closeModal(); addBlank(b.dataset.v); return; }
      if (m === 'pick') { closeModal(); openPicker(); return; }
      if (m === 'replay') { closeModal(); startReplay(); return; }
      if (m === 'score') { closeModal(); openScore(); return; }
      if (m === 'clip') { closeModal(); setTool('clip'); return; }
      if (m === 'rm') { if (armed !== 'rm') { armed = 'rm'; showModal(html(), fn); return; } closeModal(); removeBlank(pg); return; }
      if (m === 'snap') { S.snap = !S.snap; saveSettings(); armed = ''; showModal(html(), fn); return; }
      if (m === 'emode') { S.eraseMode = S.eraseMode === 'part' ? 'stroke' : 'part'; saveSettings(); renderTools(); armed = ''; showModal(html(), fn); return; }
      if (m === 'clear') {
        if (!pg.ink.length) { closeModal(); toast('이 쪽에는 지울 필기가 없어요.'); return; }
        if (armed !== 'clear') { armed = 'clear'; showModal(html(), fn); return; }
        closeModal(); clearPage(pg); toast(`${n}쪽 필기를 지웠어요. (되돌리기로 살릴 수 있어요)`);
      }
    };
    showModal(html(), fn);
  }

  // ════════════════ 글자 넣기·고치기 ════════════════
  function openText(pg, pt) {
    const item = (() => { for (let j = pg.ink.length - 1; j >= 0; j--) { const s = pg.ink[j]; if (s.k === 'text' && hitItem(s, pt[0], pt[1], 4 / S.scale)) return s; } return null; })();
    const pen = PENS[S.pen];
    let fsI = item ? Math.max(0, TEXT_SIZES.indexOf(item.fs)) : S.size;
    const color = item ? item.c : pen.k === 'pen' ? pen.c : PENS[0].c;
    const html = () => `
      <h2>${item ? '글자 고치기' : '글자 넣기'}</h2>
      <textarea id="tx" rows="3" placeholder="여기에 적어요 (줄 바꿈 가능)">${esc(item ? item.t : ($('#tx') ? $('#tx').value : ''))}</textarea>
      <div class="seg">${['작게', '보통', '크게'].map((nm, k) => `<button class="tb" type="button" data-m="fs" data-v="${k}" aria-pressed="${k === fsI}">${nm}</button>`).join('')}
        <span class="swatch" style="background:${color}" title="글자 색 (펜 색)"></span></div>
      <div class="row">${item ? '<button class="btn ghost" type="button" data-m="del">지우기</button>' : ''}<button class="btn ghost" type="button" data-m="close">취소</button><button class="btn" type="button" data-m="ok">${item ? '고치기' : '넣기'}</button></div>`;
    showModal(html(), b => {
      const m = b.dataset.m, ta = $('#tx');
      if (m === 'fs') { fsI = Number(b.dataset.v); $('#modal-card').querySelectorAll('[data-m="fs"]').forEach(x => x.setAttribute('aria-pressed', String(Number(x.dataset.v) === fsI))); ta.focus({ preventScroll: true }); return; }
      if (m === 'del' && item) {
        const at = pg.ink.indexOf(item); if (at >= 0) pg.ink.splice(at, 1);
        record({ t: 'erase', items: [{ pg, s: item, at }] }); drawPg(pg); closeModal(); return;
      }
      if (m !== 'ok') return;
      const t = ta.value.replace(/\s+$/, '');
      if (!t) { if (item) return; closeModal(); return; }
      if (item) {
        const before = { t: item.t, fs: item.fs, tw: item.tw, th: item.th };
        Object.assign(item, { t, fs: TEXT_SIZES[fsI] }); measureText(item);
        record({ t: 'text', pg, s: item, before, after: { t: item.t, fs: item.fs, tw: item.tw, th: item.th } });
      } else {
        const fs = TEXT_SIZES[fsI];
        const s = measureText({ k: 'text', x: r2(pt[0]), y: r2(Math.max(0, pt[1] - fs * 0.6)), t, c: color, fs });
        pg.ink.push(s);
        record({ t: 'add', items: [{ pg, s }] });
      }
      drawPg(pg); closeModal();
    });
    const ta = $('#tx'); ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  // ════════════════ 타이머 ════════════════
  const T = { total: 0, end: 0, left: 0, done: false, iv: 0, ac: null };
  const fmtT = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  function openTimer() {
    const on = !!(T.end || T.left) && !T.done;
    showModal(`
      <h2>타이머</h2>
      <p>${on ? '타이머가 돌고 있어요. 새 시간을 고르면 다시 시작해요.' : '시간을 고르면 바로 시작해요. 화면 오른쪽 위에 보여요.'}</p>
      <div class="grid-btns">${[1, 2, 3, 5, 10, 15, 20, 30].map(m => `<button class="btn ghost" type="button" data-m="go" data-v="${m * 60}">${m}분</button>`).join('')}</div>
      <label for="tm-in">직접 적기 (분)</label>
      <div class="inrow"><input id="tm-in" type="number" min="1" max="180" step="1" inputmode="numeric" placeholder="예: 7"><button class="btn" type="button" data-m="go-in">시작</button></div>
      <div class="row">${on ? '<button class="btn ghost" type="button" data-m="stop">타이머 끄기</button>' : ''}<button class="btn ghost" type="button" data-m="close">닫기</button></div>`, b => {
      const m = b.dataset.m;
      if (m === 'stop') { stopTimer(); closeModal(); return; }
      let sec = 0;
      if (m === 'go') sec = Number(b.dataset.v);
      if (m === 'go-in') { const v = Number($('#tm-in').value); if (!(v > 0 && v <= 180)) { $('#tm-in').focus({ preventScroll: true }); return; } sec = Math.round(v * 60); }
      if (sec) { closeModal(); startTimer(sec); }
    });
  }
  function startTimer(sec) {
    // 소리는 누른 순간에 준비해야 나중에 울릴 수 있음 (아이패드)
    try { T.ac = T.ac || new (window.AudioContext || window.webkitAudioContext)(); if (T.ac.resume) T.ac.resume(); } catch (e) { T.ac = null; }
    Object.assign(T, { total: sec * 1000, end: performance.now() + sec * 1000, left: 0, done: false });
    clearInterval(T.iv); T.iv = setInterval(tickTimer, 250);
    $('#timer').hidden = false; tickTimer();
  }
  function tickTimer() {
    const el = $('#timer'), tt = el.querySelector('.tt');
    const left = T.end ? T.end - performance.now() : T.left;
    el.classList.toggle('paused', !T.end && !T.done);
    if (T.end && left <= 0) {
      T.end = 0; T.done = true; clearInterval(T.iv);
      el.classList.add('done'); tt.textContent = '시간 끝!';
      beep();
      return;
    }
    el.classList.remove('done');
    tt.textContent = fmtT(left);
  }
  function timerToggle() {
    if (T.done) { stopTimer(); return; }
    if (T.end) { T.left = T.end - performance.now(); T.end = 0; clearInterval(T.iv); }
    else if (T.left) { T.end = performance.now() + T.left; T.left = 0; clearInterval(T.iv); T.iv = setInterval(tickTimer, 250); }
    tickTimer();
  }
  function stopTimer() {
    clearInterval(T.iv); Object.assign(T, { total: 0, end: 0, left: 0, done: false });
    const el = $('#timer'); el.hidden = true; el.classList.remove('done', 'paused');
  }
  function beep() {
    if (navigator.vibrate) try { navigator.vibrate([200, 120, 200]); } catch (e) {}
    const ac = T.ac; if (!ac) return;
    try {
      const t0 = ac.currentTime + 0.05;
      for (let n = 0; n < 3; n++) {
        const o = ac.createOscillator(), g = ac.createGain(), t = t0 + n * 0.38;
        o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
        o.start(t); o.stop(t + 0.27);
      }
    } catch (e) {}
  }

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
    clearSel();
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
  let thumbObs = null, thumbEdit = false;
  function openThumbs() {
    thumbEdit = false;
    $('#thumbs').hidden = false;
    renderThumbs();
    const cur = $('#thumbs-grid .thumb.cur'); if (cur) cur.scrollIntoView({ block: 'center' });
  }
  function renderThumbs() {
    const box = $('#thumbs'), grid = $('#thumbs-grid');
    box.classList.toggle('editing', thumbEdit);
    box.querySelector('[data-t="edit"]').textContent = thumbEdit ? '정리 끝' : '쪽 정리';
    $('#thumbs-hint').textContent = thumbEdit ? '◀ ▶로 옮기고, 복사·빼기. 되돌리기로 돌릴 수 있어요.' : '';
    grid.innerHTML = S.pages.map((pg, i) => `<div class="thumbw"><button class="thumb${i === S.cur ? ' cur' : ''}" type="button" data-go="${i}">
      <span class="tp" style="aspect-ratio:${pg.w} / ${pg.h}"></span><span class="${pg.ink.length ? 'has-ink' : ''}">${i + 1}${pg.blank ? ' · ' + (PATTERN[pg.blank] || '넣은 쪽') : ''}${pg.ink.length ? ' ✎' : ''}</span></button>
      ${thumbEdit ? `<div class="tops"><button type="button" data-op="left" data-i="${i}" aria-label="앞으로"${i ? '' : ' disabled'}>◀</button><button type="button" data-op="right" data-i="${i}" aria-label="뒤로"${i < S.pages.length - 1 ? '' : ' disabled'}>▶</button><button type="button" data-op="copy" data-i="${i}">복사</button>${canDrop(pg) ? `<button type="button" data-op="del" data-i="${i}">빼기</button>` : ''}</div>` : ''}</div>`).join('');
    if (thumbObs) thumbObs.disconnect();
    thumbObs = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) { thumbObs.unobserve(en.target); drawThumb(en.target); } }), { root: box, rootMargin: '200px' });
    grid.querySelectorAll('.thumb').forEach(t => thumbObs.observe(t));
  }
  async function drawThumb(btn) {
    const i = Number(btn.dataset.go), pg = S.pages[i], tp = btn.querySelector('.tp');
    try {
      const w = 240, k = w / pg.w;
      const c = document.createElement('canvas');
      if (pg.blank) { c.width = Math.floor(pg.w * k); c.height = Math.floor(pg.h * k); paintPattern(c.getContext('2d', { alpha: false }), pg, k); }
      else {
        const page = await S.pdf.getPage(pg.src + 1), vp = page.getViewport({ scale: k });
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
      }
      const ctx = c.getContext('2d');
      await loadImgs(pg.ink);
      for (const s of pg.ink) paintItem(ctx, s, k);
      tp.appendChild(c);
    } catch (e) {}
  }
  $('#thumbs').addEventListener('click', e => {
    const t = e.target.closest('[data-t]');
    if (t) { if (t.dataset.t === 'edit') { thumbEdit = !thumbEdit; renderThumbs(); } else $('#thumbs').hidden = true; return; }
    const op = e.target.closest('[data-op]');
    if (op) { pageOp(op.dataset.op, Number(op.dataset.i)); return; }
    if (e.target.closest('.thumbs-bar')) return;
    const g = e.target.closest('[data-go]');
    if (g && thumbEdit) return;
    $('#thumbs').hidden = true;
    if (g) goPage(Number(g.dataset.go));
  });

  // ════════════════ PDF로 내보내기 ════════════════
  // 원본 PDF에 필기를 선(벡터)으로 덧그림 → 글자는 그대로 선명하고 파일도 작음. 넣은 빈 쪽은 그 자리에 새 쪽으로
  // 넣은 글자는 그림으로(한글 글꼴을 PDF에 넣지 않아도 되게). 가림막은 수업용이라 넣지 않음
  // 원본이 암호 등으로 고칠 수 없는 PDF면 쪽마다 그림으로 만들어 새 PDF로
  async function exportPdf() {
    await flushInk();
    await loadScript(`assets/vendor/pdf-lib.min.js${V}`);
    const { PDFDocument, rgb, LineCapStyle, StandardFonts } = window.PDFLib;
    const rec = S.pdf ? await DB.get('pdf', S.meta.id) : null;
    const hex = c => rgb(parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255);
    const vps = [];
    for (const pg of S.pages) vps.push(pg.blank ? { width: pg.w, height: pg.h, convertToPdfPoint: (x, y) => [x, pg.h - y] } : pg.vp || (await S.pdf.getPage(pg.src + 1)).getViewport({ scale: 1 }));
    const textPng = async s => {
      const k = 4, c = document.createElement('canvas');
      c.width = Math.ceil(s.tw * k); c.height = Math.ceil(s.th * k);
      paintText(c.getContext('2d'), Object.assign({}, s, { x: 0, y: 0 }), k);
      const b = await new Promise(r => c.toBlob(r, 'image/png'));
      return b.arrayBuffer();
    };
    for (const pg of S.pages) await loadImgs(pg.ink);
    try {
      // PDF 쪽이 원래 순서 그대로면 원본에 덧그리고, 옮기거나 복사한 쪽이 있으면 새 PDF에 쪽을 옮겨 담음 (글자는 그대로 선명)
      const src = rec ? await PDFDocument.load(rec.data.slice(0), { ignoreEncryption: false, updateMetadata: false }) : null;
      const srcIdx = S.pages.filter(pg => !pg.blank).map(pg => pg.src);
      let doc;
      if (!src) doc = await PDFDocument.create();
      else if (srcIdx.length === src.getPageCount() && srcIdx.every((s, k) => s === k)) doc = src;
      else { doc = await PDFDocument.create(); for (const p of await doc.copyPages(src, srcIdx)) doc.addPage(p); }
      let font = null;
      for (let d = 0; d < S.pages.length; d++) {
        const pg = S.pages[d];
        if (!pg.blank) continue;
        const page = doc.insertPage(d, [pg.w, pg.h]), { L, T } = patternSpec(pg);
        for (const [x0, y0, x1, y1, c, w] of L) page.drawLine({ start: { x: x0, y: pg.h - y0 }, end: { x: x1, y: pg.h - y1 }, thickness: w, color: hex(c), lineCap: LineCapStyle.Round });
        if (T.length && !font) font = await doc.embedFont(StandardFonts.Helvetica);
        for (const [x, y, t, size, al, base] of T) {
          const tw = font.widthOfTextAtSize(t, size);
          page.drawText(t, { x: al === 'c' ? x - tw / 2 : al === 'r' ? x - tw : x, y: pg.h - y - (base === 'top' ? size * 0.74 : size * 0.36), size, font, color: hex(PC.axis) });
        }
      }
      const pages = doc.getPages(), imgs = new Map();
      for (let d = 0; d < S.pages.length; d++) {
        const list = S.pages[d].ink, page = pages[d], vp = vps[d];
        if (!page || !list.length) continue;
        const P = (x, y) => { const q = vp.convertToPdfPoint(x, y); return `${q[0].toFixed(2)} ${(-q[1]).toFixed(2)}`; };
        for (const s of list) {
          if (s.k === 'text') {
            const img = await doc.embedPng(await textPng(s)), q = vp.convertToPdfPoint(s.x, s.y + s.th);
            page.drawImage(img, { x: q[0], y: q[1], width: s.tw, height: s.th });
            continue;
          }
          if (s.k === 'img') {
            let img = imgs.get(s.src);
            if (!img) {
              const bytes = await fromB64(s.src.slice(s.src.indexOf(',') + 1));
              img = /^data:image\/png/.test(s.src) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
              imgs.set(s.src, img);
            }
            const q = vp.convertToPdfPoint(s.x, s.y + s.ih);
            page.drawImage(img, { x: q[0], y: q[1], width: s.iw, height: s.ih });
            continue;
          }
          if (s.k !== 'pen' && s.k !== 'hl') continue;
          const opt = { x: 0, y: 0, borderColor: hex(s.c), borderLineCap: LineCapStyle.Round, borderOpacity: s.k === 'hl' ? HL_ALPHA : 1 };
          const pts = s.p;
          if (s.sh) {
            let dd = `M ${P(pts[0][0], pts[0][1])}`;
            for (let n = 1; n < pts.length; n++) dd += ` L ${P(pts[n][0], pts[n][1])}`;
            if (pts.length === 1) dd += ` L ${P(pts[0][0] + 0.01, pts[0][1])}`;
            page.drawSvgPath(dd, Object.assign(opt, { borderWidth: s.w }));
          } else if (s.k === 'hl' || !s.pr || pts.length < 3) {
            let dd = `M ${P(pts[0][0], pts[0][1])}`;
            if (pts.length === 1) dd += ` L ${P(pts[0][0] + 0.01, pts[0][1])}`;
            else if (pts.length === 2) dd += ` L ${P(pts[1][0], pts[1][1])}`;
            else {
              for (let n = 1; n < pts.length - 1; n++) dd += ` Q ${P(pts[n][0], pts[n][1])} ${P((pts[n][0] + pts[n + 1][0]) / 2, (pts[n][1] + pts[n + 1][1]) / 2)}`;
              dd += ` L ${P(pts[pts.length - 1][0], pts[pts.length - 1][1])}`;
            }
            page.drawSvgPath(dd, Object.assign(opt, { borderWidth: s.k === 'hl' || !s.pr ? s.w : widthAt(s, pts[0][2]) }));
          } else {
            segments(pts, (a, c, b, pr) => page.drawSvgPath(`M ${P(a[0], a[1])} Q ${P(c[0], c[1])} ${P(b[0], b[1])}`, Object.assign({}, opt, { borderWidth: widthAt(s, pr) })));
          }
        }
      }
      return new Blob([await doc.save()], { type: 'application/pdf' });
    } catch (err) {
      const doc = await PDFDocument.create();
      for (let d = 0; d < S.pages.length; d++) {
        const pg = S.pages[d], vp1 = vps[d], k = Math.min(2, 2400 / Math.max(vp1.width, vp1.height));
        const c = document.createElement('canvas');
        const ctx = c.getContext('2d', { alpha: false });
        if (pg.blank) { c.width = Math.floor(pg.w * k); c.height = Math.floor(pg.h * k); paintPattern(ctx, pg, k); }
        else {
          const page = await S.pdf.getPage(pg.src + 1), vp = page.getViewport({ scale: k });
          c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
        }
        for (const s of pg.ink) paintItem(ctx, s, k);
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
    const sheet = S.meta.kind === 'sheet', grade = S.meta.kind === 'grade';
    const name = ls.get(K.name, '') || ls.get('irae-homework-name', '') || '';
    const base = safeName(S.meta.name.replace(/\.pdf$/i, ''));
    showModal(sheet ? `
      <h2>선생님께 보내기</h2>
      <ol>
        <li><b>이름</b>을 확인해요.</li>
        <li><b>[카톡으로 보내기]</b> → 나오는 목록에서 <b>카카오톡</b> → <b>선생님</b>(또는 반 단톡방)을 골라 보내요.</li>
        <li>목록에 카톡이 없으면 <b>[파일로 저장]</b>한 뒤, 카톡 채팅방의 <b>+ → 파일</b>에서 골라 보내요.</li>
      </ol>
      <label for="send-name">이름</label><input id="send-name" autocomplete="name" value="${esc(name)}" placeholder="이름을 적어 주세요">
      <p class="msg" id="send-msg" role="status"></p>
      <div class="row"><button class="btn ghost" type="button" data-m="close">닫기</button><button class="btn ghost" type="button" data-m="download" disabled>파일로 저장</button><button class="btn" type="button" data-m="share" disabled>카톡으로 보내기</button></div>`
      : grade ? `
      <h2>채점 돌려주기</h2>
      <ol>
        <li><b>[카톡으로 보내기]</b> → <b>카카오톡</b> → 그 학생(또는 반 단톡방)을 골라 보내요.</li>
        <li>목록에 카톡이 없으면 <b>[파일로 저장]</b>한 뒤, 채팅방의 <b>+ → 파일</b>에서 보내요.</li>
      </ol>
      <p>파일 이름: <b>${esc(base)}-채점.pdf</b></p>
      <p class="msg" id="send-msg" role="status"></p>
      <div class="row"><button class="btn ghost" type="button" data-m="close">닫기</button><button class="btn ghost" type="button" data-m="download" disabled>파일로 저장</button><button class="btn" type="button" data-m="share" disabled>카톡으로 보내기</button></div>`
      : `
      <h2>PDF로 저장</h2>
      <p>필기가 들어간 PDF를 만들어요. 인쇄하거나 다른 사람에게 보낼 수 있어요.</p>
      <p class="msg" id="send-msg" role="status"></p>
      <div class="row"><button class="btn ghost" type="button" data-m="close">닫기</button><button class="btn ghost" type="button" data-m="share" disabled>공유하기</button><button class="btn" type="button" data-m="download" disabled>파일로 저장</button></div>`, sendClick);
    const card = $('#modal-card');
    prepared = null;
    const msg = $('#send-msg');
    msg.className = 'msg'; msg.textContent = '필기를 넣은 PDF를 만드는 중이에요…';
    const fileName = () => sheet ? `${safeName($('#send-name').value) || '이름없음'}-${base}.pdf` : grade ? `${base}-채점.pdf` : `${base}-필기.pdf`;
    exportPdf().then(blob => {
      prepared = { blob, fileName };
      msg.textContent = `준비됐어요. (${Math.max(1, Math.round(blob.size / 1024))}KB)`;
      card.querySelectorAll('[data-m="share"],[data-m="download"]').forEach(b => { b.disabled = false; });
      if (!canShareFiles()) { const sb = card.querySelector('[data-m="share"]'); if (sb && !sheet && !grade) sb.hidden = true; }
    }).catch(() => { msg.className = 'msg err'; msg.textContent = 'PDF를 만들지 못했어요. 다시 시도해 주세요.'; });
    const ni = $('#send-name'); if (ni) ni.focus({ preventScroll: true });
  }
  function canShareFiles(type = 'application/pdf', ext = 'pdf') {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'])], 'x.' + ext, { type })] })); } catch (e) { return false; }
  }
  function sendClick(b) {
    if (!prepared) return;
    const sheet = S.meta.kind === 'sheet', grade = S.meta.kind === 'grade', msg = $('#send-msg');
    if (sheet) {
      const nm = $('#send-name').value.trim();
      if (!nm) { msg.className = 'msg err'; msg.textContent = '이름을 먼저 적어 주세요.'; $('#send-name').focus({ preventScroll: true }); return; }
      ls.set(K.name, nm);
    }
    const name = prepared.fileName();
    const file = new File([prepared.blob], name, { type: 'application/pdf' });
    const done = () => {
      if (!sheet && !grade) return;
      S.meta.sentAt = Date.now(); DB.put('meta', S.meta).catch(() => {});
    };
    const later = sheet || grade ? ' 카톡 채팅방의 + → 파일에서 보내 주세요.' : '';
    if (b.dataset.m === 'share') {
      if (!canShareFiles()) { download(file); msg.className = 'msg'; msg.textContent = '이 기기에서는 바로 보내기가 안 돼서 파일로 저장했어요.' + later; done(); return; }
      navigator.share(Object.assign({ files: [file], title: name }, sheet ? { text: `[이레 노트] ${$('#send-name').value.trim()} - ${S.meta.name}` } : grade ? { text: `[이레 노트] 채점 결과 - ${S.meta.name}` } : {}))
        .then(() => { msg.className = 'msg'; msg.textContent = sheet ? '보냈어요. 선생님 채팅방에 잘 갔는지 확인해 주세요.' : grade ? '보냈어요. 학생 채팅방에 잘 갔는지 확인해 주세요.' : '공유했어요.'; done(); })
        .catch(err => { if (err && err.name === 'AbortError') return; download(file); msg.textContent = '공유가 안 돼서 파일로 저장했어요.'; done(); });
    } else if (b.dataset.m === 'download') {
      download(file); msg.className = 'msg'; msg.textContent = `‘${name}’ 파일로 저장했어요.${later}`; done();
    }
  }
  function download(file) {
    const url = URL.createObjectURL(file), a = document.createElement('a');
    a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ════════════════ 사진 넣기 ════════════════
  // 긴 쪽 1600px까지 줄여 JPEG로 필기 항목에 담음 (백업·되돌리기·복제가 그대로 됨)
  let photoPage = null;
  async function readPhoto(f) {
    const url = URL.createObjectURL(f);
    try {
      const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const sc = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(im.naturalWidth * sc)); c.height = Math.max(1, Math.round(im.naturalHeight * sc));
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(im, 0, 0, c.width, c.height);
      return { src: c.toDataURL('image/jpeg', 0.85), w: c.width, h: c.height };
    } finally { URL.revokeObjectURL(url); }
  }
  function placePhoto(pg, ph) {
    const f = Math.min(pg.w * 0.6 / ph.w, pg.h * 0.5 / ph.h), iw = r2(ph.w * f), ih = r2(ph.h * f);
    // 화면 가운데(그 쪽 안)에
    let cx = pg.w / 2, cy = pg.h / 2;
    if (pg.el) {
      const r = docEl.getBoundingClientRect(), pr = pg.el.getBoundingClientRect();
      cx = clamp((r.left + r.width / 2 - pr.left) / S.scale, iw / 2, pg.w - iw / 2);
      cy = clamp((r.top + r.height / 2 - pr.top) / S.scale, ih / 2, pg.h - ih / 2);
    }
    const s = { k: 'img', x: r2(cx - iw / 2), y: r2(cy - ih / 2), iw, ih, src: ph.src };
    pg.ink.push(s);
    record({ t: 'add', items: [{ pg, s }] });
    if (S.tool !== 'lasso') { S.tool = 'lasso'; saveSettings(); renderTools(); }
    SEL = { pg, set: new Set([s]) };
    drawPg(pg); showSel();
    toast('사진을 넣었어요. 끌어서 옮기고, 오른쪽 아래 ●를 끌어 크기를 바꿔요.', 3600);
  }
  $('#img-in').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    const pg = photoPage || S.pages[S.cur]; photoPage = null;
    if (!f || !pg || !S.pages.includes(pg)) return;
    toast('사진을 넣는 중…', 0);
    try { placePhoto(pg, await readPhoto(f)); } catch (err) { toast('이 사진은 열 수 없어요. 다른 사진(JPG·PNG)을 골라 주세요.', 4000); }
  });

  // ════════════════ 오답 노트 ════════════════
  // 틀린 문제를 상자로 두르면 그 부분(PDF + 고르면 내 필기)을 그림으로 떠서 '오답 노트' 문서(A4 백지 쪽들)에 차례로 붙임
  function commitClip(a) {
    act = null;
    const [x, y, w, h] = rectOf(a.p0, a.p1, a.pg);
    if (w * S.scale < 20 || h * S.scale < 20) { a.el.remove(); toast('담을 문제를 상자로 크게 둘러 주세요.'); return; }
    const pg = a.pg, n = S.pages.indexOf(pg) + 1, hasInk = pg.ink.some(s => s.k !== 'cover' && (() => { const b = bounds(s); return b[0] < x + w && b[2] > x && b[1] < y + h && b[3] > y; })());
    showModal(`
      <h2>오답 노트에 담기</h2>
      <p>고른 부분(${n}쪽)을 오답 노트에 담아요. 다시 풀 거면 [문제만 담기]가 좋아요.</p>
      <p class="msg" id="clip-msg" role="status"></p>
      <div class="row"><button class="btn ghost" type="button" data-m="close">취소</button>${hasInk ? '<button class="btn ghost" type="button" data-m="ink">내 필기까지 담기</button>' : ''}<button class="btn" type="button" data-m="clean">문제만 담기</button></div>`, async b => {
      if ((b.dataset.m !== 'ink' && b.dataset.m !== 'clean') || b.disabled) return;
      $('#modal-card').querySelectorAll('[data-m]').forEach(x => { x.disabled = true; });
      $('#clip-msg').textContent = '담는 중이에요…';
      try {
        const src = await captureRegion(pg, [x, y, w, h], b.dataset.m === 'ink');
        const count = await addToWrong(src, w, h, `${S.meta.name.replace(/\.pdf$/i, '')} · ${n}쪽 · ${fmtDay(Date.now())}`);
        closeModal();
        toast(`오답 노트에 담았어요. (모두 ${count}문제) 첫 화면의 ‘오답 노트’에서 다시 풀어요.`, 3600);
      } catch (err) { const m = $('#clip-msg'); if (m) { m.className = 'msg err'; m.textContent = '담지 못했어요. 저장 공간을 확인해 주세요.'; } $('#modal-card').querySelectorAll('[data-m]').forEach(x => { x.disabled = false; }); }
    }, () => a.el.remove());
  }
  const fmtDay = t => { try { return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' }).format(new Date(t)); } catch (e) { return ''; } };
  async function captureRegion(pg, [x, y, w, h], withInk) {
    const k = Math.min(3, 1400 / Math.max(w, h)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const ctx = c.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    if (pg.blank) { ctx.save(); ctx.translate(-x * k, -y * k); paintPattern(ctx, pg, k); ctx.restore(); }
    else {
      const page = await S.pdf.getPage(pg.src + 1), vp = page.getViewport({ scale: k, offsetX: -x * k, offsetY: -y * k });
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    }
    if (withInk) {
      await loadImgs(pg.ink);
      ctx.save(); ctx.translate(-x * k, -y * k);
      for (const s of pg.ink) paintItem(ctx, s, k);
      ctx.restore();
    } else {
      // 문제만: 넣은 사진은 문제의 일부일 수 있어서 함께
      const ims = pg.ink.filter(s => s.k === 'img');
      if (ims.length) { await loadImgs(ims); ctx.save(); ctx.translate(-x * k, -y * k); for (const s of ims) paintItem(ctx, s, k); ctx.restore(); }
    }
    const url = c.toDataURL('image/jpeg', 0.88);
    c.width = c.height = 0;
    return url;
  }
  async function addToWrong(src, w, h, label) {
    const meta = (await DB.get('meta', WRONG).catch(() => null)) || { id: WRONG, kind: 'wrong', name: '오답 노트', added: Date.now() };
    const rec = (await DB.get('ink', WRONG).catch(() => null)) || { id: WRONG, pages: {} };
    const order = Array.isArray(rec.order) && rec.order.length ? rec.order : [{ b: 'plain', w: A4.w, h: A4.h }];
    const M = 36, f = Math.min(1, (A4.w - 2 * M) / w, (A4.h - 2 * M - 20) / h), iw = r2(w * f), ih = r2(h * f);
    let li = order.length - 1;
    const bottom = (rec.pages[li] || []).reduce((m, s) => Math.max(m, bounds(s)[3]), 0);
    let y = bottom ? bottom + 30 : M;
    if (y + 16 + ih > A4.h - M) { order.push({ b: 'plain', w: A4.w, h: A4.h }); li++; y = M; }
    const t = measureText({ k: 'text', x: M, y: r2(y), t: label, c: '#5B6675', fs: 9 });
    const im = { k: 'img', x: M, y: r2(y + 15), iw, ih, src };
    rec.pages[li] = (rec.pages[li] || []).concat([t, im]);
    rec.order = order; rec.updated = Date.now();
    let n = 0, clips = 0;
    for (const k of Object.keys(rec.pages)) { n += rec.pages[k].length; clips += rec.pages[k].filter(s => s.k === 'img').length; }
    Object.assign(meta, { pages: order.length, inkCount: n, clips });
    await DB.put('ink', rec); await DB.put('meta', meta);
    return clips;
  }

  // ════════════════ 점수 매기기·채점 기록 ════════════════
  function countStamps() {
    let o = 0, x = 0;
    for (const pg of S.pages) for (const s of pg.ink) { if (s.st === 'o' || s.st === 'v') o++; else if (s.st === 'x') x++; }
    return { o, x };
  }
  // 학생이 보낸 파일 이름은 "이름-학습지.pdf"
  const guessStudent = name => { const m = String(name).replace(/\.pdf$/i, '').match(/^([^-_]{1,12})[-_]/); return m ? m[1].trim() : ''; };
  const scoreText = (r, t, hundred) => `${r}/${t}` + (hundred ? ` · ${Math.round(r / t * 100)}점` : '');
  function openScore() {
    if (!isGrade()) return;
    const { o, x } = countStamps(), prev = S.meta.score || {};
    const name0 = prev.student || guessStudent(S.meta.name);
    showModal(`
      <h2>점수 매기기</h2>
      <p>도장 ○·✓ <b>${o}</b>개, ✗ <b>${x}</b>개를 셌어요. 숫자는 고칠 수 있어요.</p>
      <div class="inrow sc-row"><label>맞은 수<input id="sc-r" type="number" min="0" step="1" inputmode="numeric" value="${o}"></label><label>문제 수<input id="sc-t" type="number" min="1" step="1" inputmode="numeric" value="${o + x || ''}"></label></div>
      <label for="sc-name">학생 이름 (채점 기록에 남아요)</label><input id="sc-name" value="${esc(name0)}" placeholder="이름">
      <label class="check"><input type="checkbox" id="sc-100"${prev.hundred === false ? '' : ' checked'}> 100점 만점 점수도 함께 쓰기</label>
      <p class="score-prev" id="sc-prev"></p>
      <div class="row"><button class="btn ghost" type="button" data-m="close">닫기</button><button class="btn" type="button" data-m="ok">첫 쪽에 점수 찍기</button></div>`, b => {
      if (b.dataset.m !== 'ok') return;
      const v = read(); if (!v) { $('#sc-t').focus({ preventScroll: true }); return; }
      closeModal(); placeScore(v);
    });
    const read = () => {
      const r = Number($('#sc-r').value), t = Number($('#sc-t').value);
      if (!(Number.isInteger(r) && Number.isInteger(t) && t > 0 && r >= 0 && r <= t)) return null;
      return { r, t, hundred: $('#sc-100').checked, student: $('#sc-name').value.trim() };
    };
    const upd = () => { const v = read(), p = $('#sc-prev'); p.textContent = v ? scoreText(v.r, v.t, v.hundred) : '맞은 수와 문제 수를 확인해 주세요.'; p.classList.toggle('err', !v); };
    $('#modal-card').oninput = upd; $('#modal-card').onchange = upd; upd();
  }
  function placeScore(v) {
    const pg = S.pages[0];
    const old = [];
    for (let j = pg.ink.length - 1; j >= 0; j--) if (pg.ink[j].sc) { old.push({ pg, s: pg.ink[j], at: j }); pg.ink.splice(j, 1); }
    const t = measureText({ k: 'text', x: 0, y: 0, t: scoreText(v.r, v.t, v.hundred), c: STAMP_C, fs: 24, sc: 1 });
    t.x = r2(Math.max(8, pg.w - t.tw - 40)); t.y = 28;
    const p = 7, [a, b, c, d] = [t.x - p, t.y - p + 2, t.x + t.tw + p, t.y + t.th + p - 2];
    const box = { k: 'pen', c: STAMP_C, w: 2, sh: 1, sc: 1, p: [[a, b], [c, b], [c, d], [a, d], [a, b]].map(q => [r2(q[0]), r2(q[1]), 0.5]) };
    pg.ink.push(t, box);
    record({ t: 'erase', items: old, adds: [{ pg, s: t }, { pg, s: box }] });
    drawPg(pg); goPage(0);
    S.meta.score = { r: v.r, t: v.t, hundred: v.hundred, student: v.student, at: Date.now() };
    DB.put('meta', S.meta).catch(() => {});
    const log = ls.get(K.grades, []).filter(g => g && g.id !== S.meta.id);
    log.push({ id: S.meta.id, student: v.student, file: S.meta.name, r: v.r, t: v.t, at: Date.now() });
    ls.set(K.grades, log.slice(-500));
    toast(`첫 쪽에 ${scoreText(v.r, v.t, v.hundred)}을 찍었어요. 채점 기록에도 남았어요.`, 3200);
  }
  const kstStamp = t => { try { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t)); } catch (e) { return new Date(t).toISOString().slice(0, 16).replace('T', ' '); } };
  function openGrades() {
    let armed = false;
    const html = () => {
      const list = ls.get(K.grades, []).filter(g => g && g.t).sort((a, b) => b.at - a.at);
      return `
      <h2>채점 기록</h2>
      ${list.length ? `<p>이 기기에서 점수를 매긴 ${list.length}개예요. PDF를 지워도 기록은 남아요.</p>
      <div class="gtable"><table><thead><tr><th>날짜</th><th>학생</th><th>학습지</th><th>점수</th></tr></thead><tbody>
      ${list.map(g => `<tr><td>${esc(kstStamp(g.at).slice(5, 10).replace('-', '.'))}</td><td>${esc(g.student || '—')}</td><td>${esc(String(g.file || '').replace(/\.pdf$/i, ''))}</td><td class="num">${g.r}/${g.t} <small>${Math.round(g.r / g.t * 100)}</small></td></tr>`).join('')}
      </tbody></table></div>` : '<p>아직 기록이 없어요. 학생 PDF를 채점하고 [점수] 버튼으로 점수를 찍으면 여기에 모여요.</p>'}
      <div class="row">${list.length ? `<button class="btn ghost${armed ? ' armed' : ''}" type="button" data-m="clear">${armed ? '한 번 더 누르면 모두 지워요' : '기록 지우기'}</button><button class="btn ghost" type="button" data-m="csv">표로 저장 (엑셀)</button>` : ''}<button class="btn" type="button" data-m="close">닫기</button></div>`;
    };
    const fn = b => {
      if (b.dataset.m === 'clear') { if (!armed) { armed = true; showModal(html(), fn); return; } ls.set(K.grades, []); armed = false; showModal(html(), fn); toast('채점 기록을 지웠어요.'); return; }
      if (b.dataset.m === 'csv') {
        const list = ls.get(K.grades, []).filter(g => g && g.t).sort((a, b) => a.at - b.at);
        const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const rows = [['날짜', '학생', '학습지', '맞은 수', '문제 수', '점수(100점)']].concat(list.map(g => [kstStamp(g.at), g.student || '', String(g.file || '').replace(/\.pdf$/i, ''), g.r, g.t, Math.round(g.r / g.t * 100)]));
        const day = kstStamp(Date.now()).slice(0, 10);
        download(new File(['﻿' + rows.map(r => r.map(q).join(',')).join('\r\n')], `이레노트-채점기록-${day}.csv`, { type: 'text/csv' }));
        toast('채점 기록을 표(CSV) 파일로 저장했어요. 엑셀에서 열 수 있어요.', 3200);
      }
    };
    showModal(html(), fn);
  }

  // ════════════════ 발표자 뽑기 ════════════════
  // 명단은 이 기기에 저장. ‘뽑힌 사람 빼고’를 켜면 모두 한 번씩 나올 때까지 겹치지 않음
  function openPicker() {
    const R = Object.assign({ names: [], used: [], noRepeat: true }, ls.get(K.roster, {}));
    let editing = !R.names.length, busy = false, last = '';
    const save = () => ls.set(K.roster, R);
    const pool = () => R.noRepeat ? R.names.filter(n => !R.used.includes(n)) : R.names;
    const html = () => editing ? `
      <h2>발표자 뽑기 · 명단</h2>
      <p>한 줄에 한 명씩 적어요. (쉼표로 나눠도 돼요) 이 기기에 저장돼요.</p>
      <textarea id="rs" rows="8" placeholder="김하늘&#10;이바다&#10;박솔">${esc(R.names.join('\n'))}</textarea>
      <div class="row">${R.names.length ? '<button class="btn ghost" type="button" data-m="back">취소</button>' : '<button class="btn ghost" type="button" data-m="close">닫기</button>'}<button class="btn" type="button" data-m="save">명단 저장</button></div>`
      : `
      <h2>발표자 뽑기</h2>
      <div class="pick-name" id="pk">${esc(last || '?')}</div>
      <p class="pick-info" id="pk-info">${R.noRepeat ? `남은 사람 ${pool().length}명 / 모두 ${R.names.length}명` : `모두 ${R.names.length}명`}</p>
      <label class="check"><input type="checkbox" id="pk-nr"${R.noRepeat ? ' checked' : ''}> 뽑힌 사람은 빼고 뽑기</label>
      <div class="row"><button class="btn ghost" type="button" data-m="edit">명단 고치기</button>${R.noRepeat && R.used.length ? '<button class="btn ghost" type="button" data-m="reset">처음부터</button>' : ''}<button class="btn ghost" type="button" data-m="close">닫기</button><button class="btn" type="button" data-m="go">뽑기</button></div>`;
    const fn = b => {
      const m = b.dataset.m;
      if (busy) return;
      if (m === 'edit') { editing = true; show(); return; }
      if (m === 'back') { editing = false; show(); return; }
      if (m === 'save') {
        const names = [...new Set($('#rs').value.split(/[\n,]/).map(s => s.trim()).filter(Boolean))].slice(0, 200);
        if (!names.length) { $('#rs').focus({ preventScroll: true }); return; }
        R.names = names; R.used = R.used.filter(n => names.includes(n)); save(); editing = false; show(); return;
      }
      if (m === 'reset') { R.used = []; save(); last = ''; show(); return; }
      if (m === 'go') {
        R.noRepeat = $('#pk-nr').checked;
        let P = pool();
        if (!P.length) { R.used = []; P = R.names.slice(); toast('모두 한 번씩 뽑혔어요. 처음부터 다시 뽑아요.'); }
        const pick = P[Math.floor(Math.random() * P.length)];
        busy = true;
        const el = $('#pk'); el.classList.add('rolling');
        let k = 0;
        const step = () => {
          if (!$('#pk')) { busy = false; return; }   // 창을 닫음
          if (k < 14) { el.textContent = R.names[Math.floor(Math.random() * R.names.length)]; k++; setTimeout(step, 50 + k * k * 1.6); return; }
          el.textContent = pick; el.classList.remove('rolling'); el.classList.add('picked');
          last = pick; if (R.noRepeat) R.used.push(pick); save(); busy = false;
          const info = $('#pk-info'); if (info) info.textContent = R.noRepeat ? `남은 사람 ${pool().length}명 / 모두 ${R.names.length}명` : `모두 ${R.names.length}명`;
        };
        el.classList.remove('picked'); step();
      }
    };
    const show = () => {
      showModal(html(), fn);
      $('#modal-card').onchange = e => { if (e.target.id === 'pk-nr') { R.noRepeat = e.target.checked; save(); const info = $('#pk-info'); if (info) info.textContent = R.noRepeat ? `남은 사람 ${pool().length}명 / 모두 ${R.names.length}명` : `모두 ${R.names.length}명`; } };
      if (editing) $('#rs').focus({ preventScroll: true });
    };
    show();
  }

  // ════════════════ 필기 백업·불러오기 ════════════════
  // 백업 파일 = 문서 정보 + 필기 (+ 고르면 내 PDF 원본). 선생님 학습지 PDF는 다시 받을 수 있어서 넣지 않음
  const toB64 = buf => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(r.error); r.readAsDataURL(new Blob([buf])); });
  const fromB64 = async s => (await fetch('data:application/octet-stream;base64,' + s)).arrayBuffer();
  const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';
  async function openBackup() {
    const metas = await DB.all('meta').catch(() => []);
    if (!metas.length) { toast('아직 백업할 필기가 없어요.'); return; }
    const own = metas.filter(m => m.kind === 'file' || m.kind === 'grade'), pdfSize = own.reduce((a, m) => a + (m.size || 0), 0);
    const inkN = metas.filter(m => m.inkCount).length;
    showModal(`
      <h2>필기 백업</h2>
      <p>문서 ${metas.length}개(필기 있는 것 ${inkN}개)를 파일 하나로 저장해요. 새 기기나 앱을 다시 설치한 뒤 [백업 불러오기]로 되살려요.</p>
      ${own.length ? `<label class="check"><input type="checkbox" id="bk-pdf"${pdfSize < 30 * 1048576 ? ' checked' : ''}> 내 PDF·채점 PDF 파일도 함께 넣기 (${fmtSize(pdfSize)})</label>
      <p class="hint">빼면 백업이 작아지고, 새 기기에서 같은 PDF를 다시 열면 필기가 이어져요.</p>` : ''}
      <p class="msg" id="bk-msg" role="status"></p>
      <div class="row"><button class="btn ghost" type="button" data-m="close">닫기</button><button class="btn" type="button" data-m="make">백업 파일 만들기</button></div>`, async b => {
      if (b.dataset.m !== 'make' || b.disabled) return;
      const msg = $('#bk-msg'), withPdf = !!($('#bk-pdf') && $('#bk-pdf').checked);
      b.disabled = true; msg.className = 'msg'; msg.textContent = '백업 파일을 만드는 중이에요…';
      try {
        const docs = [];
        for (const m of metas) {
          const d = { meta: m, ink: await DB.get('ink', m.id).catch(() => null) };
          if (withPdf && (m.kind === 'file' || m.kind === 'grade')) { const p = await DB.get('pdf', m.id).catch(() => null); if (p) d.pdf = await toB64(p.data); }
          docs.push(d);
        }
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const file = new File([JSON.stringify({ app: 'yireh-note', v: 1, at: Date.now(), docs })], `이레노트-백업-${today}.json`, { type: 'application/json' });
        download(file);
        msg.textContent = `‘${file.name}’(${fmtSize(file.size)})로 저장했어요. 아이패드는 ‘파일’ 앱의 다운로드 폴더에 있어요.`;
      } catch (e) { msg.className = 'msg err'; msg.textContent = '백업 파일을 만들지 못했어요. 저장 공간을 확인해 주세요.'; }
      b.disabled = false;
    });
  }
  $('#bk-in').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch (err) { data = null; }
    if (!data || data.app !== 'yireh-note' || !Array.isArray(data.docs)) { toast('이레 노트 백업 파일이 아니에요.', 3600); return; }
    const docs = data.docs.filter(d => d && d.meta && typeof d.meta.id === 'string' && /^(sheet|file|grade|wrong):/.test(d.meta.id));
    const metas = await DB.all('meta').catch(() => []), have = new Set(metas.map(m => m.id));
    const over = docs.filter(d => have.has(d.meta.id)).length;
    showModal(`
      <h2>백업 불러오기</h2>
      <p>${fmtDate(data.at)}에 만든 백업이에요. 문서 ${docs.length}개를 불러와요.</p>
      ${over ? `<p><b>이 기기에 이미 있는 문서 ${over}개</b>는 백업 내용으로 바뀌어요.</p>` : ''}
      <p class="msg" id="bk-msg" role="status"></p>
      <div class="row"><button class="btn ghost" type="button" data-m="close">닫기</button><button class="btn" type="button" data-m="go">불러오기</button></div>`, async b => {
      if (b.dataset.m !== 'go' || b.disabled) return;
      b.disabled = true;
      const msg = $('#bk-msg'); msg.textContent = '불러오는 중이에요…';
      try {
        for (const d of docs) {
          const m = Object.assign({}, d.meta);
          if (d.pdf) { await DB.put('pdf', { id: m.id, data: await fromB64(d.pdf) }); delete m.noPdf; }
          else if (m.kind !== 'sheet' && m.kind !== 'wrong') { if (!(await DB.get('pdf', m.id).catch(() => null))) m.noPdf = true; else delete m.noPdf; }
          await DB.put('meta', m);
          if (d.ink && d.ink.pages) await DB.put('ink', Object.assign({}, d.ink, { id: m.id }));
        }
        closeModal(); toast(`문서 ${docs.length}개를 불러왔어요.`, 3600); renderHome();
      } catch (err) { msg.className = 'msg err'; msg.textContent = '불러오지 못했어요. 저장 공간을 확인해 주세요.'; b.disabled = false; }
    });
  });

  // 점검용
  window.NOTE_DEBUG = { S, DB, exportPdf, flushInk, openDoc, openSheet, layout, updateVisible, recognize, FX, T, G, curtains, patternSpec, placePhoto, addToWrong, countStamps, get SEL() { return SEL; }, get RP() { return RP; } };
  renderHome();
})();
