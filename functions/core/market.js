'use strict';
// 星界交易所 v2：消息驅動行情
/* 公開行情放 market/main；持股放在當季帳戶；所有買賣走 economy.mutate。
   未來會發生的事（消息還沒反映完的部分、傳聞真假、今天的大事件排程）放在 marketAdmin/engine，
   Firestore rules 沒開放 marketAdmin，客戶端讀不到。

   每 5 分鐘的價格變化 = 小雜訊 + 回歸公允價 + 成交量推力 + 消息影響
   - 消息影響會同時移動「公允價」，所以消息造成的漲跌會留下來，不會被均值回歸吃掉。
   - 雜訊與成交量只移動價格，之後會慢慢被拉回公允價。
   - 一般更新單次最多 ±7%；重大事件分段反映，單日價格區間為開盤價的 ±60%。 */

const { AppError, seasonId, TW_OFFSET } = require('./util');
const E = require('./econ');

const TOTAL_SHARES = 100000;
const PLAYER_SHARE_RATE = 0.3;
const HISTORY_LIMIT = 750;
const MAINTENANCE_MARGIN_RATE = 0.6;
const MAX_LEVERAGE_MARGIN = 100000;
const MAX_LEVERAGE_POSITIONS = 3;
const TICK_MS = 5 * 60000;

const TICK_CAP = 0.07;           // 單次 5 分鐘最大漲跌；小於 5× 的爆倉距離 8%，一般行情不會一根跳空直接打爆新倉位
const EVENT_TICK_CAP = 0.1;      // 大事件爆出來的那一次更新最多 ±10%
const DAY_LIMIT = 0.6;           // 容納 20%～50% 大事件；仍防止單日價格無限制失控
const REVERT_RATE = 0.02;        // 每 5 分鐘把價格往公允價拉回偏離的 2%
const PRESSURE_DEPTH = 2000;     // 淨買超／賣超 2000 股才會達到最大推力
const PRESSURE_MAX = 0.01;       // 成交量推力上限 1%
const ANCHOR_LO = 0.5, ANCHOR_HI = 2;   // 公允價只能在錨定價的 0.5×～2× 之間
const EVENT_MIN_PER_DAY = 2, EVENT_MAX_PER_DAY = 4;
const EVENT_SIZE_MIN = 0.3, EVENT_SIZE_MAX = 0.5;
const EVENT_LOW_MIN = 0.18, EVENT_LOW_MAX = 0.24;
const EVENT_LOW_RATE = 0.25;     // 少數事件只有約 20%，其餘主要落在 30%～50%
const HINT_ACCURACY = 0.75;      // 大事件前的「風聲」有 75% 猜對方向
const RUMOR_RATE = 0.25;         // 情報有 25% 是未證實傳聞
const RUMOR_TRUE_RATE = 0.5;     // 傳聞一半是真的
const MAX_DRIFTS = 60;
const MAX_RUMORS = 30;

const TIERS = [
  { id: 'small', label: '小', weight: 0.6, lo: 0.015, hi: 0.03 },
  { id: 'mid', label: '中', weight: 0.3, lo: 0.03, hi: 0.05 },
  { id: 'major', label: '重大', weight: 0.1, lo: 0.05, hi: 0.08 }
];

