'use strict';
/* games/poker.js — 德州牌桌：入座、動作、計時、AI 控桌、跟經濟系統的帶入帶出
   每個操作都是一個 transaction：讀牌桌 + 牌組 + 需要的帳戶 → 跑引擎 → 全部寫回 */

const { AppError, seasonId } = require('../core/util');
const CT = require('./contest');
const TK = require('../core/tasks');
const E = require('../core/econ');
const H = require('./holdem');
const C = require('./cards');
const { publishHighlights } = require('../core/highlights');
const { BASIC_EMOTES, merge } = require('../core/catalog');
const byId = merge(null);

const DEFAULT_SETTINGS = {
  seatCount: 9, sb: 25, bb: 50, buyInMax: 5000,
  turnSec: 30,          // 思考秒數
  auto: true,           // AI 控桌
  minPlayers: 3,        // 自動開局最少人數
  waitSec: 30,          // 有人進出時等待
  quickSec: 5,          // 人數沒變時下一手間隔
  maxWaitSec: 90,       // 倒數最長等待
  afkLimit: 2           // 連續超時幾次自動暫離
};
const SETTING_LIMITS = {
  sb: [1, 100000], bb: [2, 200000], buyInMax: [10, 10000000], turnSec: [10, 180],
  minPlayers: [2, 9], waitSec: [3, 300], quickSec: [2, 60], maxWaitSec: [5, 600], afkLimit: [1, 10]
};
const TABLE_ID = 'main';

function newTable() {
  return {
    id: TABLE_ID,
    settings: Object.assign({}, DEFAULT_SETTINGS),
    seats: Array.from({ length: DEFAULT_SETTINGS.seatCount }, () => null),
    hand: { no: 0, phase: 'idle', dealer: -1, sb: -1, bb: -1, turn: -1, currentBet: 0, minRaise: 0, deadline: 0 },
    board: [], lastResult: null, log: [],
    auto: { nextHandAt: null, countdownStart: null, lastSig: '' },
    actionIds: [], version: 0
  };
}

