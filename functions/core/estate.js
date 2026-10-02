'use strict';

const { AppError } = require('./util');

const CITY_ID = 'city01';
const MAX_HOLDINGS = 2;
const NEW_SHIELD_MS = 24 * 3600 * 1000;
const DAMAGE = Object.freeze({ missile: 35, bomb: 50 });

function plotId(index) {
  return String.fromCharCode(65 + Math.floor(index / 4)) + String(index % 4 + 1);
}

function blankPlot(index) {
  return {
    id: plotId(index), status: 'vacant', ownerPid: null, ownerName: null,
    stage: 0, integrity: 0, mines: 0, shieldUntil: 0, acquiredAt: 0,
    updatedAt: 0
  };
}

function seedCity(t, admin) {
  const plots = Array.from({ length: 16 }, (_, i) => blankPlot(i));
  [
    { i: 0, stage: 2, name: '二階展示地' },
    { i: 3, stage: 3, name: '三階展示地' },
    { i: 12, stage: 4, name: '四階展示地' },
    { i: 15, stage: 5, name: '五階展示地' }
  ].forEach((x) => {
    plots[x.i] = Object.assign(blankPlot(x.i), {
      status: 'showcase', ownerPid: 'system', ownerName: x.name,
      stage: x.stage, integrity: 100, updatedAt: t
    });
  });
  plots[5] = Object.assign(blankPlot(5), {
    status: 'owned', ownerPid: admin.pid, ownerName: admin.name || '管理員',
    stage: 1, integrity: 100, mines: 0, shieldUntil: 0, acquiredAt: t, updatedAt: t
  });
  return { id: CITY_ID, version: 2, sandbox: true, plots, createdAt: t, updatedAt: t };
}

function normalizeCity(raw, t, admin) {
  if (!raw || !Array.isArray(raw.plots) || raw.plots.length !== 16) return seedCity(t, admin);
  const city = Object.assign({}, raw, { id: CITY_ID, version: 2, sandbox: true });
  city.plots = raw.plots.map((p, i) => Object.assign(blankPlot(i), p || {}, { id: plotId(i) }));
  return city;
}

function publicState(city, pid, t) {
  const plots = city.plots.map((p) => Object.assign({}, p, {
    shielded: Number(p.shieldUntil || 0) > t
  }));
  return {
    id: city.id, sandbox: true, maxHoldings: MAX_HOLDINGS,
    holdings: plots.filter((p) => p.ownerPid === pid && p.status !== 'vacant').length,
    vacant: plots.filter((p) => p.status === 'vacant').length,
    plots, now: t, updatedAt: city.updatedAt || t
  };
}

function cleanLotId(value) {
  const id = String(value || '').toUpperCase();
  if (!/^[A-D][1-4]$/.test(id)) throw new AppError('土地編號不正確', 'bad-lot', 'invalid-argument');
  return id;
}

function cleanStage(value) {
  const stage = Number(value);
  if (!Number.isInteger(stage) || stage < 1 || stage > 5) throw new AppError('建築階級要在 1 到 5 之間', 'bad-stage', 'invalid-argument');
  return stage;
}

function findPlot(city, id) {
  const plot = city.plots.find((p) => p.id === id);
  if (!plot) throw new AppError('找不到這塊土地', 'no-lot', 'not-found');
  return plot;
}

function ensureOwner(plot, admin) {
  if (plot.ownerPid !== admin.pid) throw new AppError('這不是你的測試土地', 'not-owner', 'permission-denied');
}