const STOCKS = [
  { symbol: 'TKN', name: 'TOKEN 科技', tag: '核心平台', color: '#62e7ff', price: 128, vol: 0.003 },
  { symbol: 'BNK', name: '星界銀行', tag: '金融服務', color: '#79f2b1', price: 96, vol: 0.0018 },
  { symbol: 'DRG', name: '龍焰娛樂', tag: '娛樂內容', color: '#b28cff', price: 184, vol: 0.0035 },
  { symbol: 'ROY', name: '皇家賭場', tag: '博弈娛樂', color: '#ffd36d', price: 73, vol: 0.0045 },
  { symbol: 'TRS', name: '秘寶工坊', tag: '稀有收藏', color: '#ff8fa3', price: 142, vol: 0.0032 }
];

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function rndOf(random) { return typeof random === 'function' ? random : Math.random; }
function between(rnd, lo, hi) { return lo + rnd() * (hi - lo); }
function intBetween(rnd, lo, hi) { return lo + Math.min(hi - lo, Math.floor(rnd() * (hi - lo + 1))); }
function pick(rnd, list) { return list[Math.min(list.length - 1, Math.floor(rnd() * list.length))]; }
function gauss(rnd) {
  const u = Math.max(1e-9, rnd()), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function pctText(x) { return (x >= 0 ? '+' : '') + round2(x * 100) + '%'; }

/* ---------- 時間 ---------- */

function isMarketOpen(t) {
  const d = new Date(Number(t) + TW_OFFSET);
  const day = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 7 * 60 && mins < 17 * 60 + 30;
}

function shockDayKey(t) {
  const d = new Date(Number(t) + TW_OFFSET);
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
}

/* 07:00 = 0、07:05 = 1 … 17:25 = 125 */
function shockSlot(t) {
  const d = new Date(Number(t) + TW_OFFSET);
  return Math.floor((d.getUTCHours() * 60 + d.getUTCMinutes() - 7 * 60) / 5);
}

function slotClock(slot) {
  const mins = 7 * 60 + slot * 5;
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
}

function intelSlotKey(t) {
  const d = new Date(t + TW_OFFSET);
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0') + '-' +
    String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0');
}

function isIntelWindow(t) {
  const d = new Date(Number(t) + TW_OFFSET);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 8 * 60 && mins <= 16 * 60 && mins % 30 === 0;
}

/* ---------- 行情狀態 ---------- */

function applySupply(stock, playerShares) {
  stock.totalShares = TOTAL_SHARES;
  stock.playerLimit = Math.floor(TOTAL_SHARES * PLAYER_SHARE_RATE);
  stock.playerShares = clamp(Math.floor(Number(playerShares) || 0), 0, TOTAL_SHARES);
  stock.systemShares = Math.max(0, TOTAL_SHARES - stock.playerShares);
  return stock;
}

function setLimits(stock) {
  const open = stock.dayOpen || stock.price;
  stock.limitUp = Math.round(open * (1 + DAY_LIMIT));
  stock.limitDown = Math.max(5, Math.round(open * (1 - DAY_LIMIT)));
}

function freshState(t) {
  const stocks = {};
  STOCKS.forEach((s) => {
    stocks[s.symbol] = {
      symbol: s.symbol, name: s.name, tag: s.tag, color: s.color, vol: s.vol,
      price: s.price, exact: s.price, fair: s.price, anchor: s.price, base: s.price, previous: s.price,
      dayKey: '', dayOpen: s.price, limitUp: 0, limitDown: 0,
      buyVolume: 0, sellVolume: 0, history: [{ t, p: s.price }],
      totalShares: TOTAL_SHARES, playerLimit: Math.floor(TOTAL_SHARES * PLAYER_SHARE_RATE),
      playerShares: 0, systemShares: TOTAL_SHARES
    };
    setLimits(stocks[s.symbol]);
  });
  return {
    version: 2, feeRate: 0.01, intervalMin: 5, tickCap: TICK_CAP, dayLimit: DAY_LIMIT,
    updatedAt: t, nextAt: t + TICK_MS, stocks, latestIntelSlot: '',
    news: [{ t, title: '星界交易所正式開盤', body: '五支虛擬股票同步上線，價格每 5 分鐘更新。', kind: 'market', batch: '' }]
  };
}

function normalizeStock(raw, def, t) {
  const price = Math.max(5, Math.round(Number(raw && raw.price) || def.price));
  const history = Array.isArray(raw && raw.history) ? raw.history.slice(-HISTORY_LIMIT).map((x) => ({
    t: Number(x.t) || t, p: Math.max(5, Math.round(Number(x.p) || price))
  })) : [];
  if (!history.length) history.push({ t, p: price });
  // v1 → v2 遷移：舊資料沒有錨定價時，用「現在的價格」當錨定，避免被硬拉回初始價而出現可預測的單邊走勢
  const anchor = Math.max(5, Number(raw && raw.anchor) || price);
  let exact = Number(raw && raw.exact);
  if (!(exact > 0) || Math.abs(exact - price) > 0.5) exact = price;
  const fair = clamp(Number(raw && raw.fair) || price, anchor * ANCHOR_LO, anchor * ANCHOR_HI);
  const stock = applySupply({
    symbol: def.symbol,
    name: String((raw && raw.name) || def.name).slice(0, 24),
    tag: String((raw && raw.tag) || def.tag).slice(0, 24),
    color: String((raw && raw.color) || def.color).slice(0, 16),
    vol: def.vol,
    price,
    exact: round4(exact),
    fair: round4(fair),
    anchor: round4(anchor),
    base: Math.round(anchor),
    previous: Math.max(5, Math.round(Number(raw && raw.previous) || price)),
    dayKey: String((raw && raw.dayKey) || '').slice(0, 8),
    dayOpen: Math.max(5, Math.round(Number(raw && raw.dayOpen) || price)),
    limitUp: 0, limitDown: 0,
    buyVolume: Math.max(0, Number(raw && raw.buyVolume) || 0),
    sellVolume: Math.max(0, Number(raw && raw.sellVolume) || 0),
    history
  }, raw && raw.playerShares);
  setLimits(stock);
  return stock;
}

const NEWS_DIRS = ['up', 'down'];
const NEWS_TIERS = ['small', 'mid', 'major', 'event'];
const NEWS_CREDS = ['confirmed', 'rumor', 'verified', 'debunked', 'hint', 'event', 'admin', 'closed'];

function normalizeNews(n, t) {
  const out = {
    t: Number(n.t) || t,
    title: String(n.title || '市場快訊').slice(0, 60),
    body: String(n.body || '').slice(0, 160),
    kind: n.kind === 'intel' ? 'intel' : 'market',
    batch: String(n.batch || '').slice(0, 24)
  };
  if (n.symbol && STOCKS.some((s) => s.symbol === n.symbol)) out.symbol = n.symbol;
  if (NEWS_DIRS.includes(n.dir)) out.dir = n.dir;
  if (NEWS_TIERS.includes(n.tier)) out.tier = n.tier;
  if (NEWS_CREDS.includes(n.cred)) out.cred = n.cred;
  return out;
}

function normalizeState(raw, t) {
  const base = freshState(t);
  const out = Object.assign({}, base, raw || {});
  out.version = 2;
  out.feeRate = clamp(Number(out.feeRate) || 0.01, 0, 0.1);
  out.intervalMin = 5;
  out.tickCap = TICK_CAP;
  out.dayLimit = DAY_LIMIT;
  out.updatedAt = Number(out.updatedAt) || t;
  out.nextAt = Number(out.nextAt) || (t + TICK_MS);
  out.latestIntelSlot = String(out.latestIntelSlot || '').slice(0, 20);
  out.stocks = {};
  STOCKS.forEach((def) => { out.stocks[def.symbol] = normalizeStock(raw && raw.stocks && raw.stocks[def.symbol], def, t); });
  out.news = Array.isArray(raw && raw.news) ? raw.news.slice(0, 150).map((n) => normalizeNews(n || {}, t)) : base.news;
  return out;
}

/* 開盤第一次動到某支股票時，記下今日開盤參考價與漲跌停 */
function ensureDay(stock, t) {
  const day = shockDayKey(t);
  if (stock.dayKey === day) return;
  stock.dayKey = day;
  stock.dayOpen = stock.price;
  setLimits(stock);
}

function dayBand(stock) {
  const open = stock.dayOpen || stock.price;
  return { lo: Math.max(5, open * (1 - DAY_LIMIT)), hi: open * (1 + DAY_LIMIT) };
}

function clampFair(stock, value, band) {
  const lo = Math.max(band.lo, stock.anchor * ANCHOR_LO);
  const hi = Math.max(lo, Math.min(band.hi, stock.anchor * ANCHOR_HI));
  return round4(clamp(value, lo, hi));
}

function pushHistory(stock, t) {
  const history = stock.history || [];
  if (history.length && history[history.length - 1].t === t) history[history.length - 1] = { t, p: stock.price };
  else stock.history = history.concat([{ t, p: stock.price }]).slice(-HISTORY_LIMIT);
}

/* 把一次漲跌套到股票上。pct 動價格，fairPct 動公允價（消息造成的部分）。回傳實際價格變化 */
function moveStock(stock, pct, fairPct, t, cap) {
  const band = dayBand(stock);
  const oldPrice = stock.price;
  const c = cap || TICK_CAP;
  const p = clamp(pct, -c, c);
  const f = clamp(fairPct, -c, c);
  stock.exact = round4(clamp(stock.exact * (1 + p), band.lo, band.hi));
  stock.fair = clampFair(stock, stock.fair * (1 + f), band);
  stock.previous = oldPrice;
  stock.price = Math.max(5, Math.round(stock.exact));
  pushHistory(stock, t);
  return (stock.price - oldPrice) / oldPrice;
}

/* 公允價偏離錨定價越多，越容易出現反方向的消息：價格不會無限飛走，但單則消息仍然猜不到 */
function upChance(stock) {
  const tilt = clamp(Math.log((stock.fair || stock.price) / (stock.anchor || stock.price)) / Math.log(2), -1, 1);
  return 0.5 - 0.3 * tilt;
}

/* ---------- 引擎（私有） ---------- */

function freshEngine(t) {
  return { version: 2, day: '', seq: 0, lastTickSlot: 0, events: [], drifts: [], rumors: [], updatedAt: Number(t) || 0 };
}

function normalizeEngine(raw, t) {
  const out = freshEngine(t);
  if (!raw || raw.version !== 2) return out;
  out.day = String(raw.day || '').slice(0, 8);
  out.seq = Math.max(0, Math.floor(Number(raw.seq) || 0));
  out.updatedAt = Number(raw.updatedAt) || 0;
  out.lastTickSlot = Math.floor(Number(raw.lastTickSlot) || 0);
  const okSym = (s) => STOCKS.some((x) => x.symbol === s);
  out.events = (Array.isArray(raw.events) ? raw.events : []).filter((e) => e && okSym(e.symbol)).slice(0, 4).map((e) => ({
    id: String(e.id || ''), slot: clamp(Math.floor(Number(e.slot) || 0), 0, 125), hintSlot: clamp(Math.floor(Number(e.hintSlot) || 0), 0, 125),
    symbol: e.symbol, dir: e.dir === 'down' ? 'down' : 'up', size: clamp(Number(e.size) || EVENT_SIZE_MIN, 0.01, 0.6),
    hintDir: e.hintDir === 'down' ? 'down' : 'up', hinted: Number(e.hinted) || 0, applied: Number(e.applied) || 0,
    headline: String(e.headline || '').slice(0, 60)
  }));
  out.drifts = (Array.isArray(raw.drifts) ? raw.drifts : []).filter((d) => d && okSym(d.symbol) && Number(d.ticks) > 0).slice(-MAX_DRIFTS).map((d) => ({
    id: String(d.id || ''), symbol: d.symbol, left: Number(d.left) || 0, burst: Number(d.burst) || 0, ticks: Math.floor(Number(d.ticks)),
    day: String(d.day || ''), kind: String(d.kind || 'intel').slice(0, 12)
  }));
  out.rumors = (Array.isArray(raw.rumors) ? raw.rumors : []).filter((r) => r && okSym(r.symbol)).slice(-MAX_RUMORS).map((r) => ({
    id: String(r.id || ''), symbol: r.symbol, dir: r.dir === 'down' ? 'down' : 'up', size: Number(r.size) || 0,
    phase1: Number(r.phase1) || 0, truth: !!r.truth, resolveAt: Number(r.resolveAt) || 0,
    day: String(r.day || ''), title: String(r.title || '').slice(0, 60)
  }));
  return out;
}

function nextId(engine, prefix) {
  engine.seq = (engine.seq || 0) + 1;
  return prefix + '-' + engine.seq;
}

/* 建立一段消息影響：nowAmt 立刻反映，restAmt 在接下來 ticks 次更新內分攤（rest 可以跟 now 反向，代表「利多出盡」）。
   defer = true（在 5 分鐘更新裡建立）時，立刻反映的部分併入這一次更新。 */
function addDrift(engine, state, symbol, nowAmt, restAmt, ticks, kind, t, defer) {
  const stock = state.stocks[symbol];
  let moved = 0, burst = 0;
  if (nowAmt && !defer) moved = moveStock(stock, nowAmt, nowAmt, t, kind === 'event' ? EVENT_TICK_CAP : TICK_CAP);
  else burst = nowAmt || 0;
  const left = (restAmt || 0) + burst;
  if (Math.abs(left) > 1e-6 && ticks > 0) {
    engine.drifts.push({ id: nextId(engine, 'd'), symbol, left: round4(left), burst: round4(burst), ticks: Math.floor(ticks), day: shockDayKey(t), kind });
    if (engine.drifts.length > MAX_DRIFTS) engine.drifts = engine.drifts.slice(-MAX_DRIFTS);
  }
  return moved;
}

const EVENT_HEADLINES = {
  up: [
    (a) => a.name + ' 宣布跨界併購，市場瘋狂追價',
    (a) => a.name + ' 財報大爆發，獲利創歷史新高',
    (a) => a.name + ' 拿下星界政府獨家大標案',
    (a) => a.name + ' 新產品預購秒殺，訂單排到明年'
  ],
  down: [
    (a) => a.name + ' 爆出財報造假疑雲',
    (a) => a.name + ' 遭主管機關勒令暫停部分業務',
    (a) => a.name + ' 核心系統大當機，客戶大量流失',
    (a) => a.name + ' 最大股東宣布大舉出脫持股'
  ]
};

function buildEventPlan(state, t, random, engine) {
  const rnd = rndOf(random);
  const count = EVENT_MIN_PER_DAY + Math.floor(rnd() * (EVENT_MAX_PER_DAY - EVENT_MIN_PER_DAY + 1));
  const firstSlot = 18, lastSlot = 108, span = lastSlot - firstSlot + 1;   // 08:30–16:00 之間
  const symbols = STOCKS.map((s) => s.symbol);
  for (let i = symbols.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rnd() * (i + 1)));
    const tmp = symbols[i]; symbols[i] = symbols[j]; symbols[j] = tmp;
  }
  const events = [];
  for (let i = 0; i < count; i++) {
    // 把交易日切成 2～4 段，每段安排一次，避免事件全擠在同一時段。
    const lo = firstSlot + Math.floor(i * span / count);
    const hi = firstSlot + Math.floor((i + 1) * span / count) - 1;
    const slot = intBetween(rnd, lo, hi);
    const hintSlot = Math.max(1, slot - intBetween(rnd, 6, 15));   // 大事件前 30–75 分鐘出風聲
    const stock = state.stocks[symbols[i]];
    const dir = rnd() < upChance(stock) ? 'up' : 'down';
    const low = rnd() < EVENT_LOW_RATE;
    const size = round4(low ? between(rnd, EVENT_LOW_MIN, EVENT_LOW_MAX) : between(rnd, EVENT_SIZE_MIN, EVENT_SIZE_MAX));
    const hintDir = rnd() < HINT_ACCURACY ? dir : (dir === 'up' ? 'down' : 'up');
    events.push({
      id: nextId(engine || { seq: 0 }, 'ev'), slot, hintSlot, symbol: stock.symbol, dir, size, hintDir,
      hinted: 0, applied: 0, headline: pick(rnd, EVENT_HEADLINES[dir])(stock)
    });
  }
  return events;
}

