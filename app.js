/*
 * Arth — Telegram Mini App. Static ES module, no dependencies, no build step.
 *
 * Flow: find the data URL → unwrap the pairing key (stored wrapped; the wrapping key is a
 * non-extractable CryptoKey in IndexedDB, so it is bound to this origin) → show the cached envelope
 * instantly (if any) → fetch the latest envelope → AES-256-GCM decrypt on this device → render.
 * Encrypted on the PC; the key stays on this phone and is never sent to Telegram's servers.
 * (Telegram's app and its script do run this page, so they are inside the trust boundary.)
 *
 * Every string from the snapshot is untrusted: DOM is built with createElement/textContent only.
 */

const APP_VERSION = '1.1.0';
const KEY_NAME = 'arth_key_v1';
const LS_KEY = 'arth.key.v1';
const ENV_PREFIX = 'arth.env.v1:';
const STALE_MS = 3 * 60 * 60 * 1000;
const HORIZON_DAYS = 14;
const WRAP_PREFIX = 'w1.';
const IDB_NAME = 'arth-miniapp';
const IDB_STORE = 'kv';
const IDB_WRAP = 'wrap-key-v1';

const mqDark = matchMedia('(prefers-color-scheme: dark)');
const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

/* ================================================================ Telegram glue */

const T = () => (window.Telegram && window.Telegram.WebApp) || null;

/** True only inside a real Telegram client (the SDK object also exists in a plain browser). */
function inTelegram() {
  const tg = T();
  if (!tg) return false;
  try { return !!tg.initData || (!!tg.platform && tg.platform !== 'unknown'); } catch { return false; }
}
function tgAtLeast(v) {
  const tg = T();
  if (!tg || !inTelegram() || typeof tg.isVersionAtLeast !== 'function') return false;
  try { return !!tg.isVersionAtLeast(v); } catch { return false; }
}
function tgTry(fn) { try { return fn(T()); } catch { return undefined; } }
/** Opened from Telegram (launch params present) but the SDK script failed to load. */
function sdkMissingInTelegram() {
  return !T() && /tgWebApp(Data|Version|Platform)=/.test(location.hash + location.search);
}

function haptic(kind) {
  if (!tgAtLeast('6.1')) return;
  tgTry(tg => {
    if (!tg.HapticFeedback) return;
    if (kind === 'tab') tg.HapticFeedback.selectionChanged();
    else if (kind) tg.HapticFeedback.notificationOccurred(kind);
  });
}

function applyScheme() {
  const tg = T();
  let dark = mqDark.matches;
  if (tg && inTelegram() && (tg.colorScheme === 'dark' || tg.colorScheme === 'light')) dark = tg.colorScheme === 'dark';
  document.documentElement.dataset.scheme = dark ? 'dark' : 'light';
}

function initTelegram() {
  applyScheme();
  mqDark.addEventListener?.('change', applyScheme);
  const tg = T();
  if (!tg) return;
  tgTry(tg => tg.ready());
  if (!inTelegram()) return;
  tgTry(tg => tg.expand());
  tgTry(tg => tg.onEvent('themeChanged', applyScheme));
  if (tgAtLeast('6.1')) {
    tgTry(tg => tg.setHeaderColor('secondary_bg_color'));
    tgTry(tg => tg.setBackgroundColor('secondary_bg_color'));
    tgTry(tg => tg.BackButton.onClick(goBack));
  }
  if (tgAtLeast('7.0')) {
    tgTry(tg => tg.SettingsButton.onClick(() => { if (S.screen === 'app') openSub('settings'); }));
  }
  if (tgAtLeast('7.7')) tgTry(tg => tg.disableVerticalSwipes());
  if (tgAtLeast('7.10')) tgTry(tg => tg.setBottomBarColor('secondary_bg_color'));
  if (tgAtLeast('8.0')) tgTry(tg => tg.onEvent('activated', maybeRefresh));
}

function openExternal(url) {
  const safe = safeUrl(url);
  if (!safe) return;
  if (tgAtLeast('6.1')) {
    let ok = false;
    tgTry(tg => { tg.openLink(safe); ok = true; });
    if (ok) return;
  }
  window.open(safe, '_blank', 'noopener,noreferrer');
}

/* ================================================================ small utils */

const A = x => (Array.isArray(x) ? x.filter(o => o != null) : []);
const AO = x => A(x).filter(o => typeof o === 'object');
const N = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const Str = x => (typeof x === 'string' ? x : x == null ? '' : String(x));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function safeUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  try { const p = new URL(u); return p.protocol === 'https:' ? p.href : null; } catch { return null; }
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

const INR0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const INR2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NUM = new Intl.NumberFormat('en-IN');

