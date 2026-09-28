'use strict';

const assert = require('assert');
const E = require('./core/econ');
const M = require('./core/market');
const {
  freshState, positionRawEquity, positionEquity, maintenanceMargin,
  shouldLiquidate, leverageCloseFee, liquidationPrice, settlePortfolio,
  tickState, buildEventPlan, freshEngine, normalizeEngine, makeIntelBatch, applyIntelImpacts, intelSlotKey, isIntelWindow,
  rollEngineDay, runScheduled, moveStock, ensureDay, STOCKS,
  MAINTENANCE_MARGIN_RATE, MAX_LEVERAGE_MARGIN, MAX_LEVERAGE_POSITIONS, TICK_CAP, EVENT_TICK_CAP, DAY_LIMIT,
  EVENT_MIN_PER_DAY, EVENT_MAX_PER_DAY, EVENT_SIZE_MIN, EVENT_SIZE_MAX, EVENT_LOW_MIN, EVENT_LOW_MAX
} = M;

function seeded(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

const TICK = 300000;
const MON_0700 = Date.UTC(2026, 9, 4, 23, 0, 0);   // 2026-10-05（一）07:00 台灣
const SAT_1000 = Date.UTC(2026, 9, 10, 2, 0, 0);   // 2026-10-10（六）10:00 台灣
const t = Date.UTC(2026, 8, 28, 1, 0, 0);
const state = freshState(t);
state.feeRate = 0.01;
state.stocks.TKN.price = 100;

function position(side, leverage) {
  return { symbol: 'TKN', side, leverage, margin: 1000, notional: 1000 * leverage, entryPrice: 100, openedAt: t };
}

/* ---------- 槓桿公式（沿用） ---------- */
assert.strictEqual(MAINTENANCE_MARGIN_RATE, 0.6);
assert.strictEqual(MAX_LEVERAGE_MARGIN, 100000);
assert.strictEqual(MAX_LEVERAGE_POSITIONS, 3);
assert.ok(TICK_CAP < (1 - MAINTENANCE_MARGIN_RATE) / 5, '一般行情單次上限必須小於 5× 爆倉距離');

const long5 = position('long', 5);
assert.strictEqual(maintenanceMargin(long5), 600);
assert.strictEqual(liquidationPrice(long5), 92);
state.stocks.TKN.price = 93;
assert.strictEqual(positionRawEquity(long5, state), 650);
assert.strictEqual(shouldLiquidate(long5, state), false);
state.stocks.TKN.price = 92;
assert.strictEqual(shouldLiquidate(long5, state), true);

const short5 = position('short', 5);
assert.strictEqual(liquidationPrice(short5), 108);
state.stocks.TKN.price = 107;
assert.strictEqual(positionEquity(short5, state), 650);
state.stocks.TKN.price = 108;
assert.strictEqual(shouldLiquidate(short5, state), true);

state.stocks.TKN.price = 104;
assert.strictEqual(positionEquity(long5, state), 1200);
assert.strictEqual(leverageCloseFee(long5, state), 50);

/* ---------- 星期五結算：槓桿 + 一般持股賣出手續費 ---------- */
const cfg = E.cfgOf(null);
const winning = E.newAccount('test-win', cfg, t);
winning.wallet = 0;
winning.market = { holdings: {}, positions: { TKN: long5 }, value: 1200, realized: 0, fees: 50 };
const winResult = settlePortfolio(winning, state, cfg, t);
assert.strictEqual(winResult.leverageEquity, 1150);
assert.strictEqual(winResult.leverageFees, 50);
assert.strictEqual(winResult.credited, 1150);
assert.strictEqual(winResult.pnl, 150);
assert.strictEqual(winning.market.fees, 100);

const holder = E.newAccount('test-hold', cfg, t);
holder.wallet = 0;
holder.market = { holdings: { TKN: { qty: 10, cost: 1010 } }, positions: {}, value: 1040, realized: 0, fees: 10 };
const holdResult = settlePortfolio(holder, state, cfg, t);
assert.strictEqual(holdResult.stockValue, 1040);
assert.strictEqual(holdResult.stockFees, 11);        // ceil(1040 × 1%)
assert.strictEqual(holdResult.credited, 1029);
assert.strictEqual(holdResult.pnl, 19);
assert.strictEqual(holder.wallet, 1029);

state.stocks.TKN.price = 92;
const busted = E.newAccount('test-bust', cfg, t);
busted.wallet = 0;
busted.market = { holdings: {}, positions: { TKN: long5 }, value: 600, realized: 0, fees: 50 };
const bustResult = settlePortfolio(busted, state, cfg, t);
assert.strictEqual(bustResult.credited, 0);
assert.strictEqual(bustResult.pnl, -1000);

/* ---------- 一般 5 分鐘更新：小雜訊、單次上限、漲跌停 ---------- */
{
  const rnd = seeded(1);
  let s = freshState(MON_0700 - TICK), engine = null;
  for (let i = 0; i < 20; i++) {
    const out = tickState(s, MON_0700 + i * TICK, rnd, engine);
    Object.values(out.state.stocks).forEach((st) => {
      assert.ok(Math.abs(st.exact / (st.history[st.history.length - 2] || { p: st.exact }).p - 1) < EVENT_TICK_CAP + 0.02, '單次漲跌不應超過上限');
      assert.ok(st.price <= st.limitUp && st.price >= st.limitDown, '價格必須在漲跌停內');
    });
    s = out.state; engine = out.engine;
  }
  assert.strictEqual(s.stocks.TKN.dayKey, '20261005');
  assert.strictEqual(s.version, 2);
}

/* 就算消息一直推，也不能超過每日漲跌停 */
{
  const s = freshState(MON_0700);
  const stock = s.stocks.TKN;
  ensureDay(stock, MON_0700);
  for (let i = 0; i < 10; i++) moveStock(stock, 0.07, 0.07, MON_0700 + i);
  assert.ok(stock.price <= Math.round(128 * (1 + DAY_LIMIT)));
  assert.strictEqual(stock.price, stock.limitUp);
  assert.ok(stock.fair <= 128 * (1 + DAY_LIMIT) + 0.01, '公允價也要被漲停鎖住，避免隔天可預測的跳空');
}

/* ---------- 大事件排程：2–4 次、先有風聲、不同股票 ---------- */
const eventCounts = new Set();
let sawLowEvent = false, sawMainEvent = false;
for (let seed = 1; seed < 60; seed++) {
  const s = freshState(MON_0700);
  const events = buildEventPlan(s, MON_0700, seeded(seed), freshEngine(MON_0700));
  eventCounts.add(events.length);
  assert.ok(events.length >= EVENT_MIN_PER_DAY && events.length <= EVENT_MAX_PER_DAY);
  assert.strictEqual(new Set(events.map((e) => e.symbol)).size, events.length);
  events.forEach((e) => {
    assert.ok(e.slot >= 18 && e.slot <= 108, '大事件在 08:30–16:00');
    assert.ok(e.hintSlot < e.slot && e.slot - e.hintSlot >= 6, '風聲至少提早 30 分鐘');
    const low = e.size >= EVENT_LOW_MIN && e.size <= EVENT_LOW_MAX;
    const main = e.size >= EVENT_SIZE_MIN && e.size <= EVENT_SIZE_MAX;
    assert.ok(low || main, '事件幅度必須約 20%，或落在 30%～50%');
    sawLowEvent = sawLowEvent || low;
    sawMainEvent = sawMainEvent || main;
  });
}
assert.deepStrictEqual([...eventCounts].sort(), [2, 3, 4]);
assert.ok(sawLowEvent && sawMainEvent, '測試樣本必須同時涵蓋低幅與主要事件');
assert.notStrictEqual(intelSlotKey(MON_0700 + 60 * 60000), intelSlotKey(MON_0700 + 90 * 60000), '08:00 與 08:30 必須是不同情報批次');
assert.strictEqual(isIntelWindow(MON_0700 + 60 * 60000), true);
assert.strictEqual(isIntelWindow(MON_0700 + 90 * 60000), true);
assert.strictEqual(isIntelWindow(MON_0700 + 9 * 60 * 60000), true);
assert.strictEqual(isIntelWindow(MON_0700 + 9.5 * 60 * 60000), false, '16:30 不應發布情報');

/* 大事件爆出那一次更新：方向正確、幅度受 ±10% 限制，並且有新聞 */
{
  const s = freshState(MON_0700);
  STOCKS.forEach((def) => ensureDay(s.stocks[def.symbol], MON_0700));
  const engine = freshEngine(MON_0700);
  rollEngineDay(engine, s, MON_0700, seeded(3));
  const ev = engine.events[0];
  ev.dir = 'up'; ev.size = 0.4; ev.hintSlot = 1; ev.slot = 2;
  const before = s.stocks[ev.symbol].price;
  const hintNews = runScheduled(s, engine, MON_0700 + TICK, seeded(4));
  assert.ok(hintNews.some((n) => n.cred === 'hint' && n.symbol === ev.symbol));
  let out = tickState(s, MON_0700 + 2 * TICK, () => 0.5, engine);
  assert.ok(out.scheduled.some((n) => n.cred === 'event' && n.symbol === ev.symbol && n.dir === 'up'));
  const after = out.state.stocks[ev.symbol].price;
  assert.ok(after > before, '利多大事件必須上漲');
  assert.ok(after / before - 1 <= EVENT_TICK_CAP + 0.02, '大事件單次最多約 10%');
  assert.ok(out.engine.drifts.some((d) => d.symbol === ev.symbol && d.kind === 'event'), '剩下的部分之後才反映');
}

/* ---------- 情報網：開盤中立刻反映一部分；休市不影響 ---------- */
{
  const s = freshState(MON_0700);
  const engine = freshEngine(MON_0700);
  const at = MON_0700 + 12 * TICK;
  STOCKS.forEach((def) => ensureDay(s.stocks[def.symbol], at));
  const before = {};
  STOCKS.forEach((def) => { before[def.symbol] = s.stocks[def.symbol].exact; });
  const batch = makeIntelBatch(s, at, seeded(9), true);
  assert.strictEqual(batch.length, 5);
  assert.strictEqual(new Set(batch.map((b) => b.news.symbol)).size, 5);
  applyIntelImpacts(s, engine, batch, at, seeded(10));
  batch.forEach((b) => {
    const moved = s.stocks[b.news.symbol].exact / before[b.news.symbol] - 1;
    assert.ok(b.news.dir === 'up' ? moved > 0 : moved < 0, '消息一出，價格方向要跟消息一致');
    assert.ok(['confirmed', 'rumor'].includes(b.news.cred));
    assert.ok(['small', 'mid', 'major'].includes(b.news.tier));
  });
  assert.ok(engine.drifts.length >= 5, '剩下的影響排進引擎');

  const closed = makeIntelBatch(freshState(SAT_1000), SAT_1000, seeded(11), false);
  closed.forEach((b) => { assert.strictEqual(b.impact, null); assert.strictEqual(b.news.cred, 'closed'); });
}

/* ---------- 引擎資料正規化 ---------- */
assert.deepStrictEqual(normalizeEngine({ version: 1, drifts: [{}] }, t).drifts, []);
assert.strictEqual(normalizeEngine({ version: 2, lastTickSlot: 123 }, t).lastTickSlot, 123);

/* 舊版 v1 行情遷移：錨定價 = 目前價格，不會被硬拉回初始價 */
{
  const v1 = { stocks: { BNK: { price: 495, base: 96, previous: 165, history: [{ t, p: 495 }] } } };
  const s = M.normalizeState(v1, t);
  assert.strictEqual(s.stocks.BNK.price, 495);
  assert.strictEqual(s.stocks.BNK.anchor, 495);
  assert.strictEqual(s.stocks.BNK.fair, 495);
}

/* ---------- 經濟平衡（Monte Carlo 護欄） ---------- */
{
  const rnd = seeded(2026);
  let s = freshState(MON_0700), engine = null;
  const path = [];
  for (let d = 0; d < 10; d++) {
    const dayStart = MON_0700 + (Math.floor(d / 5) * 7 + d % 5) * 86400000;
    for (let slot = 0; slot < 126; slot++) {
      const at = dayStart + slot * TICK;
      const out = tickState(s, at, rnd, engine);
      s = out.state; engine = out.engine;
      if ([12, 36, 60, 84, 108].includes(slot)) {
        rollEngineDay(engine, s, at + 1000, rnd);
        applyIntelImpacts(s, engine, makeIntelBatch(s, at + 1000, rnd, true), at + 1000, rnd);
      }
      path.push(s.stocks.TKN.price, s.stocks.BNK.price, s.stocks.DRG.price, s.stocks.ROY.price, s.stocks.TRS.price);
    }
  }
  // 隨機 5× 開倉一小時：扣掉手續費後必須是負期望值（不能亂押就賺）
  let sum = 0, n = 0;
  for (let k = 0; k < 5; k++) {
    for (let i = 5 * 10 + k; i + 12 * 5 < path.length; i += 35) {
      const entry = path[i], side = (i / 35) % 2 < 1 ? 1 : -1;
      let eq = null;
      for (let j = 1; j <= 12; j++) { const q = 1 + 5 * side * (path[i + j * 5] - entry) / entry; if (q <= 0.6) { eq = 0; break; } }
      if (eq === null) eq = 1 + 5 * side * (path[i + 60] - entry) / entry;
      sum += (eq === 0 ? -1.05 : eq - 1.1); n++;
    }
  }
  assert.ok(sum / n < 0, '隨機 5× 必須是負期望值，目前 ' + (sum / n * 100).toFixed(1) + '%');
  const max = Math.max(...path), min = Math.min(...path);
  assert.ok(max < 184 * 2.5 && min > 73 * 0.35, '兩週內價格不應失控：' + min + '～' + max);
}

console.log('market tests passed');
