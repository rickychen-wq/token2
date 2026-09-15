'use strict';
/* core/economy.js — 經濟系統的資料庫操作。
   每個改錢的動作都是一個 transaction：讀設定、季、帳戶、玩家 → 套規則 → 寫帳戶、流水帳、永久紀錄 */

const { AppError, seasonId, seasonRange, cleanPid } = require('./util');
const E = require('./econ');

function createEconomy({ db, now, requireSession, requireAdmin }) {
  const cfgRef = () => db.collection('config').doc('app');
  const seasonRef = (sid) => db.collection('seasons').doc(sid);
  const accRef = (sid, pid) => seasonRef(sid).collection('accounts').doc(pid);
  const playerRef = (pid) => db.collection('players').doc(pid);

  /* 在 transaction 裡對某個玩家的當季帳戶做事。
     fn(acc, cfg, t) 回傳流水帳陣列；帳戶不存在會自動以起始資金建立 */
  async function mutate(pid, fn, meta) {
    return db.runTransaction(async (tx) => {
      const t = now();
      const sid = seasonId(t);
      const [cfgSnap, sSnap, aSnap, pSnap] = [
        await tx.get(cfgRef()), await tx.get(seasonRef(sid)),
        await tx.get(accRef(sid, pid)), await tx.get(playerRef(pid))
      ];
      if (!pSnap.exists) throw new AppError('找不到這個編號', 'not-found');
      if (sSnap.exists && sSnap.data().status && sSnap.data().status !== 'active') {
        throw new AppError('本季正在結算，暫停所有交易', 'season-locked');
      }
      const cfg = E.cfgOf(cfgSnap.exists ? cfgSnap.data() : null);
      const entries = [];
      let acc;
      if (aSnap.exists) {
        acc = aSnap.data();
      } else {
        acc = E.newAccount(pid, cfg, t);
        entries.push({ type: 'start', amount: cfg.startingMoney, wallet: acc.wallet, bank: 0, loans: 0 });
      }
      E.rollDaily(acc, t);

      const produced = fn ? fn(acc, cfg, t) : [];
      entries.push.apply(entries, produced || []);
      E.refresh(acc, cfg, t);

      if (!sSnap.exists) {
        const r = seasonRange(t);
        tx.set(seasonRef(sid), { id: sid, startAt: r.start, endAt: r.end, status: 'active', createdAt: t });
      }
      tx.set(accRef(sid, pid), acc);
      const accDoc = accRef(sid, pid);
      entries.forEach((e) => {
        tx.set(accDoc.collection('ledger').doc(), Object.assign(e, { at: t, by: (meta && meta.by) || pid, note: (meta && meta.note) || null }));
      });

      const st = pSnap.data().stats || {};
      if (acc.peakNet > (st.peakNet || 0)) {
        tx.update(playerRef(pid), { 'stats.peakNet': acc.peakNet, 'stats.peakNetSeason': sid });
      }
      return { sid, account: acc, cfg };
    });
  }

  function view(r) {
    return { sid: r.sid, account: r.account };
  }

  return {
    mutate,
    runInterest: (t) => runInterest(t),

    async account(req) {
      const s = await requireSession(req);
      return view(await mutate(s.pid, null));
    },

    async borrow(req) {
      const s = await requireSession(req);
      return view(await mutate(s.pid, (acc, cfg, t) => E.borrow(acc, cfg, t)));
    },

    async deposit(req) {
      const s = await requireSession(req);
      const amount = E.cleanAmount(req.data && req.data.amount);
      return view(await mutate(s.pid, (acc, cfg, t) => E.deposit(acc, cfg, amount, t)));
    },

    async withdraw(req) {
      const s = await requireSession(req);
      const amount = E.cleanAmount(req.data && req.data.amount);
      return view(await mutate(s.pid, (acc, cfg, t) => E.withdraw(acc, cfg, amount, t)));
    },

    async claimDaily(req) {
      const s = await requireSession(req);
      return view(await mutate(s.pid, (acc, cfg, t) => E.claimDaily(acc, cfg, t)));
    },

    /* ---------- 主辦 ---------- */

    async adminAdjust(req) {
      const s = await requireAdmin(req);
      const d = req.data || {};
      const pid = cleanPid(d.pid);
      const note = d.note ? String(d.note).slice(0, 60) : null;
      return view(await mutate(pid, (acc, cfg, t) => E.adminAdjust(acc, cfg, d.delta, t), { by: s.pid, note }));
    },

    async adminSetEcon(req) {
      await requireAdmin(req);
      const patch = E.cleanEconPatch(req.data || {});
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(cfgRef());
        const cur = (snap.exists && snap.data().econ) || {};
        const next = Object.assign({}, cur, patch);
        const merged = E.cfgOf({ econ: next });
        if (merged.interestMin > merged.interestMax) throw new AppError('最低利率不能比最高利率高', 'bad-config', 'invalid-argument');
        if (snap.exists) tx.update(cfgRef(), { econ: next });
        else tx.set(cfgRef(), { econ: next, registrationOpen: false });
      });
      return { ok: true };
    },

    async adminLedger(req) {
      await requireAdmin(req);
      const pid = cleanPid(req.data && req.data.pid);
      const sid = seasonId(now());
      const q = await accRef(sid, pid).collection('ledger').orderBy('at', 'desc').limit(40).get();
      const rows = [];
      q.forEach((d) => rows.push(d.data()));
      return { sid, rows };
    },

    async adminRunInterest(req) {
      await requireAdmin(req);
      return runInterest(now());
    }
  };

  /* 結算「最近一個已經結束的計息週期」。同一個週期只會算一次 */
  async function runInterest(t) {
    const P = E.periodStart(t) - E.PERIOD;
    const sid = seasonId(P);
    const runRef = seasonRef(sid).collection('interestRuns').doc(String(P));
    return db.runTransaction(async (tx) => {
      const run = await tx.get(runRef);
      if (run.exists) return { period: P, sid, skipped: true, total: run.data().total, count: run.data().count };
      const cfgSnap = await tx.get(cfgRef());
      const accSnap = await tx.get(seasonRef(sid).collection('accounts'));
      const plSnap = await tx.get(db.collection('players'));
      const cfg = E.cfgOf(cfgSnap.exists ? cfgSnap.data() : null);

      const accounts = [];
      accSnap.forEach((d) => accounts.push(d.data()));
      const players = {};
      plSnap.forEach((d) => { players[d.id] = d.data(); });
      const rates = E.rankRates(accounts, cfg);

      let total = 0, count = 0;
      accounts.forEach((acc) => {
        const r = rates[acc.pid];
        const gain = E.applyInterest(acc, P, r.rate);
        if (gain <= 0) return;
        total += gain; count++;
        E.refresh(acc, cfg, t);
        const ref = accRef(sid, acc.pid);
        tx.set(ref, acc);
        tx.set(ref.collection('ledger').doc(), {
          type: 'interest', amount: gain, wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans,
          rate: r.rate, rank: r.rank, at: t, by: 'system', note: null
        });
        const p = players[acc.pid];
        if (p && acc.peakNet > ((p.stats && p.stats.peakNet) || 0)) {
          tx.update(playerRef(acc.pid), { 'stats.peakNet': acc.peakNet, 'stats.peakNetSeason': sid });
        }
      });
      tx.set(runRef, { period: P, at: t, total, count });
      return { period: P, sid, skipped: false, total, count };
    });
  }
}

module.exports = { createEconomy };