/** Integer paise → "₹1,23,456". null → "—". Paise shown only for small odd amounts. */
function money(paise) {
  const p = N(paise);
  if (p == null) return '—';
  const neg = p < 0;
  const abs = Math.abs(p);
  const s = abs < 10000 && Math.round(abs) % 100 !== 0 ? INR2.format(abs / 100) : INR0.format(Math.round(abs / 100));
  return (neg ? '−' : '') + '₹' + s;
}
function pct(n) {
  const v = N(n);
  if (v == null) return '—';
  return (Math.round(v * 10) / 10).toString() + '%';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(Str(s));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d) ? null : d;
}
function fmtDate(s, { year = false, weekday = false } = {}) {
  const d = parseYmd(s);
  if (!d) return Str(s) || '—';
  const y = year || d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '';
  return (weekday ? DAYS[d.getDay()] + ', ' : '') + d.getDate() + ' ' + MONTHS[d.getMonth()] + y;
}
function fmtMonth(s) {
  const m = /^(\d{4})-(\d{2})/.exec(Str(s));
  return m ? MONTHS[+m[2] - 1] + ' ' + m[1] : Str(s);
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  let h = d.getHours();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ' ' + d.getFullYear()} · ${h}:${mm} ${ap}`;
}
function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return 'unknown';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 50) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
function ageMs(iso) { const t = new Date(iso).getTime(); return isFinite(t) ? Date.now() - t : Infinity; }

/** Whole days from today (local) to a YYYY-MM-DD date. */
function daysUntil(ymd, fallback) {
  const d = parseYmd(ymd);
  if (!d) return N(fallback);
  const n = new Date();
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((d - today) / 86400000);
}
function whenText(days) {
  if (days == null) return '';
  if (days < -1) return `${-days} days overdue`;
  if (days === -1) return '1 day overdue';
  if (days === 0) return 'due today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}
function plural(n, one, many) { return `${NUM.format(n)} ${n === 1 ? one : (many || one + 's')}`; }

function hueOf(s) { let h = 0; for (const c of Str(s)) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360; }
function initials(name) {
  const words = Str(name).replace(/[^\p{L}\p{N}\s+]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '•';
  const first = [...words[0]][0] || '';
  const second = words[1] ? [...words[1]][0] : ([...words[0]][1] || '');
  return (first + second).toUpperCase();
}

/* ================================================================ DOM builder */

const SVGNS = 'http://www.w3.org/2000/svg';
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'vars') for (const [vk, vv] of Object.entries(v)) el.style.setProperty(vk, String(vv));
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false || k === '') continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

const ICONS = {
  home: 'M3.5 10.4 12 3.8l8.5 6.6V19a1.2 1.2 0 0 1-1.2 1.2H15v-6h-6v6H4.7A1.2 1.2 0 0 1 3.5 19z',
  cal: 'M7.5 3v3M16.5 3v3M3.8 9.5h16.4M5.2 5h13.6c.8 0 1.4.6 1.4 1.4v12.2c0 .8-.6 1.4-1.4 1.4H5.2c-.8 0-1.4-.6-1.4-1.4V6.4C3.8 5.6 4.4 5 5.2 5zM8 13.5h.01M12 13.5h.01M16 13.5h.01M8 17h.01M12 17h.01',
  tag: 'M3.6 12.2V4.8c0-.7.5-1.2 1.2-1.2h7.4l8.2 8.2c.5.5.5 1.2 0 1.7l-7 7c-.5.5-1.2.5-1.7 0zM8 8h.01',
  drop: 'M12 3.2s6.3 6.6 6.3 11.2a6.3 6.3 0 0 1-12.6 0C5.7 9.8 12 3.2 12 3.2zM9.3 15a2.8 2.8 0 0 0 2.7 2.6',
  more: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
  card: 'M3.5 7.4c0-1 .8-1.9 1.9-1.9h13.2c1 0 1.9.8 1.9 1.9v9.2c0 1-.8 1.9-1.9 1.9H5.4c-1 0-1.9-.8-1.9-1.9zM3.5 10.2h17M7 14.8h3.2',
  star: 'M12 3.4l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9-5.3-2.9-5.3 2.9 1.1-5.9-4.3-4.1 5.9-.8z',
  copy: 'M9 9.3C9 8.6 9.6 8 10.3 8h7.9c.7 0 1.3.6 1.3 1.3v8.9c0 .7-.6 1.3-1.3 1.3h-7.9c-.7 0-1.3-.6-1.3-1.3zM15 8V5.8c0-.7-.6-1.3-1.3-1.3H5.8c-.7 0-1.3.6-1.3 1.3v7.9c0 .7.6 1.3 1.3 1.3H9',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.6h-4.6',
  back: 'M15 18.5 8.5 12 15 5.5',
  chev: 'M9.5 6l6 6-6 6',
  ext: 'M13.5 4.5h6v6M19.5 4.5l-8 8M18 14v4.3c0 .7-.5 1.2-1.2 1.2H5.7c-.7 0-1.2-.5-1.2-1.2V7.2c0-.7.5-1.2 1.2-1.2H10',
  scan: 'M4 8V5.2C4 4.5 4.5 4 5.2 4H8M16 4h2.8c.7 0 1.2.5 1.2 1.2V8M20 16v2.8c0 .7-.5 1.2-1.2 1.2H16M8 20H5.2C4.5 20 4 19.5 4 18.8V16M4 12h16',
};
function icon(name, cls = '') {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', ('ic ' + cls + (name === 'more' ? ' dots' : '')).trim());
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}

const chip = (text, tone = 'grey') => h('span', { class: 'chip ' + tone }, text);
const sec = (title, count, aside) =>
  h('div', { class: 'sec' }, h('span', null, title), count != null ? h('span', { class: 'count num' }, String(count)) : aside ? h('span', { class: 'aside' }, aside) : null);
const empty = (em, title, sub) =>
  h('div', { class: 'empty' }, h('span', { class: 'em', 'aria-hidden': 'true' }, em), h('div', { class: 't' }, title), sub ? h('div', { class: 's' }, sub) : null);
const emptyCard = (em, title, sub) => h('div', { class: 'card' }, empty(em, title, sub));
const avatar = (name, sm) => h('div', { class: 'av' + (sm ? ' sm' : ''), vars: { '--h': hueOf(name) }, 'aria-hidden': 'true' }, initials(name));
const aiTag = () => h('span', { class: 'ai' }, '🤖 AI lead · verify before acting');

function srcLink(url, label = 'Source') {
  const safe = safeUrl(url);
  if (!safe) return null;
  const host = hostOf(safe);
  return h('a', {
    class: 'src', href: safe, target: '_blank', rel: 'noopener noreferrer',
    onclick: e => { e.preventDefault(); openExternal(safe); },
  }, label + (host ? ' · ' + host : ''), icon('ext'));
}
function tappable(el, fn, label) {
  el.classList.add('tap');
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  if (label) el.setAttribute('aria-label', label);
  el.addEventListener('click', fn);
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  return el;
}
function bar(fraction, tone, i = 0, thin) {
  const f = clamp(N(fraction) ?? 0, 0, 1);
  return h('div', { class: 'bar' + (thin ? ' thin' : ''), role: 'presentation' },
    h('i', { class: tone || '', vars: { width: (f * 100).toFixed(1) + '%', '--i': i } }));
}

function countUp(el, target, fmt) {
  if (target == null || mqReduce.matches || S.animated.has(el.dataset.key)) { el.textContent = fmt(target); return; }
  S.animated.add(el.dataset.key);
  const t0 = performance.now();
  const dur = 900;
  el.textContent = fmt(0);
  const step = now => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(Math.round(target * e));
    if (k < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

let toastTimer = 0;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2400);
}

/** Native popup inside Telegram; an in-page sheet elsewhere (never window.confirm). */
function confirmAction(title, message, okLabel) {
  return new Promise(resolve => {
    if (tgAtLeast('6.2')) {
      let shown = false;
      tgTry(tg => {
        tg.showPopup({ title, message, buttons: [{ id: 'ok', type: 'destructive', text: okLabel }, { type: 'cancel' }] }, id => resolve(id === 'ok'));
        shown = true;
      });
      if (shown) return;
    }
    const close = v => { bg.remove(); resolve(v); };
    const bg = h('div', { class: 'sheet-bg', onclick: e => { if (e.target === bg) close(false); } },
      h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h3', null, title), h('p', null, message),
        h('div', { class: 'actions' },
          h('button', { class: 'btn danger', type: 'button', onclick: () => close(true) }, okLabel),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => close(false) }, 'Cancel'))));
    document.body.append(bg);
  });
}

/* ================================================================ storage */

/** Wrap a Telegram (err, ...values) callback API in a promise with a timeout. */
function tgCall(start, ms = 4000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('timeout')); } }, ms);
    try {
      start((err, ...vals) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (err) reject(new Error(String(err))); else resolve(vals);
      });
    } catch (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } }
  });
}
function lsGet(k) { try { return window.localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch { return false; } }
function lsDel(k) { try { window.localStorage.removeItem(k); } catch { /* ignore */ } }

/* ---- the wrapping key --------------------------------------------------------------------------
   Telegram's SecureStorage and DeviceStorage belong to the BOT, not to this page: any page the bot is
   pointed at can read them. localStorage is shared by every GitHub Pages site of the same account.
   So none of them ever holds the phone key itself — only the phone key WRAPPED (encrypted) by a
   non-extractable AES-GCM key that lives in IndexedDB, which is bound to this exact origin.
   Another origin reads a blob it cannot open. If IndexedDB is cleared the blob is useless: pair again. */

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (ok, v) => { if (settled) return; settled = true; clearTimeout(timer); if (ok) resolve(v); else reject(v instanceof Error ? v : new Error(String(v))); };
    const timer = setTimeout(() => done(false, new Error('IndexedDB timeout')), 4000);
    let open;
    try { open = window.indexedDB.open(IDB_NAME, 1); } catch (e) { done(false, e); return; }
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(IDB_STORE)) open.result.createObjectStore(IDB_STORE); };
    open.onerror = () => done(false, open.error || new Error('IndexedDB unavailable'));
    open.onblocked = () => done(false, new Error('IndexedDB blocked'));
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction(IDB_STORE, mode);
        const req = fn(tx.objectStore(IDB_STORE));
        tx.oncomplete = () => { db.close(); done(true, req ? req.result : undefined); };
        tx.onerror = tx.onabort = () => { db.close(); done(false, tx.error || new Error('IndexedDB write failed')); };
      } catch (e) { db.close(); done(false, e); }
    };
  });
}
const isKey = k => typeof CryptoKey !== 'undefined' && k instanceof CryptoKey;
const wrapKeyStore = {
  async get() { try { const k = await idb('readonly', s => s.get(IDB_WRAP)); return isKey(k) ? k : null; } catch { return null; } },
  /** Make a fresh wrapping key (replacing any old one) and prove IndexedDB really kept it. */
  async create() {
    const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'unwrapKey']);
    await idb('readwrite', s => s.put(k, IDB_WRAP));
    const back = await idb('readonly', s => s.get(IDB_WRAP));
    if (!isKey(back)) throw new Error('IndexedDB did not keep the key');
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch { /* best effort */ }
    return back;
  },
  async del() { try { await idb('readwrite', s => s.delete(IDB_WRAP)); } catch { /* ignore */ } },
};

const WRAP_AAD = new TextEncoder().encode('arth-miniapp-wrap-v1');
const WRAPPED_RE = /^w1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{60,70})\.([0-9a-f]{8})$/;
function bytesToB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** raw 32 bytes → "w1.<iv>.<wrapped key>.<kid>" — the only form of the phone key that is ever stored. */
async function wrapPhoneKey(rawBytes, kid, wrapKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: WRAP_AAD }, wrapKey, rawBytes));
  return WRAP_PREFIX + bytesToB64url(iv) + '.' + bytesToB64url(ct) + '.' + kid;
}
/** → { key, kid }: a NON-EXTRACTABLE decrypt key; the raw bytes never reach JavaScript. */
async function unwrapPhoneKey(blob, wrapKey) {
  const m = WRAPPED_RE.exec(blob);
  if (!m) throw new FormatError('bad wrapped key');
  const key = await crypto.subtle.unwrapKey('raw', b64urlToBytes(m[2]), wrapKey,
    { name: 'AES-GCM', iv: b64urlToBytes(m[1]), additionalData: WRAP_AAD }, { name: 'AES-GCM' }, false, ['decrypt']);
  return { key, kid: m[3] };
}
/** raw 32 bytes → { key (non-extractable, decrypt only), kid (first 8 hex of SHA-256) }. */
async function importPhoneKey(rawBytes) {
  const key = await crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rawBytes));
  return { key, kid: [...digest.slice(0, 4)].map(b => b.toString(16).padStart(2, '0')).join('') };
}

/* Where the WRAPPED key is kept: SecureStorage (Keychain/Keystore, Bot API 9.0+) → DeviceStorage (9.0+)
   → localStorage. Never CloudStorage — that syncs through Telegram's servers. */
const KEY_BACKENDS = [
  {
    id: 'secure', label: 'Telegram Secure Storage (phone keychain)',
    ok: () => tgAtLeast('9.0') && !!T().SecureStorage,
    async get() {
      const [value, canRestore] = await tgCall(cb => T().SecureStorage.getItem(KEY_NAME, cb));
      if (value) return value;
      if (canRestore) {
        const [restored] = await tgCall(cb => T().SecureStorage.restoreItem(KEY_NAME, cb), 120000);
        return restored || null;
      }
      return null;
    },
    async set(v) { const [stored] = await tgCall(cb => T().SecureStorage.setItem(KEY_NAME, v, cb)); if (stored === false) throw new Error('not stored'); },
    async del() { await tgCall(cb => T().SecureStorage.removeItem(KEY_NAME, cb)); },
  },
  {
    id: 'device', label: 'Telegram device storage (this phone only)',
    ok: () => tgAtLeast('9.0') && !!T().DeviceStorage,
    async get() { const [value] = await tgCall(cb => T().DeviceStorage.getItem(KEY_NAME, cb)); return value || null; },
    async set(v) { const [stored] = await tgCall(cb => T().DeviceStorage.setItem(KEY_NAME, v, cb)); if (stored === false) throw new Error('not stored'); },
    async del() { await tgCall(cb => T().DeviceStorage.removeItem(KEY_NAME, cb)); },
  },
  {
    id: 'local', label: 'This browser’s local storage',
    ok: () => { try { return !!window.localStorage; } catch { return false; } },
    async get() { return lsGet(LS_KEY); },
    async set(v) { if (!lsSet(LS_KEY, v)) throw new Error('localStorage unavailable'); },
    async del() { lsDel(LS_KEY); },
  },
];
const backendLabel = id => (KEY_BACKENDS.find(b => b.id === id) || {}).label || 'Memory only, until you close this';

const keyStore = {
  /** true after load() when a wrapped key was found but its wrapping key is gone (storage was cleared) */
  lost: false,
  /** → { key, kid, backend, state } or null. state: 'wrapped' | 'migrated' | 'legacy' (no IndexedDB here). */
  async load() {
    this.lost = false;
    const wrapKey = await wrapKeyStore.get();
    for (const b of KEY_BACKENDS) {
      if (!b.ok()) continue;
      let v;
      try { v = await b.get(); } catch { continue; }
      if (typeof v !== 'string' || !v) continue;
      if (v.startsWith(WRAP_PREFIX)) {
        if (!wrapKey) { this.lost = true; continue; }
        try { return { ...(await unwrapPhoneKey(v, wrapKey)), backend: b.id, state: 'wrapped' }; } catch { this.lost = true; continue; }
      }
      // A raw key stored by the first version of this app: wrap it and overwrite the raw copy.
      const legacy = parseKeyText(v);
      if (!legacy) continue;
      const bytes = b64urlToBytes(legacy);
      try {
        const k = await importPhoneKey(bytes);
        let state = 'migrated';
        try { await b.set(await wrapPhoneKey(bytes, k.kid, wrapKey || (await wrapKeyStore.create()))); } catch { state = 'legacy'; }
        this.lost = false;
        return { ...k, backend: b.id, state };
      } catch { continue; } finally { bytes.fill(0); }
    }
    return null;
  },
  /** Store the key wrapped. → backend id, or null when this browser has no IndexedDB (key lives in memory only). */
  async save(rawBytes, kid) {
    let wrapKey;
    try { wrapKey = await wrapKeyStore.create(); } catch { await this.clearStores(); return null; }
    const blob = await wrapPhoneKey(rawBytes, kid, wrapKey);
    for (const b of KEY_BACKENDS) {
      if (!b.ok()) continue;
      try {
        await b.set(blob);
        // keep exactly one copy: drop any older copy in another backend
        for (const o of KEY_BACKENDS) if (o !== b && o.ok()) { try { await o.del(); } catch { /* ignore */ } }
        return b.id;
      } catch { /* try the next backend */ }
    }
    throw new Error('No storage on this device accepted the key.');
  },
  async clearStores() {
    for (const b of KEY_BACKENDS) { if (!b.ok()) continue; try { await b.del(); } catch { /* ignore */ } }
  },
  async clear() { await this.clearStores(); await wrapKeyStore.del(); },
};

/* The last good envelope (ciphertext + builtAt; useless without the key): localStorage, mirrored to DeviceStorage. */
function envSlot(url) { let x = 5381; for (const c of url) x = ((x * 33) ^ c.charCodeAt(0)) >>> 0; return 'arth_env_' + x.toString(36); }
async function loadCachedEnvelope(url) {
  const s = lsGet(ENV_PREFIX + url);
  if (s) { try { return JSON.parse(s); } catch { /* fall through */ } }
  if (tgAtLeast('9.0') && T().DeviceStorage) {
    try { const [v] = await tgCall(cb => T().DeviceStorage.getItem(envSlot(url), cb), 2500); if (v) return JSON.parse(v); } catch { /* none */ }
  }
  return null;
}
function saveCachedEnvelope(url, env) {
  const s = JSON.stringify(env);
  lsSet(ENV_PREFIX + url, s);
  if (tgAtLeast('9.0') && T().DeviceStorage) tgCall(cb => T().DeviceStorage.setItem(envSlot(url), s, cb)).catch(() => {});
}
async function clearCachedEnvelope(url) {
  try { for (const k of Object.keys(window.localStorage)) if (k.startsWith(ENV_PREFIX)) lsDel(k); } catch { lsDel(ENV_PREFIX + url); }
  if (tgAtLeast('9.0') && T().DeviceStorage) { try { await tgCall(cb => T().DeviceStorage.removeItem(envSlot(url), cb), 2500); } catch { /* ignore */ } }
}

/* ================================================================ crypto + data */

class WrongKeyError extends Error {}
/** The envelope names a different key (kid) than ours: the PC re-keyed. */
class NewKeyError extends WrongKeyError {}
class FormatError extends Error {}
class FetchError extends Error { constructor(status) { super('fetch ' + status); this.status = status; } }

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToBytes(s) {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return b64ToBytes(t);
}
/** Accepts "arth-key:<base64url>" or the bare key (base64url or base64). Returns canonical base64url, or null. */
function parseKeyText(text) {
  let t = Str(text).trim().replace(/\s+/g, '');
  if (/^arth-key:/i.test(t)) t = t.slice(9);
  if (!/^[A-Za-z0-9_+/-]{43}=?$/.test(t)) return null;
  t = t.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  try { return b64urlToBytes(t).length === 32 ? t : null; } catch { return null; }
}

function checkEnvelope(env) {
  if (!env || typeof env !== 'object') throw new FormatError('envelope is not an object');
  if (env.v !== 1) throw new FormatError('envelope version ' + env.v);
  if (env.alg !== 'AES-256-GCM') throw new FormatError('alg ' + env.alg);
  if (typeof env.iv !== 'string' || typeof env.ct !== 'string') throw new FormatError('iv/ct missing');
}

/** k = { key: non-extractable CryptoKey, kid }. */
async function decryptEnvelope(env, k) {
  checkEnvelope(env);
  let iv, ct;
  try { iv = b64ToBytes(env.iv); ct = b64ToBytes(env.ct); } catch { throw new FormatError('bad base64'); }
  if (iv.length !== 12 || ct.length < 17) throw new FormatError('bad iv/ct length');
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k.key, ct); }
  catch {
    // An envelope without kid (older PC builds) keeps the generic wrong-key behaviour.
    if (typeof env.kid === 'string' && env.kid && k.kid && env.kid.toLowerCase() !== k.kid) throw new NewKeyError('kid mismatch');
    throw new WrongKeyError('decrypt failed');
  }
  let snap;
  try { snap = JSON.parse(new TextDecoder().decode(plain)); } catch { throw new FormatError('plaintext is not JSON'); }
  if (!snap || snap.v !== 1) throw new FormatError('snapshot version ' + (snap && snap.v));
  return normalize(snap);
}

/** The envelope's builtAt sits outside the encryption, so anyone who can write the data branch can change it.
    The copy inside the ciphertext is the one to trust; this says whether the two disagree. */
function timestampsDiffer(outer, inner) {
  if (!inner) return false;
  const a = Date.parse(outer), b = Date.parse(inner);
  return Number.isFinite(a) && Number.isFinite(b) ? a !== b : Str(outer) !== Str(inner);
}

/** Defensive copy: every list exists, every amount is a number or null.
    playbook / pointsPlan are null when the upload predates them (Arth before 0.14). */
function normalize(s) {
  const due = s.due && typeof s.due === 'object' ? s.due : {};
  const lk = s.leaks && typeof s.leaks === 'object' ? s.leaks : {};
  const pp = s.pointsPlan && typeof s.pointsPlan === 'object' ? s.pointsPlan : null;
  return {
    v: 1,
    builtAt: Str(s.builtAt),
    version: Str(s.version),
    privacy: !!s.privacy,
    due: { pending: AO(due.pending), settled: AO(due.settled), noStatement: A(due.noStatement).map(Str).filter(Boolean) },
    offers: AO(s.offers),
    conversions: AO(s.conversions),
    changes: AO(s.changes),
    leaks: {
      annualRecoverablePaise: N(lk.annualRecoverablePaise),
      savingsFrom: lk.savingsFrom || null,
      savingsThrough: lk.savingsThrough || null,
      upi: AO(lk.upi),
      uncategorisedCount: N(lk.uncategorisedCount) ?? 0,
      bills: AO(lk.bills),
      spikes: AO(lk.spikes),
    },
    points: AO(s.points),
    statements: AO(s.statements),
    bestCard: AO(s.bestCard),
    playbook: Array.isArray(s.playbook) ? AO(s.playbook) : null,
    pointsPlan: pp ? {
      kbChecked: Str(pp.kbChecked),
      goal: pp.goal && typeof pp.goal === 'object' ? pp.goal : null,
      stays: AO(pp.stays),
      flights: AO(pp.flights),
    } : null,
  };
}

function isLocalHost(hostname) {
  const h = Str(hostname).toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

/** Where the ciphertext lives: <owner>.github.io/<repo>/ → GitHub contents API on branch arth-data.
    ?data=<url> is a development aid: honoured on localhost only, ignored everywhere else. */
function resolveSource() {
  const host = location.hostname.toLowerCase();
  const local = isLocalHost(host);
  const override = local ? new URLSearchParams(location.search).get('data') : null;
  if (override) {
    try {
      const u = new URL(override, location.href);
      if (u.origin === location.origin || u.protocol === 'https:') return { url: u.href, label: u.origin === location.origin ? u.pathname : u.host + u.pathname, override: true };
    } catch { /* fall through */ }
    return { error: 'bad-override' };
  }
  const m = /^([a-z0-9](?:[a-z0-9-]{0,38}))\.github\.io$/.exec(host);
  if (m) {
    const owner = m[1];
    let repo = decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] || '');
    if (!repo || /\.html?$/i.test(repo)) repo = host; // user site: <owner>.github.io
    return {
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/snapshot.enc.json?ref=arth-data`,
      label: `${owner}/${repo} · arth-data`,
    };
  }
  if (local) return { url: new URL('dev/snapshot.enc.json', location.href).href, label: 'dev/snapshot.enc.json (local)', override: true };
  return { error: 'unknown-host' };
}

