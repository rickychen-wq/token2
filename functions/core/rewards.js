'use strict';
/* core/rewards.js — v13 排行榜自動發獎
   每日：台灣時間 00:05，依「前一天結束時的本季資產排名」發寶箱到信箱，期限 7 天。
         前三名直接拿；其他人當天要玩滿 dailyMinPlays 場（所有遊戲都算）才有。
         週一跳過，因為那天凌晨剛做完週結算，資產已經重置，而且週獎勵同時會發。
   每週：季結算成功後立刻發；週一 00:15 另有備援排程，發兩份——
         「總積分排行榜」和「剛結算完那一季的資產排行榜」，兩份互相獨立，同一個人可以都拿到。
   練習季（sid < rankFrom）完全不發。
   每一份獎勵都是抽 draws 次、每次依機率表抽一個稀有度的寶箱；鑰匙要自己買。
   所有名次的機率表、抽幾次、門檻、期限都存在 config/app.rewards，後台可改。 */

const { AppError, seasonId } = require('./util');
const E = require('./econ');
const { DEFAULT_RANK_FROM } = require('./season');

/* 稀有度：1 稀有、2 極稀有、3 史詩、4 神話、5 傳奇、6 神秘、7 管理員（管理員寶箱不會發） */
const DEFAULTS = {
  enabled: true,
  dailyMinPlays: 20,        // 非前三名，當天要玩滿幾場
  dailyCapPerGame: 0,       // 單一小遊戲每日最多計入幾場，0 = 不限
  dailyTopNeedsPlays: false, // 前三名是否也要玩滿才給（預設否，照使用者原本的規格）
  draws: 2,                 // 每一份獎勵抽幾次（規格的 ×2）
  expireDays: 7,            // 信件期限
  // 機率表的一列是 { r: 稀有度, w: 權重 }。
  // 不能用 [稀有度, 權重] 這種陣列，因為 Firestore 不收「陣列裡面放陣列」。
  daily: {
    r1: [{ r: 6, w: 5 }, { r: 5, w: 15 }, { r: 4, w: 30 }, { r: 3, w: 50 }],
    r2: [{ r: 5, w: 20 }, { r: 4, w: 30 }, { r: 3, w: 50 }],
    r3: [{ r: 5, w: 20 }, { r: 4, w: 20 }, { r: 3, w: 30 }, { r: 2, w: 20 }],   // 規格寫的加起來是 90，當權重正規化 → 22.2/22.2/33.3/22.2
    other: [{ r: 4, w: 20 }, { r: 3, w: 20 }, { r: 2, w: 30 }, { r: 1, w: 30 }]
  },
  weekly: {
    r1: [{ r: 6, w: 40 }, { r: 5, w: 60 }],
    r2: [{ r: 6, w: 30 }, { r: 5, w: 50 }, { r: 4, w: 20 }],
    r3: [{ r: 6, w: 15 }, { r: 5, w: 50 }, { r: 4, w: 35 }],
    other: [{ r: 5, w: 15 }, { r: 4, w: 15 }, { r: 3, w: 70 }]
  }
};

const RANK_KEY = { 1: 'r1', 2: 'r2', 3: 'r3' };

function cfgOf(raw) {
  const r = (raw || {}).rewards || {};
  const out = Object.assign({}, DEFAULTS, r);
  out.daily = Object.assign({}, DEFAULTS.daily, r.daily || {});
  out.weekly = Object.assign({}, DEFAULTS.weekly, r.weekly || {});
  return out;
}

/* 依 [{ r: 稀有度, w: 權重 }, ...] 抽一個稀有度。
   權重不需要剛好加到 100，會照總和正規化。 */
function rollRarity(table) {
  const rows = (table || []).filter((x) => x && x.r >= 1 && x.w > 0);
  if (!rows.length) return null;
  const total = rows.reduce((a, x) => a + x.w, 0);
  let n = Math.random() * total;
  for (const x of rows) { if ((n -= x.w) < 0) return x.r; }
  return rows[rows.length - 1].r;
}

