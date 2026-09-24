'use strict';
// 簡易版股市核心
/* 價格放在 market/main，持股放在當季帳戶。
   所有買賣仍走 economy.mutate，確保錢包、淨資產與流水帳一起更新。 */

const { AppError, seasonId, TW_OFFSET } = require('./util');
const E = require('./econ');

const STOCKS = [
  { symbol: 'TKN', name: 'TOKEN 科技', tag: '核心平台', color: '#62e7ff', price: 128 },
  { symbol: 'BNK', name: '星界銀行', tag: '金融服務', color: '#79f2b1', price: 96 },
  { symbol: 'DRG', name: '龍焰娛樂', tag: '娛樂內容', color: '#b28cff', price: 184 },
  { symbol: 'ROY', name: '皇家賭場', tag: '博弈娛樂', color: '#ffd36d', price: 73 },
  { symbol: 'TRS', name: '秘寶工坊', tag: '稀有收藏', color: '#ff8fa3', price: 142 }
];

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function round2(n) { return Math.round(n * 100) / 100; }

function isMarketOpen(t) {
  const d = new Date(Number(t) + TW_OFFSET);
  const day = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 7 * 60 && mins < 17 * 60 + 30;
}

function freshState(t) {
  const stocks = {};
  STOCKS.forEach((s) => {
    stocks[s.symbol] = {
      symbol: s.symbol, name: s.name, tag: s.tag, color: s.color,
      price: s.price, base: s.price, previous: s.price,
      buyVolume: 0, sellVolume: 0, history: [{ t, p: s.price }]
    };
  });
  return {
    version: 1, feeRate: 0.01, intervalMin: 5, updatedAt: t,
    nextAt: t + 5 * 60000, stocks, latestIntelSlot: '',
    news: [{ t, title: '星界交易所正式開盤', body: '五支虛擬股票同步上線，價格每 5 分鐘更新。' }]
  };
}

function normalizeStock(raw, def, t) {
  const price = Math.max(5, Math.round(Number(raw && raw.price) || def.price));
  const history = Array.isArray(raw && raw.history) ? raw.history.slice(-72).map((x) => ({
    t: Number(x.t) || t, p: Math.max(5, Math.round(Number(x.p) || price))
  })) : [];
  if (!history.length) history.push({ t, p: price });
  return {
    symbol: def.symbol,
    name: String((raw && raw.name) || def.name).slice(0, 24),
    tag: String((raw && raw.tag) || def.tag).slice(0, 24),
    color: String((raw && raw.color) || def.color).slice(0, 16),
    price,
    base: Math.max(5, Math.round(Number(raw && raw.base) || def.price)),
    previous: Math.max(5, Math.round(Number(raw && raw.previous) || price)),
    buyVolume: Math.max(0, Number(raw && raw.buyVolume) || 0),
    sellVolume: Math.max(0, Number(raw && raw.sellVolume) || 0),
    history
  };
}

function normalizeState(raw, t) {
  const base = freshState(t);
  const out = Object.assign({}, base, raw || {});
  out.version = 1;
  out.feeRate = clamp(Number(out.feeRate) || 0.01, 0, 0.1);
  out.intervalMin = 5;
  out.updatedAt = Number(out.updatedAt) || t;
  out.nextAt = Number(out.nextAt) || (t + 5 * 60000);
  out.latestIntelSlot = String(out.latestIntelSlot || '').slice(0, 20);
  out.stocks = {};
  STOCKS.forEach((def) => { out.stocks[def.symbol] = normalizeStock(raw && raw.stocks && raw.stocks[def.symbol], def, t); });
  out.news = Array.isArray(raw && raw.news) ? raw.news.slice(0, 150).map((n) => ({
    t: Number(n.t) || t,
    title: String(n.title || '市場快訊').slice(0, 60),
    body: String(n.body || '').slice(0, 120),
    kind: n.kind === 'intel' ? 'intel' : 'market',
    batch: String(n.batch || '').slice(0, 20)
  })) : base.news;
  return out;
}

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

function positionEquity(position, state) {
  const stock = state.stocks[position.symbol];
  if (!stock || !position.entryPrice) return 0;
  const change = (stock.price - position.entryPrice) / position.entryPrice;
  const signed = position.side === 'long' ? change : -change;
  return Math.max(0, Math.round(position.margin + position.notional * signed));
}

