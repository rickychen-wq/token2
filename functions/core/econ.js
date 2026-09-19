'use strict';
/* core/econ.js — 經濟規則（純函式，不碰資料庫）
   所有金額都是整數。帳戶物件在記憶體裡改，呼叫端負責寫回資料庫。 */

const { AppError, TW_OFFSET } = require('./util');

const DEFAULTS = {
  startingMoney: 5000,   // 每季起始資金
  loanUnit: 2000,        // 每筆借款
  loanRepayAt: 3000,     // 手上達到這個數字就自動還一筆
  borrowBelow: 1000,     // 總資產低於這個數字才能借
  loanPerDay: 5,         // 每天最多借幾次（台灣時間 00:00 重置）
  reviveBelow: 1000,     // 破產防護卷：總資產低於這個數字才能用
  reviveTo: 5000,        // 破產防護卷：錢包補到這個數字
  bankKeep: 2000,        // 存款後手上至少要留的錢
  interestMin: 0.001,    // 第一名每 3 小時利率
  interestMax: 0.006,    // 最後一名每 3 小時利率
  rankMinHands: 20,      // 本季至少打幾手才計入排名和積分
  starPer: 100,          // 本季淨資產每多少換 1 星幣（無條件進位）
  starCap: 0,            // 一季最多換幾顆，0 = 不限
  starMinHands: 20       // 本季至少打幾手才能換星幣
};

const LIMITS = {
  startingMoney: [0, 1000000], loanUnit: [1, 1000000], loanRepayAt: [1, 10000000],
  borrowBelow: [0, 1000000], bankKeep: [0, 1000000], loanPerDay: [0, 1000],
  reviveBelow: [0, 1000000], reviveTo: [0, 10000000],
  interestMin: [0, 0.1], interestMax: [0, 0.1],
  rankMinHands: [0, 10000],
  starPer: [1, 1000000], starCap: [0, 1000000], starMinHands: [0, 10000]
};

const PERIOD = 3 * 3600 * 1000;
const MAX_AMOUNT = 1000000000;

function cfgOf(raw) {
  const out = Object.assign({}, DEFAULTS);
  const e = (raw && raw.econ) || {};
  Object.keys(DEFAULTS).forEach((k) => { if (typeof e[k] === 'number' && isFinite(e[k])) out[k] = e[k]; });
  return out;
}

/* 主辦改設定時的檢查，回傳只含合法欄位的物件 */
function cleanEconPatch(patch) {
  const out = {};
  Object.keys(patch || {}).forEach((k) => {
    if (!LIMITS[k]) return;
    const v = Number(patch[k]);
    const [lo, hi] = LIMITS[k];
    if (!isFinite(v) || v < lo || v > hi) throw new AppError('「' + k + '」的數值不合理', 'bad-config', 'invalid-argument');
    out[k] = k.startsWith('interest') ? Math.round(v * 1e6) / 1e6 : Math.round(v);
  });
  const merged = Object.assign({}, DEFAULTS, out);
  if (merged.interestMin > merged.interestMax) throw new AppError('最低利率不能比最高利率高', 'bad-config', 'invalid-argument');
  return out;
}

function cleanAmount(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_AMOUNT) throw new AppError('金額要是正整數', 'bad-amount', 'invalid-argument');
  return n;
}

