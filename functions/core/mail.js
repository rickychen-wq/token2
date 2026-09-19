'use strict';
/* core/mail.js — 公告與信箱 */

const { AppError, cleanPid, seasonId } = require('./util');
const E = require('./econ');
const T = require('./tasks');
const { loadCatalog } = require('./catalog');
const { grant, playerPatch, fuseBowls } = require('./shop');

function createMail({ db, now, requireSession, requireAdmin }) {
  const mailRef = (id) => db.collection('mail').doc(id);
  const playerRef = (pid) => db.collection('players').doc(pid);
  const cfgRef = () => db.collection('config').doc('app');

  return {
    async adminAnnounce(req) {
      const a = await requireAdmin(req);
      const text = String((req.data && req.data.text) || '').trim().slice(0, 300);
      const snap = await cfgRef().get();
      const announce = text ? { text, at: now(), by: a.pid } : null;
      if (snap.exists) await cfgRef().update({ announce }); else await cfgRef().set({ announce, registrationOpen: false });
      return { announce };
    },

    async adminSendMail(req) {
      const a = await requireAdmin(req);
      const d = req.data || {};
      const title = String(d.title || '').trim().slice(0, 40);
      if (!title) throw new AppError('要有標題', 'bad-mail', 'invalid-argument');
      const body = String(d.body || '').trim().slice(0, 500);
      const money = Math.floor(Number(d.money) || 0), stars = Math.floor(Number(d.stars) || 0);
      if (money < 0 || stars < 0 || money > 10000000 || stars > 10000000) throw new AppError('獎勵數量不對', 'bad-mail', 'invalid-argument');
      let to = 'all';
      if (Array.isArray(d.to) && d.to.length) to = d.to.map(cleanPid);
      const items = {};
      const cat = await loadCatalog(db);
      Object.keys(d.items || {}).forEach((id) => {
        const q = Math.floor(Number(d.items[id]) || 0);
        if (q <= 0) return;
        if (!cat.items[id]) throw new AppError('物品不存在：' + id, 'bad-mail', 'invalid-argument');
        items[id] = Math.min(q, 999);
      });
      const days = Math.max(1, Math.min(365, Math.floor(Number(d.days) || 7)));
      const t = now();
      const ref = db.collection('mail').doc();
      await ref.set({ id: ref.id, title, body, money, stars, items, to, all: to === 'all', toList: to === 'all' ? [] : to, at: t, expiresAt: t + days * 86400000, by: a.pid });
      return { id: ref.id };
    },

    async adminDeleteMail(req) {
      await requireAdmin(req);
      const id = String((req.data && req.data.id) || '');
      if (!id) throw new AppError('缺少信件', 'bad-mail', 'invalid-argument');
      await mailRef(id).delete();
      return { ok: true };
    },

    async claim(req) {
      const s = await requireSession(req);
      const id = String((req.data && req.data.id) || '');
      return db.runTransaction(async (tx) => {
        const t = now(), sid = seasonId(t);
        const mSnap = await tx.get(mailRef(id));
        if (!mSnap.exists) throw new AppError('這封信已經不存在了', 'no-mail');
        const m = mSnap.data();
        if (!m.all && (m.toList || []).indexOf(s.pid) < 0) throw new AppError('這封信不是給你的', 'not-yours');
        if (m.expiresAt && t > m.expiresAt) throw new AppError('這封信已經過期了', 'expired');
        const cRef = playerRef(s.pid).collection('mailClaims').doc(id);
        const cSnap = await tx.get(cRef);
        if (cSnap.exists) throw new AppError('已經領過了', 'claimed');
        const pSnap = await tx.get(playerRef(s.pid));
        const p = pSnap.data();
        const cat = await loadCatalog(db, tx);
        let acc = null, accRef = null, cfg = null;
        if (m.money > 0) {
          const cfgSnap = await tx.get(cfgRef());
          cfg = E.cfgOf(cfgSnap.exists ? cfgSnap.data() : null);
          accRef = db.collection('seasons').doc(sid).collection('accounts').doc(s.pid);
          const aSnap = await tx.get(accRef);
          acc = aSnap.exists ? aSnap.data() : E.newAccount(s.pid, cfg, t);
          E.rollDaily(acc, t, cfg);
        }
        let salvage = 0, gotCard = false;
        if (m.stars > 0) p.stars = (p.stars || 0) + m.stars;
        Object.keys(m.items || {}).forEach((itemId) => {
          const item = cat.items[itemId];
          if (item) {
            salvage += grant(p, item, m.items[itemId]);
            if (item.type === 'card' && m.items[itemId] > 0) gotCard = true;
          }
        });
        const fused = fuseBowls(p, t);
        if (gotCard) T.bump(p, t, 'firstItem');
        tx.update(playerRef(s.pid), playerPatch(p));
        if (acc) {
          acc.wallet += m.money;
          const repaid = E.autoRepay(acc, cfg, t);
          E.refresh(acc, cfg, t);
          tx.set(accRef, acc);
          tx.set(accRef.collection('ledger').doc(), { type: 'mail', amount: m.money, wallet: acc.wallet, bank: acc.bank.balance, loans: acc.loans, at: t, by: 'mail', note: m.title });
          repaid.forEach((e) => tx.set(accRef.collection('ledger').doc(), Object.assign(e, { at: t, by: 'mail', note: null })));
        }
        tx.set(cRef, { at: t });
        return { money: m.money, stars: m.stars, items: m.items, salvage, fused };
      });
    }
  };
}

module.exports = { createMail };