function liquidationPrice(position) {
  const move = 1 / position.leverage;
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

function tickState(raw, t, random) {
  const state = normalizeState(raw, t);
  const rnd = typeof random === 'function' ? random : Math.random;
  Object.keys(state.stocks).forEach((symbol) => {
    const s = state.stocks[symbol];
    const old = s.price;
    const volume = s.buyVolume + s.sellVolume;
    const pressure = volume ? clamp((s.buyVolume - s.sellVolume) / volume, -1, 1) * 0.025 : 0;
    const randomMove = (rnd() * 0.06) - 0.03;
    const reversion = clamp((s.base - old) / s.base, -0.4, 0.4) * 0.018;
    const pct = clamp(randomMove + pressure + reversion, -0.08, 0.08);
    s.previous = old;
    s.price = Math.max(5, Math.round(old * (1 + pct)));
    s.buyVolume = round2(s.buyVolume * 0.2);
    s.sellVolume = round2(s.sellVolume * 0.2);
    s.history = (s.history || []).concat([{ t, p: s.price }]).slice(-72);
  });
  state.news = state.news.slice(0, 150);
  state.updatedAt = t;
  state.nextAt = t + 5 * 60000;
  return state;
}

const INTEL_EVENTS = [
  { direction: 'up', title: (a, b) => a.name + ' × ' + b.name + ' 簽署戰略合作', body: (a, b, money) => '雙方宣布共同開發新服務，合作規模約 ' + money + ' 萬，市場看好 ' + a.name + ' 的後續營收。' },
  { direction: 'up', title: (a, b, money) => a.name + ' 拿下 ' + money + ' 萬大型訂單', body: (a, b) => '情報指出訂單將分階段交付，' + b.name + ' 也將提供部分技術支援。' },
  { direction: 'up', title: (a, b) => a.name + ' 聯手 ' + b.name + ' 收購新創團隊', body: (a, b, money) => '雙方以約 ' + money + ' 萬完成聯合收購，預計快速擴張 ' + a.tag + ' 業務。' },
  { direction: 'up', title: (a) => '神秘資金進場 ' + a.name, body: (a, b, money) => '一筆約 ' + money + ' 萬的策略投資完成交割，買方身分尚未公開。' },
  { direction: 'up', title: (a, b) => a.name + ' 取得獨家授權', body: (a, b, money) => '新授權案規模約 ' + money + ' 萬，外界預期將替 ' + a.name + ' 帶來穩定收入。' },
  { direction: 'down', title: (a, b) => a.name + ' 與 ' + b.name + ' 合作談判破局', body: (a, b, money) => '原訂約 ' + money + ' 萬的合作案臨時喊停，雙方對分潤條件沒有共識。' },
  { direction: 'down', title: (a) => a.name + ' 重大專案宣布延期', body: (a, b, money) => '供應與測試進度不如預期，市場估計可能影響約 ' + money + ' 萬的短期收入。' },
  { direction: 'down', title: (a) => a.name + ' 遭市場監管調查', body: (a) => '情報網收到消息，主管機關要求 ' + a.name + ' 補交交易與營運資料，結果仍不明朗。' },
  { direction: 'down', title: (a) => a.name + ' 核心高層突然離職', body: (a) => '公司尚未公布接任人選，外界擔心 ' + a.name + ' 的主要計畫將重新調整。' },
  { direction: 'down', title: (a, b) => b.name + ' 搶走 ' + a.name + ' 主要客戶', body: (a, b, money) => '市場傳出一筆約 ' + money + ' 萬的合約轉由 ' + b.name + ' 承接，' + a.name + ' 尚未回應。' }
];

function intelSlotKey(t) {
  const d = new Date(t + TW_OFFSET);
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0') + '-' + String(d.getUTCHours()).padStart(2, '0');
}

function makeIntel(state, t, random, index, targetSymbol) {
  const rnd = typeof random === 'function' ? random : Math.random;
  const defs = STOCKS.map((def) => state.stocks[def.symbol] || def);
  const requested = defs.findIndex((def) => def.symbol === targetSymbol);
  const ai = requested >= 0 ? requested : Math.min(defs.length - 1, Math.floor(rnd() * defs.length));
  let bi = Math.min(defs.length - 1, Math.floor(rnd() * (defs.length - 1)));
  if (bi >= ai) bi++;
  const a = defs[ai], b = defs[bi % defs.length];
  const event = INTEL_EVENTS[Math.min(INTEL_EVENTS.length - 1, Math.floor(rnd() * INTEL_EVENTS.length))];
  const money = 800 + Math.floor(rnd() * 9200);
  const percent = 1 + Math.floor(rnd() * 11) / 2;
  const title = event.title(a, b, money);
  const body = event.body(a, b, money);
  const slot = intelSlotKey(t);
  return {
    news: { t, title, body, kind: 'intel', batch: slot },
    signal: {
      id: 'intel-' + slot + '-' + (Number(index) || 0), slot, t, title, symbol: a.symbol,
      direction: event.direction, percent, status: 'pending',
      reason: '情報網判定「' + title + '」主要影響 ' + a.name + '，建議' + (event.direction === 'up' ? '上漲 ' : '下跌 ') + percent + '%。'
    }
  };
}

function makeIntelBatch(state, t, random) {
  const rnd = typeof random === 'function' ? random : Math.random;
  const symbols = STOCKS.map((stock) => stock.symbol);
  for (let i = symbols.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rnd() * (i + 1)));
    const tmp = symbols[i]; symbols[i] = symbols[j]; symbols[j] = tmp;
  }
  return symbols.map((symbol, index) => makeIntel(state, t, rnd, index, symbol));
}

