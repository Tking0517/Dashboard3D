// BROWSER tab · in-panel private browser (one BrowserView per tab, owned
// by main). Lazy combo pane — app.js dynamically import()s this on the
// first BROWSER open. init() receives { playSfx, paintComboHeader }.
//
//   init(deps)   — one-time: build chrome, wire IPC, expose globals
//   activate()   — BROWSER tab shown: ensure inited, attach the view
//   deactivate() — BROWSER tab left: detach the view
let _ready = false;
let _activateImpl = null;
let _deactivateImpl = null;

export function init(deps) {
  if (_ready) return;
  _ready = true;
  const playSfx = deps?.playSfx;
  const paintComboHeader = deps?.paintComboHeader || (() => {});
  const comboPanel = document.querySelector('.panel-combo');

  // ── BROWSER pane ─────────────────────────────────────────────
  // Lightweight private browser. Each tab is a BrowserView in main (so
  // page rendering is reliable — the <webview> tag's shadow-DOM was
  // leaking <style>/<script> source text into the page on certain sites).
  // The renderer owns the chrome (tab strip, URL bar, splash, results)
  // and IPCs to main for navigation. A tab can be in three "modes":
  //   splash  → home screen with address + search inputs + stats
  //   results → hybrid SERP (DDG + Bing + Brave + Yahoo + Google,
  //             deduped + interleaved) as a web list, image grid, or
  //             video grid depending on the kind picker
  //   page    → the BrowserView is overlaying the stage with a real page
  // The BrowserView is positioned each time the stage's bounding rect
  // changes, and detached entirely when the user leaves the BROWSER tab.
  const browserTabstripEl = document.getElementById('browser-tabstrip');
  const browserNewTabBtn  = document.getElementById('browser-newtab-btn');
  const browserBackBtn    = document.getElementById('browser-back-btn');
  const browserForwardBtn = document.getElementById('browser-forward-btn');
  const browserReloadBtn  = document.getElementById('browser-reload-btn');
  const browserHomeBtn    = document.getElementById('browser-home-btn');
  const browserUrlEl      = document.getElementById('browser-url');
  const browserBookmarkBtn= document.getElementById('browser-bookmark-btn');
  const browserReaderBtn  = document.getElementById('browser-reader-btn');
  const browserDarkBtn    = document.getElementById('browser-dark-btn');
  const browserBookmarksEl= document.getElementById('browser-bookmarks');
  const browserBookmarksEmptyEl = document.getElementById('browser-bookmarks-empty');
  const browserStageEl    = document.getElementById('browser-stage');
  const browserStatusEl   = document.getElementById('browser-status');
  const browserSplashEl   = document.getElementById('browser-splash');
  const browserSplashAddrFormEl = document.getElementById('browser-splash-address-form');
  const browserSplashAddrEl     = document.getElementById('browser-splash-address');
  const browserSplashSearchFormEl = document.getElementById('browser-splash-search-form');
  const browserSplashSearchEl     = document.getElementById('browser-splash-search');
  const browserStatAdsEl    = document.getElementById('browser-stat-ads');
  const browserStatPopupsEl = document.getElementById('browser-stat-popups');
  const browserStatImagesEl = document.getElementById('browser-stat-images');
  const browserResultsEl     = document.getElementById('browser-results');
  const browserResultsListEl = document.getElementById('browser-results-list');
  const browserResultsGridEl = document.getElementById('browser-results-grid');
  const browserResultsLabel  = document.getElementById('browser-results-label');
  const browserResultsCount  = document.getElementById('browser-results-count');
  const browserResultsEmpty  = document.getElementById('browser-results-empty');
  const browserResultsLoadMoreEl = document.getElementById('browser-results-loadmore');

  const _browserState = { tabs: [], activeId: null, inited: false,
                          adsBlocked: 0, popupsBlocked: 0, imagesBlocked: 0,
                          bookmarks: [],
                          searchKind: 'web', inBrowserMode: false,
                          readerMode: false };
  window._browserState = _browserState; // for paintComboHeader's tab count

  function _browserNormalizeUrl(input) {
    const s = (input || '').trim();
    if (!s) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
    if (/^about:/i.test(s)) return s;
    if (/^[^\s/]+\.[^\s/]+/.test(s) && !/\s/.test(s)) return `https://${s}`;
    return null;
  }

  function _browserRenderSplashStats() {
    if (browserStatAdsEl)    browserStatAdsEl.textContent    = String(_browserState.adsBlocked || 0);
    if (browserStatPopupsEl) browserStatPopupsEl.textContent = String(_browserState.popupsBlocked || 0);
    if (browserStatImagesEl) browserStatImagesEl.textContent = String(_browserState.imagesBlocked || 0);
  }

  function _browserActiveTab() {
    return _browserState.tabs.find(t => t.id === _browserState.activeId) || null;
  }

  // Drive the stage's data-mode attribute. CSS uses it to show/hide the
  // splash and the results panel. When mode === 'page' both are hidden
  // and the native BrowserView shows through.
  function _browserApplyStageMode() {
    const t = _browserActiveTab();
    const mode = t ? t.mode : 'splash';
    browserStageEl.dataset.mode = mode;
    const shouldShowBv = !!(t && t.mode === 'page' && _browserState.inBrowserMode);
    // Send fresh bounds BEFORE activate, not after. Otherwise main
    // attaches the BrowserView with no bounds and Electron defaults to
    // "fill the BrowserWindow" — the embedded page paints over our
    // chrome until the debounced bounds message catches up.
    if (shouldShowBv) {
      try { window.dash?.browserTabBounds?.(_browserStageRectFraction()); } catch {}
    }
    try { window.dash?.browserTabActivate?.(shouldShowBv ? t.id : null); } catch {}
  }
  // Express the stage rect as fractions (0..1) of the dashboard viewport.
  // Wrinkle: an ancestor (.combo-body) has CSS `zoom: 1.2`, which scales
  // the stage's visual size but Chromium's getBoundingClientRect returns
  // the pre-zoom layout rect. Multiplying by the accumulated ancestor
  // zoom recovers the actual on-screen rect — without it, the BV lands
  // ~83% of the visible stage's size, leaving a black gap below/right.
  function _browserStageRectFraction() {
    let z = 1;
    for (let el = browserStageEl.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      const zv = parseFloat(window.getComputedStyle(el).zoom);
      if (zv && zv !== 1) z *= zv;
    }
    const r = browserStageEl.getBoundingClientRect();
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    return {
      x: (r.left   * z) / vw,
      y: (r.top    * z) / vh,
      width:  (r.width  * z) / vw,
      height: (r.height * z) / vh,
    };
  }

  function _browserUpdateChrome() {
    const t = _browserActiveTab();
    if (!t) {
      browserUrlEl.value = '';
      browserBackBtn.disabled = true;
      browserForwardBtn.disabled = true;
      browserBookmarkBtn.classList.remove('is-bookmarked');
      browserBookmarkBtn.disabled = true;
      browserStatusEl.textContent = 'NEW TAB';
      return;
    }
    const onPage = t.mode === 'page';
    const onResults = t.mode === 'results';
    // Keep the user's typed query visible when returning to a results
    // page so they don't have to re-type to refine — falls back to the
    // page URL on 'page' and empty on 'splash'.
    if (document.activeElement !== browserUrlEl) {
      browserUrlEl.value = onPage ? (t.url || '') : (onResults ? (t.query || '') : '');
    }
    // Back / forward are driven by our per-tab nav stack now. BV history
    // is irrelevant because the stack already includes every milestone +
    // every in-page link the user clicked.
    browserBackBtn.disabled    = !_navCanBack(t);
    browserForwardBtn.disabled = !_navCanFwd(t);
    const bookmarked = onPage && (_browserState.bookmarks || []).some(b => b.url === t.url);
    browserBookmarkBtn.classList.toggle('is-bookmarked', bookmarked);
    browserBookmarkBtn.disabled = !onPage;
    browserStatusEl.textContent = t.mode === 'splash' ? 'NEW TAB'
      : t.mode === 'results' ? `RESULTS · ${t.query || ''}`
      : (t.loading ? `LOADING · ${t.url}` : (t.url || 'READY'));
    paintComboHeader();
  }

  function _browserRenderTabStrip() {
    browserTabstripEl.querySelectorAll('.browser-tab').forEach(n => n.remove());
    for (const t of _browserState.tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'browser-tab' + (t.id === _browserState.activeId ? ' is-active' : '');
      btn.dataset.tabId = String(t.id);
      const titleSpan = document.createElement('span');
      titleSpan.className = 'browser-tab-title';
      titleSpan.textContent = t.title || 'NEW TAB';
      const closeBtn = document.createElement('span');
      closeBtn.className = 'browser-tab-close';
      closeBtn.textContent = '×';
      closeBtn.title = 'Close tab';
      btn.appendChild(titleSpan);
      btn.appendChild(closeBtn);
      btn.addEventListener('click', (e) => {
        if (e.target === closeBtn) { _browserCloseTab(t.id); return; }
        _browserActivateTab(t.id);
      });
      browserTabstripEl.insertBefore(btn, browserNewTabBtn);
    }
  }

  function _browserActivateTab(id) {
    _browserState.activeId = id;
    _browserRenderTabStrip();
    _browserUpdateChrome();
    _browserApplyStageMode();
    _browserRenderResults();
    // Audio-only mode is "sticky" across tab switches per the user's
    // request: switching tabs auto-enables it. _browserActivateAudioOnly
    // waits a tick so the BV has time to load + start the new video,
    // then snapshots state and swaps audio. If audio-only was already
    // on, we still re-trigger it for the new tab so the audio stream
    // matches the visible page.
    if (typeof _browserKickAudioOnly === 'function') _browserKickAudioOnly();
  }

  async function _browserCloseTab(id) {
    const idx = _browserState.tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    try { await window.dash?.browserTabClose?.(id); } catch {}
    _browserState.tabs.splice(idx, 1);
    if (_browserState.activeId === id) {
      const next = _browserState.tabs[idx] || _browserState.tabs[idx - 1] || null;
      _browserState.activeId = next ? next.id : null;
    }
    if (!_browserState.tabs.length) await _browserNewTab();
    else _browserActivateTab(_browserState.activeId);
  }

  async function _browserNewTab(url) {
    let backendId = null;
    try {
      const res = await window.dash?.browserTabCreate?.(url || null);
      backendId = res?.id ?? null;
    } catch {}
    if (backendId == null) return null;
    const tab = {
      id: backendId,
      url: url || '',
      title: 'NEW TAB',
      loading: !!url,
      canBack: false,
      canFwd: false,
      mode: url ? 'page' : 'splash',
      query: '',
      results: null,
      page: 1,
      hasMore: true,
      // Per-tab navigation stack: { type, url?, query?, kind?, results?, page?, hasMore? }
      // Back/forward step through this — BV's own history is no longer
      // consulted (it can't represent our app-level results/splash modes).
      nav: { stack: [], idx: -1 },
    };
    _navPush(tab, url ? { type: 'page', url } : { type: 'splash' });
    _browserState.tabs.push(tab);
    _browserActivateTab(backendId);
    return tab;
  }

  // ── Per-tab nav stack ──────────────────────────────────────────
  // Entries are app-level milestones (splash / results / page). Every
  // user-initiated state change pushes; every BV did-navigate event also
  // pushes (covers in-page link clicks). Back/forward simply walk the
  // stack and re-apply each entry's UI/BV state.
  //
  // _navRestoring is the dedupe guard: when we re-navigate the BV from a
  // back/forward restore, the BV fires did-navigate; that one event must
  // NOT push a duplicate entry. We mark the expected URL here and clear
  // it once the matching event arrives.
  const _navRestoring = new Map(); // tabId -> expected url

  function _navEntryEq(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === 'page')    return a.url === b.url;
    if (a.type === 'results') return a.query === b.query && a.kind === b.kind;
    if (a.type === 'splash')  return true;
    return false;
  }
  function _navPush(t, entry) {
    if (!t.nav) t.nav = { stack: [], idx: -1 };
    t.nav.stack = t.nav.stack.slice(0, t.nav.idx + 1);
    const last = t.nav.stack[t.nav.idx];
    if (last && _navEntryEq(last, entry)) return;
    t.nav.stack.push(entry);
    t.nav.idx = t.nav.stack.length - 1;
  }
  function _navCanBack(t) { return !!(t?.nav && t.nav.idx > 0); }
  function _navCanFwd(t)  { return !!(t?.nav && t.nav.idx < t.nav.stack.length - 1); }
  async function _navBack(t) {
    if (!_navCanBack(t)) return;
    t.nav.idx--;
    await _navApply(t, t.nav.stack[t.nav.idx]);
  }
  async function _navFwd(t) {
    if (!_navCanFwd(t)) return;
    t.nav.idx++;
    await _navApply(t, t.nav.stack[t.nav.idx]);
  }
  async function _navApply(t, entry) {
    if (!entry) return;
    if (entry.type === 'splash') {
      t.mode = 'splash';
      t.url = '';
      t.title = 'NEW TAB';
      t.loading = false;
      t.query = '';
      t.results = null;
    } else if (entry.type === 'results') {
      t.mode = 'results';
      t.query = entry.query || '';
      t.title = `${entry.kind === 'images' ? 'IMG · ' : entry.kind === 'videos' ? 'VID · ' : ''}${entry.query || ''}`;
      t.results = entry.results || null;
      t.page = entry.page || 1;
      t.hasMore = entry.hasMore !== false;
    } else if (entry.type === 'page') {
      t.mode = 'page';
      t.url = entry.url || '';
      t.title = entry.title || entry.url || '';
      t.loading = true;
      if (entry.url) {
        _navRestoring.set(t.id, entry.url);
        try { await window.dash?.browserTabNavigate?.(t.id, entry.url); } catch {}
      }
    }
    _browserRenderTabStrip();
    _browserUpdateChrome();
    _browserApplyStageMode();
    if (t.mode === 'results') _browserRenderResults();
  }

  async function _browserNavigateActive(url) {
    if (!url) return;
    let t = _browserActiveTab();
    if (!t) { t = await _browserNewTab(url); return; }
    t.mode = 'page';
    t.url = url;
    t.loading = true;
    // Mark the BV navigation as ours so the did-navigate echo doesn't
    // re-push, then push the milestone ourselves with proper metadata.
    _navRestoring.set(t.id, url);
    _navPush(t, { type: 'page', url });
    try { await window.dash?.browserTabNavigate?.(t.id, url); } catch {}
    _browserUpdateChrome();
    _browserApplyStageMode();
  }

  async function _browserSearchActive(query, kind) {
    const q = (query || '').trim();
    if (!q) return;
    let t = _browserActiveTab() || await _browserNewTab();
    if (!t) return;
    t.mode = 'results';
    t.query = q;
    t.title = `${kind === 'images' ? 'IMG · ' : kind === 'videos' ? 'VID · ' : ''}${q}`;
    t.page = 1;
    t.hasMore = true;
    t.results = { kind, items: [], loading: true };
    // Push milestone BEFORE the fetch so the back stack reflects intent
    // even mid-load. We update the entry's results snapshot once items
    // arrive below so a back-to-this-search restores the cached items.
    _navPush(t, { type: 'results', query: q, kind, results: t.results, page: 1, hasMore: true });
    _browserRenderTabStrip();
    _browserUpdateChrome();
    _browserApplyStageMode();
    _browserRenderResults();

    const res = await window.dash?.browserSearch?.(q, kind, 1);
    if (!res || !res.ok) {
      t.results = { kind, items: [], loading: false, error: res?.error || 'fetch failed' };
      _browserRenderResults();
      return;
    }
    // Web: main returns a { engine: rawHtml } map (DDG + Bing + Brave +
    // Yahoo + Google fanned out in parallel). We parse each engine here,
    // dedupe by canonical URL, then weave them by per-engine position
    // rank. Images & Videos: main does the vqd handshake + JSON parsing
    // and returns a ready items array.
    const items = (kind === 'images' || kind === 'videos')
      ? (Array.isArray(res.items) ? res.items : [])
      : _browserParseWebHybrid(res.html || {});
    t.results = { kind, items, loading: false, engineErrors: res.errors || {} };
    // If a fresh page-1 search returned nothing, there's no point
    // offering LOAD MORE.
    t.hasMore = items.length > 0;
    // Refresh the current milestone's snapshot so a future back-restore
    // gets the loaded items, not the in-flight placeholder.
    const cur = t.nav?.stack?.[t.nav.idx];
    if (cur && cur.type === 'results' && cur.query === q) {
      cur.results = t.results;
      cur.hasMore = t.hasMore;
    }
    _browserRenderResults();
  }

  // LOAD MORE — fetch the next page from every engine, parse + dedupe
  // against what's already shown, and append only the truly new entries.
  // When a page returns zero new hits, mark the tab as exhausted and hide
  // the button.
  async function _browserLoadMoreActive() {
    const t = _browserActiveTab();
    if (!t || t.mode !== 'results' || !t.results || t.results.loading) return;
    if (t.hasMore === false) return;
    const nextPage = (t.page || 1) + 1;
    t.results.loading = true;
    _browserRenderResults();

    const res = await window.dash?.browserSearch?.(t.query, t.results.kind, nextPage);
    if (!res || !res.ok) {
      t.results.loading = false;
      _browserRenderResults();
      return;
    }
    const incoming = (t.results.kind === 'images' || t.results.kind === 'videos')
      ? (Array.isArray(res.items) ? res.items : [])
      : _browserParseWebHybrid(res.html || {});
    const seen = new Set(t.results.items.map((it) => _canonicalUrl(it.url) || it.image || it.thumb));
    const fresh = [];
    for (const it of incoming) {
      const key = _canonicalUrl(it.url) || it.image || it.thumb;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      fresh.push(it);
    }
    t.results.items = t.results.items.concat(fresh);
    t.results.loading = false;
    t.page = nextPage;
    if (fresh.length === 0) t.hasMore = false;
    _browserRenderResults();
  }

  // Hybrid web parser — main fans out to several engines in parallel
  // and hands us back a { engineKey: rawHtml } map. We parse each with
  // engine-specific selectors, then weave them together by per-engine
  // position rank: each result's score is (idx + 0.5) / engineSize, so
  // an engine that returned 30 results spreads them evenly across the
  // 30 slots and an engine that returned 5 spreads them across the same
  // visible range. Sort by score → real mix throughout the list, no
  // "Brave block" at the bottom even when one engine returns way more
  // results than the others. Final dedupe by canonical URL collapses
  // overlap; sources chip shows every engine that surfaced it.
  function _browserParseWebHybrid(htmlByEngine) {
    const byEngine = {
      ddg:    htmlByEngine?.ddg    ? _parseDDG(htmlByEngine.ddg)       : [],
      bing:   htmlByEngine?.bing   ? _parseBing(htmlByEngine.bing)     : [],
      brave:  htmlByEngine?.brave  ? _parseBrave(htmlByEngine.brave)   : [],
      yahoo:  htmlByEngine?.yahoo  ? _parseYahoo(htmlByEngine.yahoo)   : [],
      google: htmlByEngine?.google ? _parseGoogle(htmlByEngine.google) : [],
    };
    const keys = Object.keys(byEngine);
    const annotated = [];
    for (let ki = 0; ki < keys.length; ki++) {
      const k = keys[ki];
      const list = byEngine[k];
      const len = list.length;
      if (!len) continue;
      for (let i = 0; i < len; i++) {
        annotated.push({ item: list[i], score: (i + 0.5) / len, eng: ki });
      }
    }
    // Stable score sort; ties break by engine declaration order so any
    // run of equal-score results still alternates engines.
    annotated.sort((a, b) => a.score - b.score || a.eng - b.eng);

    const seen = new Map();
    for (const { item: r } of annotated) {
      const key = _canonicalUrl(r.url);
      if (!key) continue;
      const existing = seen.get(key);
      if (existing) {
        for (const s of r.sources) if (!existing.sources.includes(s)) existing.sources.push(s);
        if ((r.snippet || '').length > (existing.snippet || '').length) existing.snippet = r.snippet;
        if (!existing.title && r.title) existing.title = r.title;
      } else {
        seen.set(key, { ...r, sources: [...r.sources] });
      }
    }
    return Array.from(seen.values());
  }

  function _canonicalUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      let path = u.pathname.replace(/\/+$/, '');
      const params = new URLSearchParams(u.search);
      for (const p of [...params.keys()]) {
        if (/^(utm_|fbclid|gclid|msclkid|mc_eid|mc_cid|_ga|yclid|igshid|si)$/i.test(p)) params.delete(p);
      }
      const search = params.toString();
      return `${host}${path}${search ? '?' + search : ''}`;
    } catch { return null; }
  }

  function _parseDDG(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      for (const el of doc.querySelectorAll('.result')) {
        const a = el.querySelector('.result__a');
        if (!a) continue;
        let href = a.getAttribute('href') || '';
        if (href.startsWith('//')) href = 'https:' + href;
        try {
          const u = new URL(href);
          const real = u.searchParams.get('uddg');
          if (real) href = decodeURIComponent(real);
        } catch {}
        const title   = (a.textContent || '').trim();
        const snippet = (el.querySelector('.result__snippet')?.textContent || '').trim();
        const display = (el.querySelector('.result__url')?.textContent || '').trim();
        if (title && href && /^https?:\/\//.test(href)) out.push({ title, url: href, snippet, display, sources: ['ddg'] });
      }
      return out;
    } catch { return []; }
  }

  function _parseBing(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      for (const el of doc.querySelectorAll('li.b_algo')) {
        const a = el.querySelector('h2 a');
        if (!a) continue;
        const href = a.getAttribute('href') || '';
        if (!/^https?:\/\//.test(href)) continue;
        const title = (a.textContent || '').trim();
        const snippet = (el.querySelector('.b_caption p, p')?.textContent || '').trim();
        const display = (el.querySelector('cite, .b_attribution')?.textContent || '').trim();
        if (title) out.push({ title, url: href, snippet, display: display || href, sources: ['bing'] });
      }
      return out;
    } catch { return []; }
  }

  function _parseBrave(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      // Brave's markup varies; cover a few generations of selectors.
      const containers = doc.querySelectorAll('[data-type="web"], .snippet.fdb, .snippet[data-pos]');
      for (const el of containers) {
        const a = el.querySelector('a.h, a.heading-serpresult, a[data-testid="result-title-a"], a.title, a[href^="http"]');
        if (!a) continue;
        const href = a.getAttribute('href') || '';
        if (!/^https?:\/\//.test(href)) continue;
        const title = (
          el.querySelector('.title, .heading, h3, h4')?.textContent ||
          a.textContent ||
          ''
        ).trim();
        const snippet = (el.querySelector('.snippet-description, .desc, .snippet-content')?.textContent || '').trim();
        const display = (el.querySelector('.netloc, cite, .snippet-url')?.textContent || '').trim();
        if (title) out.push({ title, url: href, snippet, display: display || href, sources: ['brave'] });
      }
      return out;
    } catch { return []; }
  }

  function _parseYahoo(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      for (const el of doc.querySelectorAll('div.algo, li.algo, div.algo-sr')) {
        const a = el.querySelector('h3 a, .compTitle a');
        if (!a) continue;
        let href = a.getAttribute('href') || '';
        // Yahoo wraps in r.search.yahoo.com/_ylt=…/RU=encoded-url/…/RK=…
        const ruMatch = href.match(/\/RU=([^/]+)\//);
        if (ruMatch) {
          try { href = decodeURIComponent(ruMatch[1]); } catch {}
        }
        if (!/^https?:\/\//.test(href)) continue;
        const title = (a.textContent || '').trim();
        const snippet = (el.querySelector('.compText p, .fz-ms, p')?.textContent || '').trim();
        if (title) out.push({ title, url: href, snippet, display: href, sources: ['yahoo'] });
      }
      return out;
    } catch { return []; }
  }

  function _parseGoogle(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      // Google's class names rotate every few months. Use structural
      // shape — a heading + a link to an external URL — rather than
      // brittle class hooks.
      const seenHere = new Set();
      for (const h3 of doc.querySelectorAll('h3')) {
        const a = h3.closest('a') || h3.parentElement?.querySelector('a[href]');
        if (!a) continue;
        let href = a.getAttribute('href') || '';
        if (href.startsWith('/url?')) {
          try {
            const u = new URL(href, 'https://www.google.com');
            const real = u.searchParams.get('q') || u.searchParams.get('url');
            if (real) href = real;
          } catch {}
        }
        if (!/^https?:\/\//.test(href)) continue;
        // Skip Google's own internal links.
        if (/(?:^|\.)google\.[a-z.]+$/.test(new URL(href).hostname)) continue;
        if (seenHere.has(href)) continue;
        seenHere.add(href);
        const title = (h3.textContent || '').trim();
        const container = h3.closest('div[data-hveid], div.g, div.MjjYud') || h3.parentElement;
        const snippet = (container?.querySelector('div.VwiC3b, span.aCOpRe, div[data-snc]')?.textContent || '').trim();
        if (title) out.push({ title, url: href, snippet, display: href, sources: ['google'] });
      }
      return out;
    } catch { return []; }
  }

  // (Image results are parsed in main: it does the DuckDuckGo vqd → i.js
  // JSON handshake and returns a flat items array, so the renderer does
  // not need its own image parser.)

  function _browserRenderResults() {
    const t = _browserActiveTab();
    if (!t || t.mode !== 'results') return;
    const r = t.results || { kind: 'web', items: [] };
    const isImages = r.kind === 'images';
    const isVideos = r.kind === 'videos';
    const isGrid   = isImages || isVideos;
    browserResultsEl.classList.toggle('is-images', isImages);
    browserResultsEl.classList.toggle('is-videos', isVideos);
    browserResultsListEl.hidden = isGrid;
    browserResultsGridEl.hidden = !isGrid;
    browserResultsLabel.textContent =
      (isVideos ? 'VIDEOS · ' : isImages ? 'IMAGES · ' : 'RESULTS · ') + t.query;
    // Sync the filter-chip row so the active kind reflects the result
    // kind we're actually showing. Without this the chip can drift out
    // of step with the data when results were loaded from a saved tab
    // or via a kind-specific deep link.
    for (const b of document.querySelectorAll('.browser-results-filter')) {
      b.classList.toggle('is-active', b.dataset.kind === r.kind);
    }
    if (r.loading && r.items.length === 0) {
      // Fresh search — show "SEARCHING…" while page 1 is in flight.
      browserResultsCount.textContent = 'SEARCHING…';
      browserResultsListEl.innerHTML = '';
      browserResultsGridEl.innerHTML = '';
      browserResultsEmpty.hidden = true;
      browserResultsLoadMoreEl.hidden = true;
      return;
    }
    if (r.error && r.items.length === 0) {
      browserResultsCount.textContent = 'ERROR';
      browserResultsEmpty.hidden = false;
      browserResultsEmpty.textContent = r.error.toUpperCase();
      browserResultsListEl.innerHTML = '';
      browserResultsGridEl.innerHTML = '';
      browserResultsLoadMoreEl.hidden = true;
      return;
    }
    browserResultsCount.textContent = `${r.items.length} HIT${r.items.length === 1 ? '' : 'S'}`
      + (t.page > 1 ? ` · PAGE ${t.page}` : '');
    browserResultsEmpty.hidden = r.items.length > 0;
    if (!r.items.length) browserResultsEmpty.textContent = 'NO RESULTS';
    // LOAD MORE: hidden when empty, when last fetch returned no new
    // unique results, or while a load-more request is in flight.
    browserResultsLoadMoreEl.hidden = !r.items.length || t.hasMore === false;
    browserResultsLoadMoreEl.disabled = !!r.loading;
    browserResultsLoadMoreEl.textContent = r.loading ? 'LOADING…' : 'LOAD MORE';

    if (isGrid) {
      browserResultsGridEl.innerHTML = '';
      for (const it of r.items) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = isVideos ? 'browser-result-img browser-result-vid' : 'browser-result-img';
        cell.title = it.title ? `${it.title}\n${it.url}` : it.url;
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = it.thumb;
        img.referrerPolicy = 'no-referrer';
        cell.appendChild(img);
        if (isVideos) {
          // Play-triangle hint + duration in bottom-right; title gradient
          // overlay along the bottom edge so the source is scannable
          // without hovering.
          const play = document.createElement('span');
          play.className = 'browser-result-vid-play';
          play.textContent = '▶';
          cell.appendChild(play);
          if (it.duration) {
            const dur = document.createElement('span');
            dur.className = 'browser-result-vid-duration';
            dur.textContent = it.duration;
            cell.appendChild(dur);
          }
          if (it.title) {
            const titleEl = document.createElement('div');
            titleEl.className = 'browser-result-vid-title';
            titleEl.textContent = it.title;
            cell.appendChild(titleEl);
          }
        }
        cell.addEventListener('click', (e) => {
          // Videos: always navigate to the source page.
          // Images: left-click → source page, shift/middle → raw image.
          let target = it.url;
          if (isImages && (e.shiftKey || e.button === 1)) target = it.image || it.url;
          _browserNavigateActive(target);
        });
        browserResultsGridEl.appendChild(cell);
      }
    } else {
      browserResultsListEl.innerHTML = '';
      for (const it of r.items) {
        const li = document.createElement('li');
        li.className = 'browser-result';
        // Title row: optional source-count chip + clickable title.
        const titleRow = document.createElement('div');
        titleRow.className = 'browser-result-titlerow';
        const sources = it.sources || [];
        if (sources.length > 0) {
          const chip = document.createElement('span');
          chip.className = 'browser-result-chip';
          chip.textContent = sources.length > 1 ? `${sources.length}×` : sources[0].toUpperCase();
          chip.title = sources.join(' · ');
          if (sources.length > 1) chip.classList.add('is-multi');
          titleRow.appendChild(chip);
        }
        const a = document.createElement('a');
        a.className = 'browser-result-title';
        a.href = '#';
        a.textContent = it.title;
        a.addEventListener('click', (ev) => { ev.preventDefault(); _browserNavigateActive(it.url); });
        titleRow.appendChild(a);
        const url = document.createElement('div');
        url.className = 'browser-result-url';
        url.textContent = it.display || it.url;
        const snip = document.createElement('div');
        snip.className = 'browser-result-snippet';
        snip.textContent = it.snippet || '';
        li.appendChild(titleRow);
        li.appendChild(url);
        if (it.snippet) li.appendChild(snip);
        browserResultsListEl.appendChild(li);
      }
    }
  }

  function _browserRenderBookmarks() {
    const list = _browserState.bookmarks || [];
    browserBookmarksEl.querySelectorAll('.browser-bookmark').forEach(n => n.remove());
    browserBookmarksEmptyEl.hidden = list.length > 0;
    for (const bm of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'browser-bookmark';
      btn.textContent = bm.title || bm.url;
      btn.title = bm.url;
      btn.addEventListener('click', () => _browserNavigateActive(bm.url));
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        _browserState.bookmarks = list.filter(b => b !== bm);
        window.dash?.setConfig?.({ browserBookmarks: _browserState.bookmarks });
        _browserRenderBookmarks();
        _browserUpdateChrome();
      });
      browserBookmarksEl.appendChild(btn);
    }
  }

  function _browserGoHome() {
    const t = _browserActiveTab();
    if (!t) { _browserNewTab(); return; }
    _navPush(t, { type: 'splash' });
    _navApply(t, { type: 'splash' });
    setTimeout(() => browserSplashAddrEl?.focus(), 30);
  }

  // Geometry sync. The BrowserView lives in the main-process window
  // layer; the renderer tells main where the stage is on screen each
  // time the layout shifts. ResizeObserver covers panel-resize drags;
  // window 'resize' covers viewport / DPI changes.
  let _bvBoundsTimer = null;
  let _bvLastSent = null;
  function _browserSendBounds() {
    if (_bvBoundsTimer) return;
    _bvBoundsTimer = setTimeout(() => {
      _bvBoundsTimer = null;
      if (!_browserState.inBrowserMode) return;
      const t = _browserActiveTab();
      if (!t || t.mode !== 'page') return;
      // Dedup: the 500 ms heartbeat fires whether or not anything moved.
      // Comparing to the last-sent rect (with a half-pixel tolerance to
      // ignore subpixel jitter from layout flushes) skips the IPC ping +
      // native setBounds call when the page is just sitting still.
      const r = _browserStageRectFraction();
      if (_bvLastSent
        && Math.abs(r.x      - _bvLastSent.x)      < 0.0005
        && Math.abs(r.y      - _bvLastSent.y)      < 0.0005
        && Math.abs(r.width  - _bvLastSent.width)  < 0.0005
        && Math.abs(r.height - _bvLastSent.height) < 0.0005) {
        return;
      }
      _bvLastSent = r;
      try { window.dash?.browserTabBounds?.(r); } catch {}
    }, 16);
  }
  try {
    new ResizeObserver(_browserSendBounds).observe(browserStageEl);
  } catch {}
  // Catch the panel being dragged: drag updates panel.style.left/top
  // directly, which fires no resize event, so ResizeObserver alone
  // leaves the BrowserView stranded at its old screen coordinates.
  // Watching attribute mutations on the panel + its parent stack covers
  // drag, fold, layout-recall, and saved-layout restore.
  try {
    const mo = new MutationObserver(_browserSendBounds);
    mo.observe(comboPanel, { attributes: true, attributeFilter: ['style', 'class'] });
    if (comboPanel.parentElement) {
      mo.observe(comboPanel.parentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    }
  } catch {}
  window.addEventListener('resize', _browserSendBounds);
  window.addEventListener('scroll', _browserSendBounds, true);
  // Also re-sync on mouseup as a belt-and-suspenders: ends a drag even if
  // the final mousemove didn't tick a mutation observer.
  window.addEventListener('mouseup', _browserSendBounds);
  // Heartbeat: re-measure every 500 ms while a page tab is showing in
  // the BROWSER pane. Cheap, and recovers from any layout shift our
  // observers happened to miss (saved-layout restores, side-arrange
  // recalcs, parent-style mutations on a non-watched ancestor, etc.).
  setInterval(() => {
    if (!_browserState.inBrowserMode) return;
    const t = _browserActiveTab();
    if (!t || t.mode !== 'page') return;
    _browserSendBounds();
  }, 500);

  // Exposed for paintComboHeader (tab count) and any external re-layout.
  // activate()/deactivate() below drive the attach/detach signaling.
  window._browserApplyStageMode = _browserApplyStageMode;

  async function initBrowserOnce() {
    if (_browserState.inited) return;
    _browserState.inited = true;
    const cfg = await window.dash?.getConfig?.() || {};
    _browserState.bookmarks = Array.isArray(cfg.browserBookmarks) ? cfg.browserBookmarks : [];
    _browserState.readerMode = !!cfg.browserReaderMode;
    _browserRenderBookmarks();
    // Sync reader-mode to main so the webRequest handler matches the
    // persisted state from the moment the user enters the BROWSER pane.
    try { window.dash?.browserSetReaderMode?.(_browserState.readerMode); } catch {}
    browserReaderBtn?.classList.toggle('is-active', _browserState.readerMode);
    // Dark-mode default ON unless the user has explicitly turned it off.
    _browserState.darkMode = cfg.browserDarkMode !== false;
    try { window.dash?.browserSetDarkMode?.(_browserState.darkMode); } catch {}
    browserDarkBtn?.classList.toggle('is-active', _browserState.darkMode);
    try {
      const stats = await window.dash?.browserGetStats?.();
      if (stats && typeof stats.adsBlocked    === 'number') _browserState.adsBlocked    = stats.adsBlocked;
      if (stats && typeof stats.imagesBlocked === 'number') _browserState.imagesBlocked = stats.imagesBlocked;
    } catch {}
    _browserRenderSplashStats();
    // Lazy BrowserView allocation: we used to call _browserNewTab() here,
    // which spawned a fresh Chromium renderer process (its own GPU
    // context) at app launch even when the user was only looking at the
    // splash. Combined with the 3D scene init, audio worker, LHM probes,
    // and sensor-panel renders, that added up to the GPU spike on cold
    // start that tripped the emergency-temperature panel red. The
    // BrowserView is now created on first real navigation instead —
    // _browserSearchActive / _browserNavigateActive / + new tab.
    setTimeout(() => browserSplashAddrEl?.focus(), 50);
  }

  // Subscribe to BrowserView lifecycle events from main and reflect them
  // into our local tab state. Each event carries the backend tab id.
  try {
    window.dash?.onBrowserTabEvent?.((data) => {
      if (!data || data.id == null) return;
      const t = _browserState.tabs.find(x => x.id === data.id);
      if (!t) return;
      if (data.type === 'navigate') {
        t.url = data.url || t.url;
        t.mode = 'page';
        // Push to nav stack — unless this navigation is the BV echoing
        // a load we already pushed (back/forward restore, or a fresh
        // URL bar navigation we pushed eagerly above).
        const expecting = _navRestoring.get(t.id);
        if (expecting && (expecting === data.url || expecting === t.url)) {
          _navRestoring.delete(t.id);
        } else if (data.url) {
          _navPush(t, { type: 'page', url: data.url });
        }
        _browserUpdateChrome();
      } else if (data.type === 'title') {
        t.title = data.title || t.title;
        _browserRenderTabStrip();
        _browserUpdateChrome();
      } else if (data.type === 'loading') {
        t.loading  = !!data.loading;
        if (typeof data.canBack === 'boolean') t.canBack = data.canBack;
        if (typeof data.canFwd  === 'boolean') t.canFwd  = data.canFwd;
        _browserUpdateChrome();
      } else if (data.type === 'newwindow') {
        // Main already navigated the current view to the new URL — no
        // tab spawning here. We still tally these as "popups blocked"
        // since the page intended a separate window.
        _browserState.popupsBlocked++;
        _browserRenderSplashStats();
      } else if (data.type === 'fail') {
        // Silent; URL bar still shows last attempted address.
      }
    });
  } catch {}

  browserResultsLoadMoreEl?.addEventListener('click', () => _browserLoadMoreActive());
  browserNewTabBtn?.addEventListener('click', () => _browserNewTab());
  browserBackBtn?.addEventListener('click', () => {
    const t = _browserActiveTab();
    if (!t) return;
    _navBack(t);
  });
  browserForwardBtn?.addEventListener('click', () => {
    const t = _browserActiveTab();
    if (!t) return;
    _navFwd(t);
  });
  browserReloadBtn?.addEventListener('click',  () => {
    const t = _browserActiveTab();
    if (!t) return;
    if (t.mode === 'page')    window.dash?.browserTabReload?.(t.id);
    else if (t.mode === 'results' && t.query) _browserSearchActive(t.query, t.results?.kind || 'web');
  });
  browserHomeBtn?.addEventListener('click', _browserGoHome);
  // Reader mode — image blocking on/off. We persist the choice and tell
  // main to update its webRequest filter. Reload the current page so the
  // new policy actually takes effect on this view (already-loaded images
  // stay cached; blocking only applies to fresh requests).
  browserReaderBtn?.addEventListener('click', () => {
    _browserState.readerMode = !_browserState.readerMode;
    browserReaderBtn.classList.toggle('is-active', _browserState.readerMode);
    window.dash?.setConfig?.({ browserReaderMode: _browserState.readerMode });
    window.dash?.browserSetReaderMode?.(_browserState.readerMode);
    const t = _browserActiveTab();
    if (t && t.mode === 'page') {
      // Force a fresh load — plain reload() would happily serve the same
      // images from the memory cache, which means the new image-block
      // filter would never see those requests.
      try { window.dash?.browserTabReloadFresh?.(t.id); } catch {}
    }
  });
  // Dark mode — insert/remove an invert CSS overlay on every BrowserView.
  // No reload needed; main does insertCSS/removeInsertedCSS at runtime so
  // the toggle is instant.
  browserDarkBtn?.addEventListener('click', async () => {
    _browserState.darkMode = !_browserState.darkMode;
    browserDarkBtn.classList.toggle('is-active', _browserState.darkMode);
    try { await window.dash?.browserSetDarkMode?.(_browserState.darkMode); } catch {}
    playSfx?.('click');
  });
  browserUrlEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const url = _browserNormalizeUrl(browserUrlEl.value);
    if (url) { _browserNavigateActive(url); browserUrlEl.blur(); }
    else if (browserUrlEl.value.trim()) {
      _browserSearchActive(browserUrlEl.value.trim(), _browserState.searchKind);
      browserUrlEl.blur();
    }
  });
  browserUrlEl?.addEventListener('focus', () => { browserUrlEl.select(); });
  browserBookmarkBtn?.addEventListener('click', () => {
    const t = _browserActiveTab();
    if (!t || t.mode !== 'page' || !t.url) return;
    const list = _browserState.bookmarks || [];
    const existing = list.findIndex(b => b.url === t.url);
    if (existing >= 0) list.splice(existing, 1);
    else list.push({ url: t.url, title: t.title || t.url });
    _browserState.bookmarks = list;
    window.dash?.setConfig?.({ browserBookmarks: list });
    _browserRenderBookmarks();
    _browserUpdateChrome();
  });

  // ── History overlay + clear-data ─────────────────────────────────
  // History uses the same stage-overlay pattern as splash/results: set
  // browserStageEl.dataset.mode = 'history', detach the BrowserView so
  // the native paint surface clears, and the CSS reveals the HTML list.
  // Close just re-runs _browserApplyStageMode which restores the
  // active tab's actual mode + re-attaches the BV if appropriate.
  const browserHistoryBtn        = document.getElementById('browser-history-btn');
  const browserHistoryListEl     = document.getElementById('browser-history-list');
  const browserHistoryEmptyEl    = document.getElementById('browser-history-empty');
  const browserHistoryCloseBtn   = document.getElementById('browser-history-close-btn');
  const browserHistoryClearBtn   = document.getElementById('browser-history-clear-btn');
  const browserClearBtn          = document.getElementById('browser-clear-btn');

  function _fmtHistoryTime(ts) {
    if (!Number.isFinite(ts)) return '';
    const d = new Date(ts);
    const sameDay = d.toDateString() === new Date().toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return sameDay
      ? time
      : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
  }

  async function _browserRenderHistory() {
    if (!browserHistoryListEl) return;
    const entries = (await window.dash?.browserHistoryGet?.(200)) || [];
    browserHistoryListEl.innerHTML = '';
    if (browserHistoryEmptyEl) browserHistoryEmptyEl.hidden = entries.length > 0;
    for (const e of entries) {
      const li = document.createElement('li');
      const ts    = document.createElement('div'); ts.className    = 'h-ts';    ts.textContent    = _fmtHistoryTime(e.ts);
      const title = document.createElement('div'); title.className = 'h-title'; title.textContent = e.title || e.url;
      const url   = document.createElement('div'); url.className   = 'h-url';   url.textContent   = e.url;
      li.append(ts, title, url);
      li.addEventListener('click', () => {
        // Use the current tab if there is one, otherwise spawn a new one.
        const t = _browserActiveTab() || null;
        _browserCloseHistory();
        if (t) {
          window.dash?.browserTabNavigate?.(t.id, e.url);
          t.mode = 'page'; t.url = e.url;
          _browserApplyStageMode();
        } else {
          _browserNewTab(e.url);
        }
      });
      browserHistoryListEl.appendChild(li);
    }
  }

  function _browserOpenHistory() {
    if (browserStageEl.dataset.mode === 'history') return;
    browserStageEl.dataset.mode = 'history';
    // Detach every BrowserView so the HTML overlay paints (BVs are
    // native windows and otherwise render over our DOM).
    try { window.dash?.browserTabActivate?.(null); } catch {}
    _browserRenderHistory();
  }
  function _browserCloseHistory() {
    if (browserStageEl.dataset.mode !== 'history') return;
    _browserApplyStageMode();   // restores the active tab's real mode + BV
  }

  browserHistoryBtn?.addEventListener('click', _browserOpenHistory);
  browserHistoryCloseBtn?.addEventListener('click', _browserCloseHistory);
  browserHistoryClearBtn?.addEventListener('click', async () => {
    try { await window.dash?.browserHistoryClear?.(); } catch {}
    _browserRenderHistory();
    playSfx?.('confirm');
  });

  // ── Bookmarks overlay ────────────────────────────────────────────
  // The inline bookmarks bar (.browser-bookmarks below the navrow) is
  // fine for quick clicks but cramped when you have many entries —
  // overflow-x: auto means anything past the first few scrolls off
  // horizontally. The Bookmarks button on the navrow opens this full
  // overlay so every saved page is listed vertically with title, URL,
  // and a × remove button per row. Same pattern as the history overlay.
  const browserBookmarksBtn       = document.getElementById('browser-bookmarks-btn');
  const browserBookmarksListEl    = document.getElementById('browser-bookmarks-list');
  const browserBookmarksEmpty2El  = document.getElementById('browser-bookmarks-panel-empty');
  const browserBookmarksCloseBtn  = document.getElementById('browser-bookmarks-close-btn');

  function _browserRenderBookmarksOverlay() {
    if (!browserBookmarksListEl) return;
    const list = _browserState.bookmarks || [];
    browserBookmarksListEl.innerHTML = '';
    if (browserBookmarksEmpty2El) browserBookmarksEmpty2El.hidden = list.length > 0;
    for (const bm of list) {
      const li = document.createElement('li');
      const title = document.createElement('div'); title.className = 'h-title'; title.textContent = bm.title || bm.url;
      const url   = document.createElement('div'); url.className   = 'h-url';   url.textContent   = bm.url;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'h-remove';
      remove.textContent = '×';
      remove.title = 'Remove bookmark';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = (_browserState.bookmarks || []).filter(b => b !== bm);
        _browserState.bookmarks = next;
        window.dash?.setConfig?.({ browserBookmarks: next });
        _browserRenderBookmarks();
        _browserRenderBookmarksOverlay();
        _browserUpdateChrome();
        playSfx?.('click');
      });
      li.append(title, url, remove);
      li.addEventListener('click', () => {
        const t = _browserActiveTab() || null;
        _browserCloseBookmarksOverlay();
        if (t) {
          window.dash?.browserTabNavigate?.(t.id, bm.url);
          t.mode = 'page'; t.url = bm.url;
          _browserApplyStageMode();
        } else {
          _browserNewTab(bm.url);
        }
      });
      browserBookmarksListEl.appendChild(li);
    }
  }

  function _browserOpenBookmarksOverlay() {
    if (browserStageEl.dataset.mode === 'bookmarks') return;
    browserStageEl.dataset.mode = 'bookmarks';
    try { window.dash?.browserTabActivate?.(null); } catch {}
    _browserRenderBookmarksOverlay();
  }
  function _browserCloseBookmarksOverlay() {
    if (browserStageEl.dataset.mode !== 'bookmarks') return;
    _browserApplyStageMode();
  }

  browserBookmarksBtn?.addEventListener('click', _browserOpenBookmarksOverlay);
  browserBookmarksCloseBtn?.addEventListener('click', _browserCloseBookmarksOverlay);

  // ── Video scraper overlay (yt-dlp) ───────────────────────────────
  // SCRAPE button → ask main to run yt-dlp on the active tab's URL,
  // filter to videos ≥ 5 min, present a downloadable list. Same stage-
  // overlay pattern as history/bookmarks: dataset.mode = 'scrape' +
  // detach BVs so the HTML list paints over where the page was.
  const browserScrapeBtn        = document.getElementById('browser-scrape-btn');
  const browserScrapePanel      = document.getElementById('browser-scrape-panel');
  const browserScrapeListEl     = document.getElementById('browser-scrape-list');
  const browserScrapeStatusEl   = document.getElementById('browser-scrape-status');
  const browserScrapeTitleEl    = document.getElementById('browser-scrape-title');
  const browserScrapeCloseBtn   = document.getElementById('browser-scrape-close-btn');
  const browserScrapeDlAllBtn   = document.getElementById('browser-scrape-dl-all-btn');
  // downloadId → { row, fillEl, pctEl, doneEl } so onYtDownloadProgress
  // can route each progress event to the right row's bar.
  const _scrapeRowsByDl = new Map();
  // Live unsubscribe — bound once on first scrape, kept for the session.
  let _scrapeProgressUnsub = null;
  function _ensureScrapeProgressSubscribed() {
    if (_scrapeProgressUnsub || !window.dash?.onYtDownloadProgress) return;
    _scrapeProgressUnsub = window.dash.onYtDownloadProgress((p) => {
      const row = _scrapeRowsByDl.get(p?.downloadId);
      if (!row) return;
      const pct = Math.max(0, Math.min(100, p.percent || 0));
      if (row.fillEl) row.fillEl.style.width = `${pct.toFixed(1)}%`;
      if (row.pctEl)  row.pctEl.textContent  = `${pct.toFixed(0)}%`;
      if (p.done && row.doneEl) {
        row.doneEl.classList.add('is-done');
        row.doneEl.textContent = '✓';
      }
    });
  }
  function _fmtDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      : `${m}:${String(s).padStart(2,'0')}`;
  }
  function _setScrapeStatus(text, kind) {
    if (!browserScrapeStatusEl) return;
    browserScrapeStatusEl.textContent = text || '';
    browserScrapeStatusEl.hidden = !text;
    browserScrapeStatusEl.className = `browser-history-empty${kind ? ` is-${kind}` : ''}`;
  }
  function _renderScrapeList(items, pageTitle) {
    if (!browserScrapeListEl) return;
    browserScrapeListEl.innerHTML = '';
    _scrapeRowsByDl.clear();
    if (browserScrapeTitleEl) {
      browserScrapeTitleEl.textContent = pageTitle
        ? `VIDEOS · ${items.length}`
        : `VIDEOS FOUND · ${items.length}`;
    }
    if (browserScrapeDlAllBtn) browserScrapeDlAllBtn.hidden = items.length === 0;
    for (const v of items) {
      const li = document.createElement('li');
      li.className = 'browser-scrape-row';
      // Thumbnail (fallback to a placeholder block when missing).
      const thumb = document.createElement('div');
      thumb.className = 'browser-scrape-thumb';
      if (v.thumbnail) {
        const img = document.createElement('img');
        img.src = v.thumbnail;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        thumb.appendChild(img);
      }
      const dur = document.createElement('span');
      dur.className = 'browser-scrape-dur';
      dur.textContent = _fmtDuration(v.duration);
      thumb.appendChild(dur);

      const body = document.createElement('div');
      body.className = 'browser-scrape-body';
      const title = document.createElement('div');
      title.className = 'browser-scrape-title-row';
      title.textContent = v.title || v.url;
      const meta = document.createElement('div');
      meta.className = 'browser-scrape-meta';
      meta.textContent = v.channel || v.url;
      const progWrap = document.createElement('div');
      progWrap.className = 'browser-scrape-progress';
      const progFill = document.createElement('div');
      progFill.className = 'browser-scrape-progress-fill';
      progWrap.appendChild(progFill);
      body.append(title, meta, progWrap);

      const right = document.createElement('div');
      right.className = 'browser-scrape-actions';
      const pct = document.createElement('span');
      pct.className = 'browser-scrape-pct';
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'browser-scrape-dl';
      dl.textContent = '⇩';
      dl.title = 'Download to gallery/downloads';
      const done = document.createElement('span');
      done.className = 'browser-scrape-done';
      right.append(pct, done, dl);

      const rowRef = { fillEl: progFill, pctEl: pct, doneEl: done };
      dl.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (dl.disabled) return;
        dl.disabled = true;
        const downloadId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        _scrapeRowsByDl.set(downloadId, rowRef);
        _ensureScrapeProgressSubscribed();
        pct.textContent = '0%';
        try {
          const r = await window.dash?.ytDownload?.({ url: v.url, downloadId });
          if (r?.ok) {
            done.classList.add('is-done');
            done.textContent = '✓';
            pct.textContent = '100%';
            progFill.style.width = '100%';
          } else {
            done.classList.add('is-error');
            done.textContent = '✕';
            done.title = r?.error || 'download failed';
          }
        } catch (err) {
          done.classList.add('is-error');
          done.textContent = '✕';
          done.title = err.message || 'download failed';
        } finally {
          dl.disabled = false;
        }
      });
      li.append(thumb, body, right);
      browserScrapeListEl.appendChild(li);
    }
  }
  async function _runScrape() {
    const tab = _browserActiveTab?.() || null;
    const url = tab?.url || '';
    if (!url || !/^https?:/i.test(url)) {
      _setScrapeStatus('OPEN A WEB PAGE FIRST', 'error');
      return;
    }
    _setScrapeStatus('SCANNING… (yt-dlp may take a minute on large channels)');
    if (browserScrapeListEl) browserScrapeListEl.innerHTML = '';
    if (browserScrapeDlAllBtn) browserScrapeDlAllBtn.hidden = true;
    try {
      const r = await window.dash?.ytScrapePage?.({ url, minDurationSec: 300 });
      if (!r?.ok) {
        _setScrapeStatus(`ERROR · ${r?.error || 'unknown'}`, 'error');
        return;
      }
      if (!r.items?.length) {
        _setScrapeStatus(r.note
          ? `NO VIDEOS ≥ 5 MIN · ${r.note.slice(-160)}`
          : 'NO VIDEOS ≥ 5 MIN FOUND ON THIS PAGE', 'warn');
        return;
      }
      _setScrapeStatus('');
      _renderScrapeList(r.items, true);
    } catch (err) {
      _setScrapeStatus(`ERROR · ${err.message || err}`, 'error');
    }
  }
  function _browserOpenScrape() {
    if (browserStageEl.dataset.mode === 'scrape') return;
    browserStageEl.dataset.mode = 'scrape';
    try { window.dash?.browserTabActivate?.(null); } catch {}
    _runScrape();
  }
  function _browserCloseScrape() {
    if (browserStageEl.dataset.mode !== 'scrape') return;
    _browserApplyStageMode();
  }
  browserScrapeBtn?.addEventListener('click', _browserOpenScrape);
  browserScrapeCloseBtn?.addEventListener('click', _browserCloseScrape);
  browserScrapeDlAllBtn?.addEventListener('click', () => {
    // Fire each row's download in sequence with a small stagger so yt-dlp
    // doesn't get N parallel spawns racing for the same network.
    const buttons = browserScrapeListEl?.querySelectorAll('.browser-scrape-dl:not(:disabled)');
    if (!buttons || !buttons.length) return;
    let i = 0;
    const fire = () => {
      if (i >= buttons.length) return;
      buttons[i].click();
      i += 1;
      setTimeout(fire, 250);
    };
    fire();
  });

  // ── Focus mode ─────────────────────────────────────────────────
  // Single FOCUS button. Spotlight on the playing video — dim + blur
  // everything else (dashboard chrome AND the surrounding webpage).
  // Two layers cooperate:
  //   1. Renderer overlay (this file) — dims the dashboard chrome.
  //   2. BV-injected 4-panel spotlight (main.js) — dims the page
  //      around the video without touching the video itself.
  // Either layer's click → exit. Escape → exit.
  const browserFocusBtn = document.getElementById('browser-focus-btn');
  let _browserFocusOn  = false;
  let _focusOverlayEl  = null;
  let _focusHintEl     = null;
  function _showFocusHint(text) {
    if (!_focusHintEl) {
      _focusHintEl = document.createElement('div');
      _focusHintEl.className = 'focus-mode-hint';
      document.body.appendChild(_focusHintEl);
    }
    _focusHintEl.textContent = text;
    _focusHintEl.classList.add('is-shown');
    clearTimeout(_focusHintEl._t);
    _focusHintEl._t = setTimeout(() => _focusHintEl.classList.remove('is-shown'), 2500);
  }
  async function _setBrowserFocus(on) {
    if (!!on === _browserFocusOn) return; // idempotent
    _browserFocusOn = !!on;
    document.body.classList.toggle('is-browser-focus-mode', _browserFocusOn);
    browserFocusBtn?.classList.toggle('is-active', _browserFocusOn);
    if (_browserFocusOn) {
      // Drop in the renderer overlay. A real DIV so it captures clicks.
      if (!_focusOverlayEl) {
        _focusOverlayEl = document.createElement('div');
        _focusOverlayEl.className = 'browser-focus-overlay';
        _focusOverlayEl.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          _setBrowserFocus(false);
        });
        document.body.appendChild(_focusOverlayEl);
      }
      _showFocusHint('FOCUS MODE · ESC OR CLICK TO EXIT');
    } else {
      // Tear down the renderer overlay.
      if (_focusOverlayEl) {
        _focusOverlayEl.remove();
        _focusOverlayEl = null;
      }
    }
    try { await window.dash?.browserSetFocus?.(_browserFocusOn); } catch {}
  }
  browserFocusBtn?.addEventListener('click', () => _setBrowserFocus(!_browserFocusOn));
  // Escape exits focus mode globally (works in fullscreen too).
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && _browserFocusOn) {
      ev.preventDefault();
      _setBrowserFocus(false);
    }
  });
  // Main → renderer: a click happened inside the BV while focus was
  // armed. Exit focus mode. Implemented by main awaiting the next
  // mousedown inside the BV via executeJavaScript and pushing this
  // event when it fires.
  window.dash?.onBrowserFocusClicked?.(() => {
    if (_browserFocusOn) _setBrowserFocus(false);
  });

  // ── Audio-only mode ─────────────────────────────────────────────
  // Pauses the BV's <video>, hides it (display:none → no GPU decode),
  // and plays the audio-only stream extracted by yt-dlp in a hidden
  // <audio> element. Toggling off seeks the BV video to the audio
  // element's currentTime and resumes. Auto-enables on tab switch
  // because the user wants tabs to default to audio-only.
  const browserAudioBtn  = document.getElementById('browser-audio-btn');
  const browserAudioEl   = document.getElementById('browser-audio-only-el');
  let   _browserAudioOn  = false;
  let   _browserAudioGen = 0; // token to invalidate stale async work
  let   _browserAudioChip = null;
  function _setAudioChip(text) {
    if (!text) { if (_browserAudioChip) _browserAudioChip.hidden = true; return; }
    if (!_browserAudioChip) {
      _browserAudioChip = document.createElement('div');
      _browserAudioChip.className = 'browser-audio-chip';
      // Drop the chip onto the browser stage so it follows the pane.
      const stage = document.getElementById('browser-stage') || document.querySelector('.combo-pane-browser') || document.body;
      stage.appendChild(_browserAudioChip);
    }
    _browserAudioChip.hidden = false;
    _browserAudioChip.textContent = text;
  }
  // Snapshot active-tab state, extract audio URL via yt-dlp, pause the
  // BV's video, and start the audio element. Generation token prevents
  // stale promises (from a previous tab switch) from clobbering the
  // current playback.
  async function _enterAudioOnly() {
    const gen = ++_browserAudioGen;
    browserAudioBtn?.classList.add('is-loading');
    _setAudioChip('♪ EXTRACTING AUDIO…');
    // Bail early if the preload bridge isn't loaded — that means main
    // wasn't restarted after the IPC changes shipped. Tell the user
    // explicitly so they restart instead of staring at silence.
    if (!window.dash?.browserGetActiveState || !window.dash?.ytGetAudioStream) {
      console.warn('[audio-only] IPC bridge missing — restart Electron (run Dashboard.bat)');
      _setAudioChip('♪ NOT WIRED · RESTART ELECTRON (Dashboard.bat)');
      browserAudioBtn?.classList.remove('is-loading');
      _browserAudioOn = false;
      browserAudioBtn?.classList.remove('is-active');
      setTimeout(() => { if (gen === _browserAudioGen) _setAudioChip(''); }, 5000);
      return;
    }
    let state;
    try { state = await window.dash.browserGetActiveState(); }
    catch (err) { console.warn('[audio-only] browserGetActiveState threw:', err); }
    if (!state?.ok || !state.url) {
      if (gen === _browserAudioGen) {
        browserAudioBtn?.classList.remove('is-loading');
        _setAudioChip('♪ NO ACTIVE TAB');
        _browserAudioOn = false;
        browserAudioBtn?.classList.remove('is-active');
        setTimeout(() => { if (gen === _browserAudioGen) _setAudioChip(''); }, 3000);
      }
      return;
    }
    console.log('[audio-only] extracting audio for', state.url, 'at t=', state.videoTime);
    const startT = state.videoTime || 0;
    let stream;
    try { stream = await window.dash.ytGetAudioStream(state.url); }
    catch (err) { console.warn('[audio-only] ytGetAudioStream threw:', err); }
    if (gen !== _browserAudioGen) return; // superseded
    if (!stream?.ok || !stream.url) {
      const reason = stream?.error || 'unknown';
      console.warn('[audio-only] yt-dlp failed:', reason);
      browserAudioBtn?.classList.remove('is-loading');
      _setAudioChip('♪ UNAVAILABLE · ' + reason.slice(0, 80));
      _browserAudioOn = false;
      browserAudioBtn?.classList.remove('is-active');
      setTimeout(() => { if (gen === _browserAudioGen) _setAudioChip(''); }, 5000);
      return;
    }
    try { await window.dash.browserPauseVideo(); } catch {}
    if (gen !== _browserAudioGen) return;
    browserAudioEl.src = stream.url;
    try { browserAudioEl.currentTime = startT; } catch {}
    try { await browserAudioEl.play(); }
    catch (err) {
      console.warn('[audio-only] audio.play() rejected:', err);
      _setAudioChip('♪ PLAY BLOCKED · ' + (err?.message || err?.name || 'unknown'));
      browserAudioBtn?.classList.remove('is-loading');
      _browserAudioOn = false;
      browserAudioBtn?.classList.remove('is-active');
      return;
    }
    browserAudioBtn?.classList.remove('is-loading');
    _setAudioChip('♪ ' + (stream.title || 'AUDIO ONLY'));
    _browserAudioOn = true;
    browserAudioBtn?.classList.add('is-active');
    console.log('[audio-only] playing', stream.title || '(untitled)');
  }
  async function _exitAudioOnly() {
    _browserAudioGen++;
    const t = browserAudioEl.currentTime || 0;
    try { browserAudioEl.pause(); } catch {}
    browserAudioEl.removeAttribute('src');
    try { browserAudioEl.load(); } catch {}
    try { await window.dash?.browserResumeVideo?.(t); } catch {}
    _browserAudioOn = false;
    browserAudioBtn?.classList.remove('is-active');
    browserAudioBtn?.classList.remove('is-loading');
    _setAudioChip('');
  }
  browserAudioBtn?.addEventListener('click', () => {
    if (_browserAudioOn) _exitAudioOnly();
    else _enterAudioOnly();
  });
  // Tab-switch hook (called from _browserActivateTab). Wait a tick so
  // the BV has begun loading the new tab's page, then enter audio-only.
  // If audio-only was already running, kill the previous audio first.
  function _browserKickAudioOnly() {
    _browserAudioGen++;
    try { browserAudioEl.pause(); browserAudioEl.removeAttribute('src'); browserAudioEl.load(); } catch {}
    // Debounce — give the new tab's <video> a chance to attach so
    // browserGetActiveState can read its currentTime.
    setTimeout(() => _enterAudioOnly(), 600);
  }
  // `function _browserKickAudioOnly` above is hoisted to the top of the
  // enclosing init() scope, so _browserActivateTab (defined earlier in
  // the same scope) can call it directly.

  // Clear-data — confirm, fire IPC, refresh history overlay if open.
  // Keeps cookies + localStorage + IndexedDB on the main-side handler so
  // active sign-ins survive the wipe. Cache + history + service workers
  // + shader cache all go.
  browserClearBtn?.addEventListener('click', async () => {
    const ok = window.confirm('Clear cache and browsing history?\n\nSign-ins and saved logins will be kept.');
    if (!ok) return;
    try {
      await window.dash?.browserClearData?.();
      playSfx?.('confirm');
    } catch (err) {
      console.warn('[browser] clear-data failed:', err?.message || err);
      playSfx?.('error');
    }
    if (browserStageEl.dataset.mode === 'history') _browserRenderHistory();
  });

  // Splash forms.
  browserSplashAddrFormEl?.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = _browserNormalizeUrl(browserSplashAddrEl.value);
    if (url) { _browserNavigateActive(url); browserSplashAddrEl.value = ''; }
  });
  browserSplashSearchFormEl?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = browserSplashSearchEl.value.trim();
    if (q) { _browserSearchActive(q, _browserState.searchKind); browserSplashSearchEl.value = ''; }
  });
  // Result-type filter chips (ALL · IMAGES · VIDEOS · LINKS · NEWS).
  // Live on the results header — splash always starts as 'web'. Clicking
  // a chip re-runs the active tab's query with the new kind so the user
  // can pivot from a web search into image / video results without
  // retyping. LINKS and NEWS currently fall back to 'web' on the
  // backend but ship the kind through so a future provider can pick
  // them up without renderer changes.
  for (const btn of document.querySelectorAll('.browser-results-filter')) {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind || 'web';
      for (const b of document.querySelectorAll('.browser-results-filter')) {
        b.classList.toggle('is-active', b === btn);
      }
      _browserState.searchKind = kind;
      const t = _browserActiveTab?.();
      if (t && t.query) {
        _browserSearchActive(t.query, kind);
      }
    });
  }

  // Live ad-block + image-block counts from main process. Throttled to
  // 4 Hz over IPC. The image counter exists so reader-mode users can
  // verify the filter is actually firing — if the number goes up after
  // toggling on, the block is working.
  try {
    window.dash?.onBrowserStats?.((data) => {
      if (data && typeof data.adsBlocked    === 'number') _browserState.adsBlocked    = data.adsBlocked;
      if (data && typeof data.imagesBlocked === 'number') _browserState.imagesBlocked = data.imagesBlocked;
      if (data && typeof data.popupsBlocked === 'number') _browserState.popupsBlocked = data.popupsBlocked;
      _browserRenderSplashStats();
    });
  } catch {}

  // Popup → new tab. Main fires this whenever a page tries to open a
  // separate window/popup (covers target=_blank, window.open, popups
  // from iframes like Google sign-in). Spawn a fresh tab in our chrome
  // and navigate it to the requested URL, so the user's current page
  // stays where it was.
  try {
    window.dash?.onBrowserNewTabRequest?.((url) => {
      if (url) _browserNewTab(url);
    });
  } catch {}

  // Show/hide are driven by app.js's activateLazyPane(). activate()
  // ensures the chrome is built, flags us in-browser, and attaches the
  // active tab's BrowserView; deactivate() detaches it.
  _activateImpl = async () => {
    await initBrowserOnce();
    _browserState.inBrowserMode = true;
    try { _browserApplyStageMode(); } catch {}
  };
  _deactivateImpl = () => {
    if (_browserState) _browserState.inBrowserMode = false;
    try { window.dash?.browserTabActivate?.(null); } catch {}
  };
}

export function activate()   { _activateImpl?.(); }
export function deactivate() { _deactivateImpl?.(); }
