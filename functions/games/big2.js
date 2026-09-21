'use strict';
/* games/big2.js — 四人台灣大老二
   四人坐滿後倒數 20 秒；每人鎖定 2000，正常輸家賠 1000、手上有 2 賠 2000，贏家全拿。
   公開桌面只存剩餘張數；完整手牌存在 secret，玩家只能讀自己的 hands/{pid}。 */

const { AppError, seasonId } = require('../core/util');
const E = require('../core/econ');
const TK = require('../core/tasks');
const C = require('./cards');
const R = require('./big2rules');

const TABLE_ID = 'main';
const DEFAULTS = {
  enabled: true,
  seatCount: 4,
  buyIn: 1000,
  reserve: 2000,
  readySec: 20,
  turnSec: 30,
  resultSec: 20
};

function blankRound(no) {
  return {
    no: no || 0, phase: 'idle', deadline: 0, turn: -1, starter: -1,
    leader: -1, passes: 0, moves: 0, lastPlay: null, lastAction: null,
    forced: false, discardedHands: 0, discardedCount: 0, result: null
  };
}

function newTable() {
  return {
    id: TABLE_ID,
    settings: Object.assign({}, DEFAULTS),
    seats: Array.from({ length: 4 }, () => null),
    round: blankRound(0),
    log: [], version: 0
  };
}

function seatOf(st, pid) { return st.seats.findIndex((x) => x && x.pid === pid); }
function nextSeat(st, from) {
  for (let step = 1; step <= st.seats.length; step++) {
    const i = (from + step) % st.seats.length;
    if (st.seats[i]) return i;
  }
  return from;
}
function full(st) { return st.seats.length === 4 && st.seats.every(Boolean); }
function addLog(st, t, text) { st.log = (st.log || []).concat([{ t, text }]).slice(-30); }

