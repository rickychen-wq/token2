'use strict';
/* games/holdem.js — 德州引擎（純邏輯，不碰資料庫）
   ctx = { st: 公開牌桌, sec: { deck, holes }, t }
   所有動作都直接改 ctx，回傳 null 或「這手結束了」的結果。 */

const { AppError } = require('../core/util');
const C = require('./cards');

const PHASES = ['preflop', 'flop', 'turn', 'river'];
const BOARD_AT = { flop: 3, turn: 4, river: 5 };
const PHASE_TXT = { preflop: '翻牌前', flop: '翻牌', turn: '轉牌', river: '河牌' };

const inHand = (s) => !!(s && s.inHand && !s.folded);
const canAct = (s) => inHand(s) && !s.allIn;
const ready = (s) => !!(s && !s.sitout && !s.leaveAfter && s.stack > 0);

function nextIdx(seats, from, pred) {
  const n = seats.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from % n) + n) % n + k) % n;
    if (pred(seats[i], i)) return i;
  }
  return -1;
}
const count = (seats, pred) => seats.filter(pred).length;

function log(st, text) {
  st.log = (st.log || []).concat([{ t: Date.now(), text }]).slice(-30);
}

function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

/* ---------- 開局 ---------- */
function startHand(ctx, deck) {
  const st = ctx.st, seats = st.seats, S = st.settings;
  if (st.hand.phase !== 'idle') throw new AppError('上一手還沒結束', 'busy');
  if (count(seats, ready) < 2) throw new AppError('至少要 2 位有籌碼的玩家', 'not-enough');

  seats.forEach((s) => {
    if (!s) return;
    Object.assign(s, { bet: 0, committed: 0, folded: false, allIn: false, acted: false, inHand: ready(s), startStack: s.stack, wentAllIn: false });
  });
  const prev = typeof st.hand.dealer === 'number' ? st.hand.dealer : -1;
  const dealer = nextIdx(seats, prev, (s) => !!(s && s.inHand));
  const players = count(seats, (s) => !!(s && s.inHand));
  let sb, bb;
  if (players === 2) {
    sb = dealer;
    bb = nextIdx(seats, dealer, (s) => !!(s && s.inHand));
  } else {
    sb = nextIdx(seats, dealer, (s) => !!(s && s.inHand));
    bb = nextIdx(seats, sb, (s) => !!(s && s.inHand));
  }

  st.hand = {
    no: (st.hand.no || 0) + 1, phase: 'preflop', dealer, sb, bb,
    turn: -1, currentBet: S.bb, minRaise: S.bb, deadline: 0
  };
  st.board = [];
  st.lastResult = null;

  ctx.sec.deck = deck.slice();
  ctx.sec.holes = {};
  ctx.sec.handNo = st.hand.no;
  seats.forEach((s, i) => {
    if (s && s.inHand) ctx.sec.holes[i] = [ctx.sec.deck.pop(), ctx.sec.deck.pop()];
  });

  post(st, sb, S.sb);
  post(st, bb, S.bb);
  log(st, '第 ' + st.hand.no + ' 手開始');

  st.hand.turn = nextIdx(seats, bb, canAct);
  return advance(ctx, true);
}

function post(st, i, amount) {
  const s = st.seats[i];
  const pay = Math.min(amount, s.stack);
  s.stack -= pay; s.bet += pay;
  if (s.stack === 0) { s.allIn = true; s.wentAllIn = true; }
}

/* ---------- 動作 ---------- */
/* v11b 強制下注卷：被指定的人在那一手不能蓋牌也不能過牌，必須跟到發動方的下注額。
   要跟的金額超過上限（預設 500）就整張失效，恢復自由行動。
   回傳 { on, need, by } 讓前端和 act() 共用同一份判斷。 */
