'use strict';
/* games/contest.js — v11b 道具對抗流程（共用）

   三張干擾卡（換座位卡、強制下注卷、強制幹錢券）走同一套流程：

     發動 → 扣掉發動方的卡 → 對方有鐵碗公？
       有 → guard 階段，對方選擋或不擋（逾時＝不擋）
       沒有 → 直接進效果

     幹錢券多一段 pick 階段：雙方各自從牌背裡選一張，逾時系統隨機選。

   狀態存在牌桌的 st.contest，一張桌子同時只會有一個，所以「同時發動兩張」
   天生就不可能。任何一方離座、開新的一手、或逾時沒人處理，都會作廢並退還
   發動方的卡（因為效果根本沒發生）。擋下來則不退，這是使用者指定的規則。 */

const crypto = require('crypto');
const { AppError } = require('../core/util');

const GUARD_ITEM = 'iron_bowl';

const KINDS = {
  seat: { card: 'card_seat', name: '換座位卡', guardSec: 15 },
  forcebet: { card: 'forced_action', name: '強制下注卷', guardSec: 15 },
  money: { card: 'forced_duel', name: '強制幹錢券', guardSec: 15, pickSec: 30 }
};

const countOf = (pl, id) => ((pl && pl.items) || {})[id] || 0;
const hasGuard = (pl) => countOf(pl, GUARD_ITEM) > 0;

/* 扣一張卡（改記憶體裡的 pl，呼叫端負責寫回） */
function spend(pl, id, n) {
  const have = countOf(pl, id);
  if (have < (n || 1)) return null;
  return Object.assign({}, pl.items, { [id]: have - (n || 1) });
}
function refund(pl, id) {
  return Object.assign({}, (pl && pl.items) || {}, { [id]: countOf(pl, id) + 1 });
}

/* 德州用 st.hand.no，21 點用 st.round.no，統一從這裡拿 */
function handNoOf(st) {
  if (st.hand) return st.hand.no || 0;
  if (st.round) return st.round.no || 0;
  return 0;
}

/* 目前還有效的對抗；已經結束的回 null */
function current(st) {
  const c = st.contest;
  return c && c.phase !== 'done' ? c : null;
}

/* 這個對抗該作廢了嗎？回傳原因字串或 null。
   注意逾時不算作廢——guard 逾時是「不擋」，pick 逾時是「系統幫你選」，
   兩個都要繼續往下跑，只有下面這些情況才是真的取消。 */
function staleReason(st, c, t, seatedPids) {
  if (!c || c.phase === 'done') return null;
  if (c.handNo !== handNoOf(st)) return 'new-hand';
  if (seatedPids && (seatedPids.indexOf(c.from) < 0 || seatedPids.indexOf(c.to) < 0)) return 'left-table';
  if (t - c.at > 120000) return 'too-old';       // 最後一道保險，正常不會走到
  return null;
}

/* 開始一個對抗。回傳 { contest, phase }，phase === 'exec' 代表可以直接執行效果了。
   呼叫端要先自己驗證雙方位置、時機（兩手之間）等規則。 */
function begin(st, opts, t) {
  const K = KINDS[opts.kind];
  if (!K) throw new AppError('未知的道具', 'bad-item', 'invalid-argument');
  if (current(st)) throw new AppError('桌上已經有人在用道具了，等一下', 'busy');
  if (opts.from === opts.to) throw new AppError('不能對自己用', 'self');

  const items = spend(opts.fromPlayer, K.card);
  if (!items) throw new AppError('你沒有' + K.name, 'no-card');
  opts.fromPlayer.items = items;                       // 發動就扣，被擋也不退

  const guard = hasGuard(opts.toPlayer);
  const c = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(t) + Math.random(),
    kind: opts.kind, card: K.card, name: K.name,
    from: opts.from, to: opts.to,
    fromName: opts.fromName || opts.from, toName: opts.toName || opts.to,
    payload: opts.payload || {},
    handNo: handNoOf(st),
    at: t,
    phase: guard ? 'guard' : (K.pickSec ? 'pick' : 'exec'),
    deadline: t + (guard ? K.guardSec : (K.pickSec || 0)) * 1000,
    picks: {}, blocked: false
  };
  st.contest = c;
  return c;
}