/* 換日：清掉前一天沒跑完的消息影響與傳聞，重新排今天的大事件 */
function rollEngineDay(engine, state, t, random) {
  const day = shockDayKey(t);
  if (engine.day === day) return false;
  engine.day = day;
  engine.drifts = engine.drifts.filter((d) => d.day === day);
  engine.rumors = engine.rumors.filter((r) => r.day === day);
  // 中途才建立排程（例如盤中部署）時，風聲時間已經過的大事件直接跳過，避免風聲和大事件同時爆
  const nowSlot = shockSlot(t);
  engine.events = buildEventPlan(state, t, random, engine).filter((e) => e.hintSlot > nowSlot);
  return true;
}

function newsRow(t, fields) {
  return Object.assign({ t, body: '', kind: 'market', batch: '' }, fields);
}

function pushNews(state, rows) {
  state.news = rows.concat(state.news || []).slice(0, 150);
}

/* 到時間的風聲、大事件、傳聞揭曉 */
function runScheduled(state, engine, t, random) {
  const rnd = rndOf(random);
  const slot = shockSlot(t);
  const day = shockDayKey(t);
  const out = [];
  engine.events.forEach((ev) => {
    const stock = state.stocks[ev.symbol];
    if (!ev.hinted && ev.hintSlot <= slot && !ev.applied) {
      ev.hinted = t;
      const up = ev.hintDir === 'up';
      addDrift(engine, state, ev.symbol, 0, up ? 0.01 : -0.01, 3, 'hint', t, true);
      out.push(newsRow(t, {
        title: '【風聲】' + stock.name + ' 傳出重大異動',
        body: up
          ? stock.name + ' 預告稍後將說明一項未公開計畫，供應鏈同時出現異常備貨紀錄；消息仍待公司確認。'
          : stock.name + ' 臨時取消原定公開行程，市場同時出現異常成交；目前尚無正式說明。',
        kind: 'market', batch: 'event-' + day, symbol: ev.symbol, dir: ev.hintDir, tier: 'event', cred: 'hint'
      }));
    }
    if (!ev.applied && ev.slot <= slot) {
      ev.applied = t;
      if (!ev.hinted) ev.hinted = t;
      const signed = ev.dir === 'up' ? ev.size : -ev.size;
      // 六成立即進場，其餘約三至四成分段反映，讓最終幅度貼近事件標示值。
      addDrift(engine, state, ev.symbol, signed * 0.6, signed * between(rnd, 0.3, 0.4), intBetween(rnd, 5, 6), 'event', t, true);
      out.push(newsRow(t, {
        title: '【大事件】' + (ev.headline || stock.name),
        body: '事件內容已由公司或主管機關正式公布，行情會在接下來約半小時分段反映；實際走勢與幅度請依價格自行判斷。',
        kind: 'market', batch: 'event-' + day, symbol: ev.symbol, dir: ev.dir, tier: 'event', cred: 'event'
      }));
    }
  });
  const keep = [];
  engine.rumors.forEach((r) => {
    if (r.resolveAt > t) { keep.push(r); return; }
    const stock = state.stocks[r.symbol];
    const signed = r.dir === 'up' ? 1 : -1;
    if (r.truth) {
      addDrift(engine, state, r.symbol, signed * r.size * 0.2, signed * r.size * between(rnd, 0.1, 0.7), 4, 'verified', t, true);
      out.push(newsRow(t, {
        title: '【證實】' + r.title.replace(/^傳聞：/, ''),
        body: stock.name + ' 正式證實先前傳聞，消息影響繼續擴大。',
        kind: 'intel', batch: 'follow-' + intelSlotKey(t), symbol: r.symbol, dir: r.dir, tier: 'mid', cred: 'verified'
      }));
    } else {
      addDrift(engine, state, r.symbol, -r.phase1 * 0.6, -r.phase1 * between(rnd, 0.3, 0.8), 3, 'debunked', t, true);
      out.push(newsRow(t, {
        title: '【澄清】' + r.title.replace(/^傳聞：/, '') + '，傳聞不實',
        body: stock.name + ' 發聲明否認，先前追價的資金開始撤出。',
        kind: 'intel', batch: 'follow-' + intelSlotKey(t), symbol: r.symbol, dir: r.dir === 'up' ? 'down' : 'up', tier: 'mid', cred: 'debunked'
      }));
    }
  });
  engine.rumors = keep;
  if (out.length) pushNews(state, out.reverse());
  return out;
}