function forcedOn(st, i) {
  const s = st.seats[i], H = st.hand;
  if (!s || !s.forced || s.forced.handNo !== H.no) return null;
  const j = st.seats.findIndex((x) => x && x.pid === s.forced.by);
  if (j < 0) return null;                                   // 發動方已經離座
  const by = st.seats[j];
  const need = Math.max(0, H.currentBet - s.bet);
  if (need <= 0) return null;                               // 沒有要跟的，強制不生效
  if (by.bet <= 0) return null;                             // 發動方這一手還沒下注
  if (need > (s.forced.cap || 500)) return null;            // 超過上限 → 整張失效
  return { on: true, need: Math.min(need, s.stack), by: by.name };
}

function legal(st, i) {
  const s = st.seats[i], H = st.hand;
  if (H.phase === 'idle' || H.turn !== i || !canAct(s)) return null;
  const need = Math.max(0, H.currentBet - s.bet);
  const max = s.bet + s.stack;
  const f = forcedOn(st, i);
  return {
    check: need === 0 && !f, call: Math.min(need, s.stack),
    canRaise: max > H.currentBet, min: Math.min(H.currentBet + H.minRaise, max), max,
    forced: f ? { need: f.need, by: f.by } : null
  };
}

function act(ctx, i, type, amount) {
  const st = ctx.st, H = st.hand, s = st.seats[i];
  if (H.phase === 'idle') throw new AppError('現在沒有進行中的牌局', 'idle');
  if (H.turn !== i) throw new AppError('還沒輪到你', 'not-turn');
  if (!canAct(s)) throw new AppError('你現在不能動作', 'cannot-act');
  const need = H.currentBet - s.bet;

  const forced = forcedOn(st, i);
  if (forced && (type === 'fold' || type === 'check')) {
    throw new AppError('被 ' + forced.by + ' 的強制下注卷指定，這一手必須跟到 ' + fmt(forced.need), 'forced');
  }

  if (type === 'fold') {
    s.folded = true;
    log(st, s.name + ' 蓋牌');
  } else if (type === 'check') {
    if (need > 0) throw new AppError('有人下注了，不能過牌', 'must-call');
    log(st, s.name + ' 過牌');
  } else if (type === 'call') {
    const pay = Math.min(Math.max(need, 0), s.stack);
    s.stack -= pay; s.bet += pay;
    if (s.stack === 0) s.allIn = true;
    log(st, s.name + (pay === 0 ? ' 過牌' : s.allIn ? ' 全下跟注 ' + fmt(pay) : ' 跟注 ' + fmt(pay)));
    if (forced) { s.forced = Object.assign({}, s.forced, { used: true }); log(st, s.name + ' 被強制下注卷逼著跟了這一注'); }
  } else if (type === 'raise' || type === 'allin') {
    const max = s.bet + s.stack;
    const target = type === 'allin' ? max : Math.round(Number(amount));
    if (!(target > 0)) throw new AppError('金額不對', 'bad-amount', 'invalid-argument');
    if (target > max) throw new AppError('籌碼不夠', 'bad-amount');
    const isAll = target === max;
    if (target <= H.currentBet) {
      if (!isAll) throw new AppError('加注要超過目前的 ' + fmt(H.currentBet), 'bad-amount');
      s.stack = 0; s.bet = target; s.allIn = true;
      log(st, s.name + ' 全下跟注');
    } else {
      const inc = target - H.currentBet;
      if (inc < H.minRaise && !isAll) throw new AppError('最少要加到 ' + fmt(H.currentBet + H.minRaise), 'bad-amount');
      s.stack -= target - s.bet; s.bet = target;
      if (s.stack === 0) s.allIn = true;
      if (inc >= H.minRaise) {
        H.minRaise = inc;
        st.seats.forEach((o, k) => { if (o && k !== i && canAct(o)) o.acted = false; });
      }
      H.currentBet = target;
      log(st, s.name + (s.allIn ? ' 全下 ' : ' 加注到 ') + fmt(target));
    }
  } else {
    throw new AppError('未知的動作', 'bad-type', 'invalid-argument');
  }
  s.acted = true;
  if (s.allIn) s.wentAllIn = true;
  return advance(ctx, false);
}

