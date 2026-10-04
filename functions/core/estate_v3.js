'use strict';

const { AppError } = require('./util');

const CITY_ID = 'city01';
const NEW_SHIELD_MS = 24 * 3600 * 1000;
const ATTACK_DEBUFF_MS = 24 * 3600 * 1000;
const ATTACK_RATE_MULT = 0.46;
const MATERIALS = Object.freeze(['wood', 'stone', 'alloy', 'gold', 'crystal', 'scroll', 'core']);
const MAX_LEVEL = Object.freeze([0, 3, 4, 5, 7, 10]);
// 每個數字代表「每 5 分鐘」的產出；一階 Lv.0 不產錢，五階 Lv.10 為 9,200。
const RATES = Object.freeze({
  1: [0, 10, 25, 100],
  2: [130, 170, 220, 280, 350],
  3: [420, 500, 590, 690, 800, 950],
  4: [1100, 1280, 1480, 1700, 1950, 2230, 2540, 2900],
  5: [3000, 3300, 3750, 4250, 4800, 5400, 6050, 6750, 7500, 8300, 9200]
});
const STORAGE_MINUTES = Object.freeze([0, 30, 60, 120, 240, 720]);
const MATERIAL_CYCLE_MINUTES = Object.freeze([0, 120, 90, 60, 45, 30]);
const BLACK_MARKET_REFRESH_MS = 30 * 60 * 1000;
const BLACK_MARKET = Object.freeze({
  wood: { name: '木材', icon: '🪵', rarity: '普通', price: 15 },
  stone: { name: '石材', icon: '🪨', rarity: '普通', price: 20 },
  alloy: { name: '合金', icon: '🔩', rarity: '進階', price: 45 },
  gold: { name: '黃金', icon: '◆', rarity: '稀有', price: 80 },
  crystal: { name: '晶礦', icon: '💎', rarity: '史詩', price: 140 },
  scroll: { name: '魔法卷軸', icon: '📜', rarity: '神話', price: 450 },
  core: { name: '星核', icon: '✦', rarity: '傳奇', price: 1200 }
});

