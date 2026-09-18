'use strict';
/* games/blackjack.js — 21 點（多人一桌、AI 荷官）
   流程：idle → 有人下注開始 betting 倒數 → playing（依座位輪流）→ 荷官補牌 → result 顯示 → idle
   六副牌牌靴，剩不到 1/4 重洗。荷官 17 點停（軟 17 也停）。黑傑克 3:2，其餘 1:1，平手退注。 */

const crypto = require('crypto');
const { AppError, seasonId } = require('../core/util');
const E = require('../core/econ');

const DEFAULTS = { enabled: true, minBet: 200, maxBet: 5000, betSec: 30, turnSec: 20, resultSec: 6, seatCount: 5 };
const TABLE_ID = 'main';

/* ---------- 純規則 ---------- */
function newShoe() {
  const d = [];
  for (let k = 0; k < 6; k++) for (let i = 0; i < 52; i++) d.push(i);
  for (let i = d.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); const t = d[i]; d[i] = d[j]; d[j] = t; }
  return d;
}
function cardVal(c) { const r = ((c / 4) | 0) + 2; return r === 14 ? 11 : r >= 10 ? 10 : r; }
function handValue(cards) {
  let t = 0, aces = 0;
  cards.forEach((c) => { const v = cardVal(c); t += v; if (v === 11) aces++; });
  while (t > 21 && aces) { t -= 10; aces--; }
  return { total: t, soft: aces > 0 };
}
const isBJ = (cards) => cards.length === 2 && handValue(cards).total === 21;

/* 結算一注，回傳總派彩（含本金） */
function payout(bet, player, dealer) {
  const p = handValue(player).total, dv = handValue(dealer).total;
  const pbj = isBJ(player) && !bet.doubled, dbj = isBJ(dealer);
  const stake = bet.amount;
  if (p > 21) return { result: 'bust', pay: 0 };
  if (pbj && dbj) return { result: 'push', pay: stake };
  if (pbj) return { result: 'blackjack', pay: stake + Math.floor(stake * 1.5) };
  if (dbj) return { result: 'lose', pay: 0 };
  if (dv > 21) return { result: 'win', pay: stake * 2 };
  if (p > dv) return { result: 'win', pay: stake * 2 };
  if (p === dv) return { result: 'push', pay: stake };
  return { result: 'lose', pay: 0 };
}

function newTable() {
  return {
    id: TABLE_ID, settings: Object.assign({}, DEFAULTS),
    seats: Array.from({ length: DEFAULTS.seatCount }, () => null),
    round: { no: 0, phase: 'idle', deadline: 0, turn: -1, bets: {}, dealer: [], dealerHidden: false },
    log: [], version: 0
  };
}