function createBig2({ db, now, requireSession, requireAdmin }) {
  const tableRef = () => db.collection('games').doc('big2').collection('tables').doc(TABLE_ID);
  const secretRef = () => tableRef().collection('secret').doc('state');
  const handRef = (pid) => tableRef().collection('hands').doc(pid);
  const cfgRef = () => db.collection('config').doc('app');
  const seasonRef = (sid) => db.collection('seasons').doc(sid);
  const accRef = (sid, pid) => seasonRef(sid).collection('accounts').doc(pid);
  const playerRef = (pid) => db.collection('players').doc(pid);

  async function run(fn) {
    return db.runTransaction(async (tx) => {
      const t = now(), sid = seasonId(t);
      const [tSnap, secSnap, cfgSnap, seasonSnap] = [
        await tx.get(tableRef()), await tx.get(secretRef()), await tx.get(cfgRef()), await tx.get(seasonRef(sid))
      ];
      const rawCfg = cfgSnap.exists ? cfgSnap.data() : {};
      const st = tSnap.exists ? tSnap.data() : newTable();
      st.settings = Object.assign({}, DEFAULTS, st.settings, ((rawCfg.games || {}).big2 || {}), { seatCount: 4, buyIn: 1000, reserve: 2000 });
      if (!Array.isArray(st.seats) || st.seats.length !== 4) st.seats = Array.from({ length: 4 }, (_, i) => (st.seats || [])[i] || null);
      if (!st.round) st.round = blankRound(0);
      const sec = secSnap.exists ? secSnap.data() : { hands: {}, discarded: [], roundNo: 0 };
      if (!sec.hands || typeof sec.hands !== 'object') sec.hands = {};
      if (!Array.isArray(sec.discarded)) sec.discarded = [];
      const cfg = E.cfgOf(rawCfg);
      const accs = {}, players = {}, playerPatch = {}, ledger = [], handOps = {};
      const ctx = {
        t, sid, st, sec, cfg, rawCfg,
        seasonStatus: seasonSnap.exists ? (seasonSnap.data().status || 'active') : 'active',
        async acc(pid, asSid) {
          const s2 = asSid || sid, key = s2 + '|' + pid;
          if (!accs[key]) {
            const snap = await tx.get(accRef(s2, pid));
            accs[key] = snap.exists ? snap.data() : E.newAccount(pid, cfg, t);
            if (!snap.exists) ledger.push([key, { type: 'start', amount: cfg.startingMoney, wallet: accs[key].wallet, bank: 0, loans: 0 }]);
            E.rollDaily(accs[key], t, cfg);
          }
          return accs[key];
        },
        async player(pid) {
          if (players[pid] === undefined) {
            const snap = await tx.get(playerRef(pid));
            players[pid] = snap.exists ? snap.data() : null;
          }
          return players[pid];
        },
        patchPlayer(pid, patch) { playerPatch[pid] = Object.assign(playerPatch[pid] || {}, patch); },
        led(pid, asSid, event) {
          const key = (asSid || sid) + '|' + pid, acc = accs[key];
          ledger.push([key, Object.assign({ wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans }, event)]);
        },
        hand(pid, cards, roundNo) { handOps[pid] = cards === null ? null : { cards: R.sortCards(cards), roundNo, updatedAt: t }; }
      };

      const out = await fn(ctx);
      if (ctx.noop) return Object.assign({ now: t }, out || {});
      st.version = (st.version || 0) + 1;
      st.updatedAt = t;
      tx.set(tableRef(), st);
      tx.set(secretRef(), sec);
      Object.keys(accs).forEach((key) => {
        const cut = key.indexOf('|'), s2 = key.slice(0, cut), pid = key.slice(cut + 1);
        E.refresh(accs[key], cfg, t);
        tx.set(accRef(s2, pid), accs[key]);
      });
      ledger.forEach(([key, event]) => {
        const cut = key.indexOf('|'), s2 = key.slice(0, cut), pid = key.slice(cut + 1);
        tx.set(accRef(s2, pid).collection('ledger').doc(), Object.assign(event, { at: t, by: pid, note: event.note || null }));
      });
      Object.keys(handOps).forEach((pid) => {
        if (handOps[pid] === null) tx.delete(handRef(pid));
        else tx.set(handRef(pid), handOps[pid]);
      });
      Object.keys(playerPatch).forEach((pid) => { if (players[pid]) tx.update(playerRef(pid), playerPatch[pid]); });
      return Object.assign({ now: t }, out || {});
    });
  }

  function checkOpen(ctx) {
    if (!ctx.st.settings.enabled) throw new AppError('大老二目前關閉中', 'disabled');
    if (ctx.seasonStatus !== 'active') throw new AppError('本季結算中，暫停遊戲', 'season-locked');
  }

  function startCountdown(ctx) {
    const st = ctx.st, Rn = st.round;
    if (Rn.phase !== 'idle' || !full(st)) return;
    Rn.phase = 'countdown';
    Rn.deadline = ctx.t + st.settings.readySec * 1000;
    addLog(st, ctx.t, '四人到齊，' + st.settings.readySec + ' 秒後發牌');
  }

  function cancelCountdown(ctx) {
    const Rn = ctx.st.round;
    if (Rn.phase === 'countdown') {
      const no = Rn.no;
      ctx.st.round = blankRound(no);
      addLog(ctx.st, ctx.t, '人數不足，開局倒數取消');
    }
  }

  function begin(ctx, forced) {
    const st = ctx.st, S = st.settings;
    checkOpen(ctx);
    const active = st.seats.map((seat, index) => ({ seat, index })).filter((x) => x.seat);
    if (!forced && !full(st)) { cancelCountdown(ctx); return false; }
    if (active.length < 2) throw new AppError('至少要有 2 位玩家才能強制開始', 'not-enough');
    const deck = C.shuffledDeck();
    const packets = Array.from({ length: 4 }, () => []);
    for (let n = 0; n < 52; n++) packets[n % 4].push(deck[n]);
    const clubPacket = packets.findIndex((cards) => cards.indexOf(R.CLUB_THREE) >= 0);
    if (clubPacket >= active.length) {
      const swap = packets[0]; packets[0] = packets[clubPacket]; packets[clubPacket] = swap;
    }
    const hands = {};
    active.forEach((x, i) => { hands[x.seat.pid] = packets[i]; });
    Object.keys(hands).forEach((pid) => { hands[pid] = R.sortCards(hands[pid]); });
    const discarded = packets.slice(active.length).reduce((out, cards) => out.concat(cards), []);
    const starter = st.seats.findIndex((seat) => seat && hands[seat.pid].indexOf(R.CLUB_THREE) >= 0);
    const no = (st.round.no || 0) + 1;
    st.round = {
      no, phase: 'playing', deadline: ctx.t + S.turnSec * 1000,
      turn: starter, starter, leader: starter, passes: 0, moves: 0,
      lastPlay: null, lastAction: { type: 'deal', seat: starter, at: ctx.t },
      forced: active.length < 4, discardedHands: 4 - active.length, discardedCount: discarded.length, result: null
    };
    secRound(ctx, hands, discarded, no);
    active.forEach((x) => { x.seat.count = 13; x.seat.timeouts = 0; });
    addLog(st, ctx.t, '第 ' + no + ' 局發牌，' + st.seats[starter].name + ' 持有梅花 3 先出' + (discarded.length ? '，其餘 ' + discarded.length + ' 張作廢' : ''));
    return true;
  }

  function secRound(ctx, hands, discarded, no) {
    ctx.sec.hands = hands;
    ctx.sec.discarded = discarded || [];
    ctx.sec.roundNo = no;
    Object.keys(hands).forEach((pid) => ctx.hand(pid, hands[pid], no));
  }

  function passTurn(ctx, i, timeout) {
    const st = ctx.st, Rn = st.round, seat = st.seats[i];
    if (!Rn.lastPlay || i === Rn.leader) throw new AppError('你有牌權，必須出牌', 'must-play');
    Rn.passes += 1;
    if (timeout) seat.timeouts = (seat.timeouts || 0) + 1;
    Rn.lastAction = { type: 'pass', pid: seat.pid, seat: i, timeout: !!timeout, at: ctx.t };
    addLog(st, ctx.t, seat.name + (timeout ? ' 超時，自動 Pass' : ' Pass'));
    if (Rn.passes >= st.seats.filter(Boolean).length - 1) {
      Rn.turn = Rn.leader;
      Rn.lastPlay = null;
      Rn.passes = 0;
      addLog(st, ctx.t, st.seats[Rn.leader].name + ' 取得牌權');
    } else {
      Rn.turn = nextSeat(st, i);
    }
    Rn.deadline = ctx.t + st.settings.turnSec * 1000;
  }

  async function settle(ctx, winnerIndex) {
    const st = ctx.st, Rn = st.round, S = st.settings;
    const winner = st.seats[winnerIndex];
    const rows = st.seats.map((seat, i) => {
      if (!seat) return null;
      const hand = ctx.sec.hands[seat.pid] || [];
      const hasTwo = hand.some((c) => R.rankOf(c) === 0);
      return { pid: seat.pid, name: seat.name, seat: i, remaining: hand.length, hasTwo, loss: i === winnerIndex ? 0 : (hasTwo ? S.reserve : S.buyIn) };
    }).filter(Boolean);
    const loserTotal = rows.reduce((sum, x) => sum + x.loss, 0);
    const prize = S.buyIn + loserTotal;

    for (const row of rows) {
      const seat = st.seats[row.seat];
      const acc = await ctx.acc(row.pid, seat.sid || ctx.sid);
      const locked = acc.inPlay && acc.inPlay.big2 ? Number(acc.inPlay.big2.amount) || S.reserve : S.reserve;
      if (row.seat === winnerIndex) {
        acc.wallet += locked + loserTotal;
        ctx.led(row.pid, seat.sid, { type: 'game', amount: locked + loserTotal, note: '大老二獲勝，獎池 ' + prize });
      } else {
        const refund = Math.max(0, locked - row.loss);
        acc.wallet += refund;
        ctx.led(row.pid, seat.sid, { type: 'game', amount: refund, note: '大老二結算，賠 ' + row.loss + (row.hasTwo ? '（手牌有 2）' : '') });
      }
      if (acc.inPlay) delete acc.inPlay.big2;
      if (E.recordPlay(acc, ctx.t, 'big2', 0)) {
        const pd = await ctx.player(row.pid);
        if (pd && TK.bump(pd, ctx.t, 'play', 1, ctx.rawCfg)) ctx.patchPlayer(row.pid, { tasks: pd.tasks });
      }
      E.autoRepay(acc, ctx.cfg, ctx.t).forEach((event) => ctx.led(row.pid, seat.sid, { type: 'repay', amount: event.amount }));
      ctx.hand(row.pid, ctx.sec.hands[row.pid] || [], Rn.no);
    }

    Rn.phase = 'result';
    Rn.turn = -1;
    Rn.deadline = ctx.t + S.resultSec * 1000;
    Rn.result = { winner: { pid: winner.pid, name: winner.name, seat: winnerIndex }, prize, players: rows, endedAt: ctx.t };
    addLog(st, ctx.t, winner.name + ' 出完手牌，贏得 ' + prize);
  }

  async function playCards(ctx, i, cards, timeout) {
    const st = ctx.st, Rn = st.round, seat = st.seats[i];
    const hand = ctx.sec.hands[seat.pid] || [];
    const picked = cards.map(Number);
    const check = hand.slice();
    for (const card of picked) {
      const at = check.indexOf(card);
      if (at < 0) throw new AppError('你手上沒有這張牌', 'bad-card', 'invalid-argument');
      check.splice(at, 1);
    }
    const combo = R.analyze(picked);
    if (!combo) throw new AppError('這個牌型不能出', 'bad-combo', 'invalid-argument');
    if (Rn.moves === 0 && picked.indexOf(R.CLUB_THREE) < 0) throw new AppError('第一手必須包含梅花 3', 'need-club-three');
    if (Rn.lastPlay) {
      const prev = R.analyze(Rn.lastPlay.cards);
      if (!R.beats(combo, prev)) throw new AppError('這手牌壓不過上一手', 'not-bigger');
    }

    ctx.sec.hands[seat.pid] = check;
    seat.count = check.length;
    if (timeout) seat.timeouts = (seat.timeouts || 0) + 1;
    Rn.lastPlay = { pid: seat.pid, name: seat.name, seat: i, cards: combo.cards, type: combo.type, label: combo.name, bomb: combo.bomb, at: ctx.t };
    Rn.lastAction = { type: 'play', pid: seat.pid, seat: i, cards: combo.cards, label: combo.name, bomb: combo.bomb, timeout: !!timeout, at: ctx.t };
    Rn.leader = i;
    Rn.passes = 0;
    Rn.moves += 1;
    ctx.hand(seat.pid, check, Rn.no);
    addLog(st, ctx.t, seat.name + (timeout ? ' 超時，自動出 ' : ' 出 ') + combo.name);
    if (!check.length) return settle(ctx, i);
    Rn.turn = nextSeat(st, i);
    Rn.deadline = ctx.t + st.settings.turnSec * 1000;
    return null;
  }

  async function refundSeat(ctx, i, note) {
    const seat = ctx.st.seats[i];
    if (!seat) return;
    const acc = await ctx.acc(seat.pid, seat.sid || ctx.sid);
    const held = acc.inPlay && acc.inPlay.big2 ? Number(acc.inPlay.big2.amount) || 0 : 0;
    if (held > 0) {
      acc.wallet += held;
      delete acc.inPlay.big2;
      ctx.led(seat.pid, seat.sid, { type: 'game', amount: held, note: note || '大老二離桌退回預留金' });
      E.autoRepay(acc, ctx.cfg, ctx.t).forEach((event) => ctx.led(seat.pid, seat.sid, { type: 'repay', amount: event.amount }));
    }
    ctx.hand(seat.pid, null, 0);
  }

  function clearTable(ctx) {
    ctx.st.seats.forEach((seat) => { if (seat) ctx.hand(seat.pid, null, 0); });
    ctx.st.seats = Array.from({ length: 4 }, () => null);
    ctx.st.round = blankRound(ctx.st.round.no || 0);
    ctx.sec.hands = {};
    ctx.sec.discarded = [];
    addLog(ctx.st, ctx.t, '本局結束，座位已清空');
  }

  return {
    DEFAULTS,

    async adminStart(req) {
      await requireAdmin(req);
      return run(async (ctx) => {
        const Rn = ctx.st.round || {};
        if (Rn.phase !== 'idle' && Rn.phase !== 'countdown') throw new AppError('這局已經開始了', 'in-round');
        const count = ctx.st.seats.filter(Boolean).length;
        if (count < 2) throw new AppError('至少要有 2 位玩家才能強制開始', 'not-enough');
        begin(ctx, true);
        addLog(ctx.st, ctx.t, '管理員以 ' + count + ' 人強制開始');
        return { players: count, discarded: (4 - count) * 13 };
      });
    },

    async sit(req) {
      const session = await requireSession(req);
      return run(async (ctx) => {
        checkOpen(ctx);
        const st = ctx.st;
        if (st.round.phase === 'playing' || st.round.phase === 'result') throw new AppError('本局進行中，請等下一輪', 'in-round');
        if (seatOf(st, session.pid) >= 0) throw new AppError('你已經入座了', 'seated');
        const free = st.seats.findIndex((x) => !x);
        if (free < 0) throw new AppError('四個位子都坐滿了', 'full');
        const acc = await ctx.acc(session.pid);
        if (acc.inPlay && acc.inPlay.big2) {
          acc.wallet += Number(acc.inPlay.big2.amount) || 0;
          delete acc.inPlay.big2;
        }
        if (acc.wallet < st.settings.reserve) throw new AppError('錢包至少要有 2,000 才能入座', 'poor');
        const pd = await ctx.player(session.pid);
        acc.wallet -= st.settings.reserve;
        if (!acc.inPlay) acc.inPlay = {};
        acc.inPlay.big2 = { tableId: TABLE_ID, amount: st.settings.reserve };
        ctx.led(session.pid, ctx.sid, { type: 'game', amount: -st.settings.reserve, note: '大老二預留金' });
        st.seats[free] = { pid: session.pid, name: pd ? pd.name : session.pid, sid: ctx.sid, count: 0, timeouts: 0 };
        addLog(st, ctx.t, st.seats[free].name + ' 入座');
        startCountdown(ctx);
        return { seat: free };
      });
    },

    async leave(req) {
      const session = await requireSession(req);
      return run(async (ctx) => {
        const st = ctx.st, i = seatOf(st, session.pid);
        if (i < 0) throw new AppError('你不在桌上', 'not-seated');
        if (st.round.phase === 'playing') throw new AppError('牌局開始後不能離座；斷線會由系統自動代操作', 'in-round');
        if (st.round.phase !== 'result') await refundSeat(ctx, i, '大老二離桌退回預留金');
        else ctx.hand(session.pid, null, 0);
        addLog(st, ctx.t, st.seats[i].name + ' 離桌');
        st.seats[i] = null;
        cancelCountdown(ctx);
        if (st.round.phase === 'result' && !st.seats.some(Boolean)) clearTable(ctx);
        return {};
      });
    },

    async play(req) {
      const session = await requireSession(req);
      const cards = req.data && req.data.cards;
      if (!Array.isArray(cards) || cards.length < 1 || cards.length > 5) throw new AppError('請選 1、2 或 5 張牌', 'bad-cards', 'invalid-argument');
      return run(async (ctx) => {
        const st = ctx.st, i = seatOf(st, session.pid);
        if (i < 0) throw new AppError('你不在桌上', 'not-seated');
        if (st.round.phase !== 'playing') throw new AppError('牌局還沒開始', 'not-playing');
        if (st.round.turn !== i) throw new AppError('還沒輪到你', 'not-turn');
        await playCards(ctx, i, cards, false);
        return {};
      });
    },

    async pass(req) {
      const session = await requireSession(req);
      return run(async (ctx) => {
        const st = ctx.st, i = seatOf(st, session.pid);
        if (i < 0) throw new AppError('你不在桌上', 'not-seated');
        if (st.round.phase !== 'playing') throw new AppError('牌局還沒開始', 'not-playing');
        if (st.round.turn !== i) throw new AppError('還沒輪到你', 'not-turn');
        passTurn(ctx, i, false);
        return {};
      });
    },

    async tick(req) {
      await requireSession(req);
      return run(async (ctx) => {
        const st = ctx.st, Rn = st.round;
        if (!Rn.deadline || ctx.t < Rn.deadline) { ctx.noop = true; return { did: null }; }
        if (Rn.phase === 'countdown') {
          if (!full(st)) { cancelCountdown(ctx); return { did: 'cancel' }; }
          begin(ctx);
          return { did: 'deal' };
        }
        if (Rn.phase === 'playing') {
          const i = Rn.turn, seat = st.seats[i];
          if (!seat) { ctx.noop = true; return { did: null }; }
          if (Rn.lastPlay && i !== Rn.leader) {
            passTurn(ctx, i, true);
            return { did: 'pass' };
          }
          const hand = ctx.sec.hands[seat.pid] || [];
          const card = Rn.moves === 0 ? R.CLUB_THREE : R.sortCards(hand)[0];
          await playCards(ctx, i, [card], true);
          return { did: 'play' };
        }
        if (Rn.phase === 'result') {
          clearTable(ctx);
          return { did: 'reset' };
        }
        ctx.noop = true;
        return { did: null };
      });
    },

    /* 季末鎖定時退回所有仍在桌上的預留金，未完成的牌局不結算。 */
    async closeSeason(oldSid) {
      return run(async (ctx) => {
        for (let i = 0; i < ctx.st.seats.length; i++) {
          const seat = ctx.st.seats[i];
          if (seat && (seat.sid || oldSid) === oldSid) await refundSeat(ctx, i, '大老二季末退回預留金');
        }
        clearTable(ctx);
        return {};
      });
    }
  };
}

module.exports = { createBig2, newTable, blankRound, DEFAULTS };