/* 抽 n 個寶箱，回傳 { chest_3: 2 } 這種數量表 */
function drawChests(table, n) {
  const items = {};
  for (let i = 0; i < n; i++) {
    const rar = rollRarity(table);
    if (!rar) continue;
    const id = 'chest_' + rar;
    items[id] = (items[id] || 0) + 1;
  }
  return items;
}

function tableFor(group, rank) {
  return group[RANK_KEY[rank] || 'other'] || group.other;
}

/* 台灣時間的星期，週一 = 0 */
function twDow(t) {
  const tw = new Date(t + 8 * 3600 * 1000);
  return (tw.getUTCDay() + 6) % 7;
}

function createRewards({ db, now, requireAdmin }) {
  const cfgRef = () => db.collection('config').doc('app');
  const seasonRef = (sid) => db.collection('seasons').doc(sid);
  const logRef = (id) => db.collection('rewardRuns').doc(id);

  /* 在同一個 transaction 裡排入信件。固定文件 ID 讓同一輪、同一玩家永遠只有一封。 */
  function queueMails(tx, runId, rows, t, expireDays, titleOf, bodyOf) {
    let sent = 0;
    rows.forEach((r) => {
      if (!Object.keys(r.items).length) return;
      const id = runId + '-' + r.kind + '-' + r.pid;
      const ref = db.collection('mail').doc(id);
      tx.set(ref, {
        id, title: titleOf(r), body: bodyOf(r),
        money: 0, stars: 0, items: r.items,
        to: [r.pid], all: false, toList: [r.pid],
        at: t, expiresAt: t + expireDays * 86400000, by: 'system', kind: r.kind, runId
      });
      sent++;
    });
    return sent;
  }

  /* ---------- 每日 ---------- */
  async function runDaily(t) {
    if (twDow(t) === 0) return { skipped: 'monday' };          // 週一由週獎勵負責

    const endedDay = E.twDay(t - 86400000);                     // 剛結束的那一天
    const sid = seasonId(t);
    const runId = 'daily-' + endedDay;
    const cfgSnap = await cfgRef().get();
    const rawCfg = cfgSnap.exists ? cfgSnap.data() : {};
    const C = cfgOf(rawCfg);
    if (!C.enabled) return { runId, skipped: 'disabled' };
    if (sid < (rawCfg.rankFrom || DEFAULT_RANK_FROM)) return { runId, skipped: 'practice', sid };

    const ecfg = E.cfgOf(rawCfg);
    const [accSnap, plSnap] = await Promise.all([
      seasonRef(sid).collection('accounts').get(),
      db.collection('players').get()
    ]);
    const players = {};
    plSnap.forEach((d) => { players[d.id] = d.data(); });
    const accounts = [];
    accSnap.forEach((d) => {
      const a = d.data();
      if (!players[a.pid]) return;
      E.rollDaily(a, t, ecfg);
      E.refresh(a, ecfg, t);
      a.dailyNet = E.netOnDay(a, endedDay, ecfg);
      accounts.push(a);
    });

    // 每日榜只看昨天換日瞬間保存的淨資產，不讓 00:00 後的操作改寫昨天名次。
    const byNet = accounts.slice().sort((a, b) => b.dailyNet - a.dailyNet);
    const rankOf = {};
    let prev = null, rank = 0;
    byNet.forEach((a, i) => { if (a.dailyNet !== prev) { rank = i + 1; prev = a.dailyNet; } rankOf[a.pid] = rank; });

    const rows = [];
    accounts.forEach((a) => {
      const rk = rankOf[a.pid];
      const plays = E.playsOnDay(a, endedDay);
      const top3 = rk <= 3;
      if (top3 && C.dailyTopNeedsPlays && plays < C.dailyMinPlays) return;
      if (!top3 && plays < C.dailyMinPlays) return;
      rows.push({
        pid: a.pid, kind: 'dailyRank', rank: rk, plays, net: a.dailyNet,
        items: drawChests(tableFor(C.daily, rk), C.draws)
      });
    });

    // 只有「完成紀錄＋全部信件」放進 transaction；排名快照不鎖住所有帳戶，避免玩家在線時一直衝突重試。
    return db.runTransaction(async (tx) => {
      const doneSnap = await tx.get(logRef(runId));
      if (doneSnap.exists) return Object.assign({ runId, skipped: true }, doneSnap.data().result || {});
      const sent = queueMails(tx, runId, rows, t, C.expireDays,
        (r) => '每日排行獎勵・' + endedDay.slice(5).replace('-', '/'),
        (r) => (r.rank <= 3 ? '昨天資產排行第 ' + r.rank + ' 名' : '昨天玩了 ' + r.plays + ' 場')
          + '，這是你的獎勵。鑰匙要自己去商店買喔。');
      const result = { day: endedDay, sid, players: accounts.length, sent };
      tx.set(logRef(runId), { id: runId, at: t, status: 'done', result });
      return Object.assign({ runId }, result);
    });
  }

  /* ---------- 每週 ---------- */
  async function runWeekly(t) {
    const endedSid = seasonId(t - 86400000);                    // 剛結束的那一季
    const runId = 'weekly-' + endedSid;
    const cfgSnap = await cfgRef().get();
    const rawCfg = cfgSnap.exists ? cfgSnap.data() : {};
    const C = cfgOf(rawCfg);
    if (!C.enabled) return { runId, skipped: 'disabled' };
    if (endedSid < (rawCfg.rankFrom || DEFAULT_RANK_FROM)) return { runId, skipped: 'practice', sid: endedSid };
    const sSnap = await seasonRef(endedSid).get();
    // 尚未結算不能留下完成紀錄；00:15 備援或手動補發才能再次嘗試。
    if (!sSnap.exists || sSnap.data().status !== 'closed') return { runId, sid: endedSid, skipped: 'not-settled', sent: 0 };
    const final = sSnap.data().final || [];
    const plSnap = await db.collection('players').get();
    const players = {};
    plSnap.forEach((d) => { players[d.id] = d.data(); });

    // (a) 剛結算完那一季的資產排行榜：沿用結算時寫好的名次，沒上榜的不給
    const assetRows = final.filter((r) => r.rank && players[r.pid]).map((r) => ({
      pid: r.pid, kind: 'weeklyAsset', rank: r.rank,
      items: drawChests(tableFor(C.weekly, r.rank), C.draws)
    }));

    // (b) 總積分排行榜：資格跟 (a) 一樣，要在上一季有上榜，避免沒在玩的人也領
    const eligible = {};
    final.forEach((r) => { if (r.rank) eligible[r.pid] = true; });
    const pts = Object.keys(players)
      .filter((pid) => eligible[pid])
      .map((pid) => ({ pid, points: ((players[pid].stats || {}).points) || 0 }))
      .sort((a, b) => b.points - a.points);
    let pPrev = null, pRank = 0;
    pts.forEach((x, i) => { if (x.points !== pPrev) { pRank = i + 1; pPrev = x.points; } x.rank = pRank; });
    const pointRows = pts.map((x) => ({
      pid: x.pid, kind: 'weeklyPoints', rank: x.rank, points: x.points,
      items: drawChests(tableFor(C.weekly, x.rank), C.draws)
    }));

    return db.runTransaction(async (tx) => {
      const doneSnap = await tx.get(logRef(runId));
      if (doneSnap.exists) return Object.assign({ runId, skipped: true }, doneSnap.data().result || {});
      const week = endedSid.split('-W')[1];
      const sentA = queueMails(tx, runId, assetRows, t, C.expireDays,
        () => '第 ' + parseInt(week, 10) + ' 週結算獎勵',
        (r) => '上一季資產排行第 ' + r.rank + ' 名，辛苦了。');
      const sentB = queueMails(tx, runId, pointRows, t, C.expireDays,
        () => '總積分排行獎勵',
        (r) => '總積分排行第 ' + r.rank + ' 名（' + r.points + ' 分）。');
      const result = { sid: endedSid, asset: sentA, points: sentB, sent: sentA + sentB };
      tx.set(logRef(runId), { id: runId, at: t, status: 'done', result });
      return Object.assign({ runId }, result);
    });
  }

  /* ---------- 後台 ---------- */
  function cleanTable(v, label) {
    if (!Array.isArray(v) || !v.length) throw new AppError(label + '至少要有一列', 'bad-config', 'invalid-argument');
    const out = v.map((x) => {
      const r = Math.floor(Number(x && x.r)), w = Number(x && x.w);
      if (!(r >= 1 && r <= 6)) throw new AppError(label + '的稀有度要在 1 到 6 之間', 'bad-config', 'invalid-argument');
      if (!(w >= 0 && w <= 100)) throw new AppError(label + '的機率要在 0 到 100 之間', 'bad-config', 'invalid-argument');
      return { r: r, w: Math.round(w * 100) / 100 };
    });
    const sum = out.reduce((a, x) => a + x.w, 0);
    if (sum <= 0) throw new AppError(label + '的機率全是 0', 'bad-config', 'invalid-argument');
    // 加起來不是 100 也收，當成權重照比例正規化（規格裡每日第三名那組就是 90）
    return out;
  }

  return {
    DEFAULTS, cfgOf, rollRarity, drawChests, runDaily, runWeekly,

    async adminSetRewards(req) {
      await requireAdmin(req);
      const d = (req.data && req.data.rewards) || {};
      const snap = await cfgRef().get();
      const cur = cfgOf(snap.exists ? snap.data() : null);
      const next = {
        enabled: d.enabled === undefined ? cur.enabled : !!d.enabled,
        dailyMinPlays: d.dailyMinPlays === undefined ? cur.dailyMinPlays : Math.max(0, Math.min(999, Math.floor(Number(d.dailyMinPlays) || 0))),
        dailyCapPerGame: d.dailyCapPerGame === undefined ? cur.dailyCapPerGame : Math.max(0, Math.min(999, Math.floor(Number(d.dailyCapPerGame) || 0))),
        dailyTopNeedsPlays: d.dailyTopNeedsPlays === undefined ? cur.dailyTopNeedsPlays : !!d.dailyTopNeedsPlays,
        draws: d.draws === undefined ? cur.draws : Math.max(1, Math.min(20, Math.floor(Number(d.draws) || 1))),
        expireDays: d.expireDays === undefined ? cur.expireDays : Math.max(1, Math.min(60, Math.floor(Number(d.expireDays) || 7))),
        daily: {}, weekly: {}
      };
      ['r1', 'r2', 'r3', 'other'].forEach((k) => {
        next.daily[k] = (d.daily && d.daily[k]) ? cleanTable(d.daily[k], '每日 ' + k) : cur.daily[k];
        next.weekly[k] = (d.weekly && d.weekly[k]) ? cleanTable(d.weekly[k], '每週 ' + k) : cur.weekly[k];
      });
      if (snap.exists) await cfgRef().update({ rewards: next });
      else await cfgRef().set({ rewards: next, registrationOpen: false });
      return { rewards: next };
    },

    /* 排程漏跑時手動補；已經跑過的那一天不會重複發 */
    async adminRunRewards(req) {
      await requireAdmin(req);
      const which = String((req.data && req.data.which) || 'daily');
      const t = now();
      if (which === 'weekly') return runWeekly(t);
      return runDaily(t);
    }
  };
}

module.exports = { createRewards, DEFAULTS, rollRarity, drawChests, cfgOf };