async function fetchEnvelope(src) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    let res;
    try {
      res = await fetch(src.url, {
        headers: { Accept: 'application/vnd.github.raw' },
        cache: 'no-cache', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal,
      });
    } catch { throw new FetchError(0); }
    if (!res.ok) throw new FetchError(res.status);
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new FormatError('envelope is not JSON'); }
  } finally { clearTimeout(timer); }
}

/* ================================================================ state + routing */

const S = {
  source: null,
  key: null,         // { key: non-extractable CryptoKey, kid, backend, state } — never the raw key
  env: null,         // last envelope shown
  snap: null,        // decrypted, normalized snapshot
  tsAltered: false,  // the envelope's builtAt disagrees with the one inside the ciphertext
  tab: 'home',
  sub: null,         // 'due' | 'leaks' | 'statements' | 'settings'
  screen: 'loading', // 'app' | 'pair' | 'wrongkey' | 'error' | 'loading'
  fetching: false,
  lastFetchAt: 0,
  offline: null,     // reason the last refresh failed while showing cached data
  animated: new Set(),
  calc: { i: 0, amt: '' },
};

/** Show this envelope + snapshot. Freshness always comes from the builtAt INSIDE the ciphertext. */
function adopt(env, snap) {
  S.env = env; S.snap = snap;
  S.tsAltered = timestampsDiffer(env && env.builtAt, snap && snap.builtAt);
}
function shownAt() { return (S.snap && S.snap.builtAt) || (S.env && S.env.builtAt) || ''; }

const TABS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'cards', label: 'Cards', icon: 'card' },
  { id: 'points', label: 'Points', icon: 'star' },
  { id: 'offers', label: 'Offers', icon: 'tag' },
  { id: 'more', label: 'More', icon: 'more' },
];
const TITLES = { home: 'Arth', cards: 'Cards', points: 'Points', offers: 'Offers', more: 'More', due: 'Due', leaks: 'Money leaks', statements: 'Statements', settings: 'Settings' };

function go(tab) {
  if (S.tab === tab && !S.sub) { window.scrollTo({ top: 0, behavior: mqReduce.matches ? 'auto' : 'smooth' }); return; }
  haptic('tab');
  S.tab = tab; S.sub = null;
  render({ animate: true, top: true });
}
function openSub(name) { haptic('tab'); S.sub = name; render({ animate: true, top: true }); }
function goBack() { if (S.sub) { S.sub = null; render({ animate: true, top: true }); } }
function syncTelegramButtons() {
  const showBack = S.screen === 'app' && !!S.sub;
  if (tgAtLeast('6.1')) tgTry(tg => (showBack ? tg.BackButton.show() : tg.BackButton.hide()));
  if (tgAtLeast('7.0')) tgTry(tg => (S.screen === 'app' ? tg.SettingsButton.show() : tg.SettingsButton.hide()));
}

/* ================================================================ derived data */

function pendingSorted(s) {
  return s.due.pending
    .map(r => ({ ...r, _days: daysUntil(r.dueDate, r.daysUntilDue) }))
    .sort((a, b) => (a._days ?? 9999) - (b._days ?? 9999));
}
function urgencyTone(days) { return days == null ? 'grey' : days < 0 ? 'red' : days <= 3 ? 'red' : days <= 7 ? 'amber' : 'green'; }
const STATUS = {
  due: ['Due', 'amber'],
  'part-paid': ['Part-paid', 'blue'],
  unconfirmed: ['No payment seen', 'red'],
  stale: ['Statement old', 'grey'],
  paid: ['Settled', 'green'],
};
const VERDICT = {
  'worth-it': ['✓ Worth it', 'green'],
  'worth-for-a-booking': ['✓ Worth it for a booking', 'green'],
  hold: ['⏸ Hold', 'amber'],
  'not-worth-it': ['✕ Not worth it', 'red'],
  'cannot-value': ['? Can’t value yet', 'grey'],
};
const verdictChip = v => { const [t, tone] = VERDICT[v] || [Str(v) || 'Unrated', 'grey']; return chip(t, tone); };
const KIND = { offer: ['Offer', 'blue'], campaign: ['Campaign', 'violet'], 'cheat-code': ['Cheat code', 'amber'], conversion: ['Conversion', 'green'], upgrade: ['Upgrade', 'green'], transfer: ['Transfer', 'blue'] };
const kindChip = k => { const [t, tone] = KIND[k] || [Str(k) || 'Lead', 'grey']; return chip(t, tone); };

const CATEGORY_EMOJI = [
  [/food|dining|restaurant|swiggy|zomato|eat/i, '🍽️'], [/grocer|quick|zepto|blinkit|instamart/i, '🛒'],
  [/fuel|petrol|diesel|shell|hp|bpcl|iocl|indian oil/i, '⛽'], [/flight|travel|air(line|fare|port)?s?|hotel|makemytrip|cleartrip|stays?/i, '✈️'],
  [/movie|entertain|ott|netflix|prime video|hotstar|bookmyshow|district/i, '🎬'], [/spotify|music|youtube|gaana/i, '🎵'],
  [/fibre|fiber|broadband|internet|wi-?fi|postpaid|airtel|jio|vi/i, '📶'],
  [/shop|amazon|flipkart|online|e-?com/i, '🛍️'], [/util|electric|bill|recharge|broadband|mobile/i, '💡'],
  [/rent|home|house/i, '🏠'], [/cab|uber|ola|taxi|transport|metro/i, '🚕'], [/health|pharma|medic/i, '💊'],
  [/insur/i, '🛡️'], [/educat|school|fee/i, '🎓'],
];
const catEmoji = c => (CATEGORY_EMOJI.find(([re]) => re.test(Str(c))) || [0, '💳'])[1];

/* ================================================================ chrome: header, banners, tabs */

function buildHeader() {
  const title = TITLES[S.sub || S.tab];
  const kicker = S.sub ? null : S.tab === 'home' ? fmtDate(isoToday(), { weekday: true }) : null;
  const left = h('div', { class: 'top-l' });
  if (S.sub && !tgAtLeast('6.1')) left.append(h('button', { class: 'back', type: 'button', 'aria-label': 'Back', onclick: goBack }, icon('back')));
  left.append(h('div', { style: null }, kicker ? h('div', { class: 'kicker' }, kicker) : null, h('h1', null, title)));
  return h('header', { class: 'top' + (S.sub ? ' is-sub' : '') }, left, h('div', { class: 'top-r' }, buildPill()));
}
function isoToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

function buildPill() {
  const builtAt = shownAt();
  const stale = ageMs(builtAt) > STALE_MS;
  const cls = 'pill num' + (S.offline ? ' off' : stale || S.tsAltered ? ' stale' : '') + (S.fetching ? ' busy' : '');
  const btn = h('button', { class: cls, type: 'button', id: 'pill', 'aria-label': 'Refresh — last updated ' + relTime(builtAt), onclick: () => refresh({ manual: true }) },
    h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { id: 'pill-t' }, relTime(builtAt)), icon('refresh'));
  return btn;
}
function updatePill() {
  const old = document.getElementById('pill');
  if (old) old.replaceWith(buildPill());
}

function buildBanners() {
  const box = h('div', { class: 'banners', id: 'banners' });
  const banner = (tone, em, strong, rest, role = 'status') => box.append(h('div', { class: 'banner ' + tone, role },
    h('span', { class: 'em', 'aria-hidden': 'true' }, em), h('div', null, h('b', null, strong), rest)));
  const builtAt = shownAt();
  if (S.tsAltered) banner('amber', '🕒', 'This data’s timestamp was altered.', ' The real time, from inside the encrypted data: ' + fmtDateTime(builtAt) + '.');
  if (ageMs(builtAt) > STALE_MS) banner('amber', '⚠️', 'Your PC hasn’t updated since ' + fmtDateTime(builtAt) + '.', ' Open Arth on your PC so the numbers catch up.');
  if (S.offline) {
    const why = S.offline === 'offline' ? 'You’re offline' : S.offline === 'missing' ? 'No data found on GitHub right now' : S.offline === 'limited' ? 'GitHub is rate-limiting this network' : 'Couldn’t reach GitHub';
    banner('grey', '📴', why + '.', ' Showing your last saved copy.');
  }
  if (S.snap && S.snap.privacy && (S.tab !== 'more' || S.sub)) banner('violet', '🙈', 'Privacy mode is on.', ' Your PC sent no amounts — only dates, names and counts.', 'note');
  if (S.key && S.key.backend == null) banner('grey', '🔑', 'Paired for this visit only.', ' This browser can’t keep the key safely, so you’ll pair again next time.', 'note');
  if (S.source && S.source.override) banner('blue', '🧪', 'Test data source: ', S.source.label, 'note');
  return box;
}