/* 台灣時間的日期字串 2026-09-15 */
function twDay(ms) {
  const d = new Date(ms + TW_OFFSET);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/* 計息週期的起點：台灣時間 00、03、06…21 點 */
function periodStart(ms) {
  return Math.floor((ms + TW_OFFSET) / PERIOD) * PERIOD - TW_OFFSET;
}

function newAccount(pid, cfg, t) {
  return {
    pid,
    wallet: cfg.startingMoney,
    bank: { balance: 0, periodKey: 0, periodMin: 0 },
    loans: 0,
    inPlay: {},
    daily: { day: null, hands: 0, claimed: false },
    handsPlayed: 0, plays: 0,
    everBorrowed: false,
    net: cfg.startingMoney,
    peakNet: cfg.startingMoney,
    createdAt: t,
    updatedAt: t
  };
}

function inPlayTotal(acc) {
  let s = 0;
  Object.keys(acc.inPlay || {}).forEach((g) => { s += (acc.inPlay[g] && acc.inPlay[g].amount) || 0; });
  return s;
}

function computeNet(acc, cfg) {
  return acc.wallet + acc.bank.balance + inPlayTotal(acc) - acc.loans * cfg.loanUnit;
}

/* 改完帳戶後一定要呼叫：更新淨資產和本季最高 */
function refresh(acc, cfg, t) {
  acc.net = computeNet(acc, cfg);
  if (acc.net > (acc.peakNet || 0)) acc.peakNet = acc.net;
  acc.updatedAt = t;
}

function entry(type, amount, acc, extra) {
  return Object.assign({
    type, amount,
    wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans
  }, extra || {});
}

/* 當天的每日獎勵狀態，跨日自動歸零 */
function rollDaily(acc, t) {
  const day = twDay(t);
  if (!acc.daily || acc.daily.day !== day) {
    // v13：換日時把昨天的紀錄留一份，隔天 00:05 的排行獎勵要用（避免 00:00~00:05 有人開局就把數字洗掉）
    if (acc.daily && acc.daily.day) acc.prevDaily = { day: acc.daily.day, plays: acc.daily.plays || 0, hands: acc.daily.hands || 0 };
    acc.daily = { day, hands: 0, plays: 0, claimed: false, borrows: 0 };
  }
  if (typeof acc.daily.borrows !== 'number') acc.daily.borrows = 0;   // 舊帳戶補欄位
  if (typeof acc.daily.plays !== 'number') acc.daily.plays = 0;
  return acc.daily;
}

/* 牌局結束時呼叫。
   handsPlayed 只算德州和 21 點，因為它是「本季排行榜上榜資格」的依據，這次沒有要改排行規則。
   daily.plays 另外算，所有遊戲都計入，只給 v13 的每日排行獎勵門檻用。 */
function recordHands(acc, t, n) {
  const d = rollDaily(acc, t);
  d.hands += n;
  d.plays += n;
  acc.plays = (acc.plays || 0) + n;          // 本季＝本週的場數，給每週任務用
  acc.handsPlayed = (acc.handsPlayed || 0) + n;
}

/* 小遊戲（射龍門、拉霸、骰寶）玩一次算一場，只進 daily.plays，不影響上榜資格。
   cap 是後台設定的「單一遊戲每日計入上限」，0 代表不限。 */
function recordPlay(acc, t, key, cap) {
  const d = rollDaily(acc, t);
  if (cap > 0) {
    if (!d.byGame || typeof d.byGame !== 'object') d.byGame = {};
    const n = (d.byGame[key] || 0) + 1;
    d.byGame[key] = n;
    if (n > cap) return false;
  }
  d.plays += 1;
  acc.plays = (acc.plays || 0) + 1;
  return true;
}

/* 取某一天的場數：先看今天的紀錄，換日後看昨天留下的那份 */
function playsOnDay(acc, day) {
  if (acc.daily && acc.daily.day === day) return acc.daily.plays || 0;
  if (acc.prevDaily && acc.prevDaily.day === day) return acc.prevDaily.plays || 0;
  return 0;
}

/* v11b 破產防護卷：總資產低於門檻、而且沒有欠款時，錢包直接補到 reviveTo。
   有欠款不給用，因為自動還款會在錢一進錢包時就扣走，用了等於白用。 */
function useRevive(acc, cfg, t, pl) {
  if (!(((pl && pl.items) || {}).bankruptcy_protection > 0)) throw new AppError('你沒有破產防護卷', 'no-card');
  if (acc.loans > 0) {
    throw new AppError('還有 ' + acc.loans + ' 筆欠款，還完才能用防護卷（不然錢一進來就會被自動還款扣走）', 'has-debt');
  }
  const total = acc.wallet + acc.bank.balance + inPlayTotal(acc);
  if (total >= cfg.reviveBelow) {
    throw new AppError('手上還有 ' + fmt(total) + '，低於 ' + fmt(cfg.reviveBelow) + ' 才能用', 'not-broke');
  }
  const delta = cfg.reviveTo - acc.wallet;
  if (delta <= 0) throw new AppError('錢包已經超過 ' + fmt(cfg.reviveTo) + ' 了', 'not-broke');
  acc.wallet += delta;
  return [entry('revive', delta, acc)];
}

/* 計息週期內第一次動到銀行時，記下週期起點的餘額 */
function touchBank(acc, t) {
  const P = periodStart(t);
  if (acc.bank.periodKey !== P) {
    acc.bank.periodKey = P;
    acc.bank.periodMin = acc.bank.balance;
  }
}

/* ---------- 動作 ---------- */

/* 自動還款。available 預設是錢包，德州加入後會把「不在牌局中的桌上籌碼」也算進去 */
function autoRepay(acc, cfg, t) {
  const out = [];
  while (acc.loans > 0 && acc.wallet >= cfg.loanRepayAt) {
    acc.wallet -= cfg.loanUnit;
    acc.loans -= 1;
    out.push(entry('repay', -cfg.loanUnit, acc));
  }
  return out;
}

function borrow(acc, cfg, t, pl) {
  if (Object.keys(acc.inPlay || {}).some((g) => acc.inPlay[g] && acc.inPlay[g].inHand)) {
    throw new AppError('牌局進行中不能借款，打完這手再借', 'in-hand');
  }
  // v11b：身上有破產防護卷就先用卡，不能跟銀行借
  if (((pl && pl.items) || {}).bankruptcy_protection > 0) {
    throw new AppError('身上還有破產防護卷，先用掉才能借款', 'has-revive');
  }
  const d = rollDaily(acc, t);
  if (cfg.loanPerDay > 0 && d.borrows >= cfg.loanPerDay) {
    throw new AppError('今天已經借滿 ' + cfg.loanPerDay + ' 次，明天 00:00 才會重置', 'loan-limit');
  }
  const total = acc.wallet + acc.bank.balance + inPlayTotal(acc);
  if (total >= cfg.borrowBelow) {
    throw new AppError('手上還有 ' + fmt(total) + '，低於 ' + fmt(cfg.borrowBelow) + ' 才能借款', 'not-broke');
  }
  acc.wallet += cfg.loanUnit;
  acc.loans += 1;
  acc.everBorrowed = true;
  d.borrows += 1;
  return [entry('borrow', cfg.loanUnit, acc, { borrowsToday: d.borrows })];
}

function maxDeposit(acc, cfg) {
  if (acc.loans > 0) return 0;
  return Math.max(0, Math.min(acc.wallet, acc.wallet + inPlayTotal(acc) - cfg.bankKeep));
}

function deposit(acc, cfg, amount, t) {
  if (acc.loans > 0) throw new AppError('還有借款沒還清，不能存款', 'has-loan');
  const max = maxDeposit(acc, cfg);
  if (amount > max) {
    throw new AppError(max <= 0
      ? '手上至少要留 ' + fmt(cfg.bankKeep) + '，現在還不能存'
      : '手上至少要留 ' + fmt(cfg.bankKeep) + '，最多只能存 ' + fmt(max), 'over-limit');
  }
  touchBank(acc, t);
  acc.wallet -= amount;
  acc.bank.balance += amount;
  return [entry('deposit', -amount, acc)];
}

function withdraw(acc, cfg, amount, t) {
  if (amount > acc.bank.balance) throw new AppError('銀行裡只有 ' + fmt(acc.bank.balance), 'over-limit');
  touchBank(acc, t);
  acc.bank.balance -= amount;
  acc.bank.periodMin = Math.min(acc.bank.periodMin, acc.bank.balance);
  acc.wallet += amount;
  return [entry('withdraw', amount, acc)].concat(autoRepay(acc, cfg, t));
}

function adminAdjust(acc, cfg, delta, t) {
  const n = Number(delta);
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > MAX_AMOUNT) throw new AppError('調整金額要是非零整數', 'bad-amount', 'invalid-argument');
  if (acc.wallet + n < 0) throw new AppError('錢包只有 ' + fmt(acc.wallet) + '，最多扣 ' + fmt(acc.wallet), 'over-limit');
  acc.wallet += n;
  return [entry('admin', n, acc)].concat(autoRepay(acc, cfg, t));
}