/* 一般的 5 分鐘更新 */
function tickState(raw, t, random, engineRaw) {
  const rnd = rndOf(random);
  const state = normalizeState(raw, t);
  const engine = normalizeEngine(engineRaw, t);
  STOCKS.forEach((def) => ensureDay(state.stocks[def.symbol], t));
  rollEngineDay(engine, state, t, rnd);
  const scheduled = runScheduled(state, engine, t, rnd);
  Object.keys(state.stocks).forEach((symbol) => {
    const s = state.stocks[symbol];
    let news = 0;
    const mine = engine.drifts.filter((d) => d.symbol === symbol && d.ticks > 0);
    const cap = mine.some((d) => d.kind === 'event' && d.burst) ? EVENT_TICK_CAP : TICK_CAP;
    mine.forEach((d) => {
      const burst = d.burst || 0;
      const step = burst + (d.left - burst) / d.ticks;
      news += step;
      d.left = round4(d.left - step);
      d.burst = 0;
      d.ticks -= 1;
    });
    // 單次超過 ±7% 的消息部分不會消失，留到下一次更新繼續反映
    const capped = clamp(news, -cap, cap);
    if (capped !== news && mine.length) {
      const holder = mine.reduce((a, b) => (Math.abs(b.left) > Math.abs(a.left) ? b : a), mine[0]);
      holder.left = round4(holder.left + (news - capped));
      holder.ticks = Math.max(1, holder.ticks);
      news = capped;
    }
    const noise = gauss(rnd) * s.vol;
    const reversion = clamp((s.fair - s.exact) / s.exact, -0.3, 0.3) * REVERT_RATE;
    const net = s.buyVolume - s.sellVolume;
    const pressure = clamp(net / PRESSURE_DEPTH, -1, 1) * PRESSURE_MAX;
    moveStock(s, noise + reversion + pressure + news, news, t, cap);
    s.buyVolume = round2(s.buyVolume * 0.2);
    s.sellVolume = round2(s.sellVolume * 0.2);
  });
  engine.drifts = engine.drifts.filter((d) => d.ticks > 0 && Math.abs(d.left) > 1e-6);
  engine.updatedAt = t;
  state.news = state.news.slice(0, 150);
  state.updatedAt = t;
  state.nextAt = t + TICK_MS;
  return { state, engine, scheduled };
}

/* ---------- 情報網 ---------- */

const INTEL_EVENTS = [
  { direction: 'up', title: (a, b) => a.name + ' × ' + b.name + ' 簽署戰略合作', body: (a, b, money) => '雙方宣布共同開發新服務，合作規模約 ' + money + ' 萬，執行內容將分階段公開。' },
  { direction: 'up', title: (a, b, money) => a.name + ' 拿下 ' + money + ' 萬大型訂單', body: (a, b) => '訂單將分階段交付，' + b.name + ' 也將提供部分技術支援。' },
  { direction: 'up', title: (a, b) => a.name + ' 聯手 ' + b.name + ' 收購新創團隊', body: (a, b, money) => '雙方以約 ' + money + ' 萬完成聯合收購，預計快速擴張 ' + a.tag + ' 業務。' },
  { direction: 'up', title: (a) => '神秘資金進場 ' + a.name, body: (a, b, money) => '一筆約 ' + money + ' 萬的策略投資完成交割，買方身分尚未公開。' },
  { direction: 'up', title: (a) => a.name + ' 取得獨家授權', body: (a, b, money) => '新授權案規模約 ' + money + ' 萬，合約已完成簽署，授權內容將陸續上線。' },
  { direction: 'down', title: (a, b) => a.name + ' 與 ' + b.name + ' 合作談判破局', body: (a, b, money) => '原訂約 ' + money + ' 萬的合作案臨時喊停，雙方對分潤條件沒有共識。' },
  { direction: 'down', title: (a) => a.name + ' 重大專案宣布延期', body: (a, b, money) => '供應與測試進度不如預期，可能影響約 ' + money + ' 萬的短期收入。' },
  { direction: 'down', title: (a) => a.name + ' 遭市場監管調查', body: (a) => '主管機關要求 ' + a.name + ' 補交交易與營運資料，結果仍不明朗。' },
  { direction: 'down', title: (a) => a.name + ' 核心高層突然離職', body: (a) => '公司尚未公布接任人選，外界擔心 ' + a.name + ' 的主要計畫將重新調整。' },
  { direction: 'down', title: (a, b) => b.name + ' 搶走 ' + a.name + ' 主要客戶', body: (a, b, money) => '一筆約 ' + money + ' 萬的合約轉由 ' + b.name + ' 承接，' + a.name + ' 尚未回應。' }
];

function pickTier(rnd) {
  let r = rnd();
  for (const tier of TIERS) { if (r < tier.weight) return tier; r -= tier.weight; }
  return TIERS[0];
}

/* 產生一則情報；live = 開盤中才會真的影響價格 */
function makeIntel(state, t, random, index, targetSymbol, live) {
  const rnd = rndOf(random);
  const defs = STOCKS.map((def) => state.stocks[def.symbol] || def);
  const requested = defs.findIndex((def) => def.symbol === targetSymbol);
  const ai = requested >= 0 ? requested : Math.min(defs.length - 1, Math.floor(rnd() * defs.length));
  let bi = Math.min(defs.length - 1, Math.floor(rnd() * (defs.length - 1)));
  if (bi >= ai) bi++;
  const a = defs[ai], b = defs[bi % defs.length];
  const dir = rnd() < upChance(a) ? 'up' : 'down';
  const event = pick(rnd, INTEL_EVENTS.filter((e) => e.direction === dir));
  const money = 800 + Math.floor(rnd() * 9200);
  const tier = pickTier(rnd);
  const size = round4(between(rnd, tier.lo, tier.hi));
  const rumor = rnd() < RUMOR_RATE;
  const truth = rnd() < RUMOR_TRUE_RATE;
  const baseTitle = event.title(a, b, money);
  const title = (rumor ? '傳聞：' : '') + baseTitle;
  const slot = intelSlotKey(t);
  const body = event.body(a, b, money) + (live
    ? (rumor ? '（消息來源未證實，稍後會揭曉真假）' : '')
    : '（休市期間消息，不影響開盤價）');
  return {
    news: {
      t, title: title.slice(0, 60), body, kind: 'intel', batch: slot, symbol: a.symbol, dir,
      tier: tier.id, cred: live ? (rumor ? 'rumor' : 'confirmed') : 'closed'
    },
    impact: live ? { symbol: a.symbol, dir, size, rumor, truth, title: title.slice(0, 60) } : null,
    signal: {
      id: 'intel-' + slot + '-' + (Number(index) || 0), slot, t, title: title.slice(0, 60), symbol: a.symbol,
      direction: dir, percent: round2(size * 100), tier: tier.id, rumor, truth: rumor ? truth : true,
      status: live ? 'auto' : 'closed',
      reason: live
        ? (rumor ? '傳聞（' + (truth ? '會被證實' : '會被澄清') + '），' : '確定消息，') + '總影響約 ' + (dir === 'up' ? '+' : '-') + round2(size * 100) + '%'
        : '休市消息，不影響價格'
    }
  };
}

function makeIntelBatch(state, t, random, live) {
  const rnd = rndOf(random);
  const symbols = STOCKS.map((stock) => stock.symbol);
  for (let i = symbols.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rnd() * (i + 1)));
    const tmp = symbols[i]; symbols[i] = symbols[j]; symbols[j] = tmp;
  }
  return symbols.map((symbol, index) => makeIntel(state, t, rnd, index, symbol, live));
}

/* 把一批情報的影響套進市場：
   確定消息：立刻反映 45%，之後 30–50 分鐘再走 -10%～+110%（平均約 50%，有時利多出盡）
   傳聞：先反映一半，30–60 分鐘後揭曉；證實會再走一段，被澄清會跌回去 */
function applyIntelImpacts(state, engine, batch, t, random) {
  const rnd = rndOf(random);
  batch.forEach((intel) => {
    const imp = intel.impact;
    if (!imp) return;
    const stock = state.stocks[imp.symbol];
    ensureDay(stock, t);
    const signed = imp.dir === 'up' ? imp.size : -imp.size;
    if (!imp.rumor) {
      addDrift(engine, state, imp.symbol, signed * 0.45, signed * between(rnd, -0.1, 1.1), intBetween(rnd, 6, 10), 'intel', t);
      return;
    }
    const phase1 = signed * 0.5;
    addDrift(engine, state, imp.symbol, phase1 * 0.5, phase1 * 0.5, 3, 'rumor', t);
    engine.rumors.push({
      id: nextId(engine, 'r'), symbol: imp.symbol, dir: imp.dir, size: imp.size, phase1: round4(phase1),
      truth: imp.truth, resolveAt: t + intBetween(rnd, 6, 12) * TICK_MS, day: shockDayKey(t), title: imp.title
    });
    if (engine.rumors.length > MAX_RUMORS) engine.rumors = engine.rumors.slice(-MAX_RUMORS);
  });
}