function createEstate({ db, now, requireAdmin }) {
  const ref = db.collection('estateSandbox').doc(CITY_ID);

  async function transact(req, mutate) {
    const admin = await requireAdmin(req);
    const t = now();
    let out;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const city = normalizeCity(snap.exists ? snap.data() : null, t, admin);
      out = mutate ? mutate(city, admin, t) : null;
      city.updatedAt = t;
      tx.set(ref, city);
      tx.set(ref.collection('logs').doc(), {
        action: (req.data && req.data.action) || 'view', lotId: req.data && req.data.lotId || null,
        by: admin.pid, at: t, result: out || null
      });
      out = Object.assign({ state: publicState(city, admin.pid, t) }, out || {});
    });
    return out;
  }

  return {
    async state(req) {
      const admin = await requireAdmin(req);
      const t = now();
      let state;
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const city = normalizeCity(snap.exists ? snap.data() : null, t, admin);
        if (!snap.exists) tx.set(ref, city);
        state = publicState(city, admin.pid, t);
      });
      return { state };
    },

    async action(req) {
      const d = req.data || {}, action = String(d.action || '');
      if (!['buy', 'sell', 'stage', 'repair', 'mine', 'attack', 'foreclose', 'reset'].includes(action)) {
        throw new AppError('未知的領地操作', 'bad-action', 'invalid-argument');
      }
      return transact(req, (city, admin, t) => {
        if (action === 'reset') {
          const reset = seedCity(t, admin);
          city.plots = reset.plots; city.createdAt = t;
          return { message: '測試城市已重設' };
        }
        const id = cleanLotId(d.lotId), plot = findPlot(city, id);
        if (action === 'buy') {
          if (plot.status !== 'vacant') throw new AppError('這塊土地已經有主人', 'lot-taken');
          const held = city.plots.filter((p) => p.ownerPid === admin.pid && p.status !== 'vacant').length;
          if (held >= MAX_HOLDINGS) throw new AppError('測試版每人最多持有 ' + MAX_HOLDINGS + ' 棟', 'holding-limit');
          Object.assign(plot, { status: 'owned', ownerPid: admin.pid, ownerName: admin.name || '管理員', stage: 1, integrity: 100, mines: 0, shieldUntil: t + NEW_SHIELD_MS, acquiredAt: t, updatedAt: t });
          return { lotId: id, message: '已購入 ' + id + '，並建立一階木屋' };
        }
        if (action === 'sell') {
          ensureOwner(plot, admin);
          Object.assign(plot, blankPlot(city.plots.indexOf(plot)), { updatedAt: t });
          return { lotId: id, message: id + ' 已重新開放購買' };
        }
        if (action === 'stage') {
          if (plot.status === 'vacant' || plot.status === 'ruined') throw new AppError('這塊土地目前不能切換建築', 'bad-state');
          if (plot.ownerPid !== admin.pid && plot.status !== 'showcase') throw new AppError('只能調整自己的建築', 'not-owner', 'permission-denied');
          plot.stage = cleanStage(d.stage); plot.integrity = Math.max(1, Number(plot.integrity || 100)); plot.updatedAt = t;
          return { lotId: id, message: id + ' 已切換為第 ' + plot.stage + ' 階' };
        }
        if (action === 'repair') {
          ensureOwner(plot, admin);
          plot.integrity = 100; plot.status = 'owned'; plot.updatedAt = t;
          return { lotId: id, message: id + ' 已完全修復' };
        }
        if (action === 'mine') {
          ensureOwner(plot, admin);
          if (plot.status === 'ruined') throw new AppError('廢墟不能佈置地雷', 'bad-state');
          if (plot.mines >= 3) throw new AppError('每塊土地最多三枚防禦地雷', 'mine-limit');
          plot.mines += 1; plot.updatedAt = t;
          return { lotId: id, message: id + ' 已增加一枚防禦地雷' };
        }
        if (action === 'attack') {
          if (!['owned', 'showcase'].includes(plot.status)) throw new AppError('這塊土地目前不能攻擊', 'bad-state');
          if (plot.ownerPid === admin.pid) throw new AppError('不能攻擊自己的土地', 'self-attack');
          if (Number(plot.shieldUntil || 0) > t) throw new AppError('這塊土地仍在新手保護期', 'shielded');
          const weapon = String(d.weapon || 'missile');
          if (!DAMAGE[weapon]) throw new AppError('攻擊武器不正確', 'bad-weapon', 'invalid-argument');
          let damage = DAMAGE[weapon], defended = false;
          if (plot.mines > 0) { plot.mines -= 1; damage = Math.ceil(damage * 0.45); defended = true; }
          plot.integrity = Math.max(0, Number(plot.integrity || 0) - damage);
          if (plot.integrity <= 0) plot.status = 'ruined';
          plot.updatedAt = t;
          return { lotId: id, weapon, damage, defended, ruined: plot.status === 'ruined', message: defended ? '防禦地雷啟動，傷害降低為 ' + damage : '造成 ' + damage + ' 點傷害' };
        }
        if (action === 'foreclose') {
          if (plot.status !== 'ruined') throw new AppError('只有完全損毀的土地能進入法拍', 'not-ruined');
          Object.assign(plot, blankPlot(city.plots.indexOf(plot)), { updatedAt: t });
          return { lotId: id, message: id + ' 已完成法拍並重新開放' };
        }
      });
    }
  };
}

module.exports = { createEstate, seedCity, normalizeCity, publicState, CITY_ID, MAX_HOLDINGS, DAMAGE };