/* 不是自己回合時蓋牌（離桌、暫離） */
function foldOut(ctx, i) {
  const st = ctx.st, s = st.seats[i];
  if (st.hand.phase === 'idle' || !inHand(s) || s.allIn) return null;
  if (st.hand.turn === i) return act(ctx, i, 'fold');
  s.folded = true; s.acted = true;
  log(st, s.name + ' 蓋牌');
  if (count(st.seats, inHand) <= 1 || roundDone(st)) return advance(ctx, false);
  return null;
}

/* ---------- 流程 ---------- */
function roundDone(st) {
  const live = st.seats.filter(canAct);
  if (count(st.seats, inHand) <= 1) return true;
  if (live.length === 0) return true;
  const top = Math.max.apply(null, st.seats.map((s) => (inHand(s) ? s.bet : 0)));
  if (live.length === 1 && live[0].bet >= top) return true;
  return live.every((s) => s.acted && s.bet === st.hand.currentBet);
}

function advance(ctx, justStarted) {
  const st = ctx.st;
  if (count(st.seats, inHand) <= 1) return finish(ctx);
  if (!roundDone(st)) {
    if (!justStarted || !canAct(st.seats[st.hand.turn])) {
      st.hand.turn = nextIdx(st.seats, justStarted ? st.hand.bb : st.hand.turn, canAct);
    }
    return null;
  }
  return nextStreet(ctx);
}

function nextStreet(ctx) {
  const st = ctx.st, H = st.hand;
  for (;;) {
    st.seats.forEach((s) => {
      if (!s) return;
      s.committed += s.bet; s.bet = 0; s.acted = false;
    });
    H.currentBet = 0;
    H.minRaise = st.settings.bb;
    if (H.phase === 'river') return finish(ctx);
    H.phase = PHASES[PHASES.indexOf(H.phase) + 1];
    while (st.board.length < BOARD_AT[H.phase]) st.board.push(ctx.sec.deck.pop());
    log(st, PHASE_TXT[H.phase]);
    if (count(st.seats, canAct) >= 2) {
      H.turn = nextIdx(st.seats, H.dealer, canAct);   // 翻牌後從莊家下一家開始
      return null;
    }
  }
}

function refundUncalled(st) {
  let top = -1, second = -1, who = -1;
  st.seats.forEach((s, i) => {
    if (!s || !s.inHand) return;
    const c = s.committed + s.bet;
    if (c > top) { second = top; top = c; who = i; } else if (c > second) second = c;
  });
  if (who < 0 || second < 0 || top <= second) return;
  const s = st.seats[who], back = top - second;
  s.committed = s.committed + s.bet - back; s.bet = 0; s.stack += back;
  if (s.stack > 0) s.allIn = false;
}