/* ---------- 帳戶 ---------- */

function normalizePortfolio(acc) {
  const raw = acc.market || {};
  const holdings = {};
  const positions = {};
  STOCKS.forEach((s) => {
    const h = raw.holdings && raw.holdings[s.symbol];
    const qty = Math.max(0, Math.floor(Number(h && h.qty) || 0));
    if (qty) holdings[s.symbol] = { qty, cost: Math.max(0, Math.round(Number(h.cost) || 0)) };
  });
  STOCKS.forEach((s) => {
    const p = raw.positions && raw.positions[s.symbol];
    const leverage = Math.floor(Number(p && p.leverage) || 0);
    const margin = Math.max(0, Math.round(Number(p && p.margin) || 0));
    const entryPrice = Math.max(0, Math.round(Number(p && p.entryPrice) || 0));
    if (p && margin && entryPrice && [2, 3, 5].includes(leverage) && (p.side === 'long' || p.side === 'short')) {
      positions[s.symbol] = {
        symbol: s.symbol, side: p.side, leverage, margin,
        notional: Math.max(margin * leverage, Math.round(Number(p.notional) || 0)),
        entryPrice, openedAt: Number(p.openedAt) || 0
      };
    }
  });
  acc.market = {
    holdings,
    positions,
    value: Math.max(0, Math.round(Number(raw.value) || 0)),
    realized: Math.round(Number(raw.realized) || 0),
    fees: Math.max(0, Math.round(Number(raw.fees) || 0))
  };
  return acc.market;
}

function positionRawEquity(position, state) {
  const stock = state.stocks[position.symbol];
  if (!stock || !position.entryPrice) return 0;
  const change = (stock.price - position.entryPrice) / position.entryPrice;
  const signed = position.side === 'long' ? change : -change;
  return Math.round(position.margin + position.notional * signed);
}

function positionEquity(position, state) {
  return Math.max(0, positionRawEquity(position, state));
}

function maintenanceMargin(position) {
  return Math.max(1, Math.ceil(position.margin * MAINTENANCE_MARGIN_RATE));
}

function shouldLiquidate(position, state) {
  return positionRawEquity(position, state) <= maintenanceMargin(position);
}

function leverageCloseFee(position, state) {
  return Math.max(1, Math.ceil(position.notional * state.feeRate));
}

function liquidationPrice(position) {
  const move = (1 - MAINTENANCE_MARGIN_RATE) / position.leverage;
  return Math.max(1, Math.round(position.entryPrice * (position.side === 'long' ? 1 - move : 1 + move)));
}

function portfolioValue(market, state) {
  let total = 0;
  const holdings = (market && market.holdings) || {};
  Object.keys(holdings).forEach((symbol) => {
    const stock = state.stocks[symbol];
    if (stock) total += Math.max(0, Math.floor(Number(holdings[symbol].qty) || 0)) * stock.price;
  });
  const positions = (market && market.positions) || {};
  Object.keys(positions).forEach((symbol) => { total += positionEquity(positions[symbol], state); });
  return Math.round(total);
}

/* 把爆倉的倉位移除，回傳流水帳 */
function liquidateBusted(acc, market, state) {
  const entries = [];
  Object.keys(market.positions).forEach((symbol) => {
    const position = market.positions[symbol];
    if (!shouldLiquidate(position, state)) return;
    const triggerEquity = positionEquity(position, state);
    market.realized -= position.margin;
    delete market.positions[symbol];
    entries.push({
      type: 'market_liquidation', amount: -position.margin,
      wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans,
      note: symbol + ' ' + position.leverage + '× ' + (position.side === 'long' ? '做多' : '做空') + ' 已爆倉；觸發權益 ' + triggerEquity + '，整筆保證金歸零'
    });
  });
  return entries;
}

/* 星期五收盤：一般持股按收盤價賣出（跟手動賣出一樣收 1% 手續費），槓桿先判爆倉再扣平倉費 */
function settlePortfolio(acc, state, cfg, t) {
  const market = normalizePortfolio(acc);
  const holdingSymbols = Object.keys(market.holdings);
  const positionSymbols = Object.keys(market.positions);
  if (!holdingSymbols.length && !positionSymbols.length) {
    market.value = 0;
    E.refresh(acc, cfg, t);
    return { changed: false, credited: 0, stockValue: 0, stockFees: 0, leverageEquity: 0, leverageFees: 0, pnl: 0, repayEntries: [] };
  }
  let stockValue = 0, stockCost = 0, stockFees = 0, leverageEquity = 0, leverageMargin = 0, leverageFees = 0;
  holdingSymbols.forEach((symbol) => {
    const holding = market.holdings[symbol], stock = state.stocks[symbol];
    if (!stock) return;
    const gross = holding.qty * stock.price;
    stockValue += gross;
    stockFees += Math.max(1, Math.ceil(gross * state.feeRate));
    stockCost += holding.cost;
  });
  positionSymbols.forEach((symbol) => {
    const position = market.positions[symbol];
    leverageMargin += position.margin;
    if (shouldLiquidate(position, state)) return;
    const grossEquity = positionEquity(position, state);
    const fee = Math.min(grossEquity, leverageCloseFee(position, state));
    leverageFees += fee;
    leverageEquity += Math.max(0, grossEquity - fee);
  });
  const stockNet = Math.max(0, stockValue - stockFees);
  const credited = Math.max(0, Math.round(stockNet + leverageEquity));
  const pnl = Math.round((stockNet - stockCost) + (leverageEquity - leverageMargin));
  acc.wallet += credited;
  market.realized += pnl;
  market.fees += leverageFees + stockFees;
  market.holdings = {};
  market.positions = {};
  market.value = 0;
  const closeWallet = acc.wallet;
  const repayEntries = E.autoRepay(acc, cfg, t);
  E.refresh(acc, cfg, t);
  return { changed: true, credited, stockValue, stockFees, leverageEquity, leverageFees, pnl, closeWallet, repayEntries };
}

/* ---------- Firestore ---------- */

async function runLimited(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  });
  await Promise.all(workers);
}