function buildTabs() {
  const urgent = S.snap ? pendingSorted(S.snap).some(r => r._days != null && r._days <= 3) : false;
  const inner = h('div', { class: 'tabs-in', role: 'tablist' });
  for (const t of TABS) {
    const on = S.tab === t.id;
    inner.append(h('button', {
      class: 'tab' + (on ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false',
      onclick: () => go(t.id),
    }, h('span', { class: 'ic-wrap' }, icon(t.icon), t.id === 'more' && urgent ? h('span', { class: 'dot', role: 'img', 'aria-label': 'a bill is due within 3 days' }) : null), t.label));
  }
  return h('nav', { class: 'tabs', 'aria-label': 'Sections' }, inner);
}

/* ================================================================ render */

function render({ animate = false, top = false } = {}) {
  S.screen = 'app';
  const nodes = viewNodes();
  if (animate) nodes.forEach((n, i) => { if (n instanceof Element) { n.classList.add('rise'); n.style.setProperty('--i', String(Math.min(i, 10))); } });
  const main = h('main', { class: 'view' + (animate ? ' anim' : ''), id: 'view' }, nodes);
  $app.replaceChildren(buildHeader(), buildBanners(), main, buildTabs());
  if (top) window.scrollTo(0, 0);
  syncTelegramButtons();
}
function viewNodes() {
  const s = S.snap;
  switch (S.sub || S.tab) {
    case 'cards': return viewCards(s);
    case 'points': return viewPoints(s);
    case 'offers': return viewOffers(s);
    case 'more': return viewMore(s);
    case 'due': return viewDue(s);
    case 'leaks': return viewLeaks(s);
    case 'statements': return viewStatements(s);
    case 'settings': return viewSettings(s);
    default: return viewHome(s);
  }
}

/* ---------------------------------------------------------------- Home */

function viewHome(s) {
  const out = [];
  const pending = pendingSorted(s);
  const soon = pending.filter(r => r._days != null && r._days <= HORIZON_DAYS);
  out.push(heroCard(s, soon));

  out.push(sec('Next dues', pending.length || null));
  if (pending.length) {
    const list = h('div', { class: 'card list' }, pending.slice(0, 2).map(dueRow),
      moreLink(pending.length > 2 ? `All ${pending.length} bills` : 'Dues and settled bills'));
    out.push(tappable(list, () => openSub('due'), 'Open due bills'));
  } else {
    out.push(tappable(emptyCard('🌤️', 'No pending bills', 'Every card with a statement is settled.'), () => openSub('due'), 'Open due bills'));
  }

  const goal = s.pointsPlan && s.pointsPlan.goal;
  if (goal) {
    out.push(sec('Your goal'));
    out.push(tappable(goalCard(goal, true), () => go('points'), 'Open the points planner'));
  }

  const tip = topTip(s);
  if (tip) {
    out.push(sec('Card tip'));
    out.push(tappable(tip, () => go('cards'), 'Open the card playbook'));
  }

  const offer = bestOffer(s);
  if (offer) {
    out.push(sec('Best live offer'));
    out.push(tappable(h('div', { class: 'card list' }, offerItem(offer, true)), () => go('offers'), 'Open offers'));
  }

  // quieter pointers to the rest
  const also = [];
  const alerts = s.conversions.filter(c => c.verdict === 'worth-it' || c.verdict === 'worth-for-a-booking');
  if (alerts.length) {
    also.push(tappable(h('div', { class: 'row' }, h('div', { class: 'emo', 'aria-hidden': 'true' }, '🔁'),
      h('div', { class: 'main' }, h('div', { class: 't' }, plural(alerts.length, 'conversion') + ' worth a look'), h('div', { class: 's' }, Str(alerts[0].title))),
      icon('chev', 'chev')), () => go('offers'), 'Open conversions'));
  }
  const lk = s.leaks;
  if ((lk.annualRecoverablePaise ?? 0) > 0 || lk.upi.length || lk.bills.length) {
    also.push(tappable(h('div', { class: 'row' }, h('div', { class: 'emo', 'aria-hidden': 'true' }, '💧'),
      h('div', { class: 'main' },
        h('div', { class: 't' }, (lk.annualRecoverablePaise ?? 0) > 0 ? money(lk.annualRecoverablePaise) + ' a year to recover' : 'Money leaks'),
        h('div', { class: 's' }, [lk.upi.length ? plural(lk.upi.length, 'place') : null, lk.bills.length ? plural(lk.bills.length, 'bill') : null, lk.spikes.length ? plural(lk.spikes.length, 'spike') : null].filter(Boolean).join(' · '))),
      icon('chev', 'chev')), () => openSub('leaks'), 'Open money leaks'));
  }
  if (also.length) { out.push(sec('Also')); out.push(h('div', { class: 'card list menu' }, also)); }

  out.push(h('p', { class: 'foot-note' }, 'Updated ' + relTime(shownAt()) + ' · Arth ' + (s.version || '—'), h('br'), 'Encrypted on your PC; the key stays on this phone.'));
  return out;
}
const moreLink = text => h('div', { class: 'item more-link' }, h('span', { class: 'src' }, text, icon('chev')));

/** The one switch worth knowing today: a cap that is used up, else the biggest gain from switching, else the first rule. */
function topTip(s) {
  const pb = s.playbook;
  if (!pb || !pb.length) return null;
  const used = pb.find(r => N(r.capSpendPaise) != null && N(r.spendLeftPaise) != null && r.spendLeftPaise <= 0 && nextOf(r));
  const gain = pb.filter(r => (N(r.switchGainPaise) ?? 0) > 0 && nextOf(r)).sort((a, b) => b.switchGainPaise - a.switchGainPaise)[0];
  let em, kicker, title, body;
  if (used) {
    const n = nextOf(used);
    em = '🔄'; kicker = Str(used.category) + ' · switch now';
    title = 'Use ' + Str(n.card) + ' for the rest of the month';
    body = Str(used.card) + '’s cap is used up. ' + Str(n.card) + ' still gives ' + pct(n.ratePct) + ' back.';
  } else if (gain) {
    const n = nextOf(gain);
    em = '💡'; kicker = Str(gain.category) + ' · when to switch';
    title = Str(gain.card) + ' first, then ' + Str(n.card);
    body = (N(gain.capSpendPaise) != null ? 'After ' + money(gain.capSpendPaise) + ' a month the cap is reached. ' : '') + 'Switching then keeps ' + money(gain.switchGainPaise) + ' a month.';
  } else {
    const r = pb[0];
    em = catEmoji(r.category); kicker = Str(r.category);
    title = 'Use ' + Str(r.card);
    body = pct(r.ratePct) + ' back' + (A(r.conditions)[0] ? ' · ' + Str(A(r.conditions)[0]) : '');
  }
  return h('div', { class: 'card' }, h('div', { class: 'headline tip' }, h('div', { class: 'emo', 'aria-hidden': 'true' }, em),
    h('div', null, h('div', { class: 'k' }, kicker), h('div', { class: 't' }, title), h('div', { class: 's' }, body))));
}

function heroCard(s, soon) {
  const hero = h('section', { class: 'hero' + (soon.length ? '' : ' calm'), 'aria-label': 'Due in the next 14 days' });
  if (!soon.length) {
    hero.append(h('div', { class: 'lbl' }, 'Next 14 days'),
      h('div', { class: 'big word' }, 'Nothing due 🎉'),
      h('div', { class: 'subl' }, s.due.pending.length ? `Next bill is ${whenText(pendingSorted(s)[0]._days)}.` : 'No open bills on any card.'));
    return hero;
  }
  const total = soon.reduce((a, r) => a + (N(r.amountPaise) ?? 0), 0);
  const anyAmount = soon.some(r => N(r.amountPaise) != null);
  const big = h('div', { class: 'big num', 'data-key': 'hero:' + shownAt() });
  const overdue = soon.filter(r => r._days < 0).length;
  const countMode = !(anyAmount && !s.privacy);
  hero.append(h('div', { class: 'lbl' }, countMode ? 'Bills due in the next 14 days' : 'Still owed in the next 14 days'), big);
  if (!countMode) countUp(big, total, money); else { big.textContent = plural(soon.length, 'bill'); big.classList.add('word'); }
  const first = soon[0];
  const firstLate = first._days < 0;
  hero.append(h('div', { class: 'subl' },
    countMode ? '' : plural(soon.length, 'card'), countMode ? (firstLate ? '' : 'Next: ') : firstLate ? ' · ' : ' · next ', h('b', null, Str(first.card)), (firstLate ? ' is ' : ' ') + whenText(first._days),
    overdue > (firstLate ? 1 : 0) ? ` · ${overdue} overdue` : ''));

  const tl = h('div', { class: 'timeline', 'aria-hidden': 'true' });
  const track = h('div', { class: 'tl-track' });
  const last = Math.max(...soon.map(r => clamp(r._days, 0, HORIZON_DAYS)));
  track.append(h('div', { class: 'tl-fill', vars: { width: ((last / HORIZON_DAYS) * 100).toFixed(1) + '%' } }));
  soon.forEach((r, i) => {
    const d = clamp(r._days, 0, HORIZON_DAYS);
    track.append(h('div', { class: 'tl-dot' + (r._days < 0 ? ' over' : ''), vars: { left: ((d / HORIZON_DAYS) * 100).toFixed(1) + '%', '--i': i } }));
  });
  tl.append(track, h('div', { class: 'tl-ticks' }, h('span', null, 'Today'), h('span', null, '1 week'), h('span', null, '2 weeks')));
  hero.append(tl);
  return hero;
}

const s_amount = p => (N(p) == null ? '—' : money(p));

function leakHeadline(s, teaser) {
  const lk = s.leaks;
  const amt = lk.annualRecoverablePaise;
  const numEl = h('span', { 'data-key': 'leak:' + (teaser ? 'h' : 'l') + ':' + shownAt() });
  const has = amt != null && amt > 0;
  const bigEl = h('div', { class: 'big num' + (has ? '' : ' na') }, numEl, has ? h('small', null, '/yr') : null);
  if (has) countUp(numEl, amt, money); else numEl.textContent = s.privacy && amt == null ? 'Amount hidden' : 'Nothing leaking 🎯';
  const hidden = s.privacy && amt == null;
  const range = lk.savingsFrom && lk.savingsThrough ? `Checked ${fmtDate(lk.savingsFrom, { year: true })} – ${fmtDate(lk.savingsThrough, { year: true })}` : has || hidden ? 'by paying with the right card' : 'No missed rewards found so far';
  const card = h('div', { class: 'card' },
    h('div', { class: 'headline' }, h('div', { class: 'emo', 'aria-hidden': 'true' }, '💧'),
      h('div', null, h('div', { class: 's' }, has || hidden ? 'You could recover' : 'Money leaks'), bigEl, h('div', { class: 's' }, range))));
  if (teaser) {
    const minis = [
      lk.upi.length ? chip('📍 ' + plural(lk.upi.length, 'place'), 'grey') : null,
      lk.bills.length ? chip('🧾 ' + plural(lk.bills.length, 'bill'), 'grey') : null,
      lk.spikes.length ? chip('📈 ' + plural(lk.spikes.length, 'spike'), 'grey') : null,
    ].filter(Boolean);
    if (minis.length) card.append(h('div', { class: 'minis' }, minis));
  }
  return card;
}

/* ---------------------------------------------------------------- Due */

function viewDue(s) {
  const out = [];
  const pending = pendingSorted(s);
  const owed = pending.reduce((a, r) => a + (N(r.amountPaise) ?? 0), 0);
  const anyAmt = pending.some(r => N(r.amountPaise) != null);
  out.push(h('div', { class: 'stats' },
    stat(anyAmt && !s.privacy ? money(owed) : !pending.length && !s.privacy ? money(0) : '—', 'Still owed', anyAmt && pending.length ? 'amber' : ''),
    stat(String(pending.length), 'Pending', pending.some(r => r._days < 0) ? 'red' : ''),
    stat(String(s.due.settled.length), 'Settled', s.due.settled.length ? 'green' : '')));

  out.push(sec('Pending', pending.length));
  out.push(pending.length
    ? h('div', { class: 'card list' }, pending.map(dueRow))
    : emptyCard('🎉', 'Nothing pending', 'No open bill on any card.'));

  out.push(sec('Settled', s.due.settled.length));
  const settled = s.due.settled.map(r => ({ ...r, _days: daysUntil(r.dueDate, r.daysUntilDue) })).sort((a, b) => (b._days ?? 0) - (a._days ?? 0));
  out.push(settled.length
    ? h('div', { class: 'card list' }, settled.map(r => h('div', { class: 'row muted-row' },
      (() => { const d = parseYmd(r.dueDate); return h('div', { class: 'tile green', 'aria-hidden': 'true' }, h('div', { class: 'd num' }, d ? String(d.getDate()) : '✓'), h('div', { class: 'm' }, d ? MONTHS[d.getMonth()] : '')); })(),
      h('div', { class: 'main' }, h('div', { class: 't' }, Str(r.card)), h('div', { class: 's' }, 'Due ' + fmtDate(r.dueDate) + (r.note ? ' · ' + Str(r.note) : ''))),
      h('div', { class: 'end' }, (N(r.amountPaise) == null ? null : h('div', { class: 'amt num' }, money(r.amountPaise))), h('div', { class: 'when' }, '✅ settled')))))
    : emptyCard('🗂️', 'Nothing settled yet', 'Paid bills show up here once Arth sees the payment.'));

  out.push(sec('No statement yet', s.due.noStatement.length));
  out.push(s.due.noStatement.length
    ? h('div', { class: 'card list' }, s.due.noStatement.map(c => h('div', { class: 'row' },
      h('div', { class: 'emo', 'aria-hidden': 'true' }, '📭'),
      h('div', { class: 'main' }, h('div', { class: 't' }, c), h('div', { class: 's' }, 'Arth hasn’t read a statement for this card')),
      h('div'))))
    : emptyCard('📬', 'Every card has a statement', 'Arth has read a statement for each of your cards.'));
  return out;
}
function stat(v, k, tone) {
  return h('div', { class: 'stat' }, h('div', { class: 'v num' + (tone ? ' ' + tone : '') }, v), h('div', { class: 'k' }, k));
}
function dueRow(r) {
  const days = r._days;
  const d = parseYmd(r.dueDate);
  const tone = urgencyTone(days);
  const [st, stTone] = STATUS[r.status] || [Str(r.status) || 'Unknown', 'grey'];
  const chips = [chip(st, stTone)];
  if (days != null && days < 0 && r.status !== 'paid') chips.unshift(chip('Overdue', 'red'));
  return h('div', { class: 'row indent' },
    h('div', { class: 'tile ' + (tone === 'green' ? '' : tone), 'aria-hidden': 'true' },
      h('div', { class: 'd num' }, d ? String(d.getDate()) : '?'), h('div', { class: 'm' }, d ? MONTHS[d.getMonth()] : '')),
    h('div', { class: 'main' },
      h('div', { class: 't' }, Str(r.card)),
      r.note ? h('div', { class: 's' }, Str(r.note)) : null,
      h('div', { class: 'chips' }, chips)),
    h('div', { class: 'end' },
      (N(r.amountPaise) == null ? null : h('div', { class: 'amt num' }, money(r.amountPaise))),
      h('div', { class: 'when ' + (tone === 'red' || tone === 'amber' ? tone : '') }, whenText(days))));
}

/* ---------------------------------------------------------------- Offers */

/** Offers that have not ended. An offer with no end date, or one we cannot read, stays. */
function liveOffers(s) {
  return s.offers.filter(o => { const d = o.until ? daysUntil(o.until) : null; return d == null || d >= 0; });
}
function endsText(until) {
  const d = daysUntil(until);
  if (d == null) return null;
  return 'Ends ' + fmtDate(until) + ' · ' + (d === 0 ? 'last day today' : d === 1 ? '1 day left' : d + ' days left');
}
/** The offer to show on Home: issuer-sourced, with a stated benefit, ending soonest. */
function bestOffer(s) {
  const live = liveOffers(s).filter(o => !o.community);
  const dated = live.filter(o => o.until && daysUntil(o.until) != null).sort((a, b) => daysUntil(a.until) - daysUntil(b.until));
  return dated.find(o => o.benefit) || dated[0] || live.find(o => o.deadline) || live.find(o => o.benefit) || null;
}

async function copyText(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall back */ }
  try {
    const ta = h('textarea', { class: 'sr', readonly: true, 'aria-hidden': 'true' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** One offer. compact = the Home teaser: no buttons inside (the whole card is the button). */
function offerItem(o, compact) {
  const d = o.until ? daysUntil(o.until) : null;
  const fact = (label, value) => (value ? [h('dt', null, label), h('dd', null, value)] : null);
  const facts = [
    fact('🎁 Benefit', Str(o.benefit)),
    fact('📍 Where', Str(o.where)),
    o.until && d != null ? [h('dt', null, '⏳ Ends'), h('dd', { class: d <= 3 ? 'urgent' : '' }, endsText(o.until).replace(/^Ends /, ''))] : null,
    compact ? null : fact('📄 Terms', Str(o.terms)),
  ].filter(Boolean);
  const code = Str(o.code).trim();
  return h('div', { class: 'item' },
    h('div', { class: 'head' },
      kindChip(o.kind),
      compact ? chip(Str(o.card), 'grey') : null,
      o.community ? chip('👥 Community post — unverified', 'amber') : null,
      d != null ? null : o.deadline ? chip('⏳ Deadline', 'amber') : null),
    h('div', { class: 't' }, Str(o.title)),
    !o.benefit && o.detail ? h('div', { class: 'd' }, Str(o.detail)) : null,
    facts.length ? h('dl', { class: 'facts' }, facts) : null,
    code && !compact ? h('div', { class: 'code-row' }, h('span', { class: 'muted small' }, '🎟️ Code'),
      h('button', { class: 'code', type: 'button', 'aria-label': 'Copy promo code ' + code,
        onclick: async () => { const ok = await copyText(code); haptic(ok ? 'success' : 'error'); toast(ok ? 'Code copied' : 'Couldn’t copy — press and hold the code'); } },
      h('span', { class: 'code-t' }, code), icon('copy'), h('span', { class: 'cp' }, 'Copy'))) : null,
    code && compact ? h('div', { class: 'd' }, '🎟️ Has a promo code') : null,
    compact ? null : h('div', { class: 'foot' }, o.community ? srcLink(o.url, 'Unverified post') : srcLink(o.url), aiTag()));
}

function viewOffers(s) {
  const out = [];
  out.push(h('div', { class: 'banner blue' }, h('span', { class: 'em', 'aria-hidden': 'true' }, '🤖'),
    h('div', null, h('b', null, 'Leads, not promises.'), ' Arth’s AI scan found these — check the source before you act.')));

  out.push(sec('Conversions & upgrades', s.conversions.length));
  if (s.conversions.length) {
    const order = { 'worth-it': 0, 'worth-for-a-booking': 1, hold: 2, 'cannot-value': 3, 'not-worth-it': 4 };
    const convs = [...s.conversions].sort((a, b) => (order[a.verdict] ?? 5) - (order[b.verdict] ?? 5));
    out.push(h('div', { class: 'card list' }, convs.map(c => h('div', { class: 'item' },
      h('div', { class: 'head' }, verdictChip(c.verdict), kindChip(c.kind)),
      h('div', { class: 't' }, Str(c.title)),
      A(c.lines).length ? h('ul', { class: 'lines' }, A(c.lines).map(l => h('li', null, Str(l)))) : null,
      h('div', { class: 'foot' },
        c.until ? chip('⏳ until ' + fmtDate(c.until), daysUntil(c.until) <= 7 ? 'amber' : 'grey') : null,
        srcLink(c.url), aiTag())))));
  } else out.push(emptyCard('🔁', 'No conversions to judge', 'Transfer and upgrade verdicts appear here.'));

  const live = liveOffers(s);
  const ended = s.offers.length - live.length;
  out.push(sec('Offers by card', live.length));
  if (live.length) {
    const groups = new Map();
    for (const o of live) { const k = Str(o.card) || 'Any card'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o); }
    const rank = o => { const d = o.until ? daysUntil(o.until) : null; return d != null ? d : o.deadline ? 500 : 1000; };
    for (const [cardName, list] of groups) {
      list.sort((a, b) => rank(a) - rank(b));
      const soonest = Math.min(...list.map(rank));
      out.push(h('div', { class: 'card list' },
        h('div', { class: 'group-h' }, avatar(cardName, true), h('div', null, h('div', { class: 't' }, cardName),
          h('div', { class: 's' }, plural(list.length, 'lead') + (soonest < 500 ? ' · ⏳ next ends in ' + (soonest === 0 ? 'hours' : plural(soonest, 'day')) : soonest === 500 ? ' · ⏳ has deadlines' : '')))),
        list.map(o => offerItem(o, false))));
    }
  } else out.push(emptyCard('🏷️', 'No offers right now', 'New card offers show up here after Arth’s next scan.'));
  if (ended > 0) out.push(h('p', { class: 'note' }, '🗓️ ' + plural(ended, 'offer') + ' that already ended ' + (ended === 1 ? 'is' : 'are') + ' hidden.'));

  out.push(sec('Announced changes', s.changes.length));
  out.push(s.changes.length
    ? h('div', { class: 'card list' }, s.changes.map(c => h('div', { class: 'item' },
      h('div', { class: 'head' }, chip('📣 ' + (Str(c.card) || 'All cards'), 'violet'), c.effective ? chip('from ' + fmtDate(c.effective, { year: true }), daysUntil(c.effective) <= 30 ? 'amber' : 'grey') : null),
      h('div', { class: 't' }, Str(c.title)),
      h('div', { class: 'foot' }, srcLink(c.url), aiTag()))))
    : emptyCard('📰', 'No announced changes', 'Fee, reward or lounge changes to your cards land here.'));
  return out;
}

/* ---------------------------------------------------------------- Leaks */

function viewLeaks(s) {
  const lk = s.leaks;
  const out = [leakHeadline(s, false)];

  out.push(sec('Where a better card pays back', lk.upi.length));
  if (lk.upi.length) {
    const rows = [...lk.upi].sort((a, b) => (N(b.missedPaise) ?? 0) - (N(a.missedPaise) ?? 0));
    const nums = rows.some(r => N(r.spendPaise) != null || N(r.missedPaise) != null);
    const cols = { '--cols': nums ? 'minmax(0,1fr) auto auto' : 'minmax(0,1fr)' };
    const tbl = h('div', { class: 'card list tbl', role: 'table', 'aria-label': 'Places a card would have paid back' },
      h('div', { class: 'tr th', vars: cols, role: 'row' }, h('div', { role: 'columnheader' }, 'Place · best card'), nums ? h('div', { class: 'r', role: 'columnheader' }, 'Spent') : null, nums ? h('div', { class: 'r', role: 'columnheader' }, 'Back') : null),
      rows.map(r => h('div', { class: 'tr', vars: cols, role: 'row' },
        h('div', { class: 'c1', role: 'cell' },
          h('div', { class: 't' }, Str(r.label), r.upiOnly ? h('span', null, ' ', chip('UPI', 'violet')) : null),
          h('div', { class: 's' }, '→ ' + (Str(r.bestCard) || '—'))),
        nums ? h('div', { class: 'r num', role: 'cell' }, s_amount(r.spendPaise)) : null,
        nums ? h('div', { class: 'r num gain', role: 'cell' }, N(r.missedPaise) == null ? '—' : '+' + money(r.missedPaise)) : null)));
    if (!s.privacy && rows.some(r => N(r.missedPaise) != null)) {
      const spent = rows.reduce((a, r) => a + (N(r.spendPaise) ?? 0), 0);
      const back = rows.reduce((a, r) => a + (N(r.missedPaise) ?? 0), 0);
      tbl.append(h('div', { class: 'tr total', vars: cols, role: 'row' }, h('div', { role: 'cell' }, 'Total', h('div', { class: 's muted small' }, 'over the checked period')), h('div', { class: 'r num', role: 'cell' }, money(spent)), h('div', { class: 'r num gain', role: 'cell' }, '+' + money(back))));
    }
    out.push(tbl);
  } else out.push(emptyCard('🎯', 'No leaks found', 'Every place you spent already got your best card.'));
  const rangeBits = [];
  if (lk.savingsFrom && lk.savingsThrough) rangeBits.push(`Savings checked from ${fmtDate(lk.savingsFrom, { year: true })} to ${fmtDate(lk.savingsThrough, { year: true })}.`);
  if (lk.uncategorisedCount > 0) rangeBits.push(`${plural(lk.uncategorisedCount, 'transaction')} still uncategorised — tag them on your PC to sharpen this.`);
  if (rangeBits.length) out.push(h('p', { class: 'note' }, (lk.uncategorisedCount > 0 ? '🏷️ ' : '📅 ') + rangeBits.join(' ')));

  out.push(sec('Subscriptions & bills', lk.bills.length));
  if (lk.bills.length) {
    const CAD = { monthly: '/mo', quarterly: '/qtr', annual: '/yr' };
    const bills = [...lk.bills].sort((a, b) => (N(b.annualPaise) ?? 0) - (N(a.annualPaise) ?? 0));
    out.push(h('div', { class: 'card list' }, bills.map(b => {
      const rise = N(b.priceRiseFromPaise);
      const rose = b.priceRose === true || rise != null; // rise != null: older PC builds without priceRose
      return h('div', { class: 'row' },
        h('div', { class: 'emo', 'aria-hidden': 'true' }, catEmoji(b.label) === '💳' ? '🔁' : catEmoji(b.label)),
        h('div', { class: 'main' },
          h('div', { class: 't' }, Str(b.label)),
          h('div', { class: 's' }, b.bestCard ? '💳 Best: ' + Str(b.bestCard) : 'Any card — no better option'),
          rise != null ? h('div', { class: 's' }, 'was ' + money(rise) + ' per payment') : null,
          h('div', { class: 'chips' }, chip(Str(b.cadence) || '—', 'grey'),  rose ? chip('▲ price up', 'red') : null)),
        h('div', { class: 'end' },
          N(b.perPaymentPaise) == null ? null : h('div', { class: 'amt num' }, money(b.perPaymentPaise) + (CAD[b.cadence] || '')),
          h('div', { class: 'when num' }, N(b.annualPaise) == null ? '' : money(b.annualPaise) + ' a year')));
    })));
  } else out.push(emptyCard('🧾', 'No recurring bills spotted', 'Subscriptions and repeat bills will show here.'));

  out.push(sec('Spending spikes', lk.spikes.length));
  if (lk.spikes.length) {
    const spikes = [...lk.spikes].sort((a, b) => (N(b.pct) ?? 0) - (N(a.pct) ?? 0));
    const maxAmt = Math.max(1, ...spikes.flatMap(x => [N(x.paise) ?? 0, N(x.usualPaise) ?? 0]));
    const maxRatio = Math.max(1, ...spikes.map(x => 1 + (N(x.pct) ?? 0) / 100));
    const box = h('div', { class: 'card' });
    const bars = h('div', { class: 'bars' });
    spikes.forEach((x, i) => {
      const byAmt = N(x.paise) != null && N(x.usualPaise) != null;
      const now = byAmt ? N(x.paise) / maxAmt : (1 + (N(x.pct) ?? 0) / 100) / maxRatio;
      const usual = byAmt ? N(x.usualPaise) / maxAmt : 1 / maxRatio;
      const p = N(x.pct);
      bars.append(h('div', null,
        h('div', { class: 'bar-h' },
          h('span', { class: 't' }, catEmoji(x.category) + ' ' + Str(x.category)),
          p != null ? chip((p >= 0 ? '+' : '') + pct(p) + ' vs usual', p >= 50 ? 'red' : 'amber') : null),
        h('div', { class: 'bar-line' }, bar(now, 'amber', i * 2), h('div', { class: 'bar-v num' }, byAmt ? h('b', null, money(x.paise) + ' ') : null, fmtMonth(x.month).split(' ')[0])),
        h('div', { class: 'bar-line' }, bar(usual, 'grey', i * 2 + 1), h('div', { class: 'bar-v num' }, byAmt ? money(x.usualPaise) + ' ' : '', 'usual'))));
    });
    box.append(bars, h('div', { class: 'legend' },
      h('span', null, h('i', { vars: { background: '#f2a03a' } }), 'This month'),
      h('span', null, h('i', { vars: { background: 'var(--hint)', opacity: '.45' } }), 'Usual month')));
    out.push(box);
  } else out.push(emptyCard('🧊', 'No spending spikes', 'Every category is running at its usual pace.'));
  return out;
}

/* ---------------------------------------------------------------- More */

function viewMore(s) {
  const pending = pendingSorted(s);
  const owed = pending.reduce((a, r) => a + (N(r.amountPaise) ?? 0), 0);
  const urgent = pending.filter(r => r._days != null && r._days <= 3).length;
  const lk = s.leaks;
  const items = [
    ['due', '📅', 'Due', pending.length ? plural(pending.length, 'bill') + ' pending' + (owed && !s.privacy ? ' · ' + money(owed) : '') : 'Nothing pending', urgent ? chip(urgent + ' urgent', 'red') : null],
    ['leaks', '💧', 'Money leaks', (lk.annualRecoverablePaise ?? 0) > 0 ? money(lk.annualRecoverablePaise) + ' a year to recover' : lk.upi.length || lk.bills.length ? [lk.upi.length ? plural(lk.upi.length, 'place') : null, lk.bills.length ? plural(lk.bills.length, 'bill') : null].filter(Boolean).join(' · ') : 'Nothing leaking', null],
    ['statements', '📄', 'Statements', s.statements.length ? plural(s.statements.length, 'statement') + ' read' : 'None read yet', null],
    ['settings', '⚙️', 'Settings', 'Pairing, privacy, version', null],
  ];
  return [h('div', { class: 'card list menu' }, items.map(([id, em, t, sub, extra]) => tappable(h('div', { class: 'row' },
    h('div', { class: 'emo', 'aria-hidden': 'true' }, em),
    h('div', { class: 'main' }, h('div', { class: 't' }, t), h('div', { class: 's' }, sub)),
    h('div', { class: 'end-row' }, extra, icon('chev', 'chev'))), () => openSub(id), t))),
  h('p', { class: 'foot-note' }, 'Arth Mini App ' + APP_VERSION + ' · data from Arth ' + (s.version || '—'))];
}

/* ---------------------------------------------------------------- Cards: the playbook + calculator */

function viewCards(s) {
  if (s.playbook == null) {
    // An upload from before Arth 0.14: no playbook. Fall back to the simple best-card list.
    const out = [h('div', { class: 'banner grey' }, h('span', { class: 'em', 'aria-hidden': 'true' }, '⬆️'),
      h('div', null, h('b', null, 'The full playbook isn’t in this upload.'), ' Caps, switch points and the calculator arrive once Arth on your PC is 0.14 or newer.'))];
    out.push(sec('Best card by category', s.bestCard.length || null));
    out.push(s.bestCard.length ? bestCardList(s) : emptyCard('💳', 'No card advice yet', 'Once Arth knows where you spend, it ranks your cards here.'));
    return out;
  }
  if (!s.playbook.length) return [emptyCard('💳', 'No playbook yet', 'Once Arth sees where you spend, it tells you which card to use and when to switch.')];
  return [
    calculator(s.playbook),
    sec('Which card, and when', s.playbook.length),
    ...s.playbook.map(r => playCard(r, s.privacy)),
  ];
}
const nextOf = r => (r.next && typeof r.next === 'object' && r.next.card ? r.next : null);

function playCard(r, privacy) {
  const capSpend = N(r.capSpendPaise), left = N(r.spendLeftPaise), next = nextOf(r);
  const usedUp = capSpend != null && left != null && left <= 0;
  let meter = null;
  if (capSpend != null && capSpend > 0) {
    if (left != null) {
      const used = clamp(capSpend - left, 0, capSpend);
      const f = used / capSpend;
      meter = h('div', { class: 'meter' }, bar(f, usedUp ? 'red' : f > 0.8 ? 'amber' : 'green'),
        h('div', { class: 'meter-l num' }, h('span', null, money(used) + ' used'), h('b', { class: usedUp ? 'red' : '' }, usedUp ? 'Cap used up this month' : money(left) + ' left this month')));
    } else {
      meter = h('div', { class: 'meter' }, bar(0, 'grey'), h('div', { class: 'meter-l' }, h('span', null, 'This month’s use isn’t in yet')));
    }
  }
  const step1 = h('div', { class: 'step' + (usedUp ? ' done' : ' now') },
    h('div', { class: 'n', 'aria-hidden': 'true' }, usedUp ? '✓' : '1'),
    h('div', { class: 'main' },
      h('div', { class: 't' }, Str(r.card), r.family ? chip('👪 family card', 'violet') : null),
      h('div', { class: 's num' }, capSpend != null
        ? 'until ' + money(capSpend) + ' a month' + (N(r.capPaise) != null ? ' · max ' + money(r.capPaise) + ' back' : '')
        : r.capped === true ? 'until its monthly cap is reached' : privacy ? 'your first choice here' : 'no monthly cap')),
    h('div', { class: 'rate num' }, pct(r.ratePct)),
    meter);
  const step2 = next ? h('div', { class: 'step' + (usedUp ? ' now' : '') },
    h('div', { class: 'n', 'aria-hidden': 'true' }, '2'),
    h('div', { class: 'main' },
      h('div', { class: 't' }, Str(next.card)),
      h('div', { class: 's' }, usedUp ? 'use this for the rest of the month' : capSpend != null || r.capped === true ? 'then, once the cap is reached' : 'if the first card can’t be used')),
    h('div', { class: 'rate num' + (usedUp ? '' : ' dim') }, pct(next.ratePct))) : null;
  const gain = N(r.switchGainPaise);
  return h('div', { class: 'card play' },
    h('div', { class: 'play-h' }, h('div', { class: 'emo', 'aria-hidden': 'true' }, catEmoji(r.category)),
      h('div', { class: 'main' }, h('div', { class: 't' }, Str(r.category)),
        N(r.monthlySpendPaise) != null ? h('div', { class: 's num' }, 'You spend about ' + money(r.monthlySpendPaise) + ' a month here') : null)),
    step1, step2,
    gain != null && gain > 0 ? h('div', { class: 'gain-line' }, chip('＋' + money(gain) + ' a month', 'green'), h('span', null, 'kept by switching after the cap')) : null,
    A(r.conditions).length ? h('ul', { class: 'lines cond' }, A(r.conditions).map(c => h('li', null, Str(c)))) : null);
}

/** Typed text → paise. "2,000" → 200000. */
function parseAmount(text) {
  const n = parseFloat(Str(text).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n * 100), 1e12) : 0;
}
/** What `paise` earns: on the best card up to the room left under its cap, the rest on the next card. */
function estimateReward(r, paise) {
  const rate = N(r.ratePct) ?? 0;
  const next = nextOf(r);
  const nextRate = next ? N(next.ratePct) ?? 0 : 0;
  const room = N(r.spendLeftPaise) ?? N(r.capSpendPaise); // null = no limit known
  const onBest = room == null ? paise : clamp(room, 0, paise);
  let best = (onBest * rate) / 100;
  if (N(r.capPaise) != null) best = Math.min(best, r.capPaise);
  const rest = paise - onBest;
  return { rate, next, nextRate, onBest, rest, best, restBack: next ? (rest * nextRate) / 100 : 0, allNext: next ? (paise * nextRate) / 100 : null, assumedFresh: N(r.spendLeftPaise) == null && N(r.capSpendPaise) != null };
}
function calcResult(r, paise) {
  if (!r) return [];
  if (!paise) return [h('p', { class: 'est' }, 'Type an amount to see what each card gives back.')];
  const e = estimateReward(r, paise);
  const res = (cls, title, sub, value) => h('div', { class: 'res ' + cls },
    h('div', null, h('div', { class: 't' }, title), h('div', { class: 's num' }, sub)), h('div', { class: 'v num' }, value));
  const out = [];
  if (e.onBest > 0) {
    out.push(res('best', Str(r.card), pct(e.rate) + ' on ' + (e.rest > 0 ? 'the first ' + money(e.onBest) + ' — then the cap is reached' : money(e.onBest)), money(Math.round(e.best)) + ' back'));
  } else {
    out.push(res('off', Str(r.card), 'cap used up this month', '₹0'));
  }
  if (e.rest > 0 && e.next) out.push(res(e.onBest > 0 ? 'then' : 'best', (e.onBest > 0 ? 'then ' : '') + Str(e.next.card), pct(e.nextRate) + ' on ' + (e.onBest > 0 ? 'the other ' : '') + money(e.rest), money(Math.round(e.restBack)) + ' back'));
  const total = e.best + e.restBack;
  if (e.rest > 0 && e.next && e.onBest > 0) out.push(h('div', { class: 'res-total num' }, h('span', null, 'Together'), h('b', null, money(Math.round(total)) + ' back')));
  if (e.allNext != null && e.onBest > 0) {
    const diff = Math.round(total - e.allNext);
    out.push(h('p', { class: 'est num' }, 'All on ' + Str(e.next.card) + ' instead: ' + money(Math.round(e.allNext)) + ' back' + (diff > 0 ? ' — ' + money(diff) + ' less.' : '.')));
  }
  out.push(h('p', { class: 'est' }, (e.assumedFresh ? 'Assumes none of this month’s cap is used yet. ' : '') + 'Estimate — the bot’s /card gives the exact figure.'));
  return out;
}
function calculator(rows) {
  if (S.calc.i >= rows.length) S.calc.i = 0;
  const sel = h('select', { class: 'field sel', 'aria-label': 'Where are you spending?' }, rows.map((r, i) => h('option', { value: i }, Str(r.category))));
  sel.selectedIndex = S.calc.i;
  const inp = h('input', { class: 'field amt-in num', type: 'text', inputmode: 'decimal', autocomplete: 'off', maxlength: '10', placeholder: 'Amount', 'aria-label': 'Amount in rupees' });
  inp.value = S.calc.amt;
  const outEl = h('div', { class: 'calc-out', 'aria-live': 'polite' });
  const update = () => {
    S.calc.i = sel.selectedIndex; S.calc.amt = inp.value;
    outEl.replaceChildren(...calcResult(rows[S.calc.i], parseAmount(inp.value)));
  };
  sel.addEventListener('change', update);
  inp.addEventListener('input', update);
  const quick = h('div', { class: 'quick' }, [50000, 200000, 1000000].map(p => h('button', { type: 'button', class: 'chip grey', onclick: () => { inp.value = INR0.format(p / 100); update(); } }, money(p))));
  update();
  return h('div', { class: 'card calc' },
    h('div', { class: 'calc-h' }, h('span', { 'aria-hidden': 'true' }, '🧮'), h('b', null, 'What would this spend earn?')),
    h('div', { class: 'calc-row' }, h('div', { class: 'sel-wrap' }, sel, icon('chev')), h('div', { class: 'amt-wrap' }, inp)),
    quick, outEl);
}

/** Older uploads only: category → best card, rate, runner-up. */
function bestCardList(s) {
  const rows = [...s.bestCard].sort((a, b) => (N(b.ratePct) ?? -1) - (N(a.ratePct) ?? -1));
  const maxRate = Math.max(1, ...rows.map(r => N(r.ratePct) ?? 0));
  return h('div', { class: 'card list' }, rows.map((r, i) => h('div', { class: 'row' },
    h('div', { class: 'emo', 'aria-hidden': 'true' }, catEmoji(r.category)),
    h('div', { class: 'main' },
      h('div', { class: 't' }, Str(r.category)),
      h('div', { class: 's' }, h('b', null, Str(r.card))),
      h('div', { class: 's' }, [r.runnerUp ? 'Runner-up: ' + Str(r.runnerUp) : null, N(r.examplePaise) != null ? 'on a ' + money(r.examplePaise) + ' spend' : null].filter(Boolean).join(' · ') || ''),
      N(r.ratePct) != null ? h('div', { class: 'bt' }, bar(N(r.ratePct) / maxRate, 'green', i, true)) : null),
    h('div', { class: 'end' }, h('div', { class: 'rate num' + (N(r.ratePct) == null ? ' na' : '') }, pct(r.ratePct)), h('div', { class: 'when' }, 'back')))));
}

/* ---------------------------------------------------------------- Points: the planner + balances */

const PLAN_CAVEAT = 'Examples of scale, not quotes — award prices move, seats may not exist, transfers are one-way.';

function reachStatus(r) {
  if (r.status === 'can-book') {
    const n = N(r.units) ?? 0;
    if (n < 1) return ['✅ Can book', 'green'];
    return ['✅ ' + (r.unit ? n + ' × ' + Str(r.unit) : plural(n, r.bucket === 'flight' ? 'seat' : 'night')), 'green'];
  }
  if (r.status === 'close') return ['🟡 Close', 'amber'];
  return ['⚪ Far', 'grey'];
}
const perUnit = r => (r.unit ? 'per ' + Str(r.unit) : r.bucket === 'flight' ? 'a seat' : 'a night');
const perPoint = paise => '₹' + (paise / 100).toFixed(2);
function reachWhere(r) { return [Str(r.partner), r.cabin ? Str(r.cabin) : null, Str(r.region)].filter(Boolean).join(' · '); }
function viaLine(r) {
  const via = AO(r.via);
  if (!via.length) return null;
  const out = [];
  via.forEach((v, i) => { if (i) out.push(' + '); out.push(h('span', { class: 'via' }, Str(v.program) + ' ' + Str(v.ratio) + (v.secondary ? '†' : ''))); });
  return out;
}
function valueLine(r) {
  const lo = N(r.valueLoPaise), hi = N(r.valueHiPaise);
  if (lo == null && hi == null) return null;
  const a = lo ?? hi, b = hi ?? lo;
  return (a === b ? perPoint(a) : perPoint(a) + '–' + perPoint(b)) + ' for each of your points';
}
function multipleChip(r) {
  const m = N(r.multipleLo);
  if (m == null) return null;
  return m < 1 ? chip('worse than cash', 'red') : chip('at least ' + (Math.round(m * 10) / 10) + '× the cash', 'green');
}
function gapLine(r) {
  const short = N(r.shortBy) ?? 0;
  if (short <= 0) return null;
  let t = 'Short by ' + NUM.format(short) + ' points';
  if (N(r.gapSpendPaise) != null && r.gapCard) t += ' — about ' + money(r.gapSpendPaise) + ' more spend on ' + Str(r.gapCard);
  else if (r.gapCard) t += ' — earn them on ' + Str(r.gapCard);
  return t;
}
function reachFacts(r) {
  const via = viaLine(r), val = valueLine(r), mult = multipleChip(r), gap = gapLine(r);
  const rows = [
    via ? [h('dt', null, 'Using'), h('dd', null, via)] : null,
    val || mult ? [h('dt', null, 'Worth'), h('dd', null, val ? h('span', { class: 'num' }, val + ' ') : null, mult)] : null,
    gap ? [h('dt', null, 'Gap'), h('dd', { class: 'num' }, gap)] : null,
  ].filter(Boolean);
  return rows.length ? h('dl', { class: 'facts' }, rows) : null;
}

/** The goal: a ring (have ÷ need), what is short, and the spend that closes the gap. */
function goalCard(g, compact) {
  const have = N(g.havePoints) ?? 0, need = N(g.needPoints) ?? 0;
  const f = need > 0 ? clamp(have / need, 0, 1) : 0;
  const [st, tone] = reachStatus(g);
  const ringColor = { green: 'var(--green)', amber: 'var(--amber)', grey: 'var(--accent)' }[tone];
  const gap = gapLine(g);
  const card = h('div', { class: 'card goal' },
    h('div', { class: 'ring', vars: { '--p': Math.round(f * 100), '--rc': ringColor }, role: 'img', 'aria-label': Math.round(f * 100) + '% of the points needed' },
      h('div', null, h('div', { class: 'n num' }, Math.round(f * 100) + '%'), h('div', { class: 'u' }, 'there'))),
    h('div', { class: 'main' },
      h('div', { class: 't' }, Str(g.what)),
      h('div', { class: 's' }, reachWhere(g)),
      h('div', { class: 's num' }, h('b', null, NUM.format(have)), ' of ' + NUM.format(need) + ' points ' + perUnit(g)),
      h('div', { class: 'chips' }, chip(st, tone))));
  if (compact) { if (gap) card.append(h('div', { class: 'goal-more s num' }, gap)); }
  else { const facts = reachFacts(g); if (facts) card.append(h('div', { class: 'goal-more' }, facts)); }
  return card;
}

function reachCard(r, i) {
  const have = N(r.havePoints) ?? 0, need = N(r.needPoints) ?? 0;
  const [st, tone] = reachStatus(r);
  return h('div', { class: 'card reach' },
    h('div', { class: 'reach-h' },
      h('div', { class: 'emo', 'aria-hidden': 'true' }, r.bucket === 'flight' ? '✈️' : '🏨'),
      h('div', { class: 'main' }, h('div', { class: 't' }, Str(r.what)), h('div', { class: 's' }, reachWhere(r)), h('div', { class: 'chips' }, chip(st, tone)))),
    bar(need > 0 ? have / need : 0, tone === 'green' ? 'green' : tone === 'amber' ? 'amber' : 'violet', i),
    h('div', { class: 'meter-l num' }, h('span', null, 'You could hold ', h('b', null, NUM.format(have))), h('span', null, 'needs ' + NUM.format(need) + ' ' + perUnit(r))),
    reachFacts(r));
}

function balanceCards(s) {
  const out = [];
  const anyCash = s.points.some(p => N(p.cashPaise) != null);
  const totalCash = s.points.reduce((a, p) => a + (N(p.cashPaise) ?? 0), 0);
  const expiring = s.points.filter(p => p.expiresOn && daysUntil(p.expiresOn) <= 90).length;
  out.push(h('div', { class: 'stats' },
    stat(anyCash ? money(totalCash) : '—', 'Cash value', anyCash ? 'green' : ''),
    stat(String(s.points.length), 'Programmes'),
    stat(String(expiring), 'Expiring ≤ 90d', expiring ? 'amber' : '')));
  const useCash = s.points.every(p => N(p.cashPaise) != null) || (anyCash && !s.privacy);
  const max = Math.max(1, ...s.points.map(p => (useCash ? N(p.cashPaise) : N(p.points)) ?? 0));
  const sorted = [...s.points].sort((a, b) => (N(b.cashPaise) ?? -1) - (N(a.cashPaise) ?? -1) || (N(b.points) ?? 0) - (N(a.points) ?? 0));
  sorted.forEach((p, i) => {
    const exp = p.expiresOn ? daysUntil(p.expiresOn) : null;
    const expChip = p.expiresOn ? chip((exp != null && exp < 0 ? 'expired ' : '⌛ expires ') + fmtDate(p.expiresOn, { year: true }), exp != null && exp <= 60 ? 'red' : exp != null && exp <= 180 ? 'amber' : 'grey') : chip('No expiry rule', 'grey');
    const v = (useCash ? N(p.cashPaise) : N(p.points)) ?? 0;
    out.push(h('div', { class: 'card pts' },
      h('div', { class: 'top-row' },
        h('div', null, h('div', { class: 'name' }, Str(p.program)), h('div', { class: 'big num' }, NUM.format(N(p.points) ?? 0), h('small', null, 'pts'))),
        h('div', { class: 'end' }, h('div', { class: 'rate num' + (N(p.cashPaise) == null ? ' na' : '') }, N(p.cashPaise) == null ? (s.privacy ? '' : 'No cash route') : '≈ ' + money(p.cashPaise)), h('div', { class: 'muted small' }, N(p.cashPaise) == null ? '' : 'guaranteed cash'))),
      bar(v / max, 'violet', i),
      h('div', { class: 'meta' }, expChip, h('span', { class: 'muted small' }, 'as of ' + fmtDate(p.asOf)))));
  });
  return out;
}

function viewPoints(s) {
  const out = [];
  const pp = s.pointsPlan;
  if (pp == null) {
    out.push(h('div', { class: 'banner grey' }, h('span', { class: 'em', 'aria-hidden': 'true' }, '⬆️'),
      h('div', null, h('b', null, 'The planner isn’t in this upload.'), ' What your points can buy shows here once Arth on your PC is 0.14 or newer. Your balances are below.')));
  } else {
    out.push(h('div', { class: 'banner amber caveat', role: 'note' }, h('span', { class: 'em', 'aria-hidden': 'true' }, '🧭'),
      h('div', null, h('b', null, PLAN_CAVEAT), pp.kbChecked ? ' Rates last checked ' + fmtDate(pp.kbChecked, { year: true }) + '.' : '')));

    out.push(sec('Your goal'));
    out.push(pp.goal ? goalCard(pp.goal, false) : emptyCard('🎯', 'No goal set', 'Send /goal to the bot to see the list, then /goal and a number to track one. Its progress shows here.'));

    out.push(sec('Stays', pp.stays.length));
    if (pp.stays.length) pp.stays.forEach((r, i) => out.push(reachCard(r, i)));
    else out.push(emptyCard('🏨', 'No stays to show yet', 'As your points grow, hotel nights they could buy appear here.'));

    out.push(sec('Flights', pp.flights.length));
    if (pp.flights.length) pp.flights.forEach((r, i) => out.push(reachCard(r, i)));
    else out.push(emptyCard('✈️', 'No flights to show yet', 'Award seats your points could reach appear here.'));

    const all = [pp.goal, ...pp.stays, ...pp.flights].filter(Boolean);
    if (all.some(r => AO(r.via).some(v => v.secondary))) out.push(h('p', { class: 'note' }, '† ratio from a card site, not the issuer'));
  }

  out.push(sec('Balances', s.points.length));
  if (s.points.length) out.push(...balanceCards(s));
  else out.push(emptyCard('💠', 'No points programmes', 'Add balances in Arth on your PC and they’ll show here.'));
  return out;
}

function viewStatements(s) {
  if (!s.statements.length) return [emptyCard('📄', 'No statements read yet', 'When Arth reads a statement on your PC, it’s listed here.')];
  const rows = [...s.statements].sort((a, b) => Str(b.readOn).localeCompare(Str(a.readOn)));
  const cols = { '--cols': 'minmax(0,1fr) 56px 56px 40px' };
  const txns = rows.reduce((a, r) => a + (N(r.txns) ?? 0), 0);
  return [
    h('div', { class: 'stats' }, stat(String(rows.length), 'Statements'), stat(NUM.format(txns), 'Transactions'), stat(fmtDate(rows[0].readOn), 'Last read')),
    sec('Read so far'),
    h('div', { class: 'card list tbl', role: 'table', 'aria-label': 'Statements read' },
      h('div', { class: 'tr th', vars: cols, role: 'row' }, h('div', { role: 'columnheader' }, 'Card'), h('div', { class: 'r', role: 'columnheader' }, 'Closed'), h('div', { class: 'r', role: 'columnheader' }, 'Read'), h('div', { class: 'r', role: 'columnheader' }, 'Txns')),
      rows.map(r => h('div', { class: 'tr', vars: cols, role: 'row' },
        h('div', { class: 'c1', role: 'cell' }, h('div', { class: 't' }, Str(r.card)), h('div', { class: 's num' }, [r.dueDate ? 'due ' + fmtDate(r.dueDate) : null, N(r.amountPaise) != null ? money(r.amountPaise) : null].filter(Boolean).join(' · ') || '—')),
        h('div', { class: 'r num small', role: 'cell' }, r.closed ? fmtDate(r.closed) : '—'),
        h('div', { class: 'r num small', role: 'cell' }, fmtDate(r.readOn)),
        h('div', { class: 'r num strong', role: 'cell' }, String(N(r.txns) ?? '—'))))),
  ];
}

function viewSettings(s) {
  const kv = (k, v) => h('div', { class: 'kv' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  const k = S.key;
  const protection = !k ? '—'
    : k.backend == null ? 'Not saved — this browser has no safe key store'
      : k.state === 'legacy' ? 'Saved unwrapped — this browser has no IndexedDB'
        : 'Locked to this app on this phone';
  return [
    sec('Your data'),
    h('div', { class: 'card list' },
      kv('Last update', shownAt() ? fmtDateTime(shownAt()) : '—'),
      kv('Source', S.source ? S.source.label : '—'),
      h('div', { class: 'btn-row' }, h('button', { type: 'button', onclick: () => refresh({ manual: true }) }, icon('refresh'), 'Refresh now'))),

    sec('Privacy'),
    h('div', { class: 'card' },
      h('p', { class: 'para' }, s.privacy
        ? '🙈 Privacy mode is ON. Your PC leaves out every amount, so this app shows no rupee figures from your accounts.'
        : '👁️ Privacy mode is OFF. Amounts are included. Turn it on in Arth on your PC to send only dates, names and counts.'),
      h('p', { class: 'para' }, '🔒 Encrypted on your PC (AES-256-GCM); the key stays on this phone. GitHub stores only ciphertext, and the key is never sent to Telegram’s servers.'),
      h('p', { class: 'para' }, 'ℹ️ Telegram’s app and its script run this page, so they are trusted with what you see here — the same way your browser is.')),

    sec('Pairing'),
    h('div', { class: 'card list' },
      kv('Key stored in', k ? backendLabel(k.backend) : '—'),
      kv('Protection', protection),
      h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'danger', onclick: unpair }, '🔓 Forget key / unpair this phone'))),
    h('p', { class: 'note' }, 'The saved key is wrapped by a second key that only this app, on this phone, can use — another site or app reading the storage gets nothing usable. Unpairing deletes both, and the saved copy of your data. Your PC keeps everything.'),

    sec('About'),
    h('div', { class: 'card list' },
      kv('Mini App', APP_VERSION),
      kv('Arth on your PC', s.version || '—'),
      kv('Data format', 'v' + s.v),
      kv('Opened in', inTelegram() ? 'Telegram ' + Str(T().platform) + ' · Bot API ' + Str(T().version) : 'a web browser')),
  ];
}

async function unpair() {
  const ok = await confirmAction('Forget this key?', 'This phone will stop showing your data until you pair it with your PC again.', 'Forget key');
  if (!ok) return;
  await keyStore.clear();
  if (S.source && S.source.url) await clearCachedEnvelope(S.source.url);
  S.key = null; S.snap = null; S.env = null; S.tsAltered = false; S.sub = null; S.tab = 'home'; S.animated.clear();
  haptic('success');
  screenPair();
  toast('Key forgotten');
}

/* ================================================================ full screens */

function showScreen(node, kind) {
  S.screen = kind;
  $app.replaceChildren(h('main', { class: 'screen anim' }, node));
  window.scrollTo(0, 0);
  syncTelegramButtons();
}
function messageScreen({ art, tone, title, lead, actions = [], fine, kind = 'error' }) {
  const frag = document.createDocumentFragment();
  append(frag, [
    h('div', { class: 'art ' + (tone || ''), 'aria-hidden': 'true' }, art),
    h('h2', null, title),
    lead ? h('p', { class: 'lead' }, lead) : null,
    actions.length ? h('div', { class: 'actions' }, actions.map(a => h('button', { class: 'btn' + (a.secondary ? ' secondary' : ''), type: 'button', onclick: a.onclick }, a.label))) : null,
    fine ? h('p', { class: 'fine' }, fine) : null,
  ]);
  showScreen(frag, kind);
}
function screenLoading() {
  S.screen = 'loading';
  const sk = (hgt, mt = 10) => h('div', { class: 'skel', vars: { height: hgt + 'px', 'margin-top': mt + 'px' } });
  $app.replaceChildren(
    h('header', { class: 'top' }, h('div', { class: 'top-l' }, h('div', null, h('div', { class: 'kicker' }, fmtDate(isoToday(), { weekday: true })), h('h1', null, 'Arth')))),
    h('main', { class: 'view', 'aria-busy': 'true', 'aria-label': 'Loading' }, sk(178, 8), sk(18, 28), sk(92), sk(18, 28), sk(120)));
}

function screenWrongKey(e) {
  haptic('error');
  const rekeyed = e instanceof NewKeyError;
  messageScreen({
    kind: 'wrongkey', art: rekeyed ? '🔑' : '🔐', tone: 'red',
    title: rekeyed ? 'Your PC made a new key — pair again' : 'This key doesn’t open your data',
    lead: rekeyed
      ? 'Arth on your PC switched to a new key, so the one on this phone can’t open the latest summary. On your PC, open Arth → Settings → Mini App → Pair phone and scan the new QR.'
      : 'Your PC may have made a new key, or this phone was paired with a different PC. Pair again — nothing on your PC is affected.',
    actions: [
      { label: 'Pair again', onclick: async () => { await keyStore.clear(); S.key = null; S.snap = null; S.env = null; S.tsAltered = false; screenPair(); } },
      { label: 'Try again', secondary: true, onclick: () => boot() },
    ],
  });
}
function screenFetchError(e) {
  const st = e instanceof FetchError ? e.status : -1;
  const map = {
    404: ['📡', 'grey', 'No data uploaded yet', 'Your PC hasn’t put a summary online yet. Open Arth on your PC and turn on phone sync, then try again.'],
    403: ['⏳', 'grey', 'GitHub is busy', 'GitHub is rate-limiting this network for a few minutes. Try again shortly.'],
    429: ['⏳', 'grey', 'GitHub is busy', 'GitHub is rate-limiting this network for a few minutes. Try again shortly.'],
    0: ['📴', 'grey', 'You’re offline', 'Couldn’t reach GitHub, and there’s no saved copy on this phone yet.'],
  };
  const [art, tone, title, lead] = map[st] || ['⚠️', 'grey', 'Couldn’t load your data', 'GitHub answered with an error' + (st > 0 ? ' (' + st + ')' : '') + '. Try again in a moment.'];
  messageScreen({ art, tone, title, lead, actions: [{ label: 'Try again', onclick: () => boot() }, { label: 'Pair again', secondary: true, onclick: () => screenPair() }] });
}
function screenFormat(e) {
  messageScreen({
    art: '🧩', tone: 'grey', title: 'Can’t read this data',
    lead: 'The key worked, but the summary is in a format this Mini App doesn’t know. Reload to get the latest Mini App, or update Arth on your PC.',
    actions: [{ label: 'Reload', onclick: () => location.reload() }],
    fine: 'Details: ' + Str(e && e.message),
  });
}

/* ---------------------------------------------------------------- pairing */

function screenPair({ lost = false } = {}) {
  S.screen = 'pair';
  const tg = T();
  const canScan = inTelegram() && tgAtLeast('6.4') && tg && typeof tg.showScanQrPopup === 'function';
  const err = h('p', { class: 'form-err', role: 'alert', id: 'pair-err' });
  const status = h('div', { class: 'status-line', id: 'pair-status' }, 'Looking for your PC’s data…');
  const input = h('input', {
    class: 'field', type: 'text', id: 'pair-input', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
    placeholder: 'arth-key:…', 'aria-label': 'Pairing key from your PC', enterkeyhint: 'done',
  });
  const pairBtn = h('button', { class: 'btn', type: 'button', id: 'pair-btn', onclick: () => tryPair(input.value) }, 'Pair');
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryPair(input.value); });

  const frag = document.createDocumentFragment();
  append(frag, [
    h('div', { class: 'art', 'aria-hidden': 'true' }, '🔗'),
    h('h2', null, lost ? 'Pair this phone again' : 'Pair with your PC'),
    lost
      ? h('div', { class: 'banner amber lost', role: 'status' }, h('span', { class: 'em', 'aria-hidden': 'true' }, '🧹'),
        h('div', null, h('b', null, 'This phone can’t open its saved key any more.'), ' The app’s storage here was cleared, and the key is locked to it on purpose. One scan fixes it — nothing on your PC is affected.'))
      : h('p', { class: 'lead' }, 'One scan, once. The key goes from your PC’s screen to this phone and is never sent to Telegram’s servers.'),
    h('ol', { class: 'steps' },
      h('li', null, h('span', { class: 'n' }, '1'), h('span', null, 'On your PC, open Arth → Settings → Mini App → ', h('b', null, 'Pair phone'), '.')),
      h('li', null, h('span', { class: 'n' }, '2'), h('span', null, canScan ? 'Tap Scan below and point at the QR code.' : 'Copy the key under the QR code and paste it below.')),
      h('li', null, h('span', { class: 'n' }, '3'), h('span', null, 'Done. Your summary decrypts right here on this phone.'))),
    status,
    h('div', { class: 'actions' },
      canScan
        ? h('button', { class: 'btn', type: 'button', id: 'scan-btn', onclick: scanQr }, icon('scan'), 'Scan QR code')
        : h('p', { class: 'fine' }, 'QR scanning works when you open this from your Arth bot in Telegram.')),
    h('div', { class: 'or' }, canScan ? 'or paste the key' : 'paste the key'),
    h('div', { class: 'paste' }, input, pairBtn),
    err,
    h('p', { class: 'fine' }, '🔒 The key stays on this phone, locked to this app — never in Telegram’s cloud.'),
  ]);
  showScreen(frag, 'pair');
  probeForPairing();
}

