'use strict';
/* core/economy.js — 經濟系統的資料庫操作。
   每個改錢的動作都是一個 transaction：讀設定、季、帳戶、玩家 → 套規則 → 寫帳戶、流水帳、永久紀錄 */

const { AppError, seasonId, seasonRange, cleanPid } = require('./util');
const E = require('./econ');
const { expireTemp } = require('./shop');
const T = require('./tasks');

function createEconomy({ db, now, requireSession, requireAdmin }) {
  const cfgRef = () => db.collection('config').doc('app');
  const seasonRef = (sid) => db.collection('seasons').doc(sid);
  const accRef = (sid, pid) => seasonRef(sid).collection('accounts').doc(pid);
  const playerRef = (pid) => db.collection('players').doc(pid);

  /* 在 transaction 裡對某個玩家的當季帳戶做事。
     fn(acc, cfg, t, rawCfg, pl, setPlayer) 回傳流水帳陣列；帳戶不存在會自動以起始資金建立。
     pl 是玩家永久資料（背包、裝備）的唯讀快照；要改的話呼叫 setPlayer(patch)，
     patch 會跟本來就會寫的 stats 一起用一次 update 送出。 */
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
      const rawCfg = cfgSnap.exists ? cfgSnap.data() : {};
      const cfg = E.cfgOf(rawCfg);
      const entries = [];
      let acc;
      if (aSnap.exists) {
        acc = aSnap.data();
      } else {
        acc = E.newAccount(pid, cfg, t);
        entries.push({ type: 'start', amount: cfg.startingMoney, wallet: acc.wallet, bank: 0, loans: 0 });
      }
      E.rollDaily(acc, t, cfg);

      const plPatch = {};
      const setPlayer = (patch) => { Object.assign(plPatch, patch || {}); };
      // v11b：乾洗髮純看時間，任何一次動到帳戶（登入讀帳戶也會走這裡）都順手檢查有沒有到期
      const pl = pSnap.data();
      if (expireTemp(pl, t)) { plPatch.temp = pl.temp || {}; plPatch.equipped = pl.equipped || {}; }
      // v12：任何一次動到帳戶（登入讀帳戶也會走這裡）就算今天登入過
      if (T.bump(pl, t, 'login', 1, rawCfg)) plPatch.tasks = pl.tasks;
      const produced = fn ? fn(acc, cfg, t, rawCfg, pl, setPlayer) : [];
      entries.push.apply(entries, produced || []);
      // 統一規則：任何流程結束後，錢包達到門檻就自動還款（登入讀帳戶時也會補做）。
      // 收入紀錄在前、還款紀錄在後；已經還過的不會再觸發，所以重複讀取不會重複扣。
      entries.push.apply(entries, E.autoRepay(acc, cfg, t));
      E.refresh(acc, cfg, t);

      if (!sSnap.exists) {
        const r = seasonRange(t);
        tx.set(seasonRef(sid), { id: sid, startAt: r.start, endAt: r.end, status: 'active', createdAt: t });
      }
      tx.set(accRef(sid, pid), acc);
      const accDoc = accRef(sid, pid);
      entries.forEach((e) => {
        tx.set(accDoc.collection('ledger').doc(), Object.assign(e, { at: t, by: (meta && meta.by) || pid, note: (meta && meta.note) || e.note || null }));
      });

      const st = pSnap.data().stats || {};
      if (acc.peakNet > (st.peakNet || 0)) {
        plPatch['stats.peakNet'] = acc.peakNet;
        plPatch['stats.peakNetSeason'] = sid;
      }
      if (Object.keys(plPatch).length) tx.update(playerRef(pid), plPatch);
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
      return view(await mutate(s.pid, (acc, cfg, t, raw, pl) => E.borrow(acc, cfg, t, pl)));
    },

    /* ---------- v12 任務 ---------- */
    async taskList(req) {
      const s = await requireSession(req);
      let tasks = null;
      const r = await mutate(s.pid, (acc, cfg, t, raw, pl, setPlayer) => {
        // 9/21 啟用前，登入事件不會建立 pl.tasks。先跑 progress()，由 roll()
        // 建立完整容器後再寫回，避免把 undefined 交給 Firestore 而造成 internal error。
        tasks = T.progress(pl, acc, t, raw);
        setPlayer({ tasks: pl.tasks });
        return [];
      });
      return { tasks, account: r.account };
    },

    async taskClaim(req) {
      const s = await requireSession(req);
      const id = String((req.data && req.data.id) || '');
      let got = null;
      let tasks = null;
      const r = await mutate(s.pid, (acc, cfg, t, raw, pl, setPlayer) => {
        const out = T.claim(pl, acc, t, id, raw);
        got = out.task;
        tasks = T.progress(pl, acc, t, raw);
        setPlayer({ tasks: pl.tasks, stars: pl.stars || 0 });
        return out.entries;
      });
      return { got, tasks, account: r.account };
    },

    /* v11b 破產防護卷 */
    async useRevive(req) {
      const s = await requireSession(req);
      const r = await mutate(s.pid, (acc, cfg, t, raw, pl, setPlayer) => {
        const out = E.useRevive(acc, cfg, t, pl);
        const items = Object.assign({}, pl.items);
        items.bankruptcy_protection = (items.bankruptcy_protection || 0) - 1;
        setPlayer({ items });
        return out;
      });
      return Object.assign(view(r), { used: 'bankruptcy_protection' });
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
      const sSnap = await tx.get(seasonRef(sid));
      if (sSnap.exists && sSnap.data().status === 'closed') return { period: P, sid, skipped: true, total: 0, count: 0 };
      const cfgSnap = await tx.get(cfgRef());
      const accSnap = await tx.get(seasonRef(sid).collection('accounts'));
      const plSnap = await tx.get(db.collection('players'));
      const cfg = E.cfgOf(cfgSnap.exists ? cfgSnap.data() : null);

      const accounts = [];
      accSnap.forEach((d) => accounts.push(d.data()));
      const players = {};
      plSnap.forEach((d) => { players[d.id] = d.data(); });
      const activeAccounts = accounts.filter((acc) => players[acc.pid]);
      const rates = E.rankRates(activeAccounts, cfg);

      let total = 0, count = 0;
      activeAccounts.forEach((acc) => {
        const r = rates[acc.pid];
        // 00:00 計息屬於新一天的第一筆系統操作；先保存昨天結束瞬間的淨資產，
        // 才不會讓這筆利息倒回去改寫昨天的每日排行。
        E.rollDaily(acc, t, cfg);
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