function createPoker({ db, now, requireSession, requireAdmin }) {
  const tableRef = () => db.collection('games').doc('poker').collection('tables').doc(TABLE_ID);
  const secretRef = () => tableRef().collection('secret').doc('deck');
  const holeRef = (pid) => tableRef().collection('holes').doc(pid);
  const cfgRef = () => db.collection('config').doc('app');
  const accRef = (sid, pid) => db.collection('seasons').doc(sid).collection('accounts').doc(pid);
  const playerRef = (pid) => db.collection('players').doc(pid);

  async function run(fn) {
    const result = await db.runTransaction(async (tx) => {
      const t = now(), sid = seasonId(t);
      const tSnap = await tx.get(tableRef());
      const sSnap = await tx.get(secretRef());
      const cfgSnap = await tx.get(cfgRef());
      const seasonSnap = await tx.get(db.collection('seasons').doc(sid));
      const st = tSnap.exists ? tSnap.data() : newTable();
      st.settings = Object.assign({}, DEFAULT_SETTINGS, st.settings);
      const sec = sSnap.exists ? sSnap.data() : { deck: [], holes: {}, handNo: 0 };
      const rawCfg = cfgSnap.exists ? cfgSnap.data() : {};
      const cfg = E.cfgOf(rawCfg);
      const accs = {}, ledger = [], holes = [], players = {}, playerPatch = {}, highlights = [];
      const seasonStatus = seasonSnap.exists ? (seasonSnap.data().status || 'active') : 'active';

      const ctx = {
        t, sid, st, sec, cfg, rawCfg, tx, seasonStatus,
        async player(pid) {
          if (!players[pid]) {
            const snap = await tx.get(playerRef(pid));
            players[pid] = snap.exists ? snap.data() : null;
          }
          return players[pid];
        },
        patchPlayer(pid, patch) { playerPatch[pid] = Object.assign(playerPatch[pid] || {}, patch); },
        highlight(event) { highlights.push(event); },
        /* 讀帳戶。asSid 用在座位屬於上一季的時候（季末帶回） */
        async acc(pid, asSid) {
          const k = (asSid || sid) + '|' + pid;
          if (!accs[k]) {
            const snap = await tx.get(accRef(asSid || sid, pid));
            let a;
            if (snap.exists) a = snap.data();
            else {
              a = E.newAccount(pid, cfg, t);
              ledger.push([k, { type: 'start', amount: cfg.startingMoney, wallet: a.wallet, bank: 0, loans: 0 }]);
            }
            E.rollDaily(a, t, cfg);
            accs[k] = a;
          }
          return accs[k];
        },
        led(pid, e, asSid) {
          const k = (asSid || sid) + '|' + pid, a = accs[k];
          ledger.push([k, Object.assign({ wallet: a.wallet, bank: a.bank.balance, loans: a.loans }, e)]);
        },
        hole(pid, cards, handNo) { holes.push([pid, { cards, handNo }]); }
      };

      const out = await fn(ctx);
      if (ctx.noop) return Object.assign({ now: t }, out || {});   // 沒有改任何東西就不寫入，避免觸發所有人的監聽

      st.version = (st.version || 0) + 1;
      st.updatedAt = t;
      tx.set(tableRef(), st);
      tx.set(secretRef(), sec);
      Object.keys(accs).forEach((k) => {
        const [asSid, pid] = k.split('|');
        E.refresh(accs[k], cfg, t);
        tx.set(accRef(asSid, pid), accs[k]);
      });
      ledger.forEach(([k, e]) => {
        const [asSid, pid] = k.split('|');
        tx.set(accRef(asSid, pid).collection('ledger').doc(), Object.assign(e, { at: t, by: e.by || pid, note: null }));
      });
      holes.forEach(([pid, d]) => tx.set(holeRef(pid), d));
      Object.keys(playerPatch).forEach((pid) => { if (players[pid]) tx.update(playerRef(pid), playerPatch[pid]); });
      return Object.assign({ now: t, _highlights: highlights }, out || {});
    });
    const highlights = result._highlights || [];
    delete result._highlights;
    await publishHighlights(db, highlights);
    return result;
  }

  const seatOf = (st, pid) => st.seats.findIndex((s) => s && s.pid === pid);
  const seatedPids = (st) => st.seats.filter(Boolean).map((x) => x.pid);
  /* v11b 道具數值，後台可改 */
  const FORCE_CAP = (ctx) => Math.max(1, Math.floor(Number(((ctx.rawCfg || {}).items || {}).forceBetCap) || 500));
  const DUEL_PRIZE = (ctx) => {
    const I = (ctx.rawCfg || {}).items || {};
    return { win: Math.max(0, Math.floor(Number(I.duelWin) || 1000)), lose: Math.max(0, Math.floor(Number(I.duelLose) || 200)) };
  };

  /* ---------- v11b 道具對抗 ---------- */

  /* 作廢進行中的對抗並把卡退還給發動方 */
  async function cancelContest(ctx, reason) {
    const c = CT.current(ctx.st);
    if (!c) return null;
    const from = await ctx.player(c.from);
    CT.cancel(ctx.st, reason, from);
    if (from) ctx.patchPlayer(c.from, { items: from.items });
    ctx.st.log = (ctx.st.log || []).concat([{ t: ctx.t, text: c.fromName + ' 的' + c.name + '沒用成，卡片退回' }]).slice(-30);
    return c;
  }

  /* 只要不是對抗自己造成的狀態改變，都先檢查一下該不該作廢 */
  async function sweepContest(ctx) {
    const c = CT.current(ctx.st);
    if (!c) return;
    const why = CT.staleReason(ctx.st, c, ctx.t, seatedPids(ctx.st));
    if (why) await cancelContest(ctx, why);
  }

  /* 對抗走到 exec 就執行效果 */
  async function applyContest(ctx) {
    const st = ctx.st, c = CT.current(st);
    if (!c || c.phase !== 'exec') return null;
    if (c.kind === 'seat') {
      const i = seatOf(st, c.from), j = seatOf(st, c.to);
      if (i < 0 || j < 0) { await cancelContest(ctx, 'left-table'); return null; }
      const tmp = st.seats[i]; st.seats[i] = st.seats[j]; st.seats[j] = tmp;
      st.log = (st.log || []).concat([{ t: ctx.t, text: c.fromName + ' 和 ' + c.toName + ' 換了座位' }]).slice(-30);
      CT.finish(st, { swapped: true });
      return { kind: 'seat', swapped: true };
    }
    if (c.kind === 'forcebet') {
      const j = seatOf(st, c.to);
      if (j < 0) { await cancelContest(ctx, 'left-table'); return null; }
      const cap = FORCE_CAP(ctx);
      // 標在座位上，下一手生效。handNo 先填「下一手」的編號
      st.seats[j].forced = { by: c.from, handNo: (st.hand.no || 0) + 1, cap, card: c.card };
      st.log = (st.log || []).concat([{ t: ctx.t, text: c.toName + ' 下一手必須跟到 ' + c.fromName + ' 的下注（上限 ' + cap + '）' }]).slice(-30);
      CT.finish(st, { forced: true, cap });
      return { kind: 'forcebet', cap };
    }
    if (c.kind === 'money') {
      const a = c.picks[c.from], b = c.picks[c.to];
      const fromWins = CT.beats(a, b);
      const winner = fromWins ? c.from : c.to, loser = fromWins ? c.to : c.from;
      const W = DUEL_PRIZE(ctx);
      const wa = await ctx.acc(winner), la = await ctx.acc(loser);
      wa.wallet += W.win; ctx.led(winner, { type: 'duel', amount: W.win });
      la.wallet += W.lose; ctx.led(loser, { type: 'duel', amount: W.lose });
      const wName = winner === c.from ? c.fromName : c.toName;
      st.log = (st.log || []).concat([{ t: ctx.t, text: c.fromName + ' 和 ' + c.toName + ' 抽卡對決，' + wName + ' 贏了' + (c.autoPicked ? '（有人逾時，系統代選）' : '') }]).slice(-30);
      CT.finish(st, { winner, loser, cards: { [c.from]: a, [c.to]: b }, win: W.win, lose: W.lose });
      return { kind: 'money', winner, loser, cards: { [c.from]: a, [c.to]: b } };
    }
    return null;
  }
  const readyPids = (st) => st.seats.filter(H.ready).map((s) => s.pid).sort().join(',');

  /* AI 控桌：決定下一手什麼時候開 */
  function schedule(ctx, reason) {
    const st = ctx.st, S = st.settings, a = st.auto;
    if (st.hand.phase !== 'idle') return;
    if (!S.auto || blocked(ctx)) { a.nextHandAt = null; a.countdownStart = null; return; }
    const sig = readyPids(st);
    const n = sig ? sig.split(',').length : 0;
    if (n < S.minPlayers) { a.nextHandAt = null; a.countdownStart = null; return; }
    if (reason === 'handEnd' && sig === a.lastSig) {
      a.nextHandAt = ctx.t + S.quickSec * 1000;
      a.countdownStart = null;
      return;
    }
    if (reason === 'roster' && a.nextHandAt && !a.countdownStart && sig === a.lastSig) return;
    if (!a.countdownStart) a.countdownStart = ctx.t;
    a.nextHandAt = Math.min(ctx.t + S.waitSec * 1000, a.countdownStart + S.maxWaitSec * 1000);
  }

  /* 本季鎖定、或桌上還有上一季的籌碼時，不能開新的一手 */
  function blocked(ctx) {
    if (ctx.seasonStatus !== 'active') return '本季結算中，暫停開局';
    if (ctx.st.seats.some((x) => x && x.sid && x.sid !== ctx.sid)) return '上一季還沒結算，請主辦按「結算上一季」';
    return null;
  }

  async function begin(ctx) {
    const st = ctx.st;
    const why = blocked(ctx);
    if (why) throw new AppError(why, 'season-locked');
    await cancelContest(ctx, 'new-hand');      // 道具只在兩手之間有效，開新的一手就作廢
    H.startHand(ctx, C.shuffledDeck());
    st.auto.lastSig = st.seats.filter((s) => s && s.inHand).map((s) => s.pid).sort().join(',');
    st.auto.nextHandAt = null;
    st.auto.countdownStart = null;
    Object.keys(ctx.sec.holes).forEach((i) => {
      ctx.hole(st.seats[i].pid, ctx.sec.holes[i], st.hand.no);
    });
    return after(ctx, st.hand.phase === 'idle' ? { ended: true, players: Object.keys(ctx.sec.holes).map(Number) } : null);
  }

  /* 牌桌籌碼 → 錢包，並處理還款 */
  function cashOut(ctx, acc, seat) {
    const amt = seat.stack, asSid = seat.sid || ctx.sid;
    acc.wallet += amt;
    delete acc.inPlay.poker;
    ctx.led(acc.pid, { type: 'cashOut', amount: amt }, asSid);
    E.autoRepay(acc, ctx.cfg, ctx.t).forEach((e) => ctx.led(acc.pid, { type: 'repay', amount: e.amount }, asSid));
    seat.stack = 0;
  }

  /* v11b：一手結束時清掉強制下注的標記。
     如果目標整手都沒有被逼著跟過（例如他發完牌就 all-in、或牌局提早結束沒輪到他），
     效果等於沒發生，把卡退還給發動方。 */
  async function settleForced(ctx) {
    const st = ctx.st;
    for (const seat of st.seats) {
      if (!seat || !seat.forced) continue;
      if (seat.forced.handNo > st.hand.no) continue;        // 還沒到生效的那一手
      const f = seat.forced;
      delete seat.forced;
      if (f.used) continue;
      const from = await ctx.player(f.by);
      if (!from) continue;
      from.items = CT.refund(from, f.card);
      ctx.patchPlayer(f.by, { items: from.items });
      st.log = (st.log || []).concat([{ t: ctx.t, text: seat.name + ' 這一手沒有需要跟的注，強制下注卷退回' }]).slice(-30);
    }
  }

  /* 牌局中途或結束後：推進計時、結算帳戶 */
  async function after(ctx, res) {
    const st = ctx.st, S = st.settings;
    if (!res || !res.ended) {
      if (st.hand.phase !== 'idle') st.hand.deadline = ctx.t + S.turnSec * 1000;
      return null;
    }
    await settleForced(ctx);
    const cfg = ctx.cfg;
    const record = !res.aborted && ctx.t >= (ctx.rawCfg.statsFrom || 0);
    const statOf = {};
    (res.stats || []).forEach((x) => { statOf[x.seat] = x; });
    for (const i of res.players) {
      const s = st.seats[i];
      if (!s) continue;
      const asSid = s.sid || ctx.sid;
      const acc = await ctx.acc(s.pid, asSid);
      if (!res.aborted) {
        E.recordHands(acc, ctx.t, 1);
        const pd = await ctx.player(s.pid);                 // v12 任務：生涯場數
        if (pd && TK.bump(pd, ctx.t, 'play', 1, ctx.rawCfg)) ctx.patchPlayer(s.pid, { tasks: pd.tasks });
      }
      // 還款：錢包加桌上籌碼達到門檻，先扣錢包，不夠再扣桌上
      while (acc.loans > 0 && acc.wallet + s.stack >= cfg.loanRepayAt) {
        const fromWallet = Math.min(acc.wallet, cfg.loanUnit);
        acc.wallet -= fromWallet;
        s.stack -= cfg.loanUnit - fromWallet;
        acc.loans -= 1;
        acc.inPlay.poker = { tableId: TABLE_ID, amount: s.stack };
        ctx.led(s.pid, { type: 'repay', amount: -cfg.loanUnit }, asSid);
      }
      acc.inPlay.poker = { tableId: TABLE_ID, amount: s.stack };
      const x = statOf[i];
      if (!res.aborted && x && x.net >= 15000) {
        ctx.highlight({
          id: 'poker-' + ctx.sid + '-' + st.hand.no + '-' + s.pid,
          type: 'poker', pid: s.pid, name: s.name, at: ctx.t,
          amount: x.net, handNo: st.hand.no
        });
      }
      if (record && x) {
        const sp = Object.assign({ hands: 0, wins: 0, net: 0, biggestPot: 0 }, acc.poker);
        sp.hands += 1; if (x.won > 0) sp.wins += 1; sp.net += x.net;
        if (x.won > sp.biggestPot) sp.biggestPot = x.won;
        acc.poker = sp;
        const p = await ctx.player(s.pid);
        if (p) {
          const g = Object.assign({ hands: 0, wins: 0, showdowns: 0, showdownWins: 0, allIns: 0, allInWins: 0, net: 0, biggestPot: 0 },
            (p.games && p.games.poker) || {});
          g.hands += 1;
          if (x.won > 0) g.wins += 1;
          if (x.showdown) { g.showdowns += 1; if (x.won > 0) g.showdownWins += 1; }
          if (x.allIn) { g.allIns += 1; if (x.won > 0) g.allInWins += 1; }
          g.net += x.net;
          if (x.won > g.biggestPot) g.biggestPot = x.won;
          p.games = Object.assign({}, p.games, { poker: g });
          ctx.patchPlayer(s.pid, { 'games.poker': g });
        }
      }
    }
    for (let i = 0; i < st.seats.length; i++) {
      const s = st.seats[i];
      if (!s || !s.leaveAfter) continue;
      const acc = await ctx.acc(s.pid, s.sid || ctx.sid);
      cashOut(ctx, acc, s);
      st.seats[i] = null;
    }
    schedule(ctx, 'handEnd');
    return null;
  }

  function cleanInt(v, lo, hi, msg) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new AppError(msg, 'bad-amount', 'invalid-argument');
    return n;
  }

  return {
    DEFAULT_SETTINGS,

    async sit(req) {
      const s = await requireSession(req);
      const pSnap = await playerRef(s.pid).get();
      const name = pSnap.exists ? pSnap.data().name : s.pid;
      return run(async (ctx) => {
        const st = ctx.st, S = st.settings;
        if (seatOf(st, s.pid) >= 0) throw new AppError('你已經在桌上了', 'seated');
        const why = blocked(ctx);
        if (why) throw new AppError(why, 'season-locked');
        const free = st.seats.findIndex((x) => !x);
        if (free < 0) throw new AppError('桌上已經坐滿了', 'full');
        const acc = await ctx.acc(s.pid);
        if (acc.inPlay && acc.inPlay.poker) {   // 資料不一致時先把錢還回去
          acc.wallet += acc.inPlay.poker.amount || 0;
          delete acc.inPlay.poker;
          E.autoRepay(acc, ctx.cfg, ctx.t).forEach((e) => ctx.led(s.pid, { type: 'repay', amount: e.amount }));
        }
        const max = Math.min(S.buyInMax, acc.wallet);
        if (max < S.bb) throw new AppError('錢包不到 ' + S.bb + '，先到銀行借款', 'broke');
        const amount = cleanInt(req.data && req.data.amount, S.bb, max, '帶入金額要在 ' + S.bb + ' 到 ' + max + ' 之間');
        acc.wallet -= amount;
        acc.inPlay.poker = { tableId: TABLE_ID, amount };
        ctx.led(s.pid, { type: 'buyIn', amount: -amount });
        st.seats[free] = {
          pid: s.pid, name, sid: ctx.sid, stack: amount, bet: 0, committed: 0,
          inHand: false, folded: false, allIn: false, acted: false,
          sitout: false, leaveAfter: false, timeouts: 0
        };
        st.log = (st.log || []).concat([{ t: ctx.t, text: name + ' 入座' }]).slice(-30);
        schedule(ctx, 'roster');
        return { seat: free };
      });
    },

    async rebuy(req) {
      const s = await requireSession(req);
      return run(async (ctx) => {
        const st = ctx.st, i = seatOf(st, s.pid);
        if (i < 0) throw new AppError('你不在桌上', 'not-seated');
        const seat = st.seats[i];
        if (seat.inHand) throw new AppError('這手打完才能補碼', 'in-hand');
        const why = blocked(ctx);
        if (why) throw new AppError(why, 'season-locked');
        const acc = await ctx.acc(s.pid);
        const room = st.settings.buyInMax - seat.stack;
        const max = Math.min(room, acc.wallet);
        if (room <= 0) throw new AppError('桌上籌碼已經到上限了', 'full');
        if (max <= 0) throw new AppError('錢包沒有錢了，先到銀行借款', 'broke');
        const amount = cleanInt(req.data && req.data.amount, 1, max, '補碼金額最多 ' + max);
        const wasReady = H.ready(seat);
        acc.wallet -= amount;
        seat.stack += amount;
        acc.inPlay.poker = { tableId: TABLE_ID, amount: seat.stack };
        ctx.led(s.pid, { type: 'rebuy', amount: -amount });
        if (!wasReady) schedule(ctx, 'roster');
        return {};
      });
    },

    async leave(req) {
      const s = await requireSession(req);
      return run(async (ctx) => {
        const st = ctx.st, i = seatOf(st, s.pid);
        if (i < 0) throw new AppError('你不在桌上', 'not-seated');
        const seat = st.seats[i];
        const acc = await ctx.acc(s.pid, seat.sid || ctx.sid);
        if (st.hand.phase !== 'idle' && seat.inHand) {
          seat.leaveAfter = true;
          const turn = st.hand.turn;
          const res = H.foldOut(ctx, i);
          if (res) { await after(ctx, res); return { later: false }; }
          if (st.hand.turn !== turn) await after(ctx, null);
          return { later: true };
        }
        cashOut(ctx, acc, seat);
        st.seats[i] = null;
        const c = CT.current(st);
        if (c && (c.from === s.pid || c.to === s.pid)) await cancelContest(ctx, 'left-table');
        schedule(ctx, 'roster');
        return { later: false };
      });
    },

    async sitout(req) {
      const s = await requireSession(req);
      const value = !!(req.data && req.data.value);
      return run(async (ctx) => {
        const st = ctx.st, i = seatOf(st, s.pid);
        if (i < 0) throw new AppError('你不在桌上', 'not-seated');
        const seat = st.seats[i];
        seat.sitout = value;
        seat.timeouts = 0;
        if (value && st.hand.phase !== 'idle' && seat.inHand) {
          const turn = st.hand.turn;
          const res = H.foldOut(ctx, i);
          if (res) { await after(ctx, res); return {}; }
          if (st.hand.turn !== turn) await after(ctx, null);
        }
        schedule(ctx, 'roster');
        return {};
      });
    },

    async act(req) {
      const s = await requireSession(req);
      const d = req.data || {};
      return run(async (ctx) => {
        const st = ctx.st, i = seatOf(st, s.pid);
        const aid = d.actionId ? String(d.actionId).slice(0, 40) : null;
        if (aid && (st.actionIds || []).indexOf(aid) >= 0) { ctx.noop = true; return { dup: true }; }
        if (i < 0) throw new AppError('你不在桌上', 'not-seated');
        if (d.handNo !== st.hand.no || st.hand.phase === 'idle') throw new AppError('這手已經結束了', 'stale');
        const res = H.act(ctx, i, String(d.type), d.amount);
        st.seats[i].timeouts = 0;
        if (aid) st.actionIds = (st.actionIds || []).concat([aid]).slice(-40);
        await after(ctx, res);
        return {};
      });
    },

    /* 任何人都可以呼叫：伺服器自己判斷有沒有到期 */
    async tick(req) {
      await requireSession(req);
      return run(async (ctx) => {
        const st = ctx.st, S = st.settings, t = ctx.t;
        // v11b：道具對抗的逾時（guard 逾時＝不擋、pick 逾時＝系統選牌）優先處理
        await sweepContest(ctx);
        if (CT.tickContest(st, t)) {
          const done = await applyContest(ctx);
          return { did: 'contest', contest: st.contest, applied: done };
        }
        if (CT.current(st)) { ctx.noop = true; return { did: null }; }
        if (st.hand.phase !== 'idle') {
          if (!st.hand.deadline || t < st.hand.deadline) { ctx.noop = true; return { did: null }; }
          const i = st.hand.turn, seat = st.seats[i];
          const L = H.legal(st, i);
          if (!L) { st.hand.deadline = t + S.turnSec * 1000; return { did: null }; }
          seat.timeouts = (seat.timeouts || 0) + 1;
          const res = H.act(ctx, i, L.check ? 'check' : 'fold');
          if (seat.timeouts >= S.afkLimit) {
            seat.sitout = true;
            st.log = st.log.concat([{ t, text: seat.name + ' 連續超時，自動暫離' }]).slice(-30);
          }
          await after(ctx, res);
          return { did: 'timeout' };
        }
        const a = st.auto;
        if (!a.nextHandAt || t < a.nextHandAt) { ctx.noop = true; return { did: null }; }
        const n = st.seats.filter(H.ready).length;
        if (!S.auto || n < S.minPlayers || blocked(ctx)) { a.nextHandAt = null; a.countdownStart = null; return { did: null }; }
        await begin(ctx);
        return { did: 'start' };
      });
    },

    /* 季末：作廢進行中的牌局，把屬於 sid 那一季的座位全部帶回錢包 */
    async closeSeason(oldSid) {
      return run(async (ctx) => {
        const st = ctx.st;
        let aborted = false, count = 0;
        if (st.hand.phase !== 'idle') { H.abort(ctx); aborted = true; }
        for (let i = 0; i < st.seats.length; i++) {
          const seat = st.seats[i];
          if (!seat || (seat.sid || oldSid) !== oldSid) continue;
          seat.sid = oldSid;
          const acc = await ctx.acc(seat.pid, oldSid);
          cashOut(ctx, acc, seat);
          st.seats[i] = null;
          count++;
        }
        if (count || aborted) st.log = (st.log || []).concat([{ t: ctx.t, text: '本季結束，桌上籌碼全部帶回錢包' }]).slice(-30);
        st.auto.nextHandAt = null; st.auto.countdownStart = null;
        return { count, aborted };
      });
    },

    /* 表情：基本表情免費，其他要買表情包；每人 3 秒一次 */
    async emote(req) {
      const s = await requireSession(req);
      const text = String((req.data && req.data.text) || '');
      const pSnap = await playerRef(s.pid).get();
      const owned = ((pSnap.data().unlocked || {}).emotes) || [];
      const allowed = BASIC_EMOTES.slice();
      owned.forEach((id) => { if (byId[id] && byId[id].list) allowed.push.apply(allowed, byId[id].list); });
      if (allowed.indexOf(text) < 0) throw new AppError('你沒有這個表情', 'no-emote');
      const ref = tableRef().collection('live').doc('emotes');
      return db.runTransaction(async (tx) => {
        const [tSnap, eSnap, cSnap, me] = [await tx.get(tableRef()), await tx.get(ref), await tx.get(cfgRef()), await tx.get(playerRef(s.pid))];
        const rawCfg = cSnap.exists ? cSnap.data() : {};
        const st = tSnap.exists ? tSnap.data() : null;
        if (!st || !st.seats.some((x) => x && x.pid === s.pid)) throw new AppError('坐下來才能丟表情', 'not-seated');
        const t = now();
        const live = eSnap.exists ? eSnap.data() : { items: [], last: {} };
        if (t - ((live.last || {})[s.pid] || 0) < 3000) throw new AppError('表情太快了，等一下', 'cooldown');
        const last = Object.assign({}, live.last, { [s.pid]: t });
        const items = (live.items || []).filter((x) => t - x.at < 10000).concat([{ pid: s.pid, text, at: t }]).slice(-12);
        tx.set(ref, { items, last });
        if (me.exists) {
          const pd = me.data();
          if (TK.bump(pd, t, 'emote', 1, rawCfg)) tx.update(playerRef(s.pid), { tasks: pd.tasks });
        }
        return { now: t };
      });
    },

    /* v11b：干擾型道具統一入口。kind = seat | forcebet | money
       發動就扣卡，對方有鐵碗公就先問要不要擋，沒有的話直接執行。 */
    async useCard(req) {
      const s = await requireSession(req);
      const d = req.data || {};
      const kind = String(d.kind || '');
      const target = String(d.pid || '');
      if (!CT.KINDS[kind]) throw new AppError('未知的道具', 'bad-item', 'invalid-argument');
      return run(async (ctx) => {
        const st = ctx.st;
        await sweepContest(ctx);
        const i = seatOf(st, s.pid), j = seatOf(st, target);
        if (i < 0) throw new AppError('你要先入座', 'not-seated');
        if (j < 0) throw new AppError('對方不在桌上', 'not-seated');
        if (st.hand.phase !== 'idle') throw new AppError('只能在兩手之間用道具', 'in-hand');
        const me = await ctx.player(s.pid), other = await ctx.player(target);
        const c = CT.begin(st, {
          kind, from: s.pid, to: target,
          fromName: st.seats[i].name, toName: st.seats[j].name,
          fromPlayer: me, toPlayer: other,
          payload: d.payload || {}
        }, ctx.t);
        ctx.patchPlayer(s.pid, { items: me.items });
        st.log = (st.log || []).concat([{ t: ctx.t, text: st.seats[i].name + ' 對 ' + st.seats[j].name + ' 用了' + c.name }]).slice(-30);
        const done = await applyContest(ctx);
        schedule(ctx, 'contest');
        return { contest: st.contest, applied: done };
      });
    },

    /* 目標選擇擋或不擋 */
    async contestRespond(req) {
      const s = await requireSession(req);
      const block = !!(req.data && req.data.block);
      return run(async (ctx) => {
        await sweepContest(ctx);
        const c = CT.current(ctx.st);
        if (!c) throw new AppError('這個道具已經結束了', 'no-contest');
        const me = await ctx.player(s.pid);
        const r = CT.respondGuard(ctx.st, s.pid, block, me, ctx.t);
        if (block) {
          ctx.patchPlayer(s.pid, { items: me.items });
          ctx.st.log = (ctx.st.log || []).concat([{ t: ctx.t, text: c.toName + ' 用保硬的鐵碗公擋下了 ' + c.fromName + ' 的' + c.name }]).slice(-30);
          schedule(ctx, 'contest');
          return { blocked: true, contest: ctx.st.contest };
        }
        const done = await applyContest(ctx);
        schedule(ctx, 'contest');
        return Object.assign({ blocked: false, contest: ctx.st.contest }, done || {});
      });
    },

    /* 幹錢券：雙方各自從牌背裡選一張 */
    async contestPick(req) {
      const s = await requireSession(req);
      const card = (req.data || {}).card;
      return run(async (ctx) => {
        await sweepContest(ctx);
        if (!CT.current(ctx.st)) throw new AppError('這個道具已經結束了', 'no-contest');
        const r = CT.pick(ctx.st, s.pid, card, ctx.t);
        const done = r.phase === 'exec' ? await applyContest(ctx) : null;
        return { contest: ctx.st.contest, applied: done };
      });
    },

    /* ---------- 管理員 ---------- */
    async adminKick(req) {
      await requireAdmin(req);
      const pid = req.data && String(req.data.pid);
      return run(async (ctx) => {
        const st = ctx.st, i = seatOf(st, pid);
        if (i < 0) throw new AppError('他不在桌上', 'not-seated');
        const seat = st.seats[i];
        const acc = await ctx.acc(pid, seat.sid || ctx.sid);
        if (st.hand.phase !== 'idle' && seat.inHand) {
          seat.leaveAfter = true;
          const turn = st.hand.turn;
          const res = H.foldOut(ctx, i);
          if (res) { await after(ctx, res); return { later: false }; }
          if (st.hand.turn !== turn) await after(ctx, null);
          return { later: true };
        }
        cashOut(ctx, acc, seat);
        st.seats[i] = null;
        st.log = (st.log || []).concat([{ t: ctx.t, text: seat.name + ' 被主辦請離牌桌' }]).slice(-30);
        schedule(ctx, 'roster');
        return { later: false };
      });
    },

    async adminStart(req) {
      await requireAdmin(req);
      return run(async (ctx) => { await begin(ctx); return {}; });
    },

    async adminAbort(req) {
      await requireAdmin(req);
      return run(async (ctx) => {
        const res = H.abort(ctx);
        await after(ctx, res);
        return {};
      });
    },

    async adminSettings(req) {
      await requireAdmin(req);
      const d = req.data || {};
      return run(async (ctx) => {
        const S = ctx.st.settings;
        Object.keys(SETTING_LIMITS).forEach((k) => {
          if (d[k] === undefined) return;
          const [lo, hi] = SETTING_LIMITS[k];
          S[k] = cleanInt(d[k], lo, hi, '「' + k + '」的數值不合理');
        });
        if (d.auto !== undefined) S.auto = !!d.auto;
        if (S.sb >= S.bb) throw new AppError('小盲要比大盲小', 'bad-config', 'invalid-argument');
        if (ctx.st.hand.phase === 'idle') { ctx.st.auto.countdownStart = null; schedule(ctx, 'roster'); }
        return {};
      });
    }
  };
}

module.exports = { createPoker, newTable, DEFAULT_SETTINGS };
