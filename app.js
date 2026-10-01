/* PPMI 復康用品價目平台 — frontend (vanilla JS, hash routing, Supabase RPC backend) */
(() => {
  'use strict';

  // ---------- config ----------
  const CFG = window.PPMI_CONFIG || {};
  const TEAMS = ['Medical', 'Ortho', 'Community'];
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  // ---------- state ----------
  const S = {
    theme: store.get('ppmi_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    lang: ['zh', 'en', 'both'].includes(store.get('ppmi_lang')) ? store.get('ppmi_lang') : 'zh',
    tblScale: Number(store.get('ppmi_tbl_scale')) || 0.85,
    adminToken: store.get('ppmi_admin_token'),
    admin: null, // overview payload
    tab: 'list',
    filters: { q: '', team: '', category: '', supplier: '', status: 'all', since: '' },
    portal: null, // { token, data, error }
    loading: false,
    loginError: '',
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const modal = $('#modal');

  // ---------- i18n ----------
  // L: short label; LH: table header (English as small line in 中英 mode); LP: sentence/paragraph (English on its own muted line in 中英 mode)
  const L = (zh, en) => (S.lang === 'en' ? en : S.lang === 'both' ? `${zh} ${en}` : zh);
  const LH = (zh, en) => (S.lang === 'en' ? en : S.lang === 'both' ? `${zh}<small>${en}</small>` : zh);
  const LP = (zh, en) => (S.lang === 'en' ? en : S.lang === 'both' ? `${zh}<span class="alt">${en}</span>` : zh);
  const locale = () => (S.lang === 'en' ? 'en-HK' : 'zh-HK');

  // ---------- utils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const attr = (s) => esc(s).replace(/\n/g, '&#10;');
  const HK = { timeZone: 'Asia/Hong_Kong' };
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(locale(), { ...HK, year: 'numeric', month: 'short', day: 'numeric' }) : '—');
  const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(locale(), { ...HK, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const toInputDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', HK) : '');
  function rel(iso) {
    if (!iso) return L('從未', 'never');
    const d = (Date.now() - new Date(iso).getTime()) / 864e5;
    if (d < 1) return L('今日', 'today');
    if (d < 30) return L(`${Math.floor(d)} 日前`, `${Math.floor(d)} days ago`);
    if (d < 365) return L(`${Math.floor(d / 30)} 個月前`, `${Math.floor(d / 30)} months ago`);
    return L(`${(d / 365).toFixed(1)} 年前`, `${(d / 365).toFixed(1)} years ago`);
  }
  const monthsAgo = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / (30.44 * 864e5) : Infinity);
  const actorLabel = (a) => ({ import: L('名單匯入', 'Imported list'), supplier: L('供應商', 'Supplier'), admin: L('部門', 'Department') }[a] || a);
  const fieldLabel = (f) => ({
    name: L('項目', 'Item'), model: L('型號', 'Model'), spec: L('尺寸/規格', 'Size'), weight: L('重量', 'Weight'), weight_limit: L('承重', 'Wt. limit'),
    price_text: L('參考價', 'Price'), sales: L('聯絡人', 'Sales'), tel: L('電話', 'Tel'), remarks: L('備註', 'Remarks'), url: L('產品網頁', 'Web page'),
    web_price: L('網上標價', 'Web price'), category: L('類別', 'Category'), subcategory: L('子類別', 'Sub-category'), team: L('組別', 'Team'),
    status: L('狀態', 'Status'), contact_name: L('聯絡人', 'Contact'), email: L('電郵', 'Email'), website: L('公司網址', 'Website'), notes: L('備註', 'Notes'),
  }[f] || f);
  const actionLabel = (a) => ({
    create: L('新增產品', 'Added'), update: L('更改', 'Changed'), discontinue: L('標示停售', 'Discontinued'), restore: L('恢復供應', 'Restored'),
    confirm: L('確認價格無變動', 'Confirmed no change'), delete: L('刪除', 'Deleted'),
  }[a] || a);
  const priceDisplay = (it) => (it.price != null ? `$${Number(it.price).toLocaleString('en-HK')}` : it.price_text || '—');
  // Phone numbers become tap-to-call links (8-digit HK numbers get +852)
  function telLinks(str) {
    if (!str) return '';
    return esc(str).replace(/\//g, '/<wbr>').replace(/\d[\d\s-]{6,}\d/g, (m) => {
      const digits = m.replace(/\D/g, '');
      if (digits.length < 7) return m;
      return `<a class="tel" href="tel:${digits.length === 8 ? '+852' + digits : digits}">${m}</a>`;
    });
  }

  function toast(msg, isErr = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), isErr ? 5000 : 2800);
  }

  // Supabase RPC call. Every read/write goes through SECURITY DEFINER functions; tables are not directly accessible.
  async function rpc(fn, args = {}) {
    if (!CFG.supabaseUrl || !CFG.supabaseKey) throw new Error('config.js 未設定 Supabase 連線資料');
    const res = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: { apikey: CFG.supabaseKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.message || L(`請求失敗 (${res.status})`, `Request failed (${res.status})`);
      if ((res.status === 401 || data?.code === 'PT401') && fn !== 'admin_login') { setAdminToken(null); S.admin = null; S.loginError = L('登入已過期，請重新登入', 'Session expired, please log in again'); render(); }
      throw new Error(msg === 'UNAUTHORIZED' ? L('請先登入', 'Please log in') : msg);
    }
    return data;
  }
  const adminRpc = (fn, args = {}) => rpc(fn, { p_token: S.adminToken, ...args });
  const portalRpc = (fn, args = {}) => rpc(fn, { p_stoken: S.portal.token, ...args });
  function setAdminToken(t) { S.adminToken = t; store.set('ppmi_admin_token', t); }

  // Price changed on the platform since the reference date ("最後更新日期")
  function priceChangedSince(it, sinceIso) {
    if (it.updated_by === 'import') return false;
    const since = sinceIso ? new Date(sinceIso).getTime() : 0;
    return new Date(it.price_updated_at).getTime() >= since;
  }
  const statusPill = (it) => (it.status === 'discontinued'
    ? `<span class="pill pill-stale">${L('已停售', 'Discontinued')}</span>`
    : `<span class="pill">${L('有售', 'Available')}</span>`);
  function supplierState(s, staleMonths) {
    const last = [s.last_updated_at, s.last_confirmed_at].filter(Boolean).sort().pop();
    if (!last) return { key: 'never', pill: `<span class="pill pill-warn pill-dot">${L('待更新', 'Pending')}</span>`, last: null };
    if (monthsAgo(last) > staleMonths) return { key: 'stale', pill: `<span class="pill pill-new pill-dot">${L('逾期', 'Overdue')}</span>`, last };
    return { key: 'ok', pill: `<span class="pill pill-ok pill-dot">${L('已更新', 'Updated')}</span>`, last };
  }

  const ICON = {
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>',
  };

  // ---------- routing ----------
  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, '');
    const m = h.match(/^s\/([A-Za-z0-9_-]+)/);
    if (m) return { kind: 'portal', token: m[1] };
    const tab = ['list', 'suppliers', 'changes', 'settings'].includes(h) ? h : 'list';
    return { kind: 'admin', tab };
  }
  window.addEventListener('hashchange', () => { route(); });
  async function route() {
    const r = parseRoute();
    if (r.kind === 'portal') {
      if (!S.portal || S.portal.token !== r.token) {
        S.portal = { token: r.token, data: null, error: '' };
        render();
        try { S.portal.data = await rpc('supplier_get', { p_stoken: r.token }); } catch (e) { S.portal.error = e.message; }
      }
      render();
      return;
    }
    S.portal = null;
    S.tab = r.tab;
    if (S.adminToken && !S.admin) await loadAdmin();
    render();
  }
  async function loadAdmin() {
    S.loading = true; render();
    try {
      S.admin = await adminRpc('admin_overview');
      if (!S.filters.since) S.filters.since = toInputDate(S.admin.meta.import_date);
    } catch (e) { toast(e.message, true); }
    S.loading = false;
  }

  // ---------- render root ----------
  function render() {
    document.documentElement.dataset.theme = S.theme;
    document.documentElement.lang = S.lang === 'en' ? 'en' : 'zh-HK';
    document.title = L('PPMI 復康用品價目平台', 'PPMI Rehabilitation Aids Price List');
    const r = parseRoute();
    if (r.kind === 'portal') { app.innerHTML = renderPortal(); return; }
    if (!S.adminToken) { app.innerHTML = renderLogin(); setTimeout(() => $('#pw')?.focus(), 0); return; }
    app.innerHTML = renderAdminShell();
  }

  function brandHtml(subtitle) {
    const org = S.lang === 'en'
      ? `<span class="en only">Yan Chai Hospital<br>Occupational Therapy Department</span>`
      : S.lang === 'both'
        ? `仁濟醫院 職業治療部<span class="en">Yan Chai Hospital · Occupational Therapy Department</span>`
        : '仁濟醫院 職業治療部';
    return `<a class="brand" href="${S.portal ? location.hash : '#/'}"><img class="seal" src="images/yan_chai_seal.png" alt="仁濟醫院 Yan Chai Hospital" />
      <div><div class="brand-org">${org}</div><div class="brand-sub">${esc(subtitle)}</div></div></a>`;
  }
  function langSwitch() {
    return `<div class="seg" role="group" aria-label="語言 Language">
      ${[['zh', '中文'], ['en', 'English'], ['both', '中英']].map(([k, l]) => `<button type="button" data-action="lang" data-lang="${k}" aria-pressed="${S.lang === k}">${l}</button>`).join('')}
    </div>`;
  }
  function topbar({ tabs = '', actions = '', subtitle = '' }) {
    return `<header class="topbar">
      ${brandHtml(subtitle)}
      ${tabs}
      <div class="topbar-actions">
        ${actions}
        ${langSwitch()}
        <button class="btn btn-ghost btn-icon" data-action="theme" title="${L('切換深色／淺色', 'Toggle dark / light')}" aria-label="${L('切換深色／淺色', 'Toggle dark / light')}">${S.theme === 'dark' ? ICON.sun : ICON.moon}</button>
      </div>
    </header>`;
  }

  // ---------- login ----------
  function renderLogin() {
    return topbar({ subtitle: L('PPMI 復康用品價目平台 · 部門版', 'PPMI Rehabilitation Aids Price List · Department') }) + `<main class="main"><div class="login-wrap"><form class="card card-pad login" id="loginForm">
      <div><h1>${L('部門登入', 'Department login')}</h1><p>${LP('輸入部門密碼以查看所有供應商的最新價目。供應商請使用部門發出的專屬連結。', 'Enter the department password to view the latest prices from all suppliers. Suppliers should use the private link issued by the department.')}</p></div>
      <div class="field"><label for="pw">${L('密碼', 'Password')}</label><input class="input" type="password" id="pw" name="password" autocomplete="current-password" required /></div>
      ${S.loginError ? `<div class="error">${esc(S.loginError)}</div>` : ''}
      <button class="btn btn-primary" type="submit">${L('登入', 'Log in')}</button>
      <p class="xs faint">${L('忘記密碼請聯絡平台管理員。', 'Forgot the password? Contact the platform administrator.')}</p>
    </form></div></main>`;
  }

  // ---------- admin shell ----------
  function renderAdminShell() {
    const tabs = `<nav class="tabs" role="tablist">
      ${[['list', L('價目總表', 'Price list')], ['suppliers', L('供應商', 'Suppliers')], ['changes', L('更改記錄', 'Change log')], ['settings', L('設定', 'Settings')]]
        .map(([k, l]) => `<a class="tab" role="tab" href="#/${k}" aria-selected="${S.tab === k}">${l}</a>`).join('')}
    </nav>`;
    const actions = `<button class="btn btn-ghost btn-sm" data-action="logout">${L('登出', 'Log out')}</button>`;
    let body;
    if (!S.admin) body = `<div class="container"><div class="card card-pad" style="display:grid;gap:12px"><div class="skel" style="width:40%"></div><div class="skel"></div><div class="skel"></div><div class="skel" style="width:70%"></div></div></div>`;
    else body = { list: renderList, suppliers: renderSuppliers, changes: renderChanges, settings: renderSettings }[S.tab]();
    return topbar({ tabs, actions, subtitle: S.admin ? `${S.admin.meta.title} · ${L('部門版', 'Department')}` : L('部門版', 'Department') }) + `<main class="main">${body}</main>`;
  }

  // ----- price list tab -----
  const sinceIso = () => (S.filters.since ? new Date(S.filters.since + 'T00:00:00+08:00').toISOString() : null);
  function filteredItems() {
    const f = S.filters;
    const q = f.q.trim().toLowerCase();
    const since = sinceIso();
    return S.admin.items.filter((it) => {
      if (f.team && it.team !== f.team) return false;
      if (f.category && it.category !== f.category) return false;
      if (f.supplier && String(it.supplier_id) !== f.supplier) return false;
      if (f.status === 'active' && it.status !== 'active') return false;
      if (f.status === 'discontinued' && it.status !== 'discontinued') return false;
      if (f.status === 'price' && !priceChangedSince(it, since)) return false;
      if (q) {
        const hay = [it.name, it.model, it.supplier_name, it.remarks, it.spec, it.category, it.subcategory, it.sales].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderList() {
    const A = S.admin; const f = S.filters;
    const items = filteredItems();
    const opt = (v, l, cur) => `<option value="${attr(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
    const all = L('全部', 'All');
    const filterbar = `<div class="card">
      <form class="filterbar" id="filters" onsubmit="return false">
        <div class="field grow"><label for="f-q">${L('搜尋', 'Search')}</label><input class="input" id="f-q" name="q" placeholder="${L('項目、型號、供應商、備註…', 'Item, model, supplier, remarks…')}" value="${attr(f.q)}" /></div>
        <div class="field"><label for="f-team">${L('組別', 'Team')}</label><select class="select" id="f-team" name="team">${opt('', all, f.team)}${TEAMS.map((t) => opt(t, t, f.team)).join('')}</select></div>
        <div class="field"><label for="f-cat">${L('類別', 'Category')}</label><select class="select" id="f-cat" name="category">${opt('', all, f.category)}${A.categories.map((c) => opt(c.name, c.name, f.category)).join('')}</select></div>
        <div class="field"><label for="f-sup">${L('供應商', 'Supplier')}</label><select class="select" id="f-sup" name="supplier">${opt('', all, f.supplier)}${A.suppliers.map((s) => opt(s.id, s.name, f.supplier)).join('')}</select></div>
        <div class="field"><label for="f-status">${L('復康用品狀態', 'Item status')}</label><select class="select" id="f-status" name="status">${[['all', all], ['active', L('有售', 'Available')], ['discontinued', L('已停售', 'Discontinued')], ['price', L('價格有變動', 'Price changed')]].map(([v, l]) => opt(v, l, f.status)).join('')}</select></div>
        <div class="field"><label for="f-since">${L('最後更新日期', 'Last updated')}</label><input class="input" type="date" id="f-since" name="since" value="${attr(f.since)}" title="${L('上次人手更新名單的日期；此日期之後的價格變動會標示', 'Date the list was last updated manually; price changes after this date are marked')}" /></div>
        <div class="actions">
          <span class="small muted num">${items.length} ${L('項', 'items')}</span>
          <button class="btn" type="button" data-action="export">${ICON.download}${L('匯出 Excel', 'Export Excel')}</button>
          <button class="btn btn-primary" type="button" data-action="item-new">${ICON.plus}${L('新增產品', 'Add item')}</button>
        </div>
      </form>
    </div>`;
    return `<div class="container">${filterbar}<div class="card">${tableToolbar()}${renderItemsTable(items, { admin: true })}</div></div>`;
  }

  function tableToolbar() {
    const pct = Math.round(S.tblScale * 100);
    return `<div class="card-head" style="padding-top:10px;padding-bottom:10px">
      <span class="small muted">${L('表格字體大小', 'Table text size')}</span><span class="spacer"></span>
      <div class="zoom" role="group" aria-label="${L('表格字體大小', 'Table text size')}">
        <button class="btn btn-sm" type="button" data-action="tbl-zoom" data-delta="-0.1" title="${L('縮小以一眼看盡', 'Smaller — fit more on screen')}" aria-label="${L('縮小', 'Smaller')}">−</button>
        <span class="lvl num">${pct}%</span>
        <button class="btn btn-sm" type="button" data-action="tbl-zoom" data-delta="0.1" title="${L('放大以看得更清楚', 'Larger — easier to read')}" aria-label="${L('放大', 'Larger')}">+</button>
      </div></div>`;
  }

  function renderItemsTable(items, { admin }) {
    if (!items.length) return `<div class="empty">${ICON.box}<div>${L('沒有符合條件的產品', 'No items match the filters')}</div></div>`;
    const since = admin ? sinceIso() : null;
    const H = {
      name: LH('項目', 'Item'), model: LH('型號', 'Model'), supplier: LH('供應商', 'Supplier'), spec: LH('尺寸/規格', 'Size'), wt: LH('重量', 'Wt.'), lim: LH('承重', 'Wt. limit'),
      price: LH('參考價', 'HK$'), contact: LH('聯絡', 'Sales / Tel'), remarks: LH('備註', 'Remarks'), web: LH('產品網頁', 'Web page'), webPrice: LH('網上標價', 'Web price'),
      updated: LH('最後更新', 'Last updated'), status: LH('復康用品狀態', 'Status'), ops: admin ? '' : LH('操作', 'Actions'),
    };
    const cols = admin
      ? [H.name, H.model, H.supplier, H.spec, H.wt, H.lim, H.price, H.contact, H.remarks, H.web, H.webPrice, H.updated, H.status, H.ops]
      : [H.name, H.model, H.spec, H.wt, H.lim, H.price, H.contact, H.remarks, H.updated, H.status, H.ops];
    const span = cols.length;
    let lastCat = null, lastSub = null, rows = '';
    for (const it of items) {
      if (it.category !== lastCat) {
        const cat = (S.admin?.categories || S.portal?.data?.categories || []).find((c) => c.name === it.category);
        rows += `<tr class="group-cat"><td colspan="${span}">${esc(it.category)}${cat?.team ? `<span class="team">${esc(cat.team)} Team</span>` : ''}</td></tr>`;
        lastCat = it.category; lastSub = null;
      }
      if ((it.subcategory || '') !== (lastSub || '')) {
        if (it.subcategory) rows += `<tr class="group-sub"><td colspan="${span}">${esc(it.subcategory)}</td></tr>`;
        lastSub = it.subcategory || '';
      }
      const disc = it.status === 'discontinued';
      const cls = `row-item ${disc ? 'is-disc' : ''}`;
      const changed = admin && !disc && priceChangedSince(it, since);
      const updated = `<span class="nowrap">${fmtDate(it.updated_at)}</span><span class="sub">${it.updated_by === 'import' ? actorLabel('import') : `${actorLabel(it.updated_by)} · ${rel(it.updated_at)}`}</span>`;
      const contact = `${esc(it.sales)}<span class="sub">${telLinks(it.tel)}</span>`;
      const price = `<span class="price num">${esc(priceDisplay(it))}</span>${changed ? `<span class="price-note">${L('價格已更新', 'Price updated')} ${fmtDate(it.price_updated_at)}</span>` : ''}`;
      const web = it.url ? `<a href="${attr(it.url)}" target="_blank" rel="noopener" title="${attr(it.url)}" class="btn btn-ghost btn-sm" aria-label="${L('開啟產品網頁', 'Open product page')}">${ICON.ext}${L('開啟', 'Open')}</a>` : '<span class="muted">—</span>';
      const ops = admin
        ? `<button class="btn btn-ghost btn-sm btn-icon" data-action="item-edit" data-id="${it.id}" title="${L('編輯', 'Edit')}" aria-label="${L('編輯', 'Edit')} ${attr(it.name)}">${ICON.edit}</button>`
        : `<button class="btn btn-sm btn-icon" data-action="p-item-edit" data-id="${it.id}" title="${L('編輯', 'Edit')}" aria-label="${L('編輯', 'Edit')} ${attr(it.name)}">${ICON.edit}</button>${it.status === 'active'
          ? `<button class="btn btn-ghost btn-sm" data-action="p-item-status" data-id="${it.id}" data-status="discontinued">${L('標示停售', 'Discontinue')}</button>`
          : `<button class="btn btn-ghost btn-sm" data-action="p-item-status" data-id="${it.id}" data-status="active">${L('恢復供應', 'Restore')}</button>`}`;
      rows += `<tr class="${cls}" data-id="${it.id}">
        <td class="c-name"><span class="item-name">${esc(it.name)}</span></td>
        <td class="mono c-model">${esc(it.model)}</td>
        ${admin ? `<td class="c-supplier">${esc(it.supplier_name)}</td>` : ''}
        <td class="c-spec">${esc(it.spec)}</td><td class="c-wt">${esc(it.weight)}</td><td class="c-wt">${esc(it.weight_limit)}</td>
        <td class="c-price">${price}</td><td class="c-contact">${contact}</td><td class="c-remarks">${esc(it.remarks)}</td>
        ${admin ? `<td class="c-web">${web}</td><td class="num c-webprice">${esc(it.web_price) || '<span class="muted">—</span>'}</td>` : ''}
        <td class="small c-date">${updated}</td><td class="c-status">${statusPill(it)}</td><td class="actions">${ops}</td></tr>`;
    }
    const scale = admin ? S.tblScale : 1;
    return `<div class="table-wrap"><table class="data items ${scale <= 0.9 ? 'fit' : ''}" style="--tbl-scale:${scale}"><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ----- suppliers tab -----
  function supplierLink(token) { return `${location.href.split('#')[0]}#/s/${token}`; }
  function renderSuppliers() {
    const A = S.admin;
    const rows = A.suppliers.map((s) => {
      const st = supplierState(s, A.meta.stale_months);
      return `<tr data-id="${s.id}">
        <td><span class="item-name">${esc(s.name)}</span>${s.website ? `<span class="sub"><a href="${attr(s.website)}" target="_blank" rel="noopener">${esc(s.website.replace(/^https?:\/\//, ''))}</a></span>` : ''}</td>
        <td>${esc(s.contact_name)}<span class="sub">${telLinks(s.tel)}${s.email ? ' · <a href="mailto:' + attr(s.email) + '">' + esc(s.email) + '</a>' : ''}</span></td>
        <td class="num">${s.active_count}${s.discontinued_count ? `<span class="sub">${s.discontinued_count} ${L('已停售', 'discontinued')}</span>` : ''}</td>
        <td class="small">${st.last ? `${fmtDate(st.last)}<span class="sub">${rel(st.last)}</span>` : `<span class="muted">${L('從未在平台更新', 'Never updated here')}</span><span class="sub">${L('資料來自', 'Data from')} ${fmtDate(A.meta.import_date)} ${L('名單', 'list')}</span>`}</td>
        <td class="small">${s.last_confirmed_at ? `${fmtDate(s.last_confirmed_at)}<span class="sub">${rel(s.last_confirmed_at)}</span>` : '<span class="muted">—</span>'}</td>
        <td>${st.pill}</td>
        <td class="actions">
          <button class="btn btn-sm" data-action="copy-link" data-token="${attr(s.token)}" title="${L('複製供應商專屬連結', 'Copy private supplier link')}">${ICON.link}${L('複製連結', 'Copy link')}</button>
          <a class="btn btn-ghost btn-sm" href="${attr(supplierLink(s.token))}" target="_blank" rel="noopener" title="${L('以供應商身份開啟', 'Open as supplier')}">${ICON.ext}${L('開啟', 'Open')}</a>
          <button class="btn btn-ghost btn-sm" data-action="supplier-edit" data-id="${s.id}">${ICON.edit}${L('編輯', 'Edit')}</button>
        </td></tr>`;
    }).join('');
    const never = A.suppliers.filter((s) => supplierState(s, A.meta.stale_months).key !== 'ok').length;
    return `<div class="container">
      ${never ? `<div class="banner warn"><div class="grow">${LP(`<strong>${never} 間供應商</strong>於 ${A.meta.stale_months} 個月內未有更新或確認價格。把專屬連結再傳送給他們，他們可直接在網上修改價錢、標示停售或新增產品。`, `<strong>${never} suppliers</strong> have not updated or confirmed prices in the last ${A.meta.stale_months} months. Re-send their private links so they can update prices, discontinue or add items online.`)}</div></div>` : ''}
      <div class="card">
        <div class="card-head"><h2>${L('供應商', 'Suppliers')}</h2><span class="muted small num">${A.suppliers.length}</span><span class="spacer"></span><button class="btn btn-primary" data-action="supplier-new">${ICON.plus}${L('新增供應商', 'Add supplier')}</button></div>
        <div class="table-wrap"><table class="data supplier-tbl"><thead><tr><th>${LH('公司', 'Supplier')}</th><th>${LH('聯絡', 'Contact')}</th><th>${LH('產品', 'Items')}</th><th>${LH('最後更新', 'Last updated')}</th><th>${LH('最後確認', 'Confirmed')}</th><th>${LH('狀態', 'Status')}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>
      <div class="card card-pad"><strong class="small">${L('運作方式', 'How it works')}</strong><ol class="steps" style="margin-top:8px">
        <li>${LP('按「複製連結」取得該公司的專屬連結，用電郵或 WhatsApp 傳給該公司的銷售聯絡人。每間公司只會看到自己的產品。', 'Click "Copy link" and send the private link to the company\'s sales contact by email or WhatsApp. Each company only sees its own items.')}</li>
        <li>${LP('供應商開啟連結後可直接修改價錢、規格、備註，標示「已停售」，或新增產品；每次儲存都會記錄時間。', 'Suppliers can edit prices, specs and remarks, mark items discontinued or add items; every save is time-stamped.')}</li>
        <li>${LP('如價格全部無變動，供應商可按「確認所有價格無變動」，部門便知道該公司已核對。', 'If nothing changed, the supplier clicks "Confirm no price changes" so the department knows the list was checked.')}</li>
        <li>${LP('部門在「價目總表」即時看到所有公司的最新資料，並可一鍵匯出 Excel。', 'The department sees every company\'s latest data in "Price list" and can export to Excel in one click.')}</li>
        <li>${LP('若連結外洩，按「編輯」→「重設連結」即可令舊連結失效。', 'If a link leaks, click "Edit" → "Reset link" to invalidate the old one.')}</li></ol></div>
    </div>`;
  }

  // ----- changes tab -----
  function renderChangesRows(changes, { showSupplier = true } = {}) {
    if (!changes.length) return `<div class="empty">${ICON.box}<div>${L('暫時未有更改記錄', 'No changes yet')}</div></div>`;
    return `<div class="table-wrap"><table class="data compact"><thead><tr><th>${LH('時間', 'Time')}</th>${showSupplier ? `<th>${LH('供應商', 'Supplier')}</th>` : ''}<th>${LH('項目', 'Item')}</th><th>${LH('動作', 'Action')}</th><th>${LH('欄位', 'Field')}</th><th>${LH('由', 'From')}</th><th>${LH('改為', 'To')}</th><th>${LH('操作者', 'By')}</th></tr></thead><tbody>
      ${changes.map((c) => `<tr><td class="small nowrap">${fmtDateTime(c.changed_at)}</td>${showSupplier ? `<td>${esc(c.supplier_name || '')}</td>` : ''}<td>${esc(c.item_name)}</td>
        <td><span class="pill ${c.action === 'discontinue' ? 'pill-stale' : c.action === 'confirm' ? 'pill-ok' : ''}">${actionLabel(c.action)}</span></td>
        <td class="small">${c.field ? fieldLabel(c.field) : ''}</td><td class="small muted">${esc(c.old_value)}</td><td class="small">${esc(c.new_value)}</td><td class="small muted">${actorLabel(c.actor)}</td></tr>`).join('')}
    </tbody></table></div>`;
  }
  function renderChanges() {
    return `<div class="container"><div class="card"><div class="card-head"><h2>${L('更改記錄', 'Change log')}</h2><span class="muted small">${L('最近 300 項，供應商及部門的每次修改都會記錄', 'Latest 300 entries; every edit by suppliers or the department is logged')}</span></div>${renderChangesRows(S.admin.changes)}</div></div>`;
  }

  // ----- settings tab -----
  function renderSettings() {
    const A = S.admin;
    return `<div class="container narrow">
      <div class="card card-pad" style="display:grid;gap:16px"><h2 style="margin:0;font-size:var(--text-lg)">${L('一般設定', 'General')}</h2>
        <form id="settingsForm" class="form-grid" onsubmit="return false">
          <div class="field"><label for="s-title">${L('名單標題', 'List title')}</label><input class="input" id="s-title" name="list_title" value="${attr(A.meta.title)}" /><span class="hint">${L('匯出 Excel 時會顯示', 'Shown in the exported Excel')}</span></div>
          <div class="field"><label for="s-import">${L('最後更新日期', 'Last updated date')}</label><input class="input" type="date" id="s-import" name="import_date" value="${attr(toInputDate(A.meta.import_date))}" /><span class="hint">${L('上次人手更新 Excel 名單的日期；價目總表會標示此日之後的價格變動', 'Date the Excel list was last updated manually; price changes after this date are marked in the list')}</span></div>
          <div class="field"><label for="s-stale">${L('逾期門檻（月）', 'Overdue threshold (months)')}</label><input class="input" type="number" min="1" max="24" id="s-stale" name="stale_months" value="${A.meta.stale_months}" /><span class="hint">${L('供應商超過此月數未更新／確認會標示「逾期」', 'Suppliers who have not updated / confirmed within this many months are marked overdue')}</span></div>
          <div class="span-2"><button class="btn btn-primary" data-action="save-settings">${L('儲存設定', 'Save settings')}</button></div>
        </form></div>
      <div class="card card-pad" style="display:grid;gap:16px"><h2 style="margin:0;font-size:var(--text-lg)">${L('更改部門密碼', 'Change department password')}</h2>
        <form id="pwForm" class="form-grid" onsubmit="return false">
          <div class="field"><label for="pw-cur">${L('現有密碼', 'Current password')}</label><input class="input" type="password" id="pw-cur" name="current" autocomplete="current-password" /></div>
          <div class="field"><label for="pw-new">${L('新密碼（至少 6 個字元）', 'New password (min. 6 characters)')}</label><input class="input" type="password" id="pw-new" name="next" autocomplete="new-password" /></div>
          <div class="span-2"><button class="btn btn-primary" data-action="save-password">${L('更改密碼', 'Change password')}</button></div>
        </form></div>
      <div class="card card-pad small muted">${LP(`資料來源：${esc(A.meta.title)}（最後人手更新 ${fmtDate(A.meta.import_date)}）。所有產品、供應商及更改記錄儲存在 Supabase 資料庫；供應商連結以隨機代碼產生，只有持有連結的公司才能修改自己的資料。「產品網頁」及「網上標價」欄只供部門內部使用，供應商看不到。`, `Source: ${esc(A.meta.title)} (last manual update ${fmtDate(A.meta.import_date)}). All items, suppliers and change logs are stored in Supabase; supplier links use random codes, so only the company holding a link can edit its own data. "Web page" and "Web price" columns are department-only and hidden from suppliers.`)}</div>
    </div>`;
  }

  // ---------- supplier portal ----------
  function renderPortal() {
    const P = S.portal;
    const head = topbar({ subtitle: L('PPMI 復康用品價目平台 · 供應商更新專區', 'PPMI Rehabilitation Aids Price List · Supplier portal') });
    if (P.error) return head + `<main class="main"><div class="container narrow"><div class="card card-pad empty">${ICON.box}<div><strong>${L('無法開啟', 'Cannot open')}</strong></div><div>${esc(P.error)}</div></div></div></main>`;
    if (!P.data) return head + `<main class="main"><div class="container narrow"><div class="card card-pad" style="display:grid;gap:12px"><div class="skel" style="width:40%"></div><div class="skel"></div><div class="skel" style="width:70%"></div></div></div></main>`;
    const { supplier: s, items: list, changes, meta } = P.data;
    const last = [s.last_updated_at, s.last_confirmed_at].filter(Boolean).sort().pop();
    const active = list.filter((i) => i.status === 'active').length;
    const confirmBtn = `<button class="btn" data-action="p-confirm">${ICON.check}${L('確認所有價格無變動', 'Confirm no price changes')}</button>`;
    const banner = last
      ? `<div class="banner ok"><div class="grow">${LP(`<strong>最後更新：${fmtDateTime(last)}</strong>（${rel(last)}）。如有任何價格或供貨變動，請隨時在此更新；部門會即時看到。`, `<strong>Last updated: ${fmtDateTime(last)}</strong> (${rel(last)}). Update here whenever prices or availability change; the department sees it immediately.`)}</div>${confirmBtn}</div>`
      : `<div class="banner warn"><div class="grow">${LP(`<strong>貴公司尚未在此平台更新。</strong>以下資料來自 ${fmtDate(meta.import_date)} 的部門名單，請核對每項價格：有變動請按「編輯」修改；已停產請按「標示停售」；全部正確則按右方按鈕確認。`, `<strong>Your company has not updated here yet.</strong> The data below comes from the department list of ${fmtDate(meta.import_date)}. Please check every price: click "Edit" to change, "Discontinue" for items no longer sold, or confirm with the button if everything is correct.`)}</div>${confirmBtn}</div>`;
    return head + `<main class="main"><div class="container">
      <div class="portal-head"><div class="grow"><div class="xs muted" style="font-weight:600;letter-spacing:.04em">${L('供應商', 'SUPPLIER')}</div><h1>${esc(s.name)}</h1><div class="small muted">${LP(`共 ${active} 項有售產品${list.length - active ? `，${list.length - active} 項已停售` : ''}。此頁只顯示貴公司的產品，其他供應商無法看到。`, `${active} items available${list.length - active ? `, ${list.length - active} discontinued` : ''}. This page shows only your company's items; other suppliers cannot see it.`)}</div></div></div>
      ${banner}
      <div class="card"><div class="card-head"><h2>${L('公司聯絡資料', 'Company contact')}</h2><span class="spacer"></span><button class="btn btn-sm" data-action="p-profile-edit">${ICON.edit}${L('編輯', 'Edit')}</button></div>
        <div class="card-pad contact-grid">
          <div><div class="k">${L('銷售聯絡人', 'Sales contact')}</div><div class="v">${esc(s.contact_name) || '—'}</div></div>
          <div><div class="k">${L('電話', 'Tel')}</div><div class="v">${telLinks(s.tel) || '—'}</div></div>
          <div><div class="k">${L('電郵', 'Email')}</div><div class="v">${s.email ? `<a href="mailto:${attr(s.email)}">${esc(s.email)}</a>` : '—'}</div></div>
          <div><div class="k">${L('公司網址', 'Website')}</div><div class="v">${s.website ? `<a href="${attr(s.website)}" target="_blank" rel="noopener">${esc(s.website)}</a>` : '—'}</div></div>
        </div></div>
      <div class="card"><div class="card-head"><h2>${L('產品及參考價', 'Items and prices')}</h2><span class="muted small">${L('按「編輯」修改價錢／規格；停產請按「標示停售」', 'Click "Edit" to change price / specs; "Discontinue" for items no longer sold')}</span><span class="spacer"></span><button class="btn btn-primary" data-action="p-item-new">${ICON.plus}${L('新增產品', 'Add item')}</button></div>
        ${renderItemsTable(list, { admin: false })}</div>
      <div class="card"><div class="card-head"><h2>${L('貴公司的更改記錄', 'Your change log')}</h2></div>${renderChangesRows(changes, { showSupplier: false })}</div>
      <p class="xs faint" style="text-align:center">${L(`此連結只供 ${esc(s.name)} 使用，請勿轉發。如需協助請聯絡職業治療部。`, `This link is for ${esc(s.name)} only; please do not forward it. Contact the Occupational Therapy Department for help.`)}</p>
    </div></main>`;
  }

  // ---------- modals ----------
  function openModal(html) { modal.innerHTML = html; if (!modal.open) modal.showModal(); }
  function closeModal() { if (modal.open) modal.close(); modal.innerHTML = ''; }
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  function fieldHtml(name, label, value, { type = 'text', placeholder = '', list = '', hint = '', span = false, textarea = false } = {}) {
    const input = textarea
      ? `<textarea class="textarea" name="${name}" id="m-${name}" placeholder="${attr(placeholder)}">${esc(value)}</textarea>`
      : `<input class="input" type="${type}" name="${name}" id="m-${name}" value="${attr(value)}" placeholder="${attr(placeholder)}" ${list ? `list="${list}"` : ''} />`;
    return `<div class="field ${span ? 'span-2' : ''}"><label for="m-${name}">${label}</label>${input}${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  }

  function itemModal({ item, admin, categories, subcategories, suppliers }) {
    const it = item || {};
    const isNew = !item;
    const cats = categories.map((c) => c.name);
    const catOpts = cats.map((c) => `<option value="${attr(c)}" ${it.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('') + `<option value="__new__">${L('＋ 新類別…', '+ New category…')}</option>`;
    const subList = `<datalist id="subcats">${subcategories.filter((s) => !it.category || s.category === it.category).map((s) => `<option value="${attr(s.subcategory)}"></option>`).join('')}</datalist>`;
    return `<form id="itemForm" method="dialog">
      <div class="modal-head"><h3>${isNew ? L('新增產品', 'Add item') : L('編輯產品', 'Edit item')}</h3><span class="spacer" style="flex:1"></span>${!isNew ? `<span class="xs muted">${L('最後更新', 'Last updated')} ${fmtDateTime(it.updated_at)} · ${actorLabel(it.updated_by)}</span>` : ''}</div>
      <div class="modal-body"><div class="form-grid">
        ${admin ? `<div class="field"><label for="m-supplier_id">${L('供應商', 'Supplier')} *</label><select class="select" name="supplier_id" id="m-supplier_id" required>${suppliers.map((s) => `<option value="${s.id}" ${it.supplier_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="m-team">${L('組別', 'Team')}</label><select class="select" name="team" id="m-team"><option value="">—</option>${TEAMS.map((t) => `<option ${it.team === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label for="m-category">${L('類別', 'Category')} *</label><select class="select" name="category" id="m-category" required>${catOpts}</select></div>
        <div class="field" id="newCatWrap" hidden><label for="m-category_new">${L('新類別名稱', 'New category name')}</label><input class="input" name="category_new" id="m-category_new" placeholder="${L('例如 WALKING AID', 'e.g. WALKING AID')}" /></div>
        ${fieldHtml('subcategory', L('子類別', 'Sub-category'), it.subcategory || '', { list: 'subcats', placeholder: L('例如 Spoon、Transit W/C', 'e.g. Spoon, Transit W/C') })}${subList}
        ${fieldHtml('name', L('項目名稱', 'Item name') + ' *', it.name || '', { span: true, placeholder: L('產品名稱（中／英）', 'Product name') })}
        ${fieldHtml('model', L('型號', 'Model'), it.model || '')}
        ${fieldHtml('price_text', L('報價單價格 (HK$)', 'Quotation price (HK$)') + ' *', it.price_text || '', { placeholder: L('例如 1800 或 780/835/890', 'e.g. 1800 or 780/835/890'), hint: L('輸入單一數字會自動格式化；多個價錢可用「/」分隔', 'A single number is formatted automatically; separate several prices with "/"') })}
        ${fieldHtml('spec', L('尺寸／規格', 'Size / spec'), it.spec || '', { placeholder: L('例如 16" / 18"', 'e.g. 16" / 18"') })}
        ${fieldHtml('weight', L('重量', 'Weight'), it.weight || '', { placeholder: L('例如 15kg', 'e.g. 15kg') })}
        ${fieldHtml('weight_limit', L('承重', 'Weight limit'), it.weight_limit || '', { placeholder: L('例如 100kg', 'e.g. 100kg') })}
        ${fieldHtml('sales', L('銷售聯絡人', 'Sales contact'), it.sales || '')}
        ${fieldHtml('tel', L('電話', 'Tel'), it.tel || '')}
        ${fieldHtml('remarks', L('備註', 'Remarks'), it.remarks || '', { span: true, textarea: true, placeholder: L('例如 安裝費、保養期、尺寸選項', 'e.g. installation fee, warranty, size options') })}
        ${admin ? `<div class="span-2" style="border-top:1px solid var(--color-divider);padding-top:12px"><strong class="small">${L('部門內部欄位（供應商看不到）', 'Department-only fields (hidden from suppliers)')}</strong></div>
        ${fieldHtml('url', L('產品網頁', 'Product web page'), it.url || '', { type: 'url', placeholder: 'https://…', hint: L('供同事比較報價單價格與公開網頁價格', 'For colleagues to compare the quotation price with the public web price') })}
        ${fieldHtml('web_price', L('網上標價 (HK$)', 'Web price (HK$)'), it.web_price || '', { placeholder: L('例如 1980（網頁上看到的公開價）', 'e.g. 1980 (public price seen on the web page)') })}` : ''}
        ${admin && !isNew ? `<div class="field"><label for="m-status">${L('復康用品狀態', 'Item status')}</label><select class="select" name="status" id="m-status"><option value="active" ${it.status === 'active' ? 'selected' : ''}>${L('有售', 'Available')}</option><option value="discontinued" ${it.status === 'discontinued' ? 'selected' : ''}>${L('已停售', 'Discontinued')}</option></select></div>` : ''}
      </div></div>
      <div class="modal-foot">${admin && !isNew ? `<button type="button" class="btn btn-danger left" data-action="item-delete" data-id="${it.id}">${L('刪除', 'Delete')}</button>` : ''}
        <button type="button" class="btn" data-action="modal-close">${L('取消', 'Cancel')}</button><button type="submit" class="btn btn-primary">${isNew ? L('新增', 'Add') : L('儲存', 'Save')}</button></div>
    </form>`;
  }

  function supplierModal(s) {
    const isNew = !s; s = s || {};
    return `<form id="supplierForm" method="dialog">
      <div class="modal-head"><h3>${isNew ? L('新增供應商', 'Add supplier') : L('編輯供應商', 'Edit supplier')}</h3></div>
      <div class="modal-body">
        <div class="form-grid">
          ${fieldHtml('name', L('公司名稱', 'Company name') + ' *', s.name || '', { span: true })}
          ${fieldHtml('contact_name', L('銷售聯絡人', 'Sales contact'), s.contact_name || '')}
          ${fieldHtml('tel', L('電話', 'Tel'), s.tel || '')}
          ${fieldHtml('email', L('電郵', 'Email'), s.email || '', { type: 'email' })}
          ${fieldHtml('website', L('公司網址', 'Website'), s.website || '', { type: 'url' })}
          ${fieldHtml('notes', L('部門內部備註', 'Department notes'), s.notes || '', { span: true, textarea: true, hint: L('供應商不會看到此欄', 'Hidden from the supplier') })}
        </div>
        ${!isNew ? `<div class="field"><label>${L('供應商專屬連結', 'Private supplier link')}</label><div class="linkbox"><input class="input" readonly value="${attr(supplierLink(s.token))}" id="linkInput" /><button type="button" class="btn" data-action="copy-link" data-token="${attr(s.token)}">${ICON.link}${L('複製', 'Copy')}</button></div><span class="hint">${L('只把此連結傳給該公司。按「重設連結」會令舊連結即時失效。', 'Send this link only to that company. "Reset link" invalidates the old link immediately.')}</span></div>` : ''}
      </div>
      <div class="modal-foot">${!isNew ? `<button type="button" class="btn btn-danger left" data-action="supplier-delete" data-id="${s.id}">${L('刪除供應商', 'Delete supplier')}</button><button type="button" class="btn left" data-action="supplier-token" data-id="${s.id}">${L('重設連結', 'Reset link')}</button><button type="button" class="btn left" data-action="supplier-confirm" data-id="${s.id}" title="${L('代供應商記錄已核對（例如電話確認）', 'Record a confirmation on behalf of the supplier (e.g. confirmed by phone)')}">${L('代為確認無變動', 'Confirm on their behalf')}</button>` : ''}
        <button type="button" class="btn" data-action="modal-close">${L('取消', 'Cancel')}</button><button type="submit" class="btn btn-primary">${isNew ? L('新增', 'Add') : L('儲存', 'Save')}</button></div>
    </form>`;
  }

  function profileModal(s) {
    return `<form id="profileForm" method="dialog">
      <div class="modal-head"><h3>${L('編輯公司聯絡資料', 'Edit company contact')}</h3></div>
      <div class="modal-body"><div class="form-grid">
        ${fieldHtml('contact_name', L('銷售聯絡人', 'Sales contact'), s.contact_name || '')}${fieldHtml('tel', L('電話', 'Tel'), s.tel || '')}
        ${fieldHtml('email', L('電郵', 'Email'), s.email || '', { type: 'email' })}${fieldHtml('website', L('公司網址', 'Website'), s.website || '', { type: 'url' })}
      </div></div>
      <div class="modal-foot"><button type="button" class="btn" data-action="modal-close">${L('取消', 'Cancel')}</button><button type="submit" class="btn btn-primary">${L('儲存', 'Save')}</button></div></form>`;
  }

  function confirmModal({ title, body, okLabel, danger = false, action, data = {} }) {
    const ds = Object.entries(data).map(([k, v]) => `data-${k}="${attr(v)}"`).join(' ');
    return `<div class="modal-head"><h3>${title}</h3></div><div class="modal-body small">${body}</div>
      <div class="modal-foot"><button type="button" class="btn" data-action="modal-close">${L('取消', 'Cancel')}</button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="${action}" data-confirmed="1" ${ds}>${okLabel || L('確定', 'OK')}</button></div>`;
  }

  function formData(form) {
    const o = {};
    new FormData(form).forEach((v, k) => { o[k] = typeof v === 'string' ? v.trim() : v; });
    if (o.category === '__new__') o.category = o.category_new || '';
    delete o.category_new;
    return o;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove(); return ok;
  }

  // ---------- Excel export (client-side, ExcelJS from CDN) ----------
  async function loadExcelJS() {
    if (window.ExcelJS) return window.ExcelJS;
    await new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
      sc.onload = resolve; sc.onerror = () => reject(new Error(L('無法載入 Excel 元件，請檢查網絡', 'Could not load the Excel component; check your connection')));
      document.head.appendChild(sc);
    });
    return window.ExcelJS;
  }
  const xlDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-HK', { ...HK, year: 'numeric', month: 'short', day: 'numeric' }) : '');
  async function buildExcel({ since, includeDiscontinued = true }) {
    const ExcelJS = await loadExcelJS();
    const A = S.admin;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Price list', { views: [{ state: 'frozen', ySplit: 2 }] });
    const HEADERS = ['Items', 'Model', 'Supplier', 'Seat width / Size', 'Wt.', 'Wt. limit', 'Ref. Price', 'Sales', 'Tel', 'Remarks', 'Website', 'Web price (dept)', 'Last updated', 'Status'];
    [14, 40, 30, 24, 28, 14, 12, 14, 22, 20, 40, 40, 14, 14, 12].forEach((w, i) => (ws.getColumn(i + 1).width = w));
    const sinceMs = since ? new Date(since).getTime() : null;
    ws.addRow([`${A.meta.title} — exported ${xlDate(new Date().toISOString())}`]).font = { bold: true, size: 14 };
    ws.addRow([since ? `Legend: red = newly added since ${xlDate(since)}; green = price amended since ${xlDate(since)}; grey strikethrough = discontinued` : 'Legend: grey strikethrough = discontinued']).font = { italic: true, color: { argb: 'FF666666' } };
    ws.addRow([]);
    const catOrder = new Map(A.categories.map((c) => [c.name, c.sort_order]));
    const sorted = [...A.items].sort((a, b) => (catOrder.get(a.category) ?? 999) - (catOrder.get(b.category) ?? 999) || a.sort_order - b.sort_order || a.id - b.id);
    let lastCat = null, lastSub = null;
    for (const it of sorted) {
      if (!includeDiscontinued && it.status === 'discontinued') continue;
      if (it.category !== lastCat) {
        ws.addRow([]);
        const cat = A.categories.find((c) => c.name === it.category);
        const r = ws.addRow([cat?.team ? `${cat.team} Team` : '', it.category]);
        r.getCell(1).font = { bold: true };
        for (let c = 2; c <= HEADERS.length + 1; c++) r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B050' } };
        r.getCell(2).font = { bold: true };
        const h = ws.addRow(['', ...HEADERS]); h.font = { bold: true };
        h.eachCell((cell) => { cell.border = { bottom: { style: 'thin' } }; });
        lastCat = it.category; lastSub = null;
      }
      if ((it.subcategory || '') !== (lastSub || '') && it.subcategory) ws.addRow(['', it.subcategory]).getCell(2).font = { bold: true, italic: true };
      lastSub = it.subcategory || '';
      const row = ws.addRow(['', it.name, it.model, it.supplier_name, it.spec, it.weight, it.weight_limit,
        it.price != null ? Number(it.price) : it.price_text, it.sales, it.tel, it.remarks, it.url, it.web_price,
        xlDate(it.updated_at), it.status === 'discontinued' ? 'Discontinued' : 'Available']);
      row.getCell(8).numFmt = '#,##0';
      const isNew = sinceMs && new Date(it.created_at).getTime() >= sinceMs && it.created_by !== 'import';
      const priceChanged = sinceMs && new Date(it.price_updated_at).getTime() >= sinceMs && it.updated_by !== 'import';
      if (it.status === 'discontinued') row.font = { color: { argb: 'FF888888' }, strike: true };
      else if (isNew) row.font = { color: { argb: 'FFFF0000' } };
      else if (priceChanged) row.font = { color: { argb: 'FF00A050' } };
      if (it.url) row.getCell(12).value = { text: it.url, hyperlink: it.url };
    }
    const ss = wb.addWorksheet('Suppliers');
    ss.columns = [
      { header: 'Supplier', key: 'name', width: 30 }, { header: 'Contact', key: 'contact_name', width: 24 }, { header: 'Tel', key: 'tel', width: 22 },
      { header: 'Email', key: 'email', width: 28 }, { header: 'Website', key: 'website', width: 36 }, { header: 'Active items', key: 'active_count', width: 12 },
      { header: 'Discontinued', key: 'discontinued_count', width: 12 }, { header: 'Last updated on portal', key: 'last_updated_at', width: 22 }, { header: 'Last confirmed', key: 'last_confirmed_at', width: 22 },
    ];
    ss.getRow(1).font = { bold: true };
    for (const s of A.suppliers) ss.addRow({ ...s, last_updated_at: xlDate(s.last_updated_at), last_confirmed_at: xlDate(s.last_confirmed_at) });
    const buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // ---------- events ----------
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (form.id === 'loginForm') {
      e.preventDefault();
      try {
        const { token } = await rpc('admin_login', { p_password: form.password.value });
        setAdminToken(token); S.loginError = '';
        await loadAdmin(); render();
      } catch (err) { S.loginError = err.message; render(); }
    }
    if (form.id === 'itemForm') {
      e.preventDefault();
      const d = formData(form);
      if (!d.name || !d.category) return toast(L('請填寫類別及項目名稱', 'Please fill in the category and item name'), true);
      const id = form.dataset.id;
      try {
        if (S.portal) {
          if (id) await portalRpc('supplier_update_item', { p_id: Number(id), p_data: d });
          else await portalRpc('supplier_create_item', { p_data: d });
          await reloadPortal();
        } else {
          d.supplier_id = Number(d.supplier_id);
          if (id) await adminRpc('admin_update_item', { p_id: Number(id), p_data: d });
          else await adminRpc('admin_create_item', { p_data: d });
          await loadAdmin();
        }
        closeModal(); render(); toast(id ? L('已儲存，更新時間已記錄', 'Saved; update time recorded') : L('已新增產品', 'Item added'));
      } catch (err) { toast(err.message, true); }
    }
    if (form.id === 'supplierForm') {
      e.preventDefault();
      const d = formData(form); const id = form.dataset.id;
      try {
        if (id) await adminRpc('admin_update_supplier', { p_id: Number(id), p_data: d });
        else await adminRpc('admin_create_supplier', { p_data: d });
        await loadAdmin(); closeModal(); render(); toast(id ? L('已儲存', 'Saved') : L('已新增供應商，可在列表複製其專屬連結', 'Supplier added; copy its private link from the list'));
      } catch (err) { toast(err.message, true); }
    }
    if (form.id === 'profileForm') {
      e.preventDefault();
      try { await portalRpc('supplier_update_profile', { p_data: formData(form) }); await reloadPortal(); closeModal(); render(); toast(L('聯絡資料已更新', 'Contact details updated')); }
      catch (err) { toast(err.message, true); }
    }
  });

  async function reloadPortal() { S.portal.data = await portalRpc('supplier_get'); }

  document.addEventListener('input', (e) => {
    const f = e.target.closest('#filters');
    if (f) {
      Object.assign(S.filters, Object.fromEntries(new FormData(f)));
      const active = document.activeElement; const pos = active?.selectionStart;
      render();
      if (active?.id) { const el = document.getElementById(active.id); el?.focus(); if (pos != null && el?.setSelectionRange && el.type === 'text') el.setSelectionRange(pos, pos); }
    }
    if (e.target.id === 'm-category') {
      const wrap = $('#newCatWrap'); const isNew = e.target.value === '__new__';
      if (wrap) { wrap.hidden = !isNew; if (isNew) $('#m-category_new')?.focus(); }
      const subs = (S.admin?.subcategories || S.portal?.data?.subcategories || []).filter((s) => s.category === e.target.value);
      const dl = $('#subcats'); if (dl) dl.innerHTML = subs.map((s) => `<option value="${attr(s.subcategory)}"></option>`).join('');
    }
  });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const a = btn.dataset.action; const id = btn.dataset.id;
    const A = S.admin;
    try {
      switch (a) {
        case 'theme': S.theme = S.theme === 'dark' ? 'light' : 'dark'; store.set('ppmi_theme', S.theme); render(); break;
        case 'lang': S.lang = btn.dataset.lang; store.set('ppmi_lang', S.lang); render(); break;
        case 'tbl-zoom': {
          S.tblScale = Math.min(1.4, Math.max(0.6, Math.round((S.tblScale + Number(btn.dataset.delta)) * 10) / 10));
          store.set('ppmi_tbl_scale', String(S.tblScale)); render(); break;
        }
        case 'logout': await adminRpc('admin_logout').catch(() => {}); setAdminToken(null); S.admin = null; render(); break;
        case 'modal-close': closeModal(); break;

        case 'item-new': openModal(itemModal({ item: null, admin: true, categories: A.categories, subcategories: A.subcategories, suppliers: A.suppliers })); break;
        case 'item-edit': {
          const it = A.items.find((i) => i.id === Number(id));
          openModal(itemModal({ item: it, admin: true, categories: A.categories, subcategories: A.subcategories, suppliers: A.suppliers }));
          $('#itemForm').dataset.id = id; break;
        }
        case 'item-delete':
          if (!btn.dataset.confirmed) { openModal(confirmModal({ title: L('刪除產品？', 'Delete item?'), body: L('刪除後無法復原。如只是停產，建議改為「已停售」以保留記錄。', 'This cannot be undone. If the item is merely discontinued, mark it "Discontinued" instead to keep the record.'), okLabel: L('刪除', 'Delete'), danger: true, action: 'item-delete', data: { id } })); break; }
          await adminRpc('admin_delete_item', { p_id: Number(id) }); await loadAdmin(); closeModal(); render(); toast(L('已刪除', 'Deleted')); break;

        case 'supplier-new': openModal(supplierModal(null)); break;
        case 'supplier-edit': openModal(supplierModal(A.suppliers.find((s) => s.id === Number(id)))); $('#supplierForm').dataset.id = id; break;
        case 'supplier-token':
          if (!btn.dataset.confirmed) { openModal(confirmModal({ title: L('重設專屬連結？', 'Reset private link?'), body: L('舊連結會即時失效，需把新連結再傳給該公司。', 'The old link stops working immediately; send the new link to the company.'), okLabel: L('重設連結', 'Reset link'), action: 'supplier-token', data: { id } })); break; }
          await adminRpc('admin_regenerate_token', { p_id: Number(id) }); await loadAdmin(); closeModal(); render(); toast(L('已產生新連結', 'New link generated')); break;
        case 'supplier-confirm':
          await adminRpc('admin_confirm_supplier', { p_id: Number(id) }); await loadAdmin(); closeModal(); render(); toast(L('已記錄確認', 'Confirmation recorded')); break;
        case 'supplier-delete':
          if (!btn.dataset.confirmed) { openModal(confirmModal({ title: L('刪除供應商？', 'Delete supplier?'), body: L('該公司的所有產品及記錄都會一併刪除，無法復原。', 'All of this company\'s items and records will be deleted. This cannot be undone.'), okLabel: L('刪除', 'Delete'), danger: true, action: 'supplier-delete', data: { id } })); break; }
          await adminRpc('admin_delete_supplier', { p_id: Number(id) }); await loadAdmin(); closeModal(); render(); toast(L('已刪除供應商', 'Supplier deleted')); break;

        case 'copy-link': {
          const link = supplierLink(btn.dataset.token);
          const ok = await copyText(link);
          if (ok) toast(L('已複製連結，可直接傳給該公司', 'Link copied; send it to the company'));
          else openModal(`<div class="modal-head"><h3>${L('供應商專屬連結', 'Private supplier link')}</h3></div><div class="modal-body"><input class="input" readonly value="${attr(link)}" onfocus="this.select()" /><span class="hint">${L('請手動複製以上連結', 'Please copy the link above manually')}</span></div><div class="modal-foot"><button class="btn" data-action="modal-close">${L('關閉', 'Close')}</button></div>`);
          break;
        }
        case 'export': {
          btn.disabled = true;
          const blob = await buildExcel({ since: sinceIso() || '' }); const url = URL.createObjectURL(blob);
          const aEl = document.createElement('a'); aEl.href = url; aEl.download = `PPMI_list_${new Date().toISOString().slice(0, 10)}.xlsx`; document.body.appendChild(aEl); aEl.click(); aEl.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000); btn.disabled = false; toast(L('已匯出 Excel', 'Excel exported')); break;
        }
        case 'save-settings': {
          const d = Object.fromEntries(new FormData($('#settingsForm')));
          if (d.import_date) d.import_date = new Date(d.import_date + 'T09:00:00+08:00').toISOString();
          await adminRpc('admin_save_settings', { p_data: d }); S.filters.since = ''; await loadAdmin(); render(); toast(L('設定已儲存', 'Settings saved')); break;
        }
        case 'save-password': {
          const d = Object.fromEntries(new FormData($('#pwForm')));
          await adminRpc('admin_change_password', { p_current: d.current, p_next: d.next }); $('#pwForm').reset(); toast(L('密碼已更改，請用新密碼重新登入一次以確認', 'Password changed; log in again with the new password to confirm')); break;
        }

        // ----- portal -----
        case 'p-item-new': { const D = S.portal.data; openModal(itemModal({ item: null, admin: false, categories: D.categories, subcategories: D.subcategories, suppliers: [] })); break; }
        case 'p-item-edit': { const D = S.portal.data; openModal(itemModal({ item: D.items.find((i) => i.id === Number(id)), admin: false, categories: D.categories, subcategories: D.subcategories, suppliers: [] })); $('#itemForm').dataset.id = id; break; }
        case 'p-item-status': {
          const status = btn.dataset.status;
          if (!btn.dataset.confirmed && status === 'discontinued') { openModal(confirmModal({ title: L('標示為已停售？', 'Mark as discontinued?'), body: L('部門會看到此產品已停售（以灰色刪線顯示）。日後如恢復供應可隨時按「恢復供應」。', 'The department will see this item as discontinued (grey, struck through). You can click "Restore" at any time if it becomes available again.'), okLabel: L('標示停售', 'Discontinue'), action: 'p-item-status', data: { id, status } })); break; }
          await portalRpc('supplier_update_item', { p_id: Number(id), p_data: { status } }); await reloadPortal(); closeModal(); render(); toast(status === 'discontinued' ? L('已標示為停售', 'Marked as discontinued') : L('已恢復供應', 'Restored')); break;
        }
        case 'p-profile-edit': openModal(profileModal(S.portal.data.supplier)); break;
        case 'p-confirm':
          if (!btn.dataset.confirmed) { openModal(confirmModal({ title: L('確認所有價格無變動？', 'Confirm no price changes?'), body: L('系統會記錄貴公司於今日已核對全部有售產品的價格及資料。如其後有變動，仍可隨時再更新。', 'We will record that your company checked all available items today. You can still update at any time if anything changes later.'), okLabel: L('確認無變動', 'Confirm'), action: 'p-confirm' })); break; }
          await portalRpc('supplier_confirm'); await reloadPortal(); closeModal(); render(); toast(L('已記錄確認，多謝！', 'Confirmation recorded, thank you')); break;
        default: break;
      }
    } catch (err) { toast(err.message, true); }
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.open) closeModal(); });

  route();
})();