/** On the pairing screen, show whether the PC has uploaded anything (readable without the key). */
async function probeForPairing() {
  const set = (text, ok) => { const el = document.getElementById('pair-status'); if (el) { el.textContent = text; el.classList.toggle('ok', !!ok); } };
  if (!S.source || S.source.error) { set(''); return; }
  try {
    const env = await fetchEnvelope(S.source);
    checkEnvelope(env);
    S.pendingEnv = env;
    set('✓ Found your PC’s encrypted data · updated ' + relTime(env.builtAt), true);
  } catch (e) {
    const cached = await loadCachedEnvelope(S.source.url);
    if (cached) { S.pendingEnv = cached; set('Offline — using the saved copy from ' + relTime(cached.builtAt)); }
    else set(e instanceof FetchError && e.status === 404 ? 'Your PC hasn’t uploaded anything yet — you can still pair now.' : 'Can’t reach GitHub right now — you can still pair.');
  }
}

function scanQr() {
  const tg = T();
  const err = document.getElementById('pair-err');
  try {
    tg.showScanQrPopup({ text: 'Scan the QR in Arth → Settings → Mini App → Pair phone' }, text => {
      const t = Str(text).trim();
      if (/^arth-key:/i.test(t)) { setTimeout(() => tryPair(t), 0); return true; }
      setTimeout(() => { haptic('error'); if (err) err.textContent = 'That QR code isn’t an Arth pairing code. Scan the one in Arth → Settings → Mini App → Pair phone.'; }, 0);
      return true;
    });
  } catch {
    if (err) err.textContent = 'Couldn’t open the scanner here — paste the key instead.';
  }
}

