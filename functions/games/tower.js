'use strict';
/* 高塔疊疊樂：目前是授權測試版。
   本金、樓層與方塊狀態都保存在當季帳戶；每次落板由 transaction 驗證樓層，避免重送。 */

const { AppError } = require('../core/util');
const E = require('../core/econ');
const TK = require('../core/tasks');

const BETS = Object.freeze([200, 500, 1000, 2000, 5000]);
const START_WIDTH = 62;
const PERFECT_TOLERANCE = 1.2;
const MAX_LAYER = 30;
const PAYOUTS = Object.freeze({
  20: 1, 21: 1.2, 22: 1.5, 23: 1.7, 24: 2,
  25: 2.5, 26: 3.2, 27: 4.2, 28: 5.5, 29: 7, 30: 10
});

function cleanBet(value) {
  const bet = Number(value);
  if (!Number.isInteger(bet) || BETS.indexOf(bet) < 0) {
    throw new AppError('高塔本金不正確', 'bad-tower-bet', 'invalid-argument');
  }
  return bet;
}

function cleanOffset(value) {
  const offset = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(offset) || Math.abs(offset) > 100) {
    throw new AppError('落板位置不正確', 'bad-tower-offset', 'invalid-argument');
  }
  return offset;
}

function towerMultiplier(layer) {
  return Number(PAYOUTS[Math.floor(Number(layer) || 0)] || 0);
}

function towerLanding(width, center, offset) {
  const w = Number(width), c = Number(center), d = cleanOffset(offset);
  if (!(w > 0 && w <= START_WIDTH) || !(c >= 0 && c <= 100)) {
    throw new AppError('高塔資料已損壞，請重新開始', 'stale-tower');
  }
  const overlap = w - Math.abs(d);
  if (overlap <= 0) return { missed: true, width: 0, center: c, offset: d, perfect: false };
  const perfect = Math.abs(d) <= PERFECT_TOLERANCE;
  return {
    missed: false,
    width: Math.round((perfect ? w : overlap) * 100) / 100,
    center: Math.round((perfect ? c : c + d / 2) * 100) / 100,
    offset: d,
    perfect
  };
}

function publicRun(run) {
  if (!run || !run.active) return null;
  return {
    active: true, bet: Number(run.bet || 0), layer: Number(run.layer || 0),
    width: Number(run.width || START_WIDTH), center: Number(run.center || 50),
    blocks: Array.isArray(run.blocks) ? run.blocks.slice(-MAX_LAYER) : [],
    multiplier: towerMultiplier(run.layer), nextMultiplier: towerMultiplier(Number(run.layer || 0) + 1),
    maxLayer: MAX_LAYER, startedAt: Number(run.startedAt || 0), lastAt: Number(run.lastAt || 0)
  };
}

