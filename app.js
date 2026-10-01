/* PPMI 復康用品價目平台 — frontend (vanilla JS, hash routing) */
(() => {
  'use strict';

  // ---------- config ----------
  const CFG = window.PPMI_CONFIG || {};
  const TEAMS = ['Medical', 'Ortho', 'Community'];
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  // ---------- state (kept in memory only; storage APIs are unavailable in the sandboxed iframe) ----------
  const S = {
    theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    adminToken: store.get('ppmi_admin_token'),
    admin: null, // overview payload
    tab: 'list',
    filters: { q: '', team: '', category: '', supplier: '', status: 'all', since: '' },
    portal: null, // { token, data }
    loading: false,
    loginError: '',
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const modal = $('#modal');

  // ---------- utils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const attr = (s) => esc(s).replace(/\n/g, '&#10;');
  const HK = { timeZone: 'Asia/Hong_Kong' };
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('zh-HK', { ...HK, year: 'numeric', month: 'short', day: 'numeric' }) : '—');
  const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-HK', { ...HK, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const toInputDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', HK) : '');
  function rel(iso) {
    if (!iso) return '從未';
    const d = (Date.now() - new Date(iso).getTime()) / 864e5;
    if (d < 1) return '今日';
    if (d < 30) return `${Math.floor(d)} 日前`;
    if (d < 365) return `${Math.floor(d / 30)} 個月前`;
    return `${(d / 365).toFixed(1)} 年前`;
  }
  const monthsAgo = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / (30.44 * 864e5) : Infinity);
  const actorLabel = (a) => ({ import: '名單匯入', supplier: '供應商', admin: '部門' }[a] || a);
  const fieldLabel = (f) => ({
    name: '項目', model: '型號', spec: '尺寸/規格', weight: '重量', weight_limit: '承重', price_text: '參考價', sales: '聯絡人',
    tel: '電話', remarks: '備註', url: '網址', category: '類別', subcategory: '子類別', team: '組別', status: '狀態',
    contact_name: '聯絡人', email: '電郵', website: '公司網址', notes: '備註',
  }[f] || f);
  const actionLabel = (a) => ({ create: '新增產品', update: '更改', discontinue: '標示停售', restore: '恢復供應', confirm: '確認價格無變動', delete: '刪除' }[a] || a);
  const priceDisplay = (it) => (it.price != null ? `$${Number(it.price).toLocaleString('en-HK')}` : it.price_text || '—');

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
      const msg = data?.message || `請求失敗 (${res.status})`;
      if ((res.status === 401 || data?.code === 'PT401') && fn !== 'admin_login') { setAdminToken(null); S.admin = null; S.loginError = '登入已過期，請重新登入'; render(); }
      throw new Error(msg === 'UNAUTHORIZED' ? '請先登入' : msg);
    }
    return data;
  }
  const adminRpc = (fn, args = {}) => rpc(fn, { p_token: S.adminToken, ...args });
  const portalRpc = (fn, args = {}) => rpc(fn, { p_stoken: S.portal.token, ...args });
  function setAdminToken(t) { S.adminToken = t; store.set('ppmi_admin_token', t); }

  // Change classification relative to the "since" date
  function changeKind(it, sinceIso) {
    if (it.status === 'discontinued') return 'disc';
    const since = sinceIso ? new Date(sinceIso).getTime() : 0;
    if (it.created_by !== 'import' && new Date(it.created_at).getTime() >= since) return 'new';
    if (it.updated_by !== 'import' && new Date(it.price_updated_at).getTime() >= since) return 'amend';
    if (it.updated_by !== 'import' && new Date(it.updated_at).getTime() >= since) return 'update';
    return '';
  }
  const kindPill = {
    new: '<span class="pill pill-new pill-dot">新增</span>',
    amend: '<span class="pill pill-amend pill-dot">價格已改</span>',
    update: '<span class="pill pill-update pill-dot">已更新</span>',
    disc: '<span class="pill pill-stale">已停售</span>',
    '': '<span class="pill">有售</span>',
  };
  function supplierState(s, staleMonths) {
    const last = [s.last_updated_at, s.last_confirmed_at].filter(Boolean).sort().pop();
    if (!last) return { key: 'never', pill: '<span class="pill pill-warn pill-dot">待更新</span>', last: null };
    if (monthsAgo(last) > staleMonths) return { key: 'stale', pill: '<span class="pill pill-new pill-dot">逾期</span>', last };
    return { key: 'ok', pill: '<span class="pill pill-ok pill-dot">已更新</span>', last };
  }

  const LOGO = `<svg viewBox="0 0 32 32" fill="none" aria-label="PPMI" role="img"><rect x="2.5" y="2.5" width="27" height="27" rx="7" stroke="currentColor" stroke-width="2.5"/><path d="M9 16.5l4.5 4.5L23 11.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
    const r = parseRoute();
    if (r.kind === 'portal') { app.innerHTML = renderPortal(); return; }
    if (!S.adminToken) { app.innerHTML = renderLogin(); setTimeout(() => $('#pw')?.focus(), 0); return; }
    app.innerHTML = renderAdminShell();
  }

  function topbar({ tabs = '', actions = '', subtitle = '' }) {
    return `<header class="topbar">
      <div class="brand">${LOGO}<div><div class="brand-title">PPMI 復康用品價目平台</div><div class="brand-sub">${esc(subtitle)}</div></div></div>
      ${tabs}
      <div class="topbar-actions">
        ${actions}
        <button class="btn btn-ghost btn-icon" data-action="theme" title="切換深色／淺色" aria-label="切換深色／淺色">${S.theme === 'dark' ? ICON.sun : ICON.moon}</button>
      </div>
    </header>`;
  }

  // ---------- login ----------
  function renderLogin() {
    return topbar({ subtitle: '部門版 · Department view' }) + `<main class="main"><div class="login-wrap"><form class="card card-pad login" id="loginForm">
      <div><h1>部門登入</h1><p>輸入部門密碼以查看所有供應商的最新價目。供應商請使用部門發出的專屬連結。</p></div>
      <div class="field"><label for="pw">密碼</label><input class="input" type="password" id="pw" name="password" autocomplete="current-password" required /></div>
      ${S.loginError ? `<div class="error">${esc(S.loginError)}</div>` : ''}
      <button class="btn btn-primary" type="submit">登入</button>
      <p class="xs faint">忘記密碼請聯絡平台管理員。</p>
    </form></div></main>`;
  }

  // ---------- admin shell ----------
  function renderAdminShell() {
    const tabs = `<nav class="tabs" role="tablist">
      ${[['list', '價目總表'], ['suppliers', '供應商'], ['changes', '更改記錄'], ['settings', '設定']]
        .map(([k, l]) => `<a class="tab" role="tab" href="#/${k}" aria-selected="${S.tab === k}">${l}</a>`).join('')}
    </nav>`;
    const actions = `<button class="btn btn-ghost btn-sm" data-action="logout">登出</button>`;
    let body;
    if (!S.admin) body = `<div class="container"><div class="card card-pad" style="display:grid;gap:12px"><div class="skel" style="width:40%"></div><div class="skel"></div><div class="skel"></div><div class="skel" style="width:70%"></div></div></div>`;
    else body = { list: renderList, suppliers: renderSuppliers, changes: renderChanges, settings: renderSettings }[S.tab]();
    return topbar({ tabs, actions, subtitle: S.admin ? `${S.admin.meta.title} · 部門版` : '部門版' }) + `<main class="main">${body}</main>`;
  }

  // ----- price list tab -----
  function filteredItems() {
    const f = S.filters;
    const q = f.q.trim().toLowerCase();
    const since = f.since ? new Date(f.since + 'T00:00:00+08:00').toISOString() : null;
    return S.admin.items.filter((it) => {
      if (f.team && it.team !== f.team) return false;
      if (f.category && it.category !== f.category) return false;
      if (f.supplier && String(it.supplier_id) !== f.supplier) return false;
      const kind = changeKind(it, since);
      if (f.status === 'active' && it.status !== 'active') return false;
      if (f.status === 'discontinued' && it.status !== 'discontinued') return false;
      if (f.status === 'changed' && !kind) return false;
      if (f.status === 'new' && kind !== 'new') return false;
      if (f.status === 'amend' && kind !== 'amend') return false;
      if (q) {
        const hay = [it.name, it.model, it.supplier_name, it.remarks, it.spec, it.category, it.subcategory, it.sales].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).map((it) => ({ ...it, _kind: changeKind(it, since) }));
  }

  function renderList() {
    const A = S.admin; const f = S.filters;
    const since = f.since ? new Date(f.since + 'T00:00:00+08:00').toISOString() : null;
    const all = A.items.map((it) => ({ ...it, _kind: changeKind(it, since) }));
    const stats = {
      total: all.filter((i) => i.status === 'active').length,
      disc: all.filter((i) => i.status === 'discontinued').length,
      newC: all.filter((i) => i._kind === 'new').length,
      amend: all.filter((i) => i._kind === 'amend').length,
    };
    const supStates = A.suppliers.map((s) => supplierState(s, A.meta.stale_months));
    const okSup = supStates.filter((s) => s.key === 'ok').length;
    const items = filteredItems();
    const kpis = `<div class="kpis">
      <div class="card kpi"><span class="kpi-label">有售產品</span><span class="kpi-value num">${stats.total}</span><span class="kpi-foot">${A.suppliers.length} 間供應商</span></div>
      <div class="card kpi accent-primary"><span class="kpi-label">供應商已更新</span><span class="kpi-value num">${okSup}<span class="muted" style="font-size:var(--text-sm);font-weight:500"> / ${A.suppliers.length}</span></span><span class="kpi-foot">${A.meta.stale_months} 個月內有更新或確認</span></div>
      <div class="card kpi accent-new"><span class="kpi-label">新增產品</span><span class="kpi-value num">${stats.newC}</span><span class="kpi-foot">自 ${f.since ? fmtDate(since) : '—'}</span></div>
      <div class="card kpi accent-amend"><span class="kpi-label">價格已更改</span><span class="kpi-value num">${stats.amend}</span><span class="kpi-foot">自 ${f.since ? fmtDate(since) : '—'}</span></div>
      <div class="card kpi"><span class="kpi-label">已停售</span><span class="kpi-value num">${stats.disc}</span><span class="kpi-foot">供應商標示</span></div>
    </div>`;

    const opt = (v, l, cur) => `<option value="${attr(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
    const filterbar = `<div class="card">
      <form class="filterbar" id="filters" onsubmit="return false">
        <div class="field grow"><label for="f-q">搜尋</label><input class="input" id="f-q" name="q" placeholder="項目、型號、供應商、備註…" value="${attr(f.q)}" /></div>
        <div class="field"><label for="f-team">組別 Team</label><select class="select" id="f-team" name="team">${opt('', '全部', f.team)}${TEAMS.map((t) => opt(t, t, f.team)).join('')}</select></div>
        <div class="field"><label for="f-cat">類別 Category</label><select class="select" id="f-cat" name="category">${opt('', '全部', f.category)}${A.categories.map((c) => opt(c.name, c.name, f.category)).join('')}</select></div>
        <div class="field"><label for="f-sup">供應商 Supplier</label><select class="select" id="f-sup" name="supplier">${opt('', '全部', f.supplier)}${A.suppliers.map((s) => opt(s.id, s.name, f.supplier)).join('')}</select></div>
        <div class="field"><label for="f-status">狀態</label><select class="select" id="f-status" name="status">${[['all', '全部'], ['active', '有售'], ['changed', '有變動'], ['new', '新增'], ['amend', '價格已改'], ['discontinued', '已停售']].map(([v, l]) => opt(v, l, f.status)).join('')}</select></div>
        <div class="field"><label for="f-since">變動基準日</label><input class="input" type="date" id="f-since" name="since" value="${attr(f.since)}" title="顯示此日期之後的新增及價格變動" /></div>
        <div class="actions">
          <span class="small muted num">${items.length} 項</span>
          <button class="btn" type="button" data-action="export">${ICON.download}匯出 Excel</button>
          <button class="btn btn-primary" type="button" data-action="item-new">${ICON.plus}新增產品</button>
        </div>
      </form>
      <div class="legend"><span><i style="background:var(--color-new)"></i>紅 = 基準日後新增</span><span><i style="background:var(--color-amend)"></i>綠 = 基準日後價格更改</span><span><i style="background:var(--color-update)"></i>藍 = 其他資料更新</span><span><i style="background:var(--color-text-faint)"></i>灰／刪線 = 已停售</span></div>
    </div>`;

    return `<div class="container">${kpis}${filterbar}<div class="card">${renderItemsTable(items, { admin: true })}</div></div>`;
  }

  function renderItemsTable(items, { admin }) {
    if (!items.length) return `<div class="empty">${ICON.box}<div>沒有符合條件的產品</div></div>`;
    const cols = admin
      ? ['項目<small>Item</small>', '型號<small>Model</small>', '供應商<small>Supplier</small>', '尺寸/規格<small>Size</small>', '重量<small>Wt.</small>', '承重<small>Wt. limit</small>', '參考價<small>HK$</small>', '聯絡<small>Sales / Tel</small>', '備註<small>Remarks</small>', '網址', '最後更新<small>Last updated</small>', '狀態', '']
      : ['項目<small>Item</small>', '型號<small>Model</small>', '尺寸/規格<small>Size</small>', '重量<small>Wt.</small>', '承重<small>Wt. limit</small>', '參考價<small>HK$</small>', '聯絡<small>Sales / Tel</small>', '備註<small>Remarks</small>', '網址', '最後更新<small>Last updated</small>', '狀態', '操作'];
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
      const k = it._kind;
      const cls = `row-item ${k ? 'is-' + k : ''}`;
      const url = it.url ? `<a href="${attr(it.url)}" target="_blank" rel="noopener" title="${attr(it.url)}" class="btn btn-ghost btn-sm btn-icon" aria-label="開啟網址">${ICON.ext}</a>` : '';
      const updated = `<span class="nowrap">${fmtDate(it.updated_at)}</span><span class="sub">${it.updated_by === 'import' ? '名單匯入' : `${actorLabel(it.updated_by)} · ${rel(it.updated_at)}`}</span>`;
      const contact = `${esc(it.sales)}<span class="sub">${esc(it.tel)}</span>`;
      const price = `<span class="price num ${k === 'amend' ? 'changed' : ''}">${esc(priceDisplay(it))}</span>${it.price == null && it.price_text ? '' : ''}`;
      const ops = admin
        ? `<button class="btn btn-ghost btn-sm btn-icon" data-action="item-edit" data-id="${it.id}" title="編輯" aria-label="編輯 ${attr(it.name)}">${ICON.edit}</button>`
        : `<button class="btn btn-sm btn-icon" data-action="p-item-edit" data-id="${it.id}" title="編輯" aria-label="編輯 ${attr(it.name)}">${ICON.edit}</button>${it.status === 'active'
          ? `<button class="btn btn-ghost btn-sm" data-action="p-item-status" data-id="${it.id}" data-status="discontinued">標示停售</button>`
          : `<button class="btn btn-ghost btn-sm" data-action="p-item-status" data-id="${it.id}" data-status="active">恢復供應</button>`}`;
      rows += `<tr class="${cls}" data-id="${it.id}">
        <td class="c-name"><span class="item-name">${esc(it.name)}</span></td>
        <td class="mono c-model">${esc(it.model)}</td>
        ${admin ? `<td class="c-supplier">${esc(it.supplier_name)}</td>` : ''}
        <td class="c-spec">${esc(it.spec)}</td><td class="c-wt">${esc(it.weight)}</td><td class="c-wt">${esc(it.weight_limit)}</td>
        <td class="c-price">${price}</td><td class="c-contact">${contact}</td><td class="c-remarks">${esc(it.remarks)}</td><td>${url}</td>
        <td class="small">${updated}</td><td>${kindPill[k]}</td><td class="actions">${ops}</td></tr>`;
    }
    const widths = admin ? [160, 105, 110, 105, 58, 62, 78, 105, 150, 34, 115, 74, 44] : [165, 110, 115, 60, 65, 85, 110, 160, 34, 110, 70, 116];
    const colgroup = `<colgroup>${widths.map((w) => `<col style="width:${w}px">`).join('')}</colgroup>`;
    return `<div class="table-wrap"><table class="data items">${colgroup}<thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ----- suppliers tab -----
  function supplierLink(token) { return `${location.href.split('#')[0]}#/s/${token}`; }
  function renderSuppliers() {
    const A = S.admin;
    const rows = A.suppliers.map((s) => {
      const st = supplierState(s, A.meta.stale_months);
      return `<tr data-id="${s.id}">
        <td><span class="item-name">${esc(s.name)}</span>${s.website ? `<span class="sub"><a href="${attr(s.website)}" target="_blank" rel="noopener">${esc(s.website.replace(/^https?:\/\//, ''))}</a></span>` : ''}</td>
        <td>${esc(s.contact_name)}<span class="sub">${esc(s.tel)}${s.email ? ' · ' + esc(s.email) : ''}</span></td>
        <td class="num">${s.active_count}${s.discontinued_count ? `<span class="sub">${s.discontinued_count} 已停售</span>` : ''}</td>
        <td class="small">${st.last ? `${fmtDate(st.last)}<span class="sub">${rel(st.last)}</span>` : '<span class="muted">從未在平台更新</span><span class="sub">資料來自 ' + fmtDate(A.meta.import_date) + ' 名單</span>'}</td>
        <td class="small">${s.last_confirmed_at ? `${fmtDate(s.last_confirmed_at)}<span class="sub">${rel(s.last_confirmed_at)}</span>` : '<span class="muted">—</span>'}</td>
        <td>${st.pill}</td>
        <td class="actions">
          <button class="btn btn-sm" data-action="copy-link" data-token="${attr(s.token)}" title="複製供應商專屬連結">${ICON.link}複製連結</button>
          <a class="btn btn-ghost btn-sm" href="${attr(supplierLink(s.token))}" target="_blank" rel="noopener" title="以供應商身份開啟">${ICON.ext}開啟</a>
          <button class="btn btn-ghost btn-sm" data-action="supplier-edit" data-id="${s.id}">${ICON.edit}編輯</button>
        </td></tr>`;
    }).join('');
    const never = A.suppliers.filter((s) => supplierState(s, A.meta.stale_months).key !== 'ok').length;
    return `<div class="container">
      ${never ? `<div class="banner warn"><div class="grow"><strong>${never} 間供應商</strong>於 ${A.meta.stale_months} 個月內未有更新或確認價格。把專屬連結再傳送給他們，他們可直接在網上修改價錢、標示停售或新增產品，毋須經部門再改 Excel。</div></div>` : ''}
      <div class="card">
        <div class="card-head"><h2>供應商</h2><span class="muted small num">${A.suppliers.length} 間</span><span class="spacer"></span><button class="btn btn-primary" data-action="supplier-new">${ICON.plus}新增供應商</button></div>
        <div class="table-wrap"><table class="data supplier-tbl"><thead><tr><th>公司<small>Supplier</small></th><th>聯絡<small>Contact</small></th><th>產品<small>Items</small></th><th>最後更新<small>Last updated</small></th><th>最後確認<small>Confirmed</small></th><th>狀態</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>
      <div class="card card-pad"><strong class="small">運作方式</strong><ol class="steps" style="margin-top:8px">
        <li>按「複製連結」取得該公司的專屬連結，用電郵或 WhatsApp 傳給該公司的銷售聯絡人。每間公司只會看到自己的產品。</li>
        <li>供應商開啟連結後可直接修改價錢、規格、備註，標示「已停售」，或新增產品；每次儲存都會記錄時間。</li>
        <li>如價格全部無變動，供應商可按「確認所有價格無變動」，部門便知道該公司已核對。</li>
        <li>部門在「價目總表」即時看到所有公司的最新資料，可依基準日篩選新增／變動，並一鍵匯出 Excel（紅＝新增、綠＝價格更改）。</li>
        <li>若連結外洩，按「編輯」→「重設連結」即可令舊連結失效。</li></ol></div>
    </div>`;
  }

  // ----- changes tab -----
  function renderChangesRows(changes, { showSupplier = true } = {}) {
    if (!changes.length) return `<div class="empty">${ICON.box}<div>暫時未有更改記錄</div></div>`;
    return `<div class="table-wrap"><table class="data compact"><thead><tr><th>時間</th>${showSupplier ? '<th>供應商</th>' : ''}<th>項目</th><th>動作</th><th>欄位</th><th>由</th><th>改為</th><th>操作者</th></tr></thead><tbody>
      ${changes.map((c) => `<tr><td class="small nowrap">${fmtDateTime(c.changed_at)}</td>${showSupplier ? `<td>${esc(c.supplier_name || '')}</td>` : ''}<td>${esc(c.item_name)}</td>
        <td><span class="pill ${c.action === 'create' ? 'pill-new' : c.action === 'discontinue' ? 'pill-stale' : c.action === 'confirm' ? 'pill-ok' : c.field === 'price_text' ? 'pill-amend' : 'pill-update'}">${actionLabel(c.action)}</span></td>
        <td class="small">${c.field ? fieldLabel(c.field) : ''}</td><td class="small muted">${esc(c.old_value)}</td><td class="small">${esc(c.new_value)}</td><td class="small muted">${actorLabel(c.actor)}</td></tr>`).join('')}
    </tbody></table></div>`;
  }
  function renderChanges() {
    return `<div class="container"><div class="card"><div class="card-head"><h2>更改記錄</h2><span class="muted small">最近 300 項，供應商及部門的每次修改都會記錄</span></div>${renderChangesRows(S.admin.changes)}</div></div>`;
  }

  // ----- settings tab -----
  function renderSettings() {
    const A = S.admin;
    return `<div class="container narrow">
      <div class="card card-pad" style="display:grid;gap:16px"><h2 style="margin:0;font-size:var(--text-lg)">一般設定</h2>
        <form id="settingsForm" class="form-grid" onsubmit="return false">
          <div class="field"><label for="s-title">名單標題</label><input class="input" id="s-title" name="list_title" value="${attr(A.meta.title)}" /><span class="hint">匯出 Excel 時會顯示</span></div>
          <div class="field"><label for="s-stale">逾期門檻（月）</label><input class="input" type="number" min="1" max="24" id="s-stale" name="stale_months" value="${A.meta.stale_months}" /><span class="hint">供應商超過此月數未更新／確認會標示「逾期」</span></div>
          <div class="span-2"><button class="btn btn-primary" data-action="save-settings">儲存設定</button></div>
        </form></div>
      <div class="card card-pad" style="display:grid;gap:16px"><h2 style="margin:0;font-size:var(--text-lg)">更改部門密碼</h2>
        <form id="pwForm" class="form-grid" onsubmit="return false">
          <div class="field"><label for="pw-cur">現有密碼</label><input class="input" type="password" id="pw-cur" name="current" autocomplete="current-password" /></div>
          <div class="field"><label for="pw-new">新密碼（至少 6 個字元）</label><input class="input" type="password" id="pw-new" name="next" autocomplete="new-password" /></div>
          <div class="span-2"><button class="btn btn-primary" data-action="save-password">更改密碼</button></div>
        </form></div>
      <div class="card card-pad small muted">資料來源：${esc(A.meta.title)}（匯入日期 ${fmtDate(A.meta.import_date)}）。所有產品、供應商及更改記錄儲存在 Supabase 資料庫；供應商連結以隨機代碼產生，只有持有連結的公司才能修改自己的資料。</div>
    </div>`;
  }

  // ---------- supplier portal ----------
  function renderPortal() {
    const P = S.portal;
    const head = topbar({ subtitle: '供應商更新專區 · Supplier portal' });
    if (P.error) return head + `<main class="main"><div class="container narrow"><div class="card card-pad empty">${ICON.box}<div><strong>無法開啟</strong></div><div>${esc(P.error)}</div></div></div></main>`;
    if (!P.data) return head + `<main class="main"><div class="container narrow"><div class="card card-pad" style="display:grid;gap:12px"><div class="skel" style="width:40%"></div><div class="skel"></div><div class="skel" style="width:70%"></div></div></div></main>`;
    const { supplier: s, items, changes, meta } = P.data;
    const last = [s.last_updated_at, s.last_confirmed_at].filter(Boolean).sort().pop();
    const list = items.map((it) => ({ ...it, _kind: changeKind(it, meta.import_date) }));
    const active = list.filter((i) => i.status === 'active').length;
    const banner = last
      ? `<div class="banner ok"><div class="grow"><strong>最後更新：${fmtDateTime(last)}</strong>（${rel(last)}）。如有任何價格或供貨變動，請隨時在此更新；部門會即時看到。</div><button class="btn" data-action="p-confirm">${ICON.check}確認所有價格無變動</button></div>`
      : `<div class="banner warn"><div class="grow"><strong>貴公司尚未在此平台更新。</strong>以下資料來自 ${fmtDate(meta.import_date)} 的部門名單，請核對每項價格：有變動請按「編輯」修改；已停產請按「標示停售」；全部正確則按右方按鈕確認。</div><button class="btn" data-action="p-confirm">${ICON.check}確認所有價格無變動</button></div>`;
    return head + `<main class="main"><div class="container">
      <div class="portal-head"><div class="grow"><div class="xs muted" style="font-weight:600;letter-spacing:.04em">SUPPLIER</div><h1>${esc(s.name)}</h1><div class="small muted">共 ${active} 項有售產品${list.length - active ? `，${list.length - active} 項已停售` : ''}。此頁只顯示貴公司的產品，其他供應商無法看到。</div></div></div>
      ${banner}
      <div class="card"><div class="card-head"><h2>公司聯絡資料</h2><span class="spacer"></span><button class="btn btn-sm" data-action="p-profile-edit">${ICON.edit}編輯</button></div>
        <div class="card-pad contact-grid">
          <div><div class="k">銷售聯絡人</div><div class="v">${esc(s.contact_name) || '—'}</div></div>
          <div><div class="k">電話</div><div class="v">${esc(s.tel) || '—'}</div></div>
          <div><div class="k">電郵</div><div class="v">${esc(s.email) || '—'}</div></div>
          <div><div class="k">公司網址</div><div class="v">${s.website ? `<a href="${attr(s.website)}" target="_blank" rel="noopener">${esc(s.website)}</a>` : '—'}</div></div>
        </div></div>
      <div class="card"><div class="card-head"><h2>產品及參考價</h2><span class="muted small">按「編輯」修改價錢／規格；停產請按「標示停售」</span><span class="spacer"></span><button class="btn btn-primary" data-action="p-item-new">${ICON.plus}新增產品</button></div>
        ${renderItemsTable(list, { admin: false })}</div>
      <div class="card"><div class="card-head"><h2>貴公司的更改記錄</h2></div>${renderChangesRows(changes, { showSupplier: false })}</div>
      <p class="xs faint" style="text-align:center">此連結只供 ${esc(s.name)} 使用，請勿轉發。如需協助請聯絡職業治療部。</p>
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
    const catOpts = cats.map((c) => `<option value="${attr(c)}" ${it.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('') + `<option value="__new__">＋ 新類別…</option>`;
    const subList = `<datalist id="subcats">${subcategories.filter((s) => !it.category || s.category === it.category).map((s) => `<option value="${attr(s.subcategory)}"></option>`).join('')}</datalist>`;
    return `<form id="itemForm" method="dialog">
      <div class="modal-head"><h3>${isNew ? '新增產品' : '編輯產品'}</h3><span class="spacer" style="flex:1"></span>${!isNew ? `<span class="xs muted">最後更新 ${fmtDateTime(it.updated_at)} · ${actorLabel(it.updated_by)}</span>` : ''}</div>
      <div class="modal-body"><div class="form-grid">
        ${admin ? `<div class="field"><label for="m-supplier_id">供應商 *</label><select class="select" name="supplier_id" id="m-supplier_id" required>${suppliers.map((s) => `<option value="${s.id}" ${it.supplier_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="m-team">組別 Team</label><select class="select" name="team" id="m-team"><option value="">—</option>${TEAMS.map((t) => `<option ${it.team === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label for="m-category">類別 Category *</label><select class="select" name="category" id="m-category" required>${catOpts}</select></div>
        <div class="field" id="newCatWrap" hidden><label for="m-category_new">新類別名稱</label><input class="input" name="category_new" id="m-category_new" placeholder="例如 WALKING AID" /></div>
        ${fieldHtml('subcategory', '子類別 Sub-category', it.subcategory || '', { list: 'subcats', placeholder: '例如 Spoon、Transit W/C' })}${subList}
        ${fieldHtml('name', '項目名稱 Item *', it.name || '', { span: true, placeholder: '產品名稱（中／英）' })}
        ${fieldHtml('model', '型號 Model', it.model || '')}
        ${fieldHtml('price_text', '參考價 Ref. price (HK$) *', it.price_text || '', { placeholder: '例如 1800 或 780/835/890', hint: '輸入單一數字會自動排序及格式化；多個價錢可用「/」分隔' })}
        ${fieldHtml('spec', '尺寸／規格 Size', it.spec || '', { placeholder: '例如 16" / 18"' })}
        ${fieldHtml('weight', '重量 Wt.', it.weight || '', { placeholder: '例如 15kg' })}
        ${fieldHtml('weight_limit', '承重 Wt. limit', it.weight_limit || '', { placeholder: '例如 100kg' })}
        ${fieldHtml('url', '產品網址 Website', it.url || '', { type: 'url', placeholder: 'https://…' })}
        ${fieldHtml('sales', '銷售聯絡人 Sales', it.sales || '')}
        ${fieldHtml('tel', '電話 Tel', it.tel || '')}
        ${fieldHtml('remarks', '備註 Remarks', it.remarks || '', { span: true, textarea: true, placeholder: '例如 安裝費、保養期、尺寸選項' })}
        ${admin && !isNew ? `<div class="field"><label for="m-status">狀態</label><select class="select" name="status" id="m-status"><option value="active" ${it.status === 'active' ? 'selected' : ''}>有售</option><option value="discontinued" ${it.status === 'discontinued' ? 'selected' : ''}>已停售</option></select></div>` : ''}
      </div></div>
      <div class="modal-foot">${admin && !isNew ? `<button type="button" class="btn btn-danger left" data-action="item-delete" data-id="${it.id}">刪除</button>` : ''}
        <button type="button" class="btn" data-action="modal-close">取消</button><button type="submit" class="btn btn-primary">${isNew ? '新增' : '儲存'}</button></div>
    </form>`;
  }

  function supplierModal(s) {
    const isNew = !s; s = s || {};
    return `<form id="supplierForm" method="dialog">
      <div class="modal-head"><h3>${isNew ? '新增供應商' : '編輯供應商'}</h3></div>
      <div class="modal-body">
        <div class="form-grid">
          ${fieldHtml('name', '公司名稱 *', s.name || '', { span: true })}
          ${fieldHtml('contact_name', '銷售聯絡人', s.contact_name || '')}
          ${fieldHtml('tel', '電話', s.tel || '')}
          ${fieldHtml('email', '電郵', s.email || '', { type: 'email' })}
          ${fieldHtml('website', '公司網址', s.website || '', { type: 'url' })}
          ${fieldHtml('notes', '部門內部備註', s.notes || '', { span: true, textarea: true, hint: '供應商不會看到此欄' })}
        </div>
        ${!isNew ? `<div class="field"><label>供應商專屬連結</label><div class="linkbox"><input class="input" readonly value="${attr(supplierLink(s.token))}" id="linkInput" /><button type="button" class="btn" data-action="copy-link" data-token="${attr(s.token)}">${ICON.link}複製</button></div><span class="hint">只把此連結傳給該公司。按「重設連結」會令舊連結即時失效。</span></div>` : ''}
      </div>
      <div class="modal-foot">${!isNew ? `<button type="button" class="btn btn-danger left" data-action="supplier-delete" data-id="${s.id}">刪除供應商</button><button type="button" class="btn left" data-action="supplier-token" data-id="${s.id}">重設連結</button><button type="button" class="btn left" data-action="supplier-confirm" data-id="${s.id}" title="代供應商記錄已核對（例如電話確認）">代為確認無變動</button>` : ''}
        <button type="button" class="btn" data-action="modal-close">取消</button><button type="submit" class="btn btn-primary">${isNew ? '新增' : '儲存'}</button></div>
    </form>`;
  }

  function profileModal(s) {
    return `<form id="profileForm" method="dialog">
      <div class="modal-head"><h3>編輯公司聯絡資料</h3></div>
      <div class="modal-body"><div class="form-grid">
        ${fieldHtml('contact_name', '銷售聯絡人', s.contact_name || '')}${fieldHtml('tel', '電話', s.tel || '')}
        ${fieldHtml('email', '電郵', s.email || '', { type: 'email' })}${fieldHtml('website', '公司網址', s.website || '', { type: 'url' })}
      </div></div>
      <div class="modal-foot"><button type="button" class="btn" data-action="modal-close">取消</button><button type="submit" class="btn btn-primary">儲存</button></div></form>`;
  }

  function confirmModal({ title, body, okLabel = '確定', danger = false, action, data = {} }) {
    const ds = Object.entries(data).map(([k, v]) => `data-${k}="${attr(v)}"`).join(' ');
    return `<div class="modal-head"><h3>${title}</h3></div><div class="modal-body small">${body}</div>
      <div class="modal-foot"><button type="button" class="btn" data-action="modal-close">取消</button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="${action}" data-confirmed="1" ${ds}>${okLabel}</button></div>`;
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
      sc.onload = resolve; sc.onerror = () => reject(new Error('無法載入 Excel 元件，請檢查網絡'));
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
    const HEADERS = ['Items', 'Model', 'Supplier', 'Seat width / Size', 'Wt.', 'Wt. limit', 'Ref. Price', 'Sales', 'Tel', 'Remarks', 'Website', 'Last updated', 'Status'];
    [14, 40, 30, 24, 28, 14, 12, 14, 22, 20, 40, 40, 14, 12].forEach((w, i) => (ws.getColumn(i + 1).width = w));
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
        it.price != null ? Number(it.price) : it.price_text, it.sales, it.tel, it.remarks, it.url,
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
      if (!d.name || !d.category) return toast('請填寫類別及項目名稱', true);
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
        closeModal(); render(); toast(id ? '已儲存，更新時間已記錄' : '已新增產品');
      } catch (err) { toast(err.message, true); }
    }
    if (form.id === 'supplierForm') {
      e.preventDefault();
      const d = formData(form); const id = form.dataset.id;
      try {
        if (id) await adminRpc('admin_update_supplier', { p_id: Number(id), p_data: d });
        else await adminRpc('admin_create_supplier', { p_data: d });
        await loadAdmin(); closeModal(); render(); toast(id ? '已儲存' : '已新增供應商，可在列表複製其專屬連結');
      } catch (err) { toast(err.message, true); }
    }
    if (form.id === 'profileForm') {
      e.preventDefault();
      try { await portalRpc('supplier_update_profile', { p_data: formData(form) }); await reloadPortal(); closeModal(); render(); toast('聯絡資料已更新'); }
      catch (err) { toast(err.message, true); }
    }
  });

  async function reloadPortal() { S.portal.data = await portalRpc('supplier_get'); }

  document.addEventListener('input', (e) => {
    const f = e.target.closest('#filters');
    if (f) {
      const prevSince = S.filters.since;
      Object.assign(S.filters, Object.fromEntries(new FormData(f)));
      // Re-render only the table/KPIs, preserving focus in the search box
      const active = document.activeElement; const pos = active?.selectionStart;
      render();
      if (active?.id) { const el = document.getElementById(active.id); el?.focus(); if (pos != null && el?.setSelectionRange && el.type === 'text') el.setSelectionRange(pos, pos); }
      void prevSince;
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
        case 'theme': S.theme = S.theme === 'dark' ? 'light' : 'dark'; render(); break;
        case 'logout': await adminRpc('admin_logout').catch(() => {}); setAdminToken(null); S.admin = null; render(); break;
        case 'modal-close': closeModal(); break;

        case 'item-new': openModal(itemModal({ item: null, admin: true, categories: A.categories, subcategories: A.subcategories, suppliers: A.suppliers })); break;
        case 'item-edit': {
          const it = A.items.find((i) => i.id === Number(id));
          openModal(itemModal({ item: it, admin: true, categories: A.categories, subcategories: A.subcategories, suppliers: A.suppliers }));
          $('#itemForm').dataset.id = id; break;
        }
        case 'item-delete':
          if (!btn.dataset.confirmed) { openModal(confirmModal({ title: '刪除產品？', body: '刪除後無法復原。如只是停產，建議改為「已停售」以保留記錄。', okLabel: '刪除', danger: true, action: 'item-delete', data: { id } })); break; }
          await adminRpc('admin_delete_item', { p_id: Number(id) }); await loadAdmin(); closeModal(); render(); toast('已刪除'); break;

        case 'supplier-new': openModal(supplierModal(null)); break;
        case 'supplier-edit': openModal(supplierModal(A.suppliers.find((s) => s.id === Number(id)))); $('#supplierForm').dataset.id = id; break;
        case 'supplier-token':
          if (!btn.dataset.confirmed) { openModal(confirmModal({ title: '重設專屬連結？', body: '舊連結會即時失效，需把新連結再傳給該公司。', okLabel: '重設連結', action: 'supplier-token', data: { id } })); break; }
          await adminRpc('admin_regenerate_token', { p_id: Number(id) }); await loadAdmin(); closeModal(); render(); toast('已產生新連結'); break;
        case 'supplier-confirm':
          await adminRpc('admin_confirm_supplier', { p_id: Number(id) }); await loadAdmin(); closeModal(); render(); toast('已記錄確認'); break;
        case 'supplier-delete':
          if (!btn.dataset.confirmed) { openModal(confirmModal({ title: '刪除供應商？', body: '該公司的所有產品及記錄都會一併刪除，無法復原。', okLabel: '刪除', danger: true, action: 'supplier-delete', data: { id } })); break; }
          await adminRpc('admin_delete_supplier', { p_id: Number(id) }); await loadAdmin(); closeModal(); render(); toast('已刪除供應商'); break;

        case 'copy-link': {
          const link = supplierLink(btn.dataset.token);
          const ok = await copyText(link);
          if (ok) toast('已複製連結，可直接傳給該公司');
          else openModal(`<div class="modal-head"><h3>供應商專屬連結</h3></div><div class="modal-body"><input class="input" readonly value="${attr(link)}" onfocus="this.select()" /><span class="hint">請手動複製以上連結</span></div><div class="modal-foot"><button class="btn" data-action="modal-close">關閉</button></div>`);
          break;
        }
        case 'export': {
          btn.disabled = true;
          const since = S.filters.since ? new Date(S.filters.since + 'T00:00:00+08:00').toISOString() : '';
          const blob = await buildExcel({ since }); const url = URL.createObjectURL(blob);
          const aEl = document.createElement('a'); aEl.href = url; aEl.download = `PPMI_list_${new Date().toISOString().slice(0, 10)}.xlsx`; document.body.appendChild(aEl); aEl.click(); aEl.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000); btn.disabled = false; toast('已匯出 Excel'); break;
        }
        case 'save-settings': {
          const d = Object.fromEntries(new FormData($('#settingsForm')));
          await adminRpc('admin_save_settings', { p_data: d }); await loadAdmin(); render(); toast('設定已儲存'); break;
        }
        case 'save-password': {
          const d = Object.fromEntries(new FormData($('#pwForm')));
          await adminRpc('admin_change_password', { p_current: d.current, p_next: d.next }); $('#pwForm').reset(); toast('密碼已更改'); break;
        }

        // ----- portal -----
        case 'p-item-new': { const D = S.portal.data; openModal(itemModal({ item: null, admin: false, categories: D.categories, subcategories: D.subcategories, suppliers: [] })); break; }
        case 'p-item-edit': { const D = S.portal.data; openModal(itemModal({ item: D.items.find((i) => i.id === Number(id)), admin: false, categories: D.categories, subcategories: D.subcategories, suppliers: [] })); $('#itemForm').dataset.id = id; break; }
        case 'p-item-status': {
          const status = btn.dataset.status;
          if (!btn.dataset.confirmed && status === 'discontinued') { openModal(confirmModal({ title: '標示為已停售？', body: '部門會看到此產品已停售（以灰色刪線顯示）。日後如恢復供應可隨時按「恢復供應」。', okLabel: '標示停售', action: 'p-item-status', data: { id, status } })); break; }
          await portalRpc('supplier_update_item', { p_id: Number(id), p_data: { status } }); await reloadPortal(); closeModal(); render(); toast(status === 'discontinued' ? '已標示為停售' : '已恢復供應'); break;
        }
        case 'p-profile-edit': openModal(profileModal(S.portal.data.supplier)); break;
        case 'p-confirm':
          if (!btn.dataset.confirmed) { openModal(confirmModal({ title: '確認所有價格無變動？', body: '系統會記錄貴公司於今日已核對全部有售產品的價格及資料。如其後有變動，仍可隨時再更新。', okLabel: '確認無變動', action: 'p-confirm' })); break; }
          await portalRpc('supplier_confirm'); await reloadPortal(); closeModal(); render(); toast('已記錄確認，多謝！'); break;
        default: break;
      }
    } catch (err) { toast(err.message, true); }
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.open) closeModal(); });

  route();
})();
