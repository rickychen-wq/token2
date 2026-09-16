'use strict';
/* core/shop.js — 星幣商店、外觀、改名卡、主辦發放 */

const { AppError, cleanPid, cleanName } = require('./util');
const { byId, SLOT_KEY } = require('./catalog');

function inv(p) {
  const u = Object.assign({ avatars: [], frames: [], bgs: [], emotes: [] }, p.unlocked || {});
  Object.keys(SLOT_KEY).forEach((k) => { if (!Array.isArray(u[SLOT_KEY[k]])) u[SLOT_KEY[k]] = []; });
  return u;
}

/* 把物品放進玩家資料（在記憶體裡改），回傳要寫回的欄位 */
function giveItem(p, item) {
  if (item.type === 'consumable') {
    const items = Object.assign({}, p.items || {});
    items[item.id] = (items[item.id] || 0) + 1;
    return { items };
  }
  const u = inv(p), key = SLOT_KEY[item.type];
  if (u[key].indexOf(item.id) >= 0) return null;
  u[key] = u[key].concat([item.id]);
  return { unlocked: u };
}

function createShop({ db, now, requireSession, requireAdmin }) {
  const playerRef = (pid) => db.collection('players').doc(pid);

  return {
    giveItem,

    async buy(req) {
      const s = await requireSession(req);
      const item = byId[req.data && req.data.itemId];
      if (!item) throw new AppError('找不到這個商品', 'no-item', 'invalid-argument');
      if (item.limited || item.price == null) throw new AppError('這是限定商品，不能購買', 'limited');
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(playerRef(s.pid));
        const p = snap.data();
        const stars = p.stars || 0;
        const patch = giveItem(p, item);
        if (!patch) throw new AppError('你已經有這個了', 'owned');
        if (stars < item.price) throw new AppError('星幣不夠，還差 ' + (item.price - stars), 'poor');
        patch.stars = stars - item.price;
        tx.update(playerRef(s.pid), patch);
        tx.set(playerRef(s.pid).collection('purchases').doc(), { itemId: item.id, price: item.price, at: now() });
        return { stars: patch.stars };
      });
    },

    async equip(req) {
      const s = await requireSession(req);
      const d = req.data || {};
      const slot = String(d.slot);
      if (['avatar', 'frame', 'bg'].indexOf(slot) < 0) throw new AppError('欄位不對', 'bad-slot', 'invalid-argument');
      const id = d.itemId || null;
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(playerRef(s.pid));
        const p = snap.data();
        if (id) {
          const item = byId[id];
          if (!item || item.type !== slot) throw new AppError('這個物品不能放在這裡', 'bad-item', 'invalid-argument');
          if (inv(p)[SLOT_KEY[slot]].indexOf(id) < 0) throw new AppError('你還沒有這個物品', 'not-owned');
        }
        const eq = Object.assign({ avatar: null, frame: null, bg: null }, p.equipped || {});
        eq[slot] = id;
        tx.update(playerRef(s.pid), { equipped: eq });
        return { equipped: eq };
      });
    },

    async rename(req) {
      const s = await requireSession(req);
      const name = cleanName(req.data && req.data.name);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(playerRef(s.pid));
        const p = snap.data();
        const n = (p.items && p.items.rename) || 0;
        if (n <= 0) throw new AppError('你沒有改名卡', 'no-card');
        if (name === p.name) throw new AppError('名字跟現在一樣', 'same');
        const items = Object.assign({}, p.items, { rename: n - 1 });
        tx.update(playerRef(s.pid), { name, items });
        return { name };
      });
    },

    async adminGrant(req) {
      const a = await requireAdmin(req);
      const d = req.data || {};
      const pid = cleanPid(d.pid);
      const stars = d.stars === undefined || d.stars === '' ? 0 : Number(d.stars);
      if (!Number.isInteger(stars) || Math.abs(stars) > 1000000) throw new AppError('星幣要是整數', 'bad-amount', 'invalid-argument');
      const item = d.itemId ? byId[d.itemId] : null;
      if (d.itemId && !item) throw new AppError('找不到這個物品', 'no-item', 'invalid-argument');
      if (!stars && !item) throw new AppError('要發星幣或選一個物品', 'empty', 'invalid-argument');
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(playerRef(pid));
        if (!snap.exists) throw new AppError('找不到這個編號', 'not-found');
        const p = snap.data();
        const patch = item ? (giveItem(p, item) || {}) : {};
        if (item && !Object.keys(patch).length) throw new AppError('他已經有這個物品了', 'owned');
        if (stars) {
          const next = (p.stars || 0) + stars;
          if (next < 0) throw new AppError('他只有 ' + (p.stars || 0) + ' 星幣', 'poor');
          patch.stars = next;
        }
        tx.update(playerRef(pid), patch);
        tx.set(playerRef(pid).collection('purchases').doc(), { itemId: item ? item.id : null, stars, by: a.pid, at: now() });
        return { ok: true };
      });
    }
  };
}

module.exports = { createShop, giveItem, inv };