let pairing = false;
async function tryPair(text) {
  if (pairing) return;
  const err = document.getElementById('pair-err');
  const btn = document.getElementById('pair-btn');
  const field = document.getElementById('pair-input');
  const setErr = m => { if (err) err.textContent = m; if (m) haptic('error'); };
  const canon = parseKeyText(text);
  if (!canon) { setErr('That doesn’t look like an Arth key. It starts with “arth-key:” followed by 43 letters, digits, - or _.'); return; }
  setErr('');
  pairing = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  // The raw key exists only in this buffer, for the length of this function; it is zeroed in `finally`.
  const bytes = b64urlToBytes(canon);
  try {
    const k = await importPhoneKey(bytes);
    let env = null;
    if (S.source && !S.source.error) {
      try { env = await fetchEnvelope(S.source); } catch { env = S.pendingEnv || (await loadCachedEnvelope(S.source.url)); }
    }
    let snap = null;
    if (env) {
      try { snap = await decryptEnvelope(env, k); }
      catch (e) {
        if (e instanceof NewKeyError) { setErr('This isn’t the key your PC is using now. Open Arth → Settings → Mini App → Pair phone and scan the QR shown there.'); return; }
        if (e instanceof WrongKeyError) { setErr('This key doesn’t open your data. Make sure it’s the QR from your own PC’s Arth, shown just now.'); return; }
        snap = null; // format problems surface after pairing, with their own screen
      }
    }
    let backend;
    try { backend = await keyStore.save(bytes, k.kid); } catch (e) { setErr(Str(e.message)); return; }
    S.key = { key: k.key, kid: k.kid, backend, state: 'wrapped' };
    if (field) field.value = '';
    haptic('success');
    if (snap) {
      adopt(env, snap); S.tab = 'home'; S.sub = null;
      saveCachedEnvelope(S.source.url, env);
      render({ animate: true, top: true });
      toast(backend == null ? 'Paired for this visit' : 'Paired ✓ Key saved on this phone');
      refresh();
    } else {
      toast('Paired ✓');
      boot();
    }
  } finally {
    bytes.fill(0);
    pairing = false;
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = 'Pair'; }
  }
}