function createMarket({ db, now, requireSession, requireAdmin, mutate }) {
  const ref = () => db.collection('market').doc('main');
  const signalsRef = () => db.collection('marketAdmin').doc('signals');
  const engineRef = () => db.collection('marketAdmin').doc('engine');

  function marketTxnMeta() {
    return {
      load: async (tx, ctx) => {
        const snap = await tx.get(ref());
        return { market: normalizeState(snap.exists ? snap.data() : null, ctx.t) };
      },
      write: async (tx, extra) => { tx.set(ref(), extra.market); }
    };
  }

  /* 只讀：在同一個 transaction 裡讀行情，避免帳戶跟行情不同步 */
  function marketReadMeta() {
    return {
      load: async (tx, ctx) => {
        const snap = await tx.get(ref());
        return { market: normalizeState(snap.exists ? snap.data() : null, ctx.t) };
      }
    };
  }

  async function syncSupplyTotals(totals) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref());
      const state = normalizeState(snap.exists ? snap.data() : null, now());
      STOCKS.forEach((def) => { applySupply(state.stocks[def.symbol], totals[def.symbol] || 0); });
      tx.set(ref(), state);
    });
  }

  async function syncSupply(t) {
    const at = Number(t) || now();
    const sid = seasonId(at);
    const accSnap = await db.collection('seasons').doc(sid).collection('accounts').get();
    const totals = {};
    STOCKS.forEach((stock) => { totals[stock.symbol] = 0; });
    accSnap.forEach((doc) => {
      const market = normalizePortfolio(doc.data());
      Object.keys(market.holdings).forEach((symbol) => {
        totals[symbol] = (totals[symbol] || 0) + market.holdings[symbol].qty;
      });
    });
    await syncSupplyTotals(totals);
    return { ok: true, sid, accounts: accSnap.size, totals };
  }

  async function getState() {
    const snap = await ref().get();
    if (snap.exists) return normalizeState(snap.data(), now());
    const state = freshState(now());
    try { await ref().create(state); } catch (e) {
      const latest = await ref().get();
      if (latest.exists) return normalizeState(latest.data(), now());
      throw e;
    }
    return state;
  }

  /* 每個有市場資產的帳戶各自用一個 transaction 重算：
     讀到的是最新帳戶，不會把同一時間玩家剛完成的交易蓋掉。 */
  async function refreshPortfolios(state) {
    const t = now();
    const sid = seasonId(t);
    const [cfgSnap, accSnap] = await Promise.all([
      db.collection('config').doc('app').get(),
      db.collection('seasons').doc(sid).collection('accounts').get()
    ]);
    const cfg = E.cfgOf(cfgSnap.exists ? cfgSnap.data() : null);
    const targets = accSnap.docs.filter((doc) => {
      const m = doc.data().market || {};
      return Object.keys(m.holdings || {}).length || Object.keys(m.positions || {}).length || Number(m.value);
    });
    let count = 0, liquidations = 0;
    await runLimited(targets, 6, async (doc) => {
      try {
        const n = await db.runTransaction(async (tx) => {
          const playerRef = db.collection('players').doc(doc.id);
          const [snap, playerSnap] = await Promise.all([tx.get(doc.ref), tx.get(playerRef)]);
          if (!snap.exists) return 0;
          const acc = snap.data();
          const market = normalizePortfolio(acc);
          const before = market.value;
          const entries = liquidateBusted(acc, market, state);
          const value = portfolioValue(market, state);
          if (!entries.length && value === before) return 0;   // 價格沒變就不寫，省寫入
          market.value = value;
          E.refresh(acc, cfg, t);
          tx.update(doc.ref, { market, net: acc.net, peakNet: acc.peakNet, updatedAt: t });
          entries.forEach((entry) => tx.set(doc.ref.collection('ledger').doc(), Object.assign(entry, { at: t, by: 'system' })));
          const player = playerSnap.exists ? playerSnap.data() : null;
          if (player && acc.peakNet > ((player.stats && player.stats.peakNet) || 0)) {
            tx.update(playerRef, { 'stats.peakNet': acc.peakNet, 'stats.peakNetSeason': sid });
          }
          return entries.length;
        });
        count++; liquidations += n;
      } catch (e) {
        console.error('refresh account failed', doc.id, e && e.message);
      }
    });
    return { accounts: count, liquidations };
  }

  async function state(req) {
    const session = await requireSession(req);
    let marketState = null;
    const result = await mutate(session.pid, (acc, cfg, t, rawCfg, pl, setPlayer, extra) => {
      marketState = extra.market;
      const market = normalizePortfolio(acc);
      const entries = liquidateBusted(acc, market, marketState);
      market.value = portfolioValue(market, marketState);
      return entries;
    }, marketReadMeta());
    return { market: marketState, marketOpen: isMarketOpen(now()), account: result.account };
  }

  async function trade(req) {
    const session = await requireSession(req);
    if (!isMarketOpen(now())) throw new AppError('目前已收盤，交易時間是週一到週五 07:00–17:30（17:00 後為盤後交易）', 'market-closed');
    const d = req.data || {};
    const symbol = String(d.symbol || '').toUpperCase();
    const side = String(d.side || '').toLowerCase();
    const qty = Math.floor(Number(d.qty));
    if (!STOCKS.some((s) => s.symbol === symbol)) throw new AppError('找不到這支股票', 'bad-stock', 'invalid-argument');
    if (side !== 'buy' && side !== 'sell') throw new AppError('交易方向錯誤', 'bad-side', 'invalid-argument');
    if (!Number.isFinite(qty) || qty < 1 || qty > 1000) throw new AppError('每次交易股數要在 1 到 1000 之間', 'bad-qty', 'invalid-argument');
    let tradeInfo = null;
    const result = await mutate(session.pid, (acc, cfg, t, rawCfg, pl, setPlayer, extra) => {
      const marketState = extra.market;
      const stock = marketState.stocks[symbol];
      const gross = stock.price * qty;
      const fee = Math.max(1, Math.ceil(gross * marketState.feeRate));
      const market = normalizePortfolio(acc);
      const old = market.holdings[symbol] || { qty: 0, cost: 0 };
      if (side === 'buy') {
        const total = gross + fee;
        if (acc.wallet < total) throw new AppError('錢包餘額不足', 'no-money');
        if (old.qty + qty > 5000) throw new AppError('單支股票最多持有 5000 股', 'holding-limit');
        const available = Math.max(0, stock.playerLimit - stock.playerShares);
        if (qty > available) throw new AppError('市場只剩 ' + available + ' 股可供玩家持有；系統必須保留至少 70%', 'market-supply');
        acc.wallet -= total;
        market.holdings[symbol] = { qty: old.qty + qty, cost: old.cost + total };
        market.fees += fee;
        applySupply(stock, stock.playerShares + qty);
        stock.buyVolume = round2(stock.buyVolume + qty);
      } else {
        if (old.qty < qty) throw new AppError('持股不足，不能賣出', 'no-shares');
        const basis = Math.round(old.cost * qty / old.qty);
        const net = gross - fee;
        acc.wallet += net;
        market.realized += net - basis;
        market.fees += fee;
        const left = old.qty - qty;
        if (left) market.holdings[symbol] = { qty: left, cost: Math.max(0, old.cost - basis) };
        else delete market.holdings[symbol];
        applySupply(stock, Math.max(0, stock.playerShares - qty));
        stock.sellVolume = round2(stock.sellVolume + qty);
      }
      market.value = portfolioValue(market, marketState);
      tradeInfo = { side, symbol, qty, price: stock.price, fee };
      return [{
        type: side === 'buy' ? 'market_buy' : 'market_sell',
        amount: side === 'buy' ? -(gross + fee) : (gross - fee),
        wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans,
        note: stock.name + ' ' + qty + ' 股 @ ' + stock.price
      }];
    }, marketTxnMeta());
    return Object.assign({ ok: true, market: result.extra.market, account: result.account }, tradeInfo);
  }

  async function leverageOpen(req) {
    const session = await requireSession(req);
    if (!isMarketOpen(now())) throw new AppError('目前已收盤，交易時間是週一到週五 07:00–17:30（17:00 後為盤後交易）', 'market-closed');
    const d = req.data || {};
    const symbol = String(d.symbol || '').toUpperCase();
    const side = String(d.side || '').toLowerCase();
    const leverage = Math.floor(Number(d.leverage));
    const margin = Math.floor(Number(d.margin));
    if (!STOCKS.some((s) => s.symbol === symbol)) throw new AppError('找不到這支股票', 'bad-stock', 'invalid-argument');
    if (side !== 'long' && side !== 'short') throw new AppError('請選擇做多或做空', 'bad-side', 'invalid-argument');
    if (![2, 3, 5].includes(leverage)) throw new AppError('槓桿只開放 2×、3×、5×', 'bad-leverage', 'invalid-argument');
    if (!Number.isFinite(margin) || margin < 100 || margin > MAX_LEVERAGE_MARGIN) throw new AppError('保證金要在 100 到 ' + MAX_LEVERAGE_MARGIN.toLocaleString('en-US') + ' 之間', 'bad-margin', 'invalid-argument');
    let opened = null;
    const result = await mutate(session.pid, (acc, cfg, t, rawCfg, pl, setPlayer, extra) => {
      const marketState = extra.market;
      const stock = marketState.stocks[symbol];
      const notional = margin * leverage;
      const fee = Math.max(1, Math.ceil(notional * marketState.feeRate));
      const market = normalizePortfolio(acc);
      if (market.positions[symbol]) throw new AppError('這支股票已經有槓桿倉位，請先平倉', 'position-exists');
      if (Object.keys(market.positions).length >= MAX_LEVERAGE_POSITIONS) throw new AppError('同時最多持有 ' + MAX_LEVERAGE_POSITIONS + ' 個槓桿倉位', 'position-limit');
      if (acc.wallet < margin + fee) throw new AppError('錢包不足以支付保證金和手續費', 'no-money');
      acc.wallet -= margin + fee;
      market.fees += fee;
      market.positions[symbol] = { symbol, side, leverage, margin, notional, entryPrice: stock.price, openedAt: t };
      market.value = portfolioValue(market, marketState);
      opened = { notional, fee };
      return [{
        type: 'market_leverage_open', amount: -(margin + fee),
        wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans,
        note: symbol + ' ' + leverage + '× ' + (side === 'long' ? '做多' : '做空') + ' @ ' + stock.price
      }];
    }, marketTxnMeta());
    return { ok: true, symbol, side, leverage, margin, notional: opened.notional, fee: opened.fee, liquidationPrice: liquidationPrice(result.account.market.positions[symbol]), market: result.extra.market, account: result.account };
  }

  async function leverageClose(req) {
    const session = await requireSession(req);
    if (!isMarketOpen(now())) throw new AppError('目前已收盤，交易時間是週一到週五 07:00–17:30（17:00 後為盤後交易）', 'market-closed');
    const symbol = String((req.data && req.data.symbol) || '').toUpperCase();
    if (!STOCKS.some((s) => s.symbol === symbol)) throw new AppError('找不到這支股票', 'bad-stock', 'invalid-argument');
    let closed = null;
    const result = await mutate(session.pid, (acc, cfg, t, rawCfg, pl, setPlayer, extra) => {
      const marketState = extra.market;
      const market = normalizePortfolio(acc);
      const position = market.positions[symbol];
      if (!position) throw new AppError('找不到這個槓桿倉位', 'no-position');
      const grossEquity = positionEquity(position, marketState);
      const liquidated = shouldLiquidate(position, marketState);
      const fee = liquidated ? 0 : Math.min(grossEquity, leverageCloseFee(position, marketState));
      const equity = liquidated ? 0 : Math.max(0, grossEquity - fee);
      const pnl = liquidated ? -position.margin : equity - position.margin;
      acc.wallet += equity;
      market.realized += pnl;
      market.fees += fee;
      delete market.positions[symbol];
      market.value = portfolioValue(market, marketState);
      closed = { equity, grossEquity, fee, pnl, liquidated, position };
      return [{
        type: liquidated ? 'market_liquidation' : 'market_leverage_close', amount: liquidated ? -position.margin : equity,
        wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans,
        note: liquidated
          ? symbol + ' ' + position.leverage + '× 已爆倉；觸發權益 ' + grossEquity + '，整筆保證金歸零'
          : symbol + ' ' + position.leverage + '× 平倉，手續費 ' + fee + '，損益 ' + (pnl >= 0 ? '+' : '') + pnl
      }];
    }, marketTxnMeta());
    return { ok: true, symbol, equity: closed.equity, grossEquity: closed.grossEquity, fee: closed.fee, pnl: closed.pnl, liquidated: closed.liquidated, market: result.extra.market, account: result.account };
  }

  /* 管理員調價
     mode 'instant'：立刻漲跌 0.5–10%，不發新聞（玩家只看得到價格動）
     mode 'news'   ：發一則快訊，1–15% 在 3–12 次更新內逐步反映（取代舊的寫死一次性事件） */
  async function adminMove(req) {
    const admin = await requireAdmin(req);
    const d = req.data || {};
    const symbol = String(d.symbol || '').toUpperCase();
    const direction = String(d.direction || '').toLowerCase();
    const percent = Number(d.percent);
    const mode = d.mode === 'news' ? 'news' : 'instant';
    const ticks = clamp(Math.floor(Number(d.ticks) || 6), 3, 12);
    const title = String(d.title || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
    const signalId = d.signalId ? String(d.signalId).slice(0, 40) : null;
    if (!STOCKS.some((s) => s.symbol === symbol)) throw new AppError('找不到這支股票', 'bad-stock', 'invalid-argument');
    if (direction !== 'up' && direction !== 'down') throw new AppError('請選擇上漲或下跌', 'bad-direction', 'invalid-argument');
    const maxPct = mode === 'news' ? 15 : 10;
    const minPct = mode === 'news' ? 1 : 0.5;
    if (!Number.isFinite(percent) || percent < minPct || percent > maxPct) throw new AppError('調整幅度要在 ' + minPct + '% 到 ' + maxPct + '% 之間', 'bad-percent', 'invalid-argument');
    let result, moved = 0;
    await db.runTransaction(async (tx) => {
      const [snap, engSnap] = await Promise.all([tx.get(ref()), tx.get(engineRef())]);
      const t = now();
      const state = normalizeState(snap.exists ? snap.data() : null, t);
      const engine = normalizeEngine(engSnap.exists ? engSnap.data() : null, t);
      const stock = state.stocks[symbol];
      ensureDay(stock, t);
      const signed = (direction === 'up' ? 1 : -1) * percent / 100;
      if (mode === 'instant') {
        // 管理員立即調價不受單次 7% 限制，但仍受每日漲跌停限制
        const band = dayBand(stock);
        const old = stock.price;
        stock.exact = round4(clamp(stock.exact * (1 + signed), band.lo, band.hi));
        stock.fair = clampFair(stock, stock.fair * (1 + signed), band);
        stock.previous = old;
        stock.price = Math.max(5, Math.round(stock.exact));
        pushHistory(stock, t);
        moved = (stock.price - old) / old;
      } else {
        moved = addDrift(engine, state, symbol, signed * 0.3, signed * 0.7, ticks, 'admin', t);
        pushNews(state, [newsRow(t, {
          title: '【快訊】' + (title || (stock.name + ' 發布重大公告')),
          body: '預估影響 ' + (direction === 'up' ? '+' : '-') + percent + '%，約三成立刻反映，其餘在接下來 ' + (ticks * 5) + ' 分鐘內反映。',
          kind: 'market', batch: 'event-' + shockDayKey(t), symbol, dir: direction, tier: 'event', cred: 'admin'
        })]);
      }
      state.updatedAt = t;
      tx.set(ref(), state);
      tx.set(engineRef(), engine);
      result = state;
    });
    const refreshed = await refreshPortfolios(result);
    if (signalId) await markSignal(signalId, admin.pid, direction, percent).catch(() => {});
    return { ok: true, by: admin.pid, mode, moved: round4(moved), refreshed, market: result };
  }

  async function markSignal(id, pid, direction, percent) {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(signalsRef());
      if (!snap.exists) return false;
      let found = false;
      const rows = (snap.data().rows || []).map((row) => {
        if (row.id !== id) return row;
        found = true;
        return Object.assign({}, row, { status: 'applied', appliedAt: now(), appliedBy: pid, appliedDirection: direction, appliedPercent: percent });
      });
      if (found) tx.update(signalsRef(), { rows, updatedAt: now() });
      return found;
    });
  }

  /* 管理員看得到：最新情報（含傳聞真假）、今天的大事件排程、還沒揭曉的傳聞 */
  async function adminSignals(req) {
    await requireAdmin(req);
    const [snap, engSnap] = await Promise.all([signalsRef().get(), engineRef().get()]);
    const data = snap.exists ? snap.data() : {};
    const rows = Array.isArray(data.rows) ? data.rows.slice(0, 150) : [];
    const engine = normalizeEngine(engSnap.exists ? engSnap.data() : null, now());
    const today = shockDayKey(now());
    const events = engine.day === today ? engine.events.map((e) => ({
      symbol: e.symbol, dir: e.dir, percent: round2(e.size * 100), time: slotClock(e.slot), hintTime: slotClock(e.hintSlot),
      hintDir: e.hintDir, hinted: !!e.hinted, applied: !!e.applied, headline: e.headline
    })) : [];
    const rumors = engine.rumors.map((r) => ({ symbol: r.symbol, title: r.title, truth: r.truth, resolveAt: r.resolveAt }));
    return { rows, latestSlot: String(data.latestSlot || (rows[0] && rows[0].slot) || ''), events, rumors };
  }

  async function closeWeek(t) {
    const at = Number(t) || now();
    const sid = seasonId(at);
    const runRef = db.collection('seasons').doc(sid).collection('marketRuns').doc('friday-close');
    const existing = await runRef.get();
    if (existing.exists && existing.data().status === 'completed') {
      return Object.assign({ skipped: true, sid }, existing.data());
    }
    const marketState = await getState();
    const savedPrices = existing.exists && existing.data().prices ? existing.data().prices : null;
    const prices = {};
    STOCKS.forEach((stock) => {
      const saved = savedPrices && Number(savedPrices[stock.symbol]);
      if (saved > 0) marketState.stocks[stock.symbol].price = Math.round(saved);
      prices[stock.symbol] = marketState.stocks[stock.symbol].price;
    });
    await runRef.set({ status: 'running', sid, startedAt: at, prices }, { merge: true });
    const [cfgSnap, accSnap] = await Promise.all([
      db.collection('config').doc('app').get(),
      db.collection('seasons').doc(sid).collection('accounts').get()
    ]);
    const cfg = E.cfgOf(cfgSnap.exists ? cfgSnap.data() : null);
    let accounts = 0, credited = 0, pnl = 0;
    for (const accountDoc of accSnap.docs) {
      const result = await db.runTransaction(async (tx) => {
        const playerRef = db.collection('players').doc(accountDoc.id);
        const [accLatest, playerSnap] = await Promise.all([tx.get(accountDoc.ref), tx.get(playerRef)]);
        if (!accLatest.exists) return null;
        const acc = accLatest.data();
        const settled = settlePortfolio(acc, marketState, cfg, at);
        if (!settled.changed) return null;
        tx.set(accountDoc.ref, acc);
        tx.set(accountDoc.ref.collection('ledger').doc(), {
          type: 'market_weekly_close', amount: settled.credited,
          wallet: settled.closeWallet, bank: acc.bank.balance, loans: acc.loans,
          at, by: 'system',
          note: '星期五收盤自動結算：股票 ' + settled.stockValue + '（手續費 ' + settled.stockFees + '）、槓桿淨權益 ' + settled.leverageEquity + '（平倉費 ' + settled.leverageFees + '）、損益 ' + (settled.pnl >= 0 ? '+' : '') + settled.pnl
        });
        settled.repayEntries.forEach((entry) => {
          tx.set(accountDoc.ref.collection('ledger').doc(), Object.assign({}, entry, { at, by: 'system', note: '收盤結算後自動還款' }));
        });
        const player = playerSnap.exists ? playerSnap.data() : null;
        if (player && acc.peakNet > ((player.stats && player.stats.peakNet) || 0)) {
          tx.update(playerRef, { 'stats.peakNet': acc.peakNet, 'stats.peakNetSeason': sid });
        }
        return settled;
      });
      if (result) { accounts++; credited += result.credited; pnl += result.pnl; }
    }
    await syncSupplyTotals({});
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref());
      const state = normalizeState(snap.exists ? snap.data() : null, at);
      state.lastWeeklyClose = { sid, at, accounts, credited, pnl };
      tx.set(ref(), state);
    });
    const output = { status: 'completed', sid, completedAt: now(), accounts, credited, pnl, prices };
    await runRef.set(output, { merge: true });
    return output;
  }

  async function publishIntel(t, random) {
    const at = Number(t) || now();
    if (!isIntelWindow(at)) {
      return { skipped: true, reason: 'outside-intel-window', updatedAt: at };
    }
    const live = isMarketOpen(at);
    let output;
    await db.runTransaction(async (tx) => {
      const [marketSnap, signalSnap, engSnap] = await Promise.all([tx.get(ref()), tx.get(signalsRef()), tx.get(engineRef())]);
      const state = normalizeState(marketSnap.exists ? marketSnap.data() : null, at);
      const engine = normalizeEngine(engSnap.exists ? engSnap.data() : null, at);
      const oldRows = signalSnap.exists && Array.isArray(signalSnap.data().rows) ? signalSnap.data().rows : [];
      const slot = intelSlotKey(at);
      const oldBatch = oldRows.filter((row) => row.slot === slot);
      if (oldBatch.length >= 5) { output = { skipped: true, slot, signals: oldBatch.slice(0, 5) }; return; }
      if (live) rollEngineDay(engine, state, at, random);
      const batch = makeIntelBatch(state, at, random, live);
      if (live) applyIntelImpacts(state, engine, batch, at, random);
      const news = batch.map((intel) => intel.news);
      const signals = batch.map((intel) => intel.signal);
      state.latestIntelSlot = slot;
      state.news = news.concat(state.news).slice(0, 150);
      state.updatedAt = at;
      tx.set(ref(), state);
      tx.set(engineRef(), engine);
      tx.set(signalsRef(), { rows: signals.concat(oldRows.filter((row) => row.slot !== slot)).slice(0, 150), latestSlot: slot, updatedAt: at });
      output = { skipped: false, live, slot, news, signals, state };
    });
    // 開盤中的情報會立刻動到價格，順手同步持倉資產與爆倉
    if (output && !output.skipped && output.live) output.refreshed = await refreshPortfolios(output.state);
    if (output) delete output.state;
    return output;
  }

  /* 交易日前置：開盤前先建立當天事件排程，讓新聞台能在 07:00 前完成晨間版面。 */
  async function prepareDay(t, random) {
    const at = Number(t) || now();
    const d = new Date(at + TW_OFFSET);
    const weekday = d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
    if (!weekday) return { skipped: true, reason: 'weekend', updatedAt: at };
    let output;
    await db.runTransaction(async (tx) => {
      const [marketSnap, engineSnap] = await Promise.all([tx.get(ref()), tx.get(engineRef())]);
      const state = normalizeState(marketSnap.exists ? marketSnap.data() : null, at);
      const engine = normalizeEngine(engineSnap.exists ? engineSnap.data() : null, at);
      const changed = rollEngineDay(engine, state, at, random);
      if (changed) tx.set(engineRef(), engine);
      output = {
        skipped: !changed, day: engine.day,
        events: engine.events.map((e) => ({ id: e.id, symbol: e.symbol, hintSlot: e.hintSlot, slot: e.slot })),
        updatedAt: at
      };
    });
    return output;
  }

  async function tick(t) {
    const at = Number(t) || now();
    if (!isMarketOpen(at)) return { ok: true, skipped: true, reason: 'market-closed', updatedAt: at };
    let result, scheduled = [];
    await db.runTransaction(async (tx) => {
      const [snap, engSnap] = await Promise.all([tx.get(ref()), tx.get(engineRef())]);
      const engineRaw = engSnap.exists ? engSnap.data() : null;
      // 同一個 5 分鐘格子已經跑過（排程重試）就不再動價格，避免重複套用消息
      if (engineRaw && Number(engineRaw.lastTickSlot) === Math.floor(at / TICK_MS) && snap.exists) {
        result = normalizeState(snap.data(), at); scheduled = null; return;
      }
      const out = tickState(snap.exists ? snap.data() : null, at, null, engineRaw);
      out.engine.lastTickSlot = Math.floor(at / TICK_MS);
      result = out.state;
      scheduled = out.scheduled;
      tx.set(ref(), result);
      tx.set(engineRef(), out.engine);
    });
    if (scheduled === null) return { ok: true, skipped: true, reason: 'duplicate-tick', updatedAt: at };
    const refreshed = await refreshPortfolios(result);
    return { ok: true, refreshed, scheduled: scheduled.map((n) => n.title), updatedAt: result.updatedAt };
  }

  return { state, trade, leverageOpen, leverageClose, adminMove, adminSignals, publishIntel, prepareDay, tick, closeWeek, syncSupply, getState, refreshPortfolios };
}