function createMarket({ db, now, requireSession, requireAdmin, mutate, FieldValue }) {
  const ref = () => db.collection('market').doc('main');
  const signalsRef = () => db.collection('marketAdmin').doc('signals');

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

  async function refreshPortfolios(state) {
    const t = now();
    const sid = seasonId(t);
    const [cfgSnap, accSnap, playerSnap] = await Promise.all([
      db.collection('config').doc('app').get(),
      db.collection('seasons').doc(sid).collection('accounts').get(),
      db.collection('players').get()
    ]);
    const cfg = E.cfgOf(cfgSnap.exists ? cfgSnap.data() : null);
    const players = {};
    playerSnap.forEach((doc) => { players[doc.id] = doc.data(); });
    let batch = db.batch();
    let pending = 0;
    let count = 0;
    for (const doc of accSnap.docs) {
      const acc = doc.data();
      const market = normalizePortfolio(acc);
      if (!Object.keys(market.holdings).length && !Object.keys(market.positions).length && !market.value) continue;
      const liquidated = [];
      Object.keys(market.positions).forEach((symbol) => {
        const position = market.positions[symbol];
        if (positionEquity(position, state) > 0) return;
        market.realized -= position.margin;
        liquidated.push(position);
        delete market.positions[symbol];
      });
      market.value = portfolioValue(market, state);
      E.refresh(acc, cfg, t);
      batch.update(doc.ref, { market, net: acc.net, peakNet: acc.peakNet, updatedAt: t });
      pending++; count++;
      liquidated.forEach((position) => {
        batch.set(doc.ref.collection('ledger').doc(), {
          type: 'market_liquidation', amount: -position.margin,
          wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans,
          at: t, by: 'system', note: position.symbol + ' ' + position.leverage + '× ' + (position.side === 'long' ? '做多' : '做空') + ' 已爆倉'
        });
        pending++;
      });
      const player = players[acc.pid];
      if (player && acc.peakNet > ((player.stats && player.stats.peakNet) || 0)) {
        batch.update(db.collection('players').doc(acc.pid), { 'stats.peakNet': acc.peakNet, 'stats.peakNetSeason': sid });
        pending++;
      }
      if (pending >= 350) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (pending) await batch.commit();
    return count;
  }

  async function state(req) {
    const session = await requireSession(req);
    const marketState = await getState();
    const result = await mutate(session.pid, (acc) => {
      const market = normalizePortfolio(acc);
      market.value = portfolioValue(market, marketState);
      return [];
    });
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
    const marketState = await getState();
    const stock = marketState.stocks[symbol];
    const gross = stock.price * qty;
    const fee = Math.max(1, Math.ceil(gross * marketState.feeRate));
    const result = await mutate(session.pid, (acc) => {
      const market = normalizePortfolio(acc);
      const old = market.holdings[symbol] || { qty: 0, cost: 0 };
      if (side === 'buy') {
        const total = gross + fee;
        if (acc.wallet < total) throw new AppError('錢包餘額不足', 'no-money');
        if (old.qty + qty > 5000) throw new AppError('單支股票最多持有 5000 股', 'holding-limit');
        acc.wallet -= total;
        market.holdings[symbol] = { qty: old.qty + qty, cost: old.cost + total };
        market.fees += fee;
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
      }
      market.value = portfolioValue(market, marketState);
      return [{
        type: side === 'buy' ? 'market_buy' : 'market_sell',
        amount: side === 'buy' ? -(gross + fee) : (gross - fee),
        wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans,
        note: stock.name + ' ' + qty + ' 股 @ ' + stock.price
      }];
    });
    const field = side === 'buy' ? 'stocks.' + symbol + '.buyVolume' : 'stocks.' + symbol + '.sellVolume';
    // 成交量只影響下一輪價格壓力；就算這個非關鍵更新失敗，也不能讓玩家誤以為交易失敗而重複下單。
    await ref().update({ [field]: FieldValue.increment(qty) }).catch(() => {});
    return { ok: true, side, symbol, qty, price: stock.price, fee, market: marketState, account: result.account };
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
    if (!Number.isFinite(margin) || margin < 100 || margin > 100000) throw new AppError('保證金要在 100 到 100,000 之間', 'bad-margin', 'invalid-argument');
    const marketState = await getState();
    const stock = marketState.stocks[symbol];
    const notional = margin * leverage;
    const fee = Math.max(1, Math.ceil(notional * marketState.feeRate));
    const result = await mutate(session.pid, (acc, cfg, t) => {
      const market = normalizePortfolio(acc);
      if (market.positions[symbol]) throw new AppError('這支股票已經有槓桿倉位，請先平倉', 'position-exists');
      if (Object.keys(market.positions).length >= 3) throw new AppError('同時最多持有 3 個槓桿倉位', 'position-limit');
      if (acc.wallet < margin + fee) throw new AppError('錢包不足以支付保證金和手續費', 'no-money');
      acc.wallet -= margin + fee;
      market.fees += fee;
      market.positions[symbol] = { symbol, side, leverage, margin, notional, entryPrice: stock.price, openedAt: t };
      market.value = portfolioValue(market, marketState);
      return [{
        type: 'market_leverage_open', amount: -(margin + fee),
        wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans,
        note: symbol + ' ' + leverage + '× ' + (side === 'long' ? '做多' : '做空') + ' @ ' + stock.price
      }];
    });
    const shares = Math.max(1, Math.round(notional / stock.price));
    const field = side === 'long' ? 'stocks.' + symbol + '.buyVolume' : 'stocks.' + symbol + '.sellVolume';
    await ref().update({ [field]: FieldValue.increment(shares) }).catch(() => {});
    return { ok: true, symbol, side, leverage, margin, notional, fee, liquidationPrice: liquidationPrice(result.account.market.positions[symbol]), market: marketState, account: result.account };
  }

  async function leverageClose(req) {
    const session = await requireSession(req);
    if (!isMarketOpen(now())) throw new AppError('目前已收盤，交易時間是週一到週五 07:00–17:30（17:00 後為盤後交易）', 'market-closed');
    const symbol = String((req.data && req.data.symbol) || '').toUpperCase();
    if (!STOCKS.some((s) => s.symbol === symbol)) throw new AppError('找不到這支股票', 'bad-stock', 'invalid-argument');
    const marketState = await getState();
    let closed = null;
    const result = await mutate(session.pid, (acc) => {
      const market = normalizePortfolio(acc);
      const position = market.positions[symbol];
      if (!position) throw new AppError('找不到這個槓桿倉位', 'no-position');
      const equity = positionEquity(position, marketState);
      const pnl = equity - position.margin;
      acc.wallet += equity;
      market.realized += pnl;
      delete market.positions[symbol];
      market.value = portfolioValue(market, marketState);
      closed = { equity, pnl, position };
      return [{
        type: equity > 0 ? 'market_leverage_close' : 'market_liquidation', amount: equity,
        wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans,
        note: symbol + ' ' + position.leverage + '× 平倉，損益 ' + (pnl >= 0 ? '+' : '') + pnl
      }];
    });
    return { ok: true, symbol, equity: closed.equity, pnl: closed.pnl, market: marketState, account: result.account };
  }

  async function adminMove(req) {
    const admin = await requireAdmin(req);
    const d = req.data || {};
    const symbol = String(d.symbol || '').toUpperCase();
    const direction = String(d.direction || '').toLowerCase();
    const percent = Number(d.percent);
    const signalId = d.signalId ? String(d.signalId).slice(0, 40) : null;
    if (!STOCKS.some((s) => s.symbol === symbol)) throw new AppError('找不到這支股票', 'bad-stock', 'invalid-argument');
    if (direction !== 'up' && direction !== 'down') throw new AppError('請選擇上漲或下跌', 'bad-direction', 'invalid-argument');
    if (!Number.isFinite(percent) || percent < 0.5 || percent > 10) throw new AppError('調整幅度要在 0.5% 到 10% 之間', 'bad-percent', 'invalid-argument');
    let result;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref());
      const t = now();
      const state = normalizeState(snap.exists ? snap.data() : null, t);
      const stock = state.stocks[symbol];
      const old = stock.price;
      const sign = direction === 'up' ? 1 : -1;
      stock.previous = old;
      stock.price = Math.max(5, Math.round(old * (1 + sign * percent / 100)));
      stock.history = stock.history.concat([{ t, p: stock.price }]).slice(-72);
      state.updatedAt = t;
      tx.set(ref(), state);
      result = state;
    });
    const refreshed = await refreshPortfolios(result);
    if (signalId) await markSignal(signalId, admin.pid, direction, percent).catch(() => {});
    return { ok: true, by: admin.pid, refreshed, market: result };
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

  async function adminSignals(req) {
    await requireAdmin(req);
    const snap = await signalsRef().get();
    const data = snap.exists ? snap.data() : {};
    const rows = Array.isArray(data.rows) ? data.rows.slice(0, 150) : [];
    return { rows, latestSlot: String(data.latestSlot || (rows[0] && rows[0].slot) || '') };
  }

  async function publishIntel(t, random) {
    const at = Number(t) || now();
    let output;
    await db.runTransaction(async (tx) => {
      const [marketSnap, signalSnap] = await Promise.all([tx.get(ref()), tx.get(signalsRef())]);
      const state = normalizeState(marketSnap.exists ? marketSnap.data() : null, at);
      const oldRows = signalSnap.exists && Array.isArray(signalSnap.data().rows) ? signalSnap.data().rows : [];
      const slot = intelSlotKey(at);
      const oldBatch = oldRows.filter((row) => row.slot === slot);
      if (oldBatch.length >= 5) { output = { skipped: true, slot, signals: oldBatch.slice(0, 5) }; return; }
      const batch = makeIntelBatch(state, at, random);
      const news = batch.map((intel) => intel.news);
      const signals = batch.map((intel) => intel.signal);
      state.latestIntelSlot = slot;
      state.news = news.concat(state.news).slice(0, 150);
      state.updatedAt = at;
      tx.set(ref(), state);
      tx.set(signalsRef(), { rows: signals.concat(oldRows.filter((row) => row.slot !== slot)).slice(0, 150), latestSlot: slot, updatedAt: at });
      output = { skipped: false, slot, news, signals };
    });
    return output;
  }

  async function tick(t) {
    const at = Number(t) || now();
    if (!isMarketOpen(at)) return { ok: true, skipped: true, reason: 'market-closed', updatedAt: at };
    let result;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref());
      result = tickState(snap.exists ? snap.data() : null, at);
      tx.set(ref(), result);
    });
    const refreshed = await refreshPortfolios(result);
    return { ok: true, refreshed, updatedAt: result.updatedAt };
  }

  return { state, trade, leverageOpen, leverageClose, adminMove, adminSignals, publishIntel, tick, getState, refreshPortfolios };
}

module.exports = { createMarket, freshState, normalizeState, normalizePortfolio, portfolioValue, positionEquity, liquidationPrice, isMarketOpen, tickState, makeIntel, makeIntelBatch, intelSlotKey, STOCKS };