/* ================================================================ boot + refresh */

async function refresh({ manual = false } = {}) {
  if (S.fetching || !S.key || !S.source || S.source.error) return;
  S.fetching = true;
  updatePill();
  try {
    let env;
    try { env = await fetchEnvelope(S.source); }
    catch (e) {
      if (e instanceof FormatError) throw e;
      S.lastFetchAt = Date.now();
      if (S.snap) {
        const st = e.status;
        S.offline = st === 0 ? 'offline' : st === 404 ? 'missing' : st === 403 || st === 429 ? 'limited' : 'http';
        if (S.screen === 'app') render();
        if (manual) toast('Couldn’t refresh — showing saved copy');
        return;
      }
      if (S.cacheWrongKey) { screenWrongKey(S.cacheWrongKey); return; }
      screenFetchError(e);
      return;
    }
    S.lastFetchAt = Date.now();
    S.offline = null;
    if (S.snap && S.env && env.builtAt === S.env.builtAt && env.ct === S.env.ct) {
      if (S.screen === 'app') render();
      if (manual) toast('Already up to date');
      return;
    }
    const snap = await decryptEnvelope(env, S.key);
    const first = !S.snap;
    adopt(env, snap); S.cacheWrongKey = null;
    saveCachedEnvelope(S.source.url, env);
    render({ animate: first, top: first });
    if (manual) toast('Updated ✓');
  } catch (e) {
    if (e instanceof WrongKeyError) screenWrongKey(e);
    else if (e instanceof FormatError) { if (S.snap) toast('New data arrived in a format this app can’t read'); else screenFormat(e); }
    else if (!S.snap) screenFetchError(e);
  } finally {
    S.fetching = false;
    updatePill();
  }
}