function createBlackjack({ db, now, requireSession, requireAdmin }) {
  const tableRef = () => db.collection('games').doc('bj').collection('tables').doc(TABLE_ID);
  const secretRef = () => tableRef().collection('secret').doc('shoe');
  const cfgRef = () => db.collection('config').doc('app');
  const accRef = (sid, pid) => db.collection('seasons').doc(sid).collection('accounts').doc(pid);
  const playerRef = (pid) => db.collection('players').doc(pid);

  async function run(fn) {
    return db.runTransaction(async (tx) => {
      const t = now(), sid = seasonId(t);
      const tSnap = await tx.get(tableRef()), sSnap = await tx.get(secretRef()), cSnap = await tx.get(cfgRef());
      const seasonSnap = await tx.get(db.collection('seasons').doc(sid));
      const raw = cSnap.exists ? cSnap.data() : {};
      const st = tSnap.exists ? tSnap.data() : newTable();
      st.settings = Object.assign({}, DEFAULTS, st.settings, (raw.games && raw.games.bj) || {});
      const sec = sSnap.exists ? sSnap.data() : { shoe: [], hole: null };
      const cfg = E.cfgOf(raw);
      const accs = {}, ledger = [];
      const ctx = {
        t, sid, st, sec, cfg, seasonStatus: seasonSnap.exists ? (seasonSnap.data().status || 'active') : 'active',
        async acc(pid, asSid) {
          const k = (asSid || sid) + '|' + pid;
          if (!accs[k]) {
            const snap = await tx.get(accRef(asSid || sid, pid));
            accs[k] = snap.exists ? snap.data() : E.newAccount(pid, cfg, t);
            if (!snap.exists) ledger.push([k, { type: 'start', amount: cfg.startingMoney, wallet: accs[k].wallet, bank: 0, loans: 0 }]);
            E.rollDaily(accs[k], t);
          }
          return accs[k];
        },
        led(pid, asSid, e) {
          const k = (asSid || sid) + '|' + pid, a = accs[k];
          ledger.push([k, Object.assign({ wallet: a.wallet, bank: a.bank.balance, loans: a.loans }, e)]);
        },
        async name(pid) { const p = await tx.get(playerRef(pid)); return p.exists ? p.data().name : pid; }
      };
      const out = await fn(ctx);
      if (ctx.noop) return Object.assign({ now: t }, out || {});   // 沒有改任何東西就不寫入，避免觸發所有人的監聽
      st.version = (st.version || 0) + 1; st.updatedAt = t;
      tx.set(tableRef(), st); tx.set(secretRef(), sec);
      Object.keys(accs).forEach((k) => { const [s2, pid] = k.split('|'); E.refresh(accs[k], cfg, t); tx.set(accRef(s2, pid), accs[k]); });
      ledger.forEach(([k, e]) => { const [s2, pid] = k.split('|'); tx.set(accRef(s2, pid).collection('ledger').doc(), Object.assign(e, { at: t, by: pid, note: e.note || null })); });
      return Object.assign({ now: t }, out || {});
    });
  }

  const seatOf = (st, pid) => st.seats.findIndex((x) => x && x.pid === pid);
  const log = (st, text) => { st.log = (st.log || []).concat([{ t: Date.now(), text }]).slice(-20); };

  function draw(ctx) {
    if (!ctx.sec.shoe || ctx.sec.shoe.length < 78) { ctx.sec.shoe = newShoe(); log(ctx.st, '荷官重新洗牌'); }
    return ctx.sec.shoe.pop();
  }

  function nextTurn(st, from) {
    const n = st.seats.length;
    for (let i = from + 1; i < n; i++) { const b = st.round.bets[i]; if (b && !b.done) return i; }
    return -1;
  }

  async function deal(ctx) {
    const st = ctx.st, R = st.round;
    R.phase = 'playing';
    Object.keys(R.bets).forEach((i) => { R.bets[i].cards = [draw(ctx)]; });
    const up = draw(ctx);
    Object.keys(R.bets).forEach((i) => { R.bets[i].cards.push(draw(ctx)); });
    ctx.sec.hole = draw(ctx);
    R.dealer = [up]; R.dealerHidden = true;
    Object.keys(R.bets).forEach((i) => { if (isBJ(R.bets[i].cards)) R.bets[i].done = true; });
    log(st, '第 ' + R.no + ' 局發牌');
    if (isBJ([up, ctx.sec.hole])) return finishRound(ctx);   // 荷官黑傑克直接結算
    R.turn = nextTurn(st, -1);
    if (R.turn < 0) return finishRound(ctx);
    R.deadline = ctx.t + st.settings.turnSec * 1000;
  }

  async function finishRound(ctx) {
    const st = ctx.st, R = st.round;
    R.dealer = [R.dealer[0], ctx.sec.hole]; R.dealerHidden = false; ctx.sec.hole = null;
    const live = Object.keys(R.bets).some((i) => handValue(R.bets[i].cards).total <= 21 && !isBJ(R.bets[i].cards));
    if (live) { while (handValue(R.dealer).total < 17) R.dealer.push(draw(ctx)); }
    for (const i of Object.keys(R.bets)) {
      const b = R.bets[i];
      const r = payout(b, b.cards, R.dealer);
      b.result = r.result; b.payout = r.pay; b.done = true;
      const acc = await ctx.acc(b.pid, b.sid);
      acc.wallet += r.pay;
      E.recordHands(acc, ctx.t, 1);
      if (r.pay) ctx.led(b.pid, b.sid, { type: 'game', amount: r.pay, note: '21點派彩（' + { win: '贏', blackjack: '黑傑克', push: '平手', lose: '輸', bust: '爆牌' }[r.result] + '）' });
      E.autoRepay(acc, ctx.cfg, ctx.t).forEach((e) => ctx.led(b.pid, b.sid, { type: 'repay', amount: e.amount }));
    }
    R.phase = 'result'; R.turn = -1; R.deadline = ctx.t + st.settings.resultSec * 1000;
    log(st, '荷官 ' + handValue(R.dealer).total + ' 點，本局結束');
  }

  async function afterAction(ctx, i) {
    const st = ctx.st, R = st.round;
    const b = R.bets[i];
    if (handValue(b.cards).total >= 21) b.done = true;
    if (b.done) {
      R.turn = nextTurn(st, i);
      if (R.turn < 0) return finishRound(ctx);
    }
    R.deadline = ctx.t + st.settings.turnSec * 1000;
  }

  function checkOpen(ctx) {
    if (!ctx.st.settings.enabled) throw new AppError('21 點目前關閉中', 'disabled');
    if (ctx.seasonStatus !== 'active') throw new AppError('本季結算中，暫停遊戲', 'season-locked');
  }

  return {
    handValue, isBJ, payout, DEFAULTS,

    async sit(req) {
      const s = await requireSession(req);
      return run(async (ctx) => {
        checkOpen(ctx);
        const st = ctx.st;
        if (seatOf(st, s.pid) >= 0) throw new AppError('你已經坐下了', 'seated');
        const free = st.seats.findIndex((x) => !x);
        if (free < 0) throw new AppError('位子坐滿了', 'full');
        st.seats[free] = { pid: s.pid, name: await ctx.name(s.pid) };
        return { seat: free };
      });
    },

    async leave(req) {
      const s = await requireSession(req);
      return run(async (ctx) => {
        const st = ctx.st, i = seatOf(st, s.pid);
        if (i < 0) throw new AppError('你不在桌上', 'not-seated');
        const b = st.round.bets[i];
        if (b && st.round.phase === 'betting') {
          const acc = await ctx.acc(b.pid, b.sid);
          acc.wallet += b.amount;
          ctx.led(b.pid, b.sid, { type: 'game', amount: b.amount, note: '21點取消下注' });
          E.autoRepay(acc, ctx.cfg, ctx.t).forEach((e) => ctx.led(b.pid, b.sid, { type: 'repay', amount: e.amount }));
          delete st.round.bets[i];
          if (!Object.keys(st.round.bets).length) { st.round.phase = 'idle'; st.round.deadline = 0; }
        } else if (b && st.round.phase === 'playing') {
          b.done = true;   // 直接停牌，注照算
          if (st.round.turn === i) await afterAction(ctx, i);
        }
        st.seats[i] = null;
        return {};
      });
    },

    async bet(req) {
      const s = await requireSession(req);
      return run(async (ctx) => {
        checkOpen(ctx);
        const st = ctx.st, R = st.round, S = st.settings, i = seatOf(st, s.pid);
        if (i < 0) throw new AppError('先坐下才能下注', 'not-seated');
        if (R.phase !== 'idle' && R.phase !== 'betting') throw new AppError('這局已經開始了，等下一局', 'in-round');
        if (R.bets[i]) throw new AppError('這局已經下注了', 'already');
        const amt = Number(req.data && req.data.amount);
        if (!Number.isInteger(amt) || amt < S.minBet || amt > S.maxBet) throw new AppError('下注要在 ' + S.minBet + ' 到 ' + S.maxBet + ' 之間', 'bad-bet', 'invalid-argument');
        const acc = await ctx.acc(s.pid);
        if (acc.wallet < amt) throw new AppError('錢包不夠', 'poor');
        acc.wallet -= amt;
        ctx.led(s.pid, ctx.sid, { type: 'game', amount: -amt, note: '21點下注' });
        if (R.phase === 'idle') {
          R.no += 1; R.phase = 'betting'; R.bets = {}; R.dealer = []; R.dealerHidden = false; R.turn = -1;
          R.deadline = ctx.t + S.betSec * 1000;
        }
        R.bets[i] = { pid: s.pid, name: st.seats[i].name, sid: ctx.sid, amount: amt, cards: [], done: false, doubled: false };
        return {};
      });
    },

    async act(req) {
      const s = await requireSession(req);
      const type = String((req.data && req.data.type) || '');
      return run(async (ctx) => {
        const st = ctx.st, R = st.round, i = seatOf(st, s.pid);
        if (R.phase !== 'playing') throw new AppError('現在不能動作', 'not-playing');
        if (R.turn !== i) throw new AppError('還沒輪到你', 'not-turn');
        const b = R.bets[i];
        if (type === 'hit') {
          b.cards.push(draw(ctx));
        } else if (type === 'stand') {
          b.done = true;
        } else if (type === 'double') {
          if (b.cards.length !== 2 || b.doubled) throw new AppError('只有前兩張牌可以加倍', 'no-double');
          const acc = await ctx.acc(b.pid, b.sid);
          if (acc.wallet < b.amount) throw new AppError('錢包不夠加倍', 'poor');
          acc.wallet -= b.amount;
          ctx.led(b.pid, b.sid, { type: 'game', amount: -b.amount, note: '21點加倍' });
          b.amount *= 2; b.doubled = true;
          b.cards.push(draw(ctx)); b.done = true;
        } else {
          throw new AppError('未知的動作', 'bad-type', 'invalid-argument');
        }
        await afterAction(ctx, i);
        return {};
      });
    },

    async tick(req) {
      await requireSession(req);
      return run(async (ctx) => {
        const st = ctx.st, R = st.round;
        if (!R.deadline || ctx.t < R.deadline) { ctx.noop = true; return { did: null }; }
        if (R.phase === 'betting') {
          if (!Object.keys(R.bets).length) { R.phase = 'idle'; R.deadline = 0; return { did: null }; }
          await deal(ctx); return { did: 'deal' };
        }
        if (R.phase === 'playing') {
          const b = R.bets[R.turn];
          if (b) { b.done = true; log(st, b.name + ' 超時自動停牌'); }
          await afterAction(ctx, R.turn); return { did: 'timeout' };
        }
        if (R.phase === 'result') {
          R.phase = 'idle'; R.deadline = 0; R.bets = {}; R.turn = -1;
          return { did: 'reset' };
        }
        ctx.noop = true;
        return { did: null };
      });
    },

    /* 季末：還沒結算的注全部退回 */
    async closeSeason(oldSid) {
      return run(async (ctx) => {
        const st = ctx.st, R = st.round;
        if (R.phase === 'betting' || R.phase === 'playing') {
          for (const i of Object.keys(R.bets)) {
            const b = R.bets[i];
            if ((b.sid || oldSid) !== oldSid) continue;
            const acc = await ctx.acc(b.pid, oldSid);
            acc.wallet += b.amount;
            ctx.led(b.pid, oldSid, { type: 'game', amount: b.amount, note: '21點季末退注' });
            E.autoRepay(acc, ctx.cfg, ctx.t).forEach((e) => ctx.led(b.pid, oldSid, { type: 'repay', amount: e.amount }));
          }
          ctx.sec.hole = null;
        }
        R.phase = 'idle'; R.bets = {}; R.turn = -1; R.deadline = 0; R.dealer = [];
        return {};
      });
    }
  };
}

module.exports = { createBlackjack, handValue, isBJ, payout };
