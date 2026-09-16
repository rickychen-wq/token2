'use strict';
/* core/season.js — 每週結算
   流程：鎖定（週日 23:00）→ 牌桌帶回 → 補算最後一段利息 → 排名、寫入永久紀錄、封存（週一 00:00）
   每一步都可以重跑，不會重複發分。 */

const { AppError, seasonId, seasonRange } = require('./util');
const E = require('./econ');
const { byId } = require('./catalog');
const { giveItem } = require('./shop');

const POINTS = { 1: 5, 2: 3, 3: 1 };
const DEFAULT_RANK_FROM = '2026-W39';   // 這一季之前是練習季，不發積分

/* 排名：打滿手數的人依淨資產排序，同分同名次；沒打滿的排在後面、沒有名次 */
function rankSeason(accounts, players, minHands) {
  const rows = accounts.map((a) => ({
    pid: a.pid,
    name: (players[a.pid] && players[a.pid].name) || a.pid,
    net: a.net, peakNet: a.peakNet || a.net,
    hands: a.handsPlayed || 0,
    eligible: (a.handsPlayed || 0) >= minHands,
    rank: null
  }));
  const ok = rows.filter((r) => r.eligible).sort((a, b) => b.net - a.net || a.pid.localeCompare(b.pid));
  const rest = rows.filter((r) => !r.eligible).sort((a, b) => b.net - a.net || a.pid.localeCompare(b.pid));
  let prev = null, rank = 0;
  ok.forEach((r, i) => { if (r.net !== prev) { rank = i + 1; prev = r.net; } r.rank = rank; });
  return ok.concat(rest);
}