function createTower({ now, requireAccess, requireAdmin, mutate }) {
  const authenticate = requireAccess || requireAdmin;
  function finishPlay(acc, raw, pl, setPlayer, t) {
    if (E.recordPlay(acc, t, 'tower', 0) && TK.bump(pl, t, 'play', 1, raw)) {
      setPlayer({ tasks: pl.tasks });
    }
  }

  return {
    async state(req) {
      const s = await authenticate(req);
      let run;
      const r = await mutate(s.pid, (acc) => { run = publicRun(acc.tower); return []; });
      return { run, wallet: r.account.wallet, preview: true, bets: BETS, payouts: PAYOUTS };
    },

    async start(req) {
      const s = await authenticate(req);
      const bet = cleanBet(req.data && req.data.bet);
      let run;
      const r = await mutate(s.pid, (acc, cfg, t) => {
        if (acc.tower && acc.tower.active) throw new AppError('你還有一座高塔正在建造', 'tower-active');
        if (acc.wallet < bet) throw new AppError('錢包不夠', 'poor');
        acc.wallet -= bet;
        acc.tower = {
          active: true, bet, layer: 0, width: START_WIDTH, center: 50,
          blocks: [], startedAt: t, lastAt: t
        };
        run = publicRun(acc.tower);
        return [{ type: 'game', amount: -bet, wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans, note: '高塔疊疊樂・投入本金' }];
      });
      return { run, wallet: r.account.wallet, preview: true, bets: BETS, payouts: PAYOUTS };
    },

    async drop(req) {
      const s = await authenticate(req);
      const expected = Number(req.data && req.data.layer), offset = cleanOffset(req.data && req.data.offset);
      let out;
      const r = await mutate(s.pid, (acc, cfg, t, raw, pl, setPlayer) => {
        const run = acc.tower;
        if (!run || !run.active) throw new AppError('目前沒有正在建造的高塔', 'no-tower');
        const nextLayer = Number(run.layer || 0) + 1;
        if (!Number.isInteger(expected) || expected !== nextLayer) {
          throw new AppError('這塊樓層已經處理過，請重新整理', 'tower-turn', 'already-exists');
        }
        const landed = towerLanding(run.width, run.center, offset);
        if (landed.missed) {
          const bet = Number(run.bet || 0), layer = Number(run.layer || 0);
          delete acc.tower;
          finishPlay(acc, raw, pl, setPlayer, t);
          out = { ended: true, missed: true, layer, payout: 0, profit: -bet, multiplier: 0, wallet: acc.wallet };
          return [{ type: 'game', amount: 0, wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans, note: '高塔疊疊樂・第 ' + nextLayer + ' 層墜落' }];
        }
        const block = { layer: nextLayer, width: landed.width, center: landed.center, offset: landed.offset, perfect: landed.perfect };
        run.layer = nextLayer; run.width = landed.width; run.center = landed.center;
        run.blocks = (Array.isArray(run.blocks) ? run.blocks : []).concat(block).slice(-MAX_LAYER);
        run.lastAt = t;
        const mult = towerMultiplier(nextLayer);
        if (nextLayer >= MAX_LAYER) {
          const payout = Math.floor(Number(run.bet || 0) * mult), bet = Number(run.bet || 0);
          acc.wallet += payout;
          delete acc.tower;
          finishPlay(acc, raw, pl, setPlayer, t);
          out = { ended: true, completed: true, missed: false, block, layer: nextLayer, multiplier: mult, payout, profit: payout - bet, wallet: acc.wallet };
          return [{ type: 'game', amount: payout, wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans, note: '高塔疊疊樂・登頂 ' + MAX_LAYER + ' 層' }];
        }
        out = { ended: false, missed: false, block, run: publicRun(run), perfect: landed.perfect, wallet: acc.wallet };
        return [];
      });
      out.wallet = r.account.wallet;
      return out;
    },

    async cashout(req) {
      const s = await authenticate(req);
      let out;
      const r = await mutate(s.pid, (acc, cfg, t, raw, pl, setPlayer) => {
        const run = acc.tower;
        if (!run || !run.active) throw new AppError('目前沒有可以結算的高塔', 'no-tower');
        const mult = towerMultiplier(run.layer);
        if (mult <= 0) throw new AppError('第 20 層開始才能帶走本金', 'tower-no-payout');
        const bet = Number(run.bet || 0), payout = Math.floor(bet * mult), layer = Number(run.layer || 0);
        acc.wallet += payout;
        delete acc.tower;
        finishPlay(acc, raw, pl, setPlayer, t);
        out = { ended: true, layer, multiplier: mult, payout, profit: payout - bet };
        return [{ type: 'game', amount: payout, wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans, note: '高塔疊疊樂・第 ' + layer + ' 層收手' }];
      });
      out.wallet = r.account.wallet;
      return out;
    },

    async abandon(req) {
      const s = await authenticate(req);
      let out;
      const r = await mutate(s.pid, (acc, cfg, t, raw, pl, setPlayer) => {
        const run = acc.tower;
        if (!run || !run.active) throw new AppError('目前沒有正在建造的高塔', 'no-tower');
        const bet = Number(run.bet || 0), layer = Number(run.layer || 0);
        delete acc.tower;
        finishPlay(acc, raw, pl, setPlayer, t);
        out = { ended: true, abandoned: true, layer, payout: 0, profit: -bet };
        return [{ type: 'game', amount: 0, wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans, note: '高塔疊疊樂・放棄建造' }];
      });
      out.wallet = r.account.wallet;
      return out;
    }
  };
}

module.exports = {
  createTower, BETS, PAYOUTS, START_WIDTH, PERFECT_TOLERANCE, MAX_LAYER,
  cleanBet, cleanOffset, towerMultiplier, towerLanding, publicRun
};