function marketRandom(slot) {
  let x = (Number(slot) ^ 0x9e3779b9) >>> 0;
  return function next() {
    x = (x + 0x6d2b79f5) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

function marketStockForSlot(slot) {
  const r = marketRandom(slot), between = (min, max) => min + Math.floor(r() * (max - min + 1));
  return {
    wood: between(10, 20),
    stone: between(10, 20),
    alloy: between(3, 7),
    gold: between(3, 7),
    crystal: r() < 0.5 ? between(1, 3) : 0,
    scroll: r() < 0.15 ? (r() < 0.75 ? 1 : 2) : 0,
    core: r() < 0.015 ? 1 : 0
  };
}

function ensureBlackMarket(city, t) {
  const slot = Math.floor(Number(t) / BLACK_MARKET_REFRESH_MS);
  const old = city.blackMarket || {};
  if (Number(old.slot) !== slot || !old.stock) {
    city.blackMarket = {
      slot,
      refreshedAt: slot * BLACK_MARKET_REFRESH_MS,
      nextRefreshAt: (slot + 1) * BLACK_MARKET_REFRESH_MS,
      stock: marketStockForSlot(slot)
    };
  }
  MATERIALS.forEach((id) => { city.blackMarket.stock[id] = Math.max(0, Math.floor(Number(city.blackMarket.stock[id]) || 0)); });
  return city.blackMarket;
}

function plotId(index) {
  return String.fromCharCode(65 + Math.floor(index / 4)) + String(index % 4 + 1);
}

function blankPlot(index) {
  return {
    id: plotId(index), status: 'vacant', ownerPid: null, ownerName: null,
    stage: 0, level: 0, mines: 0, shieldUntil: 0, acquiredAt: 0,
    storedCash: 0, lastProducedAt: 0, lastMaterialAt: 0,
    debuffUntil: 0, materialPausedCycles: 0, updatedAt: 0
  };
}

function ownedPlot(index, owner, t, stage, level) {
  return Object.assign(blankPlot(index), {
    status: 'owned', ownerPid: owner.pid, ownerName: owner.name || '管理員',
    stage: stage || 1, level: level || 0,
    shieldUntil: owner.shield === false ? 0 : t + NEW_SHIELD_MS,
    acquiredAt: t, lastProducedAt: t, lastMaterialAt: t, updatedAt: t
  });
}

function seedCity(t, admin) {
  const plots = Array.from({ length: 16 }, (_, i) => blankPlot(i));
  [
    { i: 0, stage: 2, level: 4, name: '森影古寺展示地' },
    { i: 3, stage: 3, level: 3, name: '東方名邸展示地' },
    { i: 12, stage: 4, level: 7, name: '深淵門邸展示地' },
    { i: 15, stage: 5, level: 10, name: '黯星城塞展示地' }
  ].forEach((x) => {
    plots[x.i] = Object.assign(blankPlot(x.i), {
      status: 'showcase', ownerPid: 'system', ownerName: x.name,
      stage: x.stage, level: x.level,
      storedCash: Math.floor(RATES[x.stage][x.level] * (STORAGE_MINUTES[x.stage] / 5) * 0.6),
      lastProducedAt: t, lastMaterialAt: t, updatedAt: t
    });
  });
  plots[5] = ownedPlot(5, { pid: admin.pid, name: admin.name, shield: false }, t, 1, 0);
  const city = { id: CITY_ID, version: 5, sandbox: true, plots, createdAt: t, updatedAt: t };
  ensureBlackMarket(city, t);
  return city;
}

function seedProfile(pid, t) {
  return {
    pid, version: 4,
    materials: { wood: 120, stone: 120, alloy: 80, gold: 60, crystal: 40, scroll: 18, core: 8 },
    blackCoins: 10000, missiles: 8, mines: 2, createdAt: t, updatedAt: t
  };
}

function normalizeProfile(raw, pid, t) {
  const base = seedProfile(pid, t);
  if (!raw) return base;
  const out = Object.assign({}, base, raw, { pid, version: 4 });
  out.materials = Object.assign({}, base.materials, raw.materials || {});
  MATERIALS.forEach((k) => { out.materials[k] = Math.max(0, Math.floor(Number(out.materials[k]) || 0)); });
  out.missiles = Math.max(0, Math.floor(Number(out.missiles) || 0));
  out.mines = Math.max(0, Math.floor(Number(out.mines) || 0));
  out.blackCoins = Math.max(0, Math.floor(Number(out.blackCoins) || 0));
  return out;
}

function normalizeCity(raw, t, admin) {
  if (!raw || !Array.isArray(raw.plots) || raw.plots.length !== 16) return seedCity(t, admin);
  const city = Object.assign({}, raw, { id: CITY_ID, version: 5, sandbox: true });
  city.plots = raw.plots.map((p, i) => {
    const src = p || {}, out = Object.assign(blankPlot(i), src, { id: plotId(i) });
    if (out.status === 'ruined') out.status = out.ownerPid === 'system' ? 'showcase' : 'owned';
    if (out.status !== 'vacant') {
      out.stage = Math.max(1, Math.min(5, Math.floor(Number(out.stage) || 1)));
      out.level = Math.max(0, Math.min(MAX_LEVEL[out.stage], Math.floor(Number(out.level) || 0)));
      delete out.exp;
      out.storedCash = Math.max(0, Math.floor(Number(out.storedCash) || 0));
      out.lastProducedAt = Number(out.lastProducedAt || out.updatedAt || t);
      out.lastMaterialAt = Number(out.lastMaterialAt || out.updatedAt || t);
      out.debuffUntil = Math.max(0, Number(out.debuffUntil) || 0);
      out.materialPausedCycles = Math.max(0, Math.floor(Number(out.materialPausedCycles) || 0));
      if (Number(raw.version || 0) < 3 && out.status === 'showcase' && !out.storedCash) out.storedCash = Math.floor(storageCap(out) * 0.6);
    }
    return out;
  });
  ensureBlackMarket(city, t);
  return city;
}

function baseRate(plot) {
  return (RATES[plot.stage] || [0])[plot.level] || 0;
}

function rateAt(plot, t) {
  const rate = baseRate(plot);
  return Number(plot.debuffUntil || 0) > t ? Math.floor(rate * ATTACK_RATE_MULT) : rate;
}

function storageCap(plot) {
  return baseRate(plot) * ((STORAGE_MINUTES[plot.stage] || 30) / 5);
}

function materialYield(plot, cycles) {
  const out = {};
  if (plot.stage === 1) out.wood = cycles;
  if (plot.stage === 2) { out.stone = cycles; out.alloy = cycles; }
  if (plot.stage === 3) { out.gold = cycles * 3; out.crystal = Math.floor(cycles / 2); }
  if (plot.stage === 4) { out.crystal = cycles * 2; out.scroll = Math.floor(cycles / 4); }
  if (plot.stage === 5) { out.gold = cycles * 3; out.crystal = cycles * 2; out.scroll = Math.floor(cycles / 3); out.core = Math.floor(cycles / 8); }
  return out;
}

function accruePlot(plot, profile, pid, t) {
  if (!plot || plot.status !== 'owned') return false;
  let changed = false;
  let from = Number(plot.lastProducedAt || t);
  if (t > from) {
    let earned = 0;
    const debuffEnd = Number(plot.debuffUntil || 0);
    if (debuffEnd > from) {
      const weakEnd = Math.min(t, debuffEnd);
      earned += (weakEnd - from) / 300000 * Math.floor(baseRate(plot) * ATTACK_RATE_MULT);
      from = weakEnd;
    }
    if (t > from) earned += (t - from) / 300000 * baseRate(plot);
    plot.storedCash = Math.min(storageCap(plot), Math.floor(Number(plot.storedCash || 0) + earned));
    plot.lastProducedAt = t;
    changed = true;
  }
  if (profile && plot.ownerPid === pid) {
    const cycleMs = (MATERIAL_CYCLE_MINUTES[plot.stage] || 120) * 60000;
    const matFrom = Number(plot.lastMaterialAt || t);
    const cycles = Math.floor((t - matFrom) / cycleMs);
    if (cycles > 0) {
      const skipped = Math.min(cycles, Math.max(0, Number(plot.materialPausedCycles || 0)));
      const produced = cycles - skipped;
      plot.materialPausedCycles = Math.max(0, Number(plot.materialPausedCycles || 0) - skipped);
      if (produced > 0) {
        const got = materialYield(plot, produced);
        Object.keys(got).forEach((k) => { profile.materials[k] = (profile.materials[k] || 0) + got[k]; });
      }
      plot.lastMaterialAt = matFrom + cycles * cycleMs;
      profile.updatedAt = t;
      changed = true;
    }
  }
  return changed;
}

function upgradeSpec(plot) {
  if (!plot || plot.status !== 'owned') return null;
  if (plot.stage === 5 && plot.level === MAX_LEVEL[5]) return null;
  const major = plot.level >= MAX_LEVEL[plot.stage];
  const nextStage = major ? plot.stage + 1 : plot.stage;
  const nextLevel = major ? 0 : plot.level + 1;
  const step = Object.keys(RATES).slice(0, plot.stage - 1).reduce((n, k) => n + MAX_LEVEL[k], 0) + plot.level + 1;
  const money = step === 1 ? 50000 : Math.round((50000 + step * step * 12500) / 5000) * 5000;
  const materials = {};
  if (step === 1) { materials.wood = 2; materials.stone = 3; }
  else if (plot.stage === 1) { materials.wood = 3 + plot.level * 2; materials.stone = 2 + plot.level; }
  else if (plot.stage === 2) { materials.stone = 5 + plot.level * 2; materials.alloy = 3 + plot.level; }
  else if (plot.stage === 3) { materials.alloy = 7 + plot.level * 2; materials.gold = 3 + plot.level; }
  else if (plot.stage === 4) { materials.gold = 8 + plot.level * 2; materials.crystal = 4 + plot.level; }
  else { materials.crystal = 10 + plot.level * 2; materials.scroll = 1 + Math.floor(plot.level / 3); if (plot.level >= 7) materials.core = 1; }
  if (major) materials.scroll = (materials.scroll || 0) + plot.stage;
  return { nextStage, nextLevel, money, materials, specialMission: major && plot.stage >= 3 ? '正式開放前公布' : null };
}

function maxHoldings(city, pid) {
  return city.plots.some((p) => p.ownerPid === pid && p.status === 'owned' && p.stage === 5 && p.level === 10) ? 2 : 1;
}

function blackMarketState(profile, market) {
  return {
    currencyName: '黑曜幣',
    balance: Math.max(0, Math.floor(Number(profile.blackCoins) || 0)),
    refreshedAt: market.refreshedAt,
    nextRefreshAt: market.nextRefreshAt,
    shared: true,
    items: Object.keys(BLACK_MARKET).map((id) => Object.assign({
      id,
      owned: Math.max(0, Math.floor(Number((profile.materials || {})[id]) || 0)),
      stock: Math.max(0, Math.floor(Number((market.stock || {})[id]) || 0))
    }, BLACK_MARKET[id]))
  };
}

function publicState(city, pid, t, profile) {
  const plots = city.plots.map((p) => Object.assign({}, p, {
    shielded: Number(p.shieldUntil || 0) > t,
    debuffed: Number(p.debuffUntil || 0) > t,
    ratePerFiveMinutes: rateAt(p, t), baseRatePerFiveMinutes: baseRate(p),
    storageCap: storageCap(p), nextUpgrade: upgradeSpec(p)
  }));
  return {
    id: city.id, sandbox: true, version: 5,
    maxHoldings: maxHoldings(city, pid),
    holdings: plots.filter((p) => p.ownerPid === pid && p.status === 'owned').length,
    vacant: plots.filter((p) => p.status === 'vacant').length,
    profile: profile ? JSON.parse(JSON.stringify(profile)) : null,
    plots, now: t, updatedAt: city.updatedAt || t
  };
}

function cleanLotId(value) {
  const id = String(value || '').toUpperCase();
  if (!/^[A-D][1-4]$/.test(id)) throw new AppError('土地編號不正確', 'bad-lot', 'invalid-argument');
  return id;
}

function findPlot(city, id) {
  const plot = city.plots.find((p) => p.id === id);
  if (!plot) throw new AppError('找不到這塊土地', 'no-lot', 'not-found');
  return plot;
}

function ensureOwner(plot, admin) {
  if (plot.ownerPid !== admin.pid || plot.status !== 'owned') throw new AppError('這不是你的土地', 'not-owner', 'permission-denied');
}

function createEstate({ db, now, requireAdmin, mutate }) {
  const ref = db.collection('estateSandbox').doc(CITY_ID);
  const profileRef = (pid) => ref.collection('profiles').doc(pid);

  function prepare(city, profile, admin, t) {
    ensureBlackMarket(city, t);
    city.plots.forEach((p) => accruePlot(p, profile, admin.pid, t));
    city.updatedAt = t;
    profile.updatedAt = t;
  }

  async function transact(req, fn, authenticatedAdmin) {
    const admin = authenticatedAdmin || await requireAdmin(req), t = now();
    let out;
    await db.runTransaction(async (tx) => {
      const [snap, profileSnap] = await Promise.all([tx.get(ref), tx.get(profileRef(admin.pid))]);
      const city = normalizeCity(snap.exists ? snap.data() : null, t, admin);
      const profile = normalizeProfile(profileSnap.exists ? profileSnap.data() : null, admin.pid, t);
      prepare(city, profile, admin, t);
      out = fn(city, profile, admin, t) || {};
      tx.set(ref, city); tx.set(profileRef(admin.pid), profile);
      tx.set(ref.collection('logs').doc(), {
        action: (req.data && req.data.action) || 'view', lotId: req.data && req.data.lotId || null,
        by: admin.pid, at: t, result: out
      });
      out = Object.assign({ state: publicState(city, admin.pid, t, profile) }, out);
    });
    return out;
  }

  function economyMeta(admin, lotId) {
    return {
      by: admin.pid,
      load: async (tx, ctx) => {
        const [snap, profileSnap] = await Promise.all([tx.get(ref), tx.get(profileRef(admin.pid))]);
        const city = normalizeCity(snap.exists ? snap.data() : null, ctx.t, admin);
        const profile = normalizeProfile(profileSnap.exists ? profileSnap.data() : null, admin.pid, ctx.t);
        prepare(city, profile, admin, ctx.t);
        return { city, profile, plot: findPlot(city, lotId) };
      },
      write: async (tx, extra, ctx) => {
        extra.city.updatedAt = ctx.t; extra.profile.updatedAt = ctx.t;
        tx.set(ref, extra.city); tx.set(profileRef(admin.pid), extra.profile);
        tx.set(ref.collection('logs').doc(), { action: extra.action, lotId, by: admin.pid, at: ctx.t, result: extra.result || null });
      }
    };
  }

  return {
    async state(req) {
      const admin = await requireAdmin(req), t = now();
      let state;
      await db.runTransaction(async (tx) => {
        const [snap, profileSnap] = await Promise.all([tx.get(ref), tx.get(profileRef(admin.pid))]);
        const city = normalizeCity(snap.exists ? snap.data() : null, t, admin);
        const profile = normalizeProfile(profileSnap.exists ? profileSnap.data() : null, admin.pid, t);
        prepare(city, profile, admin, t);
        tx.set(ref, city); tx.set(profileRef(admin.pid), profile);
        state = publicState(city, admin.pid, t, profile);
      });
      return { state };
    },

    async action(req) {
      const authenticatedAdmin = await requireAdmin(req);
      const d = req.data || {}, action = String(d.action || '');
      if (!['claim', 'mine', 'attack', 'reset'].includes(action)) throw new AppError('未知的領地操作', 'bad-action', 'invalid-argument');
      return transact(req, (city, profile, admin, t) => {
        if (action === 'reset') {
          const reset = seedCity(t, admin), fresh = seedProfile(admin.pid, t);
          city.plots = reset.plots; city.createdAt = t;
          Object.assign(profile, fresh);
          return { message: '測試城市與材料庫已重設' };
        }
        const id = cleanLotId(d.lotId), plot = findPlot(city, id);
        if (action === 'claim') {
          if (plot.status !== 'vacant') throw new AppError('這塊土地已經有主人', 'lot-taken');
          const held = city.plots.filter((p) => p.ownerPid === admin.pid && p.status === 'owned').length;
          if (held >= maxHoldings(city, admin.pid)) throw new AppError(held ? '必須先將第一棟升到五階十級，才能取得第二塊土地' : '目前不能取得土地', 'holding-limit');
          Object.assign(plot, ownedPlot(city.plots.indexOf(plot), admin, t, 1, 0));
          return { lotId: id, message: '已免費取得 ' + id + '，一階木屋 Lv.0 建造完成' };
        }
        if (action === 'mine') {
          ensureOwner(plot, admin);
          if (plot.mines >= 2) throw new AppError('每棟房屋最多部署兩枚防禦地雷', 'mine-limit');
          if (profile.mines < 1) throw new AppError('材料庫沒有防禦地雷', 'no-mine');
          profile.mines -= 1; plot.mines += 1; plot.updatedAt = t;
          return { lotId: id, message: id + ' 已部署防禦地雷（' + plot.mines + ' / 2）' };
        }
        if (action === 'attack') {
          if (!['owned', 'showcase'].includes(plot.status)) throw new AppError('這塊土地目前不能攻擊', 'bad-state');
          if (plot.ownerPid === admin.pid) throw new AppError('不能攻擊自己的土地', 'self-attack');
          if (Number(plot.shieldUntil || 0) > t) throw new AppError('這塊土地仍在新手保護期', 'shielded');
          if (String(d.weapon || 'missile') !== 'missile') throw new AppError('目前只開放重型飛彈', 'bad-weapon', 'invalid-argument');
          if (profile.missiles < 1) throw new AppError('飛彈庫存不足', 'no-missile');
          profile.missiles -= 1;
          const before = Math.floor(Number(plot.storedCash || 0));
          let lost = 0, defended = false;
          if (plot.mines > 0) { plot.mines -= 1; defended = true; }
          else {
            plot.storedCash = Math.floor(before * 0.25);
            lost = before - plot.storedCash;
            plot.debuffUntil = Math.max(Number(plot.debuffUntil || 0), t + ATTACK_DEBUFF_MS);
            plot.materialPausedCycles = Number(plot.materialPausedCycles || 0) + 3;
          }
          plot.updatedAt = t;
          return {
            lotId: id, weapon: 'missile', defended, lost,
            debuffUntil: plot.debuffUntil || 0,
            message: defended ? '防禦地雷完整攔截飛彈，房屋毫髮無傷' : '飛彈命中：倉庫損失 75%，24 小時產能受損並停產三次材料'
          };
        }
      }, authenticatedAdmin);
    },

    async economy(req) {
      if (typeof mutate !== 'function') throw new AppError('經濟系統尚未連接', 'economy-unavailable');
      const admin = await requireAdmin(req), d = req.data || {}, action = String(d.action || '');
      if (!['collect', 'upgrade'].includes(action)) throw new AppError('未知的經濟操作', 'bad-action', 'invalid-argument');
      const id = cleanLotId(d.lotId), meta = economyMeta(admin, id);
      const r = await mutate(admin.pid, (acc, cfg, t, raw, pl, setPlayer, extra) => {
        const plot = extra.plot; ensureOwner(plot, admin); extra.action = action;
        if (action === 'collect') {
          const amount = Math.floor(Number(plot.storedCash || 0));
          if (amount < 1) throw new AppError('倉庫目前沒有可領取的收益', 'empty-storage');
          plot.storedCash = 0; plot.updatedAt = t;
          acc.wallet = Number(acc.wallet || 0) + amount;
          extra.result = { amount };
          return [{ type: 'estate-income', amount, note: id + ' 倉庫收益' }];
        }
        const spec = upgradeSpec(plot);
        if (!spec) throw new AppError('這棟房屋已經達到最高等級', 'max-level');
        if (Number(acc.wallet || 0) < spec.money) throw new AppError('錢包餘額不足，升級需要 ' + spec.money, 'low-wallet');
        Object.keys(spec.materials).forEach((k) => {
          if (Number(extra.profile.materials[k] || 0) < spec.materials[k]) throw new AppError('材料不足：' + k, 'low-material');
        });
        acc.wallet -= spec.money;
        Object.keys(spec.materials).forEach((k) => { extra.profile.materials[k] -= spec.materials[k]; });
        plot.stage = spec.nextStage; plot.level = spec.nextLevel; plot.updatedAt = t;
        extra.result = { stage: plot.stage, level: plot.level, cost: spec.money };
        return [{ type: 'estate-upgrade', amount: -spec.money, note: id + ' 升至 ' + plot.stage + '階 Lv.' + plot.level }];
      }, meta);
      return Object.assign({ account: r.account, state: publicState(r.extra.city, admin.pid, now(), r.extra.profile) }, r.extra.result || {}, {
        message: action === 'collect' ? '倉庫收益已轉入錢包' : id + ' 升級完成'
      });
    },

    async blackMarketState(req) {
      const admin = await requireAdmin(req);
      const result = await transact({ data: { action: 'black-market-view' } }, (city, profile, actor, t) => ({
        market: blackMarketState(profile, ensureBlackMarket(city, t))
      }), admin);
      return { market: result.market };
    },

    async blackMarketBuy(req) {
      const admin = await requireAdmin(req), d = req.data || {};
      const itemId = String(d.itemId || ''), quantity = Math.floor(Number(d.quantity) || 0);
      const item = BLACK_MARKET[itemId];
      if (!item) throw new AppError('找不到這項黑市材料', 'bad-market-item', 'invalid-argument');
      if (quantity < 1 || quantity > 20) throw new AppError('單次購買數量必須介於 1 到 20', 'bad-market-quantity', 'invalid-argument');
      const result = await transact({ data: { action: 'black-market-buy', itemId, quantity } }, (city, profile, actor, t) => {
        const market = ensureBlackMarket(city, t), available = Number(market.stock[itemId] || 0);
        if (available < quantity) throw new AppError(available > 0 ? '全服庫存只剩 ' + available + ' 個' : '這項材料本輪已售完', 'low-market-stock');
        const cost = item.price * quantity;
        if (profile.blackCoins < cost) throw new AppError('黑曜幣不足，還差 ' + (cost - profile.blackCoins), 'low-black-coins');
        profile.blackCoins -= cost;
        profile.materials[itemId] = Number(profile.materials[itemId] || 0) + quantity;
        market.stock[itemId] -= quantity;
        return {
          market: blackMarketState(profile, market), itemId, quantity, cost,
          message: '已取得 ' + item.name + ' × ' + quantity
        };
      }, admin);
      return { market: result.market, itemId, quantity, cost: result.cost, message: result.message };
    },

    async refreshBlackMarket(at) {
      const t = Number(at) || now();
      let result = { skipped: true };
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const city = snap.data(), before = city.blackMarket && city.blackMarket.slot;
        const market = ensureBlackMarket(city, t);
        city.updatedAt = t;
        tx.set(ref, city);
        result = { skipped: false, refreshed: Number(before) !== Number(market.slot), slot: market.slot, stock: market.stock, nextRefreshAt: market.nextRefreshAt };
      });
      return result;
    }
  };
}

module.exports = {
  createEstate, seedCity, seedProfile, normalizeCity, normalizeProfile, publicState,
  accruePlot, upgradeSpec, baseRate, rateAt, storageCap, materialYield, maxHoldings, blackMarketState,
  marketStockForSlot, ensureBlackMarket,
  CITY_ID, MATERIALS, MAX_LEVEL, RATES, STORAGE_MINUTES, BLACK_MARKET, BLACK_MARKET_REFRESH_MS, ATTACK_DEBUFF_MS, ATTACK_RATE_MULT
};