function createSeason({ db, now, requireAdmin, runInterest, closeTables }) {
  const cfgRef = () => db.collection('config').doc('app');
  const seasonRef = (sid) => db.collection('seasons').doc(sid);

  async function lock(t) {
    const sid = seasonId(t);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(seasonRef(sid));
      const r = seasonRange(t);
      if (!snap.exists) tx.set(seasonRef(sid), { id: sid, startAt: r.start, endAt: r.end, status: 'locking', createdAt: t });
      else if ((snap.data().status || 'active') === 'active') tx.update(seasonRef(sid), { status: 'locking', lockedAt: t });
    });
    return { sid };
  }

  async function settle(sid, t) {
    const pre = await seasonRef(sid).get();
    if (pre.exists && pre.data().status === 'closed') return { sid, skipped: true };

    // 1. 標記結算中，擋掉這一季的新交易
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(seasonRef(sid));
      if (!snap.exists) tx.set(seasonRef(sid), { id: sid, status: 'settling', createdAt: t });
      else if (snap.data().status !== 'closed') tx.update(seasonRef(sid), { status: 'settling' });
    });

    // 2. 牌桌帶回、3. 補算利息
    const tables = await closeTables(sid);
    await runInterest(t);

    // 4. 排名、永久紀錄、封存（同一個 transaction）
    return db.runTransaction(async (tx) => {
      const sSnap = await tx.get(seasonRef(sid));
      if (sSnap.exists && sSnap.data().status === 'closed') return { sid, skipped: true };
      const cfgSnap = await tx.get(cfgRef());
      const accSnap = await tx.get(seasonRef(sid).collection('accounts'));
      const plSnap = await tx.get(db.collection('players'));
      const rawCfg = cfgSnap.exists ? cfgSnap.data() : {};
      const cfg = E.cfgOf(rawCfg);
      const rankFrom = rawCfg.rankFrom || DEFAULT_RANK_FROM;
      const practice = sid < rankFrom;

      const accounts = [], players = {};
      accSnap.forEach((d) => { const a = d.data(); E.refresh(a, cfg, t); accounts.push(a); });
      plSnap.forEach((d) => { players[d.id] = d.data(); });
      const rows = rankSeason(accounts, players, cfg.rankMinHands);

      rows.forEach((r) => {
        const p = players[r.pid];
        r.stars = !practice && r.hands >= cfg.starMinHands ? E.starsFor(r.net, cfg) : 0;
        if (!p || p.lastSettledSeason === sid) return;
        const st = Object.assign({
          points: 0, champions: 0, top3: 0, seasonsPlayed: 0, bestRank: null, peakNet: 0, peakNetSeason: null,
          bestSeasonNet: 0, bestSeasonId: null, champStreak: 0, lastChampSeason: null
        }, p.stats || {});
        if (r.peakNet > (st.peakNet || 0)) { st.peakNet = r.peakNet; st.peakNetSeason = sid; }
        if (!practice && r.hands > 0) {
          st.seasonsPlayed += 1;
          if (r.eligible && r.net > (st.bestSeasonId ? st.bestSeasonNet : -Infinity)) { st.bestSeasonNet = r.net; st.bestSeasonId = sid; }
          if (r.rank) {
            st.points += POINTS[r.rank] || 0;
            if (r.rank <= 3) st.top3 += 1;
            if (st.bestRank === null || r.rank < st.bestRank) st.bestRank = r.rank;
            if (r.rank === 1) {
              const prevSid = seasonId(prevStart(sid));
              st.champions += 1;
              st.champStreak = st.lastChampSeason === prevSid ? st.champStreak + 1 : 1;
              st.lastChampSeason = sid;
            } else {
              st.champStreak = 0;
            }
          }
        }
        const patch = { stats: st, lastSettledSeason: sid };
        if (r.stars) patch.stars = (p.stars || 0) + r.stars;
        if (!practice && r.rank === 1) {
          const got = giveItem(p, byId.fr_champion);
          if (got) Object.assign(patch, got);
        }
        const hist = Array.isArray(p.history) ? p.history.slice() : [];
        if (r.hands > 0) {
          hist.unshift({ sid, rank: r.rank, net: r.net, hands: r.hands, stars: r.stars, practice });
          patch.history = hist.slice(0, 12);
        }
        tx.update(db.collection('players').doc(r.pid), patch);
      });

      const final = rows.map((r) => ({ pid: r.pid, name: r.name, net: r.net, rank: r.rank, hands: r.hands, eligible: r.eligible, stars: r.stars }));
      const doc = { id: sid, status: 'closed', settledAt: t, final, practice, minHands: cfg.rankMinHands };
      if (sSnap.exists) tx.update(seasonRef(sid), doc); else tx.set(seasonRef(sid), doc);
      if (cfgSnap.exists) tx.update(cfgRef(), { lastSeason: sid }); else tx.set(cfgRef(), { lastSeason: sid, registrationOpen: false });
      return { sid, skipped: false, practice, players: rows.length, tables };
    });
  }

  /* 上一季的 ID（用那一季週一往前推一天） */
  function prevStart(sid) {
    return seasonStartOf(sid) - 86400000;
  }
  function seasonStartOf(sid) {
    const [y, w] = sid.split('-W').map(Number);
    const jan4 = Date.UTC(y, 0, 4);
    const mon = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86400000 + (w - 1) * 7 * 86400000;
    return mon - 8 * 3600000 + 3600000;   // 週一台灣 01:00，保證落在那一週
  }

  return {
    lock, settle, rankSeason,
    /* 排程：週一 00:00 結算剛結束的那一季 */
    async settleEnded(t) {
      const sid = seasonId(seasonRange(t).start - 1);
      return settle(sid, t);
    },
    async adminSettle(req) {
      await requireAdmin(req);
      const t = now();
      const sid = seasonId(seasonRange(t).start - 1);
      const r = await settle(sid, t);
      return r;
    },
    /* 正式季從哪一週開始、牌局數據從什麼時候開始記錄 */
    async adminSeasonConfig(req) {
      await requireAdmin(req);
      const d = req.data || {};
      const patch = {};
      if (d.rankFrom !== undefined) {
        const v = String(d.rankFrom);
        if (!/^\d{4}-W\d{2}$/.test(v)) throw new AppError('週次格式要像 2026-W39', 'bad-config', 'invalid-argument');
        patch.rankFrom = v;
      }
      if (d.statsFrom !== undefined) {
        const n = d.statsFrom === null ? 0 : Number(d.statsFrom);
        if (!Number.isFinite(n) || n < 0) throw new AppError('時間格式不對', 'bad-config', 'invalid-argument');
        patch.statsFrom = n;
      }
      const snap = await cfgRef().get();
      if (snap.exists) await cfgRef().update(patch); else await cfgRef().set(Object.assign({ registrationOpen: false }, patch));
      return patch;
    },

    async adminLock(req) {
      await requireAdmin(req);
      return lock(now());
    },
    async adminUnlock(req) {
      await requireAdmin(req);
      const sid = seasonId(now());
      const snap = await seasonRef(sid).get();
      if (!snap.exists || snap.data().status !== 'locking') throw new AppError('本季沒有被鎖定', 'not-locked');
      await seasonRef(sid).update({ status: 'active' });
      return { sid };
    }
  };
}

module.exports = { createSeason, rankSeason, POINTS, DEFAULT_RANK_FROM };