/* ---------- 利息 ---------- */

/* 依淨資產排名給利率：第一名最低、最後一名最高。同分同名次 */
function rankRates(accounts, cfg) {
  const list = accounts.slice().sort((a, b) => b.net - a.net);
  const n = list.length;
  const out = {};
  let rank = 0, prevNet = null;
  list.forEach((a, i) => {
    if (a.net !== prevNet) { rank = i + 1; prevNet = a.net; }
    const rate = n <= 1 ? cfg.interestMin
      : cfg.interestMin + (cfg.interestMax - cfg.interestMin) * (rank - 1) / (n - 1);
    out[a.pid] = { rank, total: n, rate: Math.round(rate * 1e7) / 1e7 };
  });
  return out;
}

/* 結算週期 P（起點）的利息。用這個週期內銀行的最低餘額計算，防止計息前才存進來 */
function applyInterest(acc, P, rate) {
  const b = acc.bank;
  const base = b.periodKey >= P ? b.periodMin : b.balance;
  const interest = Math.floor(Math.max(0, base) * rate);
  b.balance += interest;
  if (b.periodKey > P) {
    b.periodMin += interest;
  } else {
    b.periodKey = P + PERIOD;
    b.periodMin = b.balance;
  }
  return interest;
}

/* 本季淨資產 → 星幣 */
function starsFor(net, cfg) {
  if (!(net > 0)) return 0;
  const n = Math.ceil(net / cfg.starPer);
  return cfg.starCap > 0 ? Math.min(cfg.starCap, n) : n;
}

function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

module.exports = {
  DEFAULTS, PERIOD, cfgOf, cleanEconPatch, cleanAmount, twDay, periodStart,
  newAccount, inPlayTotal, computeNet, refresh, rollDaily, recordHands, recordPlay, playsOnDay, maxDeposit, useRevive,
  autoRepay, borrow, deposit, withdraw, adminAdjust, rankRates, applyInterest, starsFor
};