/* 目標選擇擋或不擋。block=true 就消耗一個鐵碗公，對抗結束。 */
function respondGuard(st, pid, block, toPlayer, t) {
  const c = current(st);
  if (!c) throw new AppError('沒有進行中的道具', 'no-contest');
  if (c.phase !== 'guard') throw new AppError('現在不是防禦階段', 'bad-phase');
  if (c.to !== pid) throw new AppError('這不是對你用的', 'not-target');
  if (block) {
    const items = spend(toPlayer, GUARD_ITEM);
    if (!items) throw new AppError('你沒有保硬的鐵碗公', 'no-card');
    toPlayer.items = items;
    c.blocked = true;
    c.phase = 'done';
    return { blocked: true };
  }
  return advance(st, c, t);
}

/* guard 過了之後往下走：幹錢券進選牌，其他直接執行 */
function advance(st, c, t) {
  const K = KINDS[c.kind];
  if (K.pickSec) {
    c.phase = 'pick';
    c.deadline = t + K.pickSec * 1000;
    return { blocked: false, phase: 'pick' };
  }
  c.phase = 'exec';
  c.deadline = 0;
  return { blocked: false, phase: 'exec' };
}

/* 幹錢券選牌。兩邊都選完就進 exec。 */
function pick(st, pid, cardId, t) {
  const c = current(st);
  if (!c) throw new AppError('沒有進行中的道具', 'no-contest');
  if (c.phase !== 'pick') throw new AppError('現在不是選牌階段', 'bad-phase');
  if (pid !== c.from && pid !== c.to) throw new AppError('你不在這場對決裡', 'not-in-duel');
  const n = Number(cardId);
  if (!(n >= 0 && n <= 51 && Number.isInteger(n))) throw new AppError('選的牌不對', 'bad-card', 'invalid-argument');
  if (c.picks[pid] !== undefined) throw new AppError('你已經選過了', 'picked');
  const other = pid === c.from ? c.to : c.from;
  if (c.picks[other] === n) throw new AppError('這張被對方選走了，換一張', 'taken');
  c.picks = Object.assign({}, c.picks, { [pid]: n });
  if (c.picks[c.from] !== undefined && c.picks[c.to] !== undefined) {
    c.phase = 'exec';
    c.deadline = 0;
  }
  return { phase: c.phase, picks: c.picks };
}

/* 逾時處理，由 tick 呼叫。
   guard 逾時 = 不擋；pick 逾時 = 沒選的那方系統隨機選一張（不會跟對方重複）。
   回傳有沒有改到狀態。 */
function tickContest(st, t) {
  const c = current(st);
  if (!c || !c.deadline || t < c.deadline) return false;
  if (c.phase === 'guard') { advance(st, c, t); return true; }
  if (c.phase === 'pick') {
    const picks = Object.assign({}, c.picks);
    [c.from, c.to].forEach((pid) => {
      if (picks[pid] !== undefined) return;
      let n;
      do { n = crypto.randomInt(52); } while (Object.keys(picks).some((k) => picks[k] === n));
      picks[pid] = n;
    });
    c.picks = picks;
    c.autoPicked = true;
    c.phase = 'exec';
    c.deadline = 0;
    return true;
  }
  return false;
}

/* 作廢並退還發動方的卡。呼叫端要把 fromPlayer 寫回去。 */
function cancel(st, reason, fromPlayer) {
  const c = current(st);
  if (!c) return null;
  if (fromPlayer) fromPlayer.items = refund(fromPlayer, c.card);
  c.phase = 'done';
  c.cancelled = reason;
  return c;
}

/* 效果執行完之後收尾 */
function finish(st, result) {
  const c = st.contest;
  if (!c) return;
  c.phase = 'done';
  c.result = result || null;
}

/* 幹錢券比大小：先比點數，同點數比花色（黑桃 > 紅心 > 方塊 > 梅花）。
   card id 0~51：rank = (c/4|0)+2，suit = c%4。花色強弱用 SUIT_RANK 定義。 */
const SUIT_RANK = { 0: 4, 1: 3, 2: 2, 3: 1 };   // 0=黑桃 1=紅心 2=方塊 3=梅花
function beats(a, b) {
  const ra = (a / 4 | 0), rb = (b / 4 | 0);
  if (ra !== rb) return ra > rb;
  return SUIT_RANK[a % 4] > SUIT_RANK[b % 4];
}

module.exports = {
  KINDS, GUARD_ITEM, countOf, hasGuard, spend, refund,
  current, staleReason, begin, respondGuard, advance, pick, tickContest, cancel, finish, beats, SUIT_RANK, handNoOf
};