module.exports = {
  createMarket, freshState, normalizeState, normalizePortfolio, portfolioValue, settlePortfolio,
  positionRawEquity, positionEquity, maintenanceMargin, shouldLiquidate, leverageCloseFee, liquidationPrice,
  isMarketOpen, isIntelWindow, tickState, shockDayKey, shockSlot, slotClock, buildEventPlan, rollEngineDay, runScheduled,
  normalizeEngine, freshEngine, addDrift, moveStock, ensureDay, dayBand, upChance, applyIntelImpacts,
  makeIntel, makeIntelBatch, intelSlotKey, liquidateBusted, STOCKS, TIERS,
  TOTAL_SHARES, PLAYER_SHARE_RATE, HISTORY_LIMIT, MAINTENANCE_MARGIN_RATE,
  MAX_LEVERAGE_MARGIN, MAX_LEVERAGE_POSITIONS, TICK_CAP, EVENT_TICK_CAP, DAY_LIMIT, REVERT_RATE,
  PRESSURE_DEPTH, PRESSURE_MAX, EVENT_MIN_PER_DAY, EVENT_MAX_PER_DAY,
  EVENT_SIZE_MIN, EVENT_SIZE_MAX, EVENT_LOW_MIN, EVENT_LOW_MAX, EVENT_LOW_RATE,
  HINT_ACCURACY, RUMOR_RATE, RUMOR_TRUE_RATE
};