function buildPots(seats) {
  const levels = [...new Set(seats.map((s) => (s && s.inHand ? s.committed : 0)).filter((c) => c > 0))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  levels.forEach((lv) => {
    let amount = 0; const elig = [];
    seats.forEach((s, i) => {
      if (!s || !s.inHand) return;
      amount += Math.min(s.committed, lv) - Math.min(s.committed, prev);
      if (s.committed >= lv && !s.folded) elig.push(i);
    });
    const last = pots[pots.length - 1];
    if (amount > 0) {
      if (last && (elig.length === 0 || last.eligible.join() === elig.join())) last.amount += amount;
      else pots.push({ amount, eligible: elig });
    }
    prev = lv;
  });
  return pots;
}

function orderFromDealer(st, list) {
  const n = st.seats.length, d = st.hand.dealer;
  return list.slice().sort((a, b) => ((a - d - 1 + n) % n) - ((b - d - 1 + n) % n));
}

function finish(ctx) {
  const st = ctx.st, seats = st.seats;
  seats.forEach((s) => { if (s && s.inHand) { s.committed += s.bet; s.bet = 0; } });
  refundUncalled(st);
  const alive = seats.map((s, i) => (inHand(s) ? i : -1)).filter((i) => i >= 0);
  const won = {}, reveal = {};
  let pots;

  if (alive.length === 1) {
    const total = seats.reduce((a, s) => a + (s && s.inHand ? s.committed : 0), 0);
    won[alive[0]] = total;
    pots = [{ amount: total, eligible: alive }];
    log(st, seats[alive[0]].name + ' 贏得 ' + fmt(total));
  } else {
    while (st.board.length < 5) st.board.push(ctx.sec.deck.pop());
    alive.forEach((i) => {
      const r = C.best((ctx.sec.holes[i] || []).concat(st.board));
      reveal[i] = { cards: ctx.sec.holes[i] || [], name: r.name, score: r.score };
    });
    pots = buildPots(seats);
    pots.forEach((p) => {
      const top = Math.max.apply(null, p.eligible.map((i) => reveal[i].score));
      const winners = orderFromDealer(st, p.eligible.filter((i) => reveal[i].score === top));
      const each = Math.floor(p.amount / winners.length);
      let rem = p.amount - each * winners.length;
      winners.forEach((i) => { won[i] = (won[i] || 0) + each + (rem-- > 0 ? 1 : 0); });
    });
    Object.keys(won).forEach((i) => log(st, seats[i].name + ' 贏得 ' + fmt(won[i]) + '（' + reveal[i].name + '）'));
  }

  const players = [], stats = [];
  const showdown = alive.length > 1;
  seats.forEach((s, i) => {
    if (!s || !s.inHand) return;
    s.stack += won[i] || 0;
    players.push(i);
    stats.push({
      seat: i, pid: s.pid, won: won[i] || 0,
      net: s.stack - (typeof s.startStack === 'number' ? s.startStack : s.stack),
      showdown: showdown && !s.folded, allIn: !!s.wentAllIn
    });
  });
  st.lastResult = {
    handNo: st.hand.no,
    winners: Object.keys(won).map((i) => ({ seat: +i, pid: seats[i].pid, name: seats[i].name, amount: won[i], hand: reveal[i] ? reveal[i].name : null })),
    reveal: Object.keys(reveal).reduce((o, i) => { o[i] = { cards: reveal[i].cards, name: reveal[i].name }; return o; }, {}),
    pot: pots.reduce((a, p) => a + p.amount, 0)
  };
  seats.forEach((s) => {
    if (!s) return;
    Object.assign(s, { bet: 0, committed: 0, folded: false, allIn: false, acted: false, inHand: false });
  });
  st.hand.phase = 'idle';
  st.hand.turn = -1;
  st.hand.deadline = 0;
  ctx.sec.deck = [];
  return { ended: true, players, stats, pot: st.lastResult.pot };
}

/* 主辦作廢：退回這手所有下注 */
function abort(ctx) {
  const st = ctx.st;
  if (st.hand.phase === 'idle') throw new AppError('現在沒有進行中的牌局', 'idle');
  const players = [];
  st.seats.forEach((s, i) => {
    if (!s) return;
    if (s.inHand) players.push(i);
    s.stack += s.bet + s.committed;
    Object.assign(s, { bet: 0, committed: 0, folded: false, allIn: false, acted: false, inHand: false });
  });
  st.hand.phase = 'idle'; st.hand.turn = -1; st.hand.deadline = 0;
  st.board = []; st.lastResult = null; ctx.sec.deck = [];
  log(st, '這手作廢，下注全數退回');
  return { ended: true, players, aborted: true };
}

module.exports = { startHand, act, foldOut, legal, abort, buildPots, ready, inHand, canAct, nextIdx, forcedOn };