function maybeRefresh() {
  if (S.screen === 'app' && Date.now() - S.lastFetchAt > 60000) refresh();
}

async function boot() {
  S.source = resolveSource();
  S.cacheWrongKey = null;
  if (S.source.error) {
    if (S.source.error === 'bad-override') {
      messageScreen({ art: '🧭', tone: 'grey', title: 'That data link isn’t allowed', lead: 'The ?data= address must be on this site or use https.' });
    } else {
      messageScreen({ art: '🧭', tone: 'grey', title: 'Open this from your Arth bot', lead: 'This page can’t tell where your data lives. Open it from the button in your Arth Telegram bot.' });
    }
    return;
  }
  if (!S.snap) screenLoading();
  // A key paired "for this visit only" (no safe store in this browser) lives in memory: keep it.
  if (!(S.key && S.key.backend == null)) S.key = await keyStore.load();
  if (!S.key) {
    if (sdkMissingInTelegram()) {
      // Opened from Telegram but its SDK failed to load: the key may be in Telegram storage we can't reach yet.
      messageScreen({ art: '📴', tone: 'grey', title: 'Telegram didn’t finish loading', lead: 'Part of Telegram’s Mini App kit couldn’t load, so your key can’t be read yet. Check your connection and try again.', actions: [{ label: 'Try again', onclick: () => location.reload() }] });
    } else screenPair({ lost: keyStore.lost });
    return;
  }

  if (!S.snap) {
    const cached = await loadCachedEnvelope(S.source.url);
    if (cached) {
      try {
        adopt(cached, await decryptEnvelope(cached, S.key));
        render({ animate: true, top: true });
      } catch (e) {
        if (e instanceof WrongKeyError) S.cacheWrongKey = e; // the fresh copy may still open — decide after fetching
      }
    }
  }
  await refresh();
}

/* ================================================================ go */

// Dev only: a fake Telegram.WebApp so the Telegram-only paths can be driven in a normal browser.
if (isLocalHost(location.hostname) && new URLSearchParams(location.search).has('mocktg')) await import('./dev/tg-mock.js');

initTelegram();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') maybeRefresh(); });
setInterval(() => {
  if (S.screen !== 'app') return;
  updatePill();
  const b = document.getElementById('banners');
  if (b) b.replaceWith(buildBanners());
}, 30000);
boot().catch(() => {
  messageScreen({ art: '⚠️', tone: 'grey', title: 'Something went wrong', lead: 'Arth couldn’t start. Try again.', actions: [{ label: 'Try again', onclick: () => location.reload() }] });
});
