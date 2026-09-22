'use strict';
/* core/feedback.js — 意見箱：玩家投稿、圖片附件與管理員處理 */

const { AppError } = require('./util');
const { loadCatalog } = require('./catalog');

const DAY = 86400000;
const MAX_DAILY = 5;

function text(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function publicFeedback(id, x) {
  return {
    id,
    pid: x.pid,
    name: x.name || x.pid,
    type: x.type,
    title: x.title,
    body: x.body,
    status: x.status,
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
    reward: x.reward || null,
    adminNote: x.adminNote || '',
    hideAt: x.hideAt || null
  };
}

function createFeedback({ db, now, requireSession, requireAdmin }) {
  const feedbackRef = (id) => db.collection('feedback').doc(id);
  const playerRef = (pid) => db.collection('players').doc(pid);

  async function addMail(tx, pid, data, by, t, days) {
    const ref = db.collection('mail').doc();
    tx.set(ref, {
      id: ref.id,
      title: data.title,
      body: data.body || '',
      money: data.money || 0,
      stars: data.stars || 0,
      items: data.items || {},
      to: [pid],
      all: false,
      toList: [pid],
      at: t,
      expiresAt: t + (days || 7) * DAY,
      by
    });
    return ref.id;
  }

  return {
    async submit(req) {
      const s = await requireSession(req);
      const d = req.data || {};
      const type = d.type === 'bug' ? 'bug' : d.type === 'idea' ? 'idea' : '';
      const title = text(d.title, 40);
      const body = text(d.body, 1000);
      if (!type) throw new AppError('請選擇回報類型', 'bad-feedback', 'invalid-argument');
      if (!title) throw new AppError('請填寫標題', 'bad-feedback', 'invalid-argument');
      if (!body) throw new AppError('請填寫內容', 'bad-feedback', 'invalid-argument');

      const t = now();
      const day = new Date(t + 8 * 3600000).toISOString().slice(0, 10);
      const ref = db.collection('feedback').doc();
      await db.runTransaction(async (tx) => {
        const pSnap = await tx.get(playerRef(s.pid));
        if (!pSnap.exists) throw new AppError('找不到玩家資料', 'no-player', 'not-found');
        const p = pSnap.data();
        const count = p.feedbackDay === day ? Number(p.feedbackCount || 0) : 0;
        if (count >= MAX_DAILY) throw new AppError('今天已經投稿 5 次，明天再試', 'feedback-limit', 'resource-exhausted');
        tx.update(playerRef(s.pid), { feedbackDay: day, feedbackCount: count + 1 });
        tx.set(ref, {
          id: ref.id,
          pid: s.pid,
          name: text(p.name || s.name || s.pid, 20),
          type,
          title,
          body,
          status: 'pending',
          createdAt: t,
          updatedAt: t,
          client: text(d.client, 120)
        });
      });
      return { id: ref.id };
    },

    async mine(req) {
      const s = await requireSession(req);
      const t = now();
      const snap = await db.collection('feedback').where('pid', '==', s.pid).limit(100).get();
      const items = [];
      snap.forEach((doc) => {
        const x = doc.data();
        if (x.status === 'received' && x.hideAt && t >= x.hideAt) return;
        items.push(publicFeedback(doc.id, x));
      });
      items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return { items };
    },

    async adminList(req) {
      await requireAdmin(req);
      const snap = await db.collection('feedback').orderBy('createdAt', 'desc').limit(100).get();
      const items = [];
      snap.forEach((doc) => items.push(publicFeedback(doc.id, doc.data())));
      const order = { pending: 0, received: 1, rewarded: 2 };
      items.sort((a, b) => (order[a.status] === undefined ? 9 : order[a.status]) - (order[b.status] === undefined ? 9 : order[b.status]) || (b.createdAt || 0) - (a.createdAt || 0));
      return { items };
    },

    async adminAction(req) {
      const a = await requireAdmin(req);
      const d = req.data || {};
      const id = text(d.id, 80);
      const action = text(d.action, 20);
      if (!id || !['delete', 'received', 'reward'].includes(action)) {
        throw new AppError('處理方式不正確', 'bad-feedback-action', 'invalid-argument');
      }

      if (action === 'delete') {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(feedbackRef(id));
          if (!snap.exists) throw new AppError('投稿已經不存在', 'no-feedback', 'not-found');
          tx.delete(feedbackRef(id));
        });
        return { ok: true, action };
      }

      const note = text(d.note, 200);
      let reward = null;
      if (action === 'reward') {
        const money = Math.floor(Number(d.money) || 0);
        const stars = Math.floor(Number(d.stars) || 0);
        const itemId = text(d.itemId, 80);
        const qty = itemId ? Math.max(1, Math.min(999, Math.floor(Number(d.qty) || 1))) : 0;
        if (money < 0 || stars < 0 || money > 10000000 || stars > 10000000) {
          throw new AppError('獎勵數量不正確', 'bad-reward', 'invalid-argument');
        }
        const items = {};
        let itemName = '';
        if (itemId) {
          const cat = await loadCatalog(db);
          if (!cat.items[itemId]) throw new AppError('獎勵物品不存在', 'bad-reward', 'invalid-argument');
          items[itemId] = qty;
          itemName = cat.items[itemId].name;
        }
        if (!money && !stars && !itemId) throw new AppError('至少要設定一項獎勵', 'bad-reward', 'invalid-argument');
        reward = { money, stars, items, itemName, qty };
      }

      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(feedbackRef(id));
        if (!snap.exists) throw new AppError('投稿已經不存在', 'no-feedback', 'not-found');
        const x = snap.data();
        const t = now();
        if (action === 'received') {
          if (x.status === 'rewarded') throw new AppError('這筆已經發過獎勵', 'already-handled');
          if (x.status === 'received') return { ok: true, action, unchanged: true };
          const mailId = await addMail(tx, x.pid, {
            title: '意見箱：我們已收到',
            body: '你回報的「' + x.title + '」已經確認收到，謝謝你幫忙改善遊戲。' + (note ? '\n管理員：' + note : '')
          }, a.pid, t, 3);
          tx.update(feedbackRef(id), { status: 'received', adminNote: note, hideAt: t + 3 * DAY, mailId, updatedAt: t, handledBy: a.pid });
          return { ok: true, action, mailId };
        }
        if (x.status === 'rewarded') throw new AppError('這筆已經發過獎勵', 'already-rewarded');
        const mailId = await addMail(tx, x.pid, {
          title: '意見箱：獎勵已送達',
          body: '你回報的「' + x.title + '」對遊戲很有幫助。' + (note ? '\n管理員：' + note : '\n謝謝你的貢獻！'),
          money: reward.money,
          stars: reward.stars,
          items: reward.items
        }, a.pid, t, 30);
        tx.update(feedbackRef(id), { status: 'rewarded', reward, adminNote: note, hideAt: null, mailId, updatedAt: t, handledBy: a.pid });
        return { ok: true, action, mailId };
      });
      return result;
    }
  };
}

module.exports = { createFeedback, publicFeedback };
