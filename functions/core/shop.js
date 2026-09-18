'use strict';
/* core/shop.js — 星幣商店、包包、寶箱、卡片、外觀、管理員發放與商品管理 */

const { AppError, cleanPid, cleanName } = require('./util');
const { SLOT_KEY, STACKABLE, EDITABLE, RARITY, DEX_FULL_STARS, loadCatalog } = require('./catalog');

function inv(p) {
  const u = Object.assign({}, p.unlocked || {});
  Object.keys(SLOT_KEY).forEach((k) => { if (!Array.isArray(u[SLOT_KEY[k]])) u[SLOT_KEY[k]] = []; });
  return u;
}

/* 把物品給玩家（改記憶體裡的 p），回傳重複時的分解星幣 */
function grant(p, item, qty) {
  qty = qty || 1;
  if (STACKABLE[item.type]) {
    p.items = Object.assign({}, p.items || {});
    p.items[item.id] = (p.items[item.id] || 0) + qty;
    return 0;
  }
  const u = inv(p), key = SLOT_KEY[item.type];
  if (!key) return 0;
  if (u[key].indexOf(item.id) >= 0) {
    const value = item.salvage != null ? item.salvage : Math.floor((item.price || 0) * 0.5);
    p.stars = (p.stars || 0) + value * qty;
    return value * qty;
  }
  u[key] = u[key].concat([item.id]);
  p.unlocked = u;
  if (qty > 1) {
    const value = item.salvage != null ? item.salvage : Math.floor((item.price || 0) * 0.5);
    p.stars = (p.stars || 0) + value * (qty - 1);
    return value * (qty - 1);
  }
  return 0;
}

/* ---------- v11 寶箱／合成工具 ---------- */
const rnd = () => Math.random();
function randInt(min, max) { return min + Math.floor(rnd() * (max - min + 1)); }

/* 破損的陶碗滿 2 個自動合成 1 個保硬的鐵碗公，回傳合成了幾個 */
function fuseBowls(p) {
  const items = Object.assign({}, p.items || {});
  const shards = items.broken_bowl || 0;
  const made = Math.floor(shards / 2);
  if (made <= 0) return 0;
  items.broken_bowl = shards - made * 2;
  items.iron_bowl = (items.iron_bowl || 0) + made;
  p.items = items;
  return made;
}

/* 從目錄挑一個符合條件的商品（等機率） */
function pickFrom(cat, test) {
  const pool = Object.keys(cat.items).filter((id) => test(cat.items[id]));
  if (!pool.length) return null;
  return cat.items[pool[Math.floor(rnd() * pool.length)]];
}

/* 挑一個還沒收集到的圖鑑收藏品；全滿回傳 null */
function pickNewDex(cat, p) {
  const owned = (inv(p).dex) || [];
  const pool = Object.keys(cat.items).filter((id) => cat.items[id].type === 'dex' && owned.indexOf(id) < 0);
  if (!pool.length) return null;
  return cat.items[pool[Math.floor(rnd() * pool.length)]];
}

function playerPatch(p) {
  return { stars: p.stars || 0, items: p.items || {}, unlocked: inv(p), bought: p.bought || {} };
}

function useCard(p, id) {
  const n = (p.items && p.items[id]) || 0;
  if (n <= 0) return false;
  p.items = Object.assign({}, p.items, { [id]: n - 1 });
  return true;
}

function cleanQty(v, max) {
  const n = v === undefined ? 1 : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > (max || 99)) throw new AppError('數量要在 1 到 ' + (max || 99) + ' 之間', 'bad-qty', 'invalid-argument');
  return n;
}

function createShop({ db, now, requireSession, requireAdmin }) {
  const playerRef = (pid) => db.collection('players').doc(pid);
  const catRef = () => db.collection('config').doc('catalog');

  return {
    grant, inv, useCard,

    async buy(req) {
      const s = await requireSession(req);
      const d = req.data || {};
      return db.runTransaction(async (tx) => {
        const cat = await loadCatalog(db, tx);
        const item = cat.items[d.itemId];
        if (!item) throw new AppError('找不到這個商品', 'no-item', 'invalid-argument');
        const qty = STACKABLE[item.type] ? cleanQty(d.qty) : 1;
        const t = now();
        if (!item.onSale || item.price == null) throw new AppError('這個商品目前沒有販售', 'not-for-sale');
        if (item.startAt && t < item.startAt) throw new AppError('還沒開賣', 'not-started');
        if (item.endAt && t > item.endAt) throw new AppError('已經停止販售了', 'ended');
        const sold = cat.sold[item.id] || 0;
        if (item.stock != null && sold + qty > item.stock) throw new AppError(item.stock - sold > 0 ? '只剩 ' + (item.stock - sold) + ' 個' : '已經賣完了', 'sold-out');
        const snap = await tx.get(playerRef(s.pid));
        const p = snap.data();
        const bought = Object.assign({}, p.bought || {});
        if (item.perUser != null && (bought[item.id] || 0) + qty > item.perUser) throw new AppError('每人限購 ' + item.perUser + ' 個', 'limit');
        if (!STACKABLE[item.type] && inv(p)[SLOT_KEY[item.type]].indexOf(item.id) >= 0) throw new AppError('你已經有這個了', 'owned');
        const cost = item.price * qty, stars = p.stars || 0;
        if (stars < cost) throw new AppError('星幣不夠，還差 ' + (cost - stars), 'poor');
        p.stars = stars - cost;
        grant(p, item, qty);
        fuseBowls(p);
        bought[item.id] = (bought[item.id] || 0) + qty;
        p.bought = bought;
        tx.update(playerRef(s.pid), playerPatch(p));
        if (item.stock != null) {
          const soldMap = Object.assign({}, cat.sold, { [item.id]: sold + qty });
          if (cat.raw) tx.update(catRef(), { sold: soldMap }); else tx.set(catRef(), { items: {}, sold: soldMap });
        }
        tx.set(playerRef(s.pid).collection('logs').doc(), { kind: 'buy', itemId: item.id, qty, cost, at: t });
        return { stars: p.stars };
      });
    },

    async equip(req) {
      const s = await requireSession(req);
      const d = req.data || {};
      const slot = String(d.slot);
      if (['avatar', 'frame', 'bg', 'back'].indexOf(slot) < 0) throw new AppError('欄位不對', 'bad-slot', 'invalid-argument');
      const id = d.itemId || null;
      return db.runTransaction(async (tx) => {
        const cat = await loadCatalog(db, tx);
        const snap = await tx.get(playerRef(s.pid));
        const p = snap.data();
        if (id) {
          const item = cat.items[id];
          if (!item || item.type !== slot) throw new AppError('這個物品不能放在這裡', 'bad-item', 'invalid-argument');
          if (inv(p)[SLOT_KEY[slot]].indexOf(id) < 0) throw new AppError('你還沒有這個物品', 'not-owned');
        }
        const eq = Object.assign({ avatar: null, frame: null, bg: null, back: null }, p.equipped || {});
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
        if (name === p.name) throw new AppError('名字跟現在一樣', 'same');
        if (!useCard(p, 'card_rename')) throw new AppError('你沒有改名卡', 'no-card');
        tx.update(playerRef(s.pid), { name, items: p.items });
        return { name };
      });
    },

    /* 靚號：1~7 位數字，全服不能重複 */
    async vanity(req) {
      const s = await requireSession(req);
      const num = String((req.data && req.data.number) || '').trim();
      if (!/^\d{1,7}$/.test(num)) throw new AppError('靚號要是 1 到 7 位數字', 'bad-number', 'invalid-argument');
      return db.runTransaction(async (tx) => {
        const vRef = db.collection('vanity').doc(num);
        const [snap, vSnap] = [await tx.get(playerRef(s.pid)), await tx.get(vRef)];
        const p = snap.data();
        if (p.vanity === num) throw new AppError('這已經是你的靚號了', 'same');
        if (vSnap.exists) throw new AppError('這個號碼已經有人用了', 'taken');
        if (!useCard(p, 'card_vanity')) throw new AppError('你沒有全新身份卡', 'no-card');
        if (p.vanity) tx.delete(db.collection('vanity').doc(p.vanity));
        tx.set(vRef, { pid: s.pid, at: now() });
        tx.update(playerRef(s.pid), { vanity: num, items: p.items });
        return { vanity: num };
      });
    },

    /* 開寶箱：鑰匙要同階或更高。
       v11 改成「一次全部開出」：星幣 + 每一項道具各自擲一次（p 是出現機率、min~max 是數量），
       再加上頭像／UR 頭像／背景／圖鑑收藏品四個獨立加抽。內容與機率全部存在 config/catalog 的 loot，後台可改。 */
    async openChest(req) {
      const s = await requireSession(req);
      const d = req.data || {};
      const cr = Number(d.chest), kr = Number(d.key);
      if (!(cr >= 1 && cr <= 7) || !(kr >= 1 && kr <= 7)) throw new AppError('寶箱或鑰匙不對', 'bad-item', 'invalid-argument');
      if (kr < cr) throw new AppError(RARITY[kr] + '鑰匙打不開' + RARITY[cr] + '寶箱', 'key-too-low');
      return db.runTransaction(async (tx) => {
        const cat = await loadCatalog(db, tx);
        const snap = await tx.get(playerRef(s.pid));
        const p = snap.data();
        const chestId = 'chest_' + cr, keyId = 'key_' + kr;
        if (!((p.items || {})[chestId] > 0)) throw new AppError('你沒有' + RARITY[cr] + '寶箱', 'no-chest');
        if (!((p.items || {})[keyId] > 0)) throw new AppError('你沒有' + RARITY[kr] + '鑰匙', 'no-key');
        const L = cat.items[chestId].loot;
        if (!L || !Array.isArray(L.items)) throw new AppError('這個寶箱還沒設定內容', 'empty-chest');
        useCard(p, chestId); useCard(p, keyId);

        const got = [];
        const add = (item, qty, tag) => {
          if (!item || qty <= 0) return;
          const salvage = grant(p, item, qty);
          got.push({ itemId: item.id, name: item.name, img: item.img || null, type: item.type, qty, salvage, tag: tag || item.type });
        };

        /* 星幣 */
        const stars = L.stars ? randInt(L.stars.min, L.stars.max) : 0;
        if (stars > 0) p.stars = (p.stars || 0) + stars;

        /* 道具 */
        for (const e of L.items) {
          const item = cat.items[e.itemId];
          if (!item) continue;
          const hit = e.p === undefined || e.p >= 1 || rnd() < e.p;
          if (!hit) continue;
          add(item, randInt(e.min, e.max), 'item');
        }

        /* 額外加抽：一般頭像（女／男／迷因）、UR 頭像、背景、圖鑑 */
        if (L.avatar > 0 && rnd() < L.avatar) {
          add(pickFrom(cat, (it) => it.type === 'avatar' && ['female', 'male', 'meme'].indexOf(it.sub) >= 0), 1, 'avatar');
        }
        if (L.ur > 0 && rnd() < L.ur) {
          add(pickFrom(cat, (it) => it.type === 'avatar' && it.sub === 'ur'), 1, 'ur');
        }
        if (L.bg > 0 && rnd() < L.bg) {
          add(pickFrom(cat, (it) => it.type === 'bg'), 1, 'bg');
        }
        let dexFull = 0;
        if (L.dex > 0 && rnd() < L.dex) {
          const dx = pickNewDex(cat, p);
          if (dx) add(dx, 1, 'dex');
          else { dexFull = L.dexFullStars || DEX_FULL_STARS; p.stars = (p.stars || 0) + dexFull; }
        }

        const fused = fuseBowls(p);
        const result = { chest: cr, key: kr, stars, items: got, fused, dexFull };
        tx.update(playerRef(s.pid), playerPatch(p));
        tx.set(playerRef(s.pid).collection('logs').doc(), Object.assign({ kind: 'open', at: now() }, result));
        return result;
      });
    },

    /* ---------- 管理員 ---------- */
    async adminGrant(req) {
      const a = await requireAdmin(req);
      const d = req.data || {};
      const pid = cleanPid(d.pid);
      const stars = d.stars === undefined || d.stars === '' || d.stars === null ? 0 : Number(d.stars);
      if (!Number.isInteger(stars) || Math.abs(stars) > 10000000) throw new AppError('星幣要是整數', 'bad-amount', 'invalid-argument');
      return db.runTransaction(async (tx) => {
        const cat = await loadCatalog(db, tx);
        const item = d.itemId ? cat.items[d.itemId] : null;
        if (d.itemId && !item) throw new AppError('找不到這個物品', 'no-item', 'invalid-argument');
        if (!stars && !item) throw new AppError('要發星幣或選一個物品', 'empty', 'invalid-argument');
        const qty = item ? cleanQty(d.qty, 999) : 0;
        const snap = await tx.get(playerRef(pid));
        if (!snap.exists) throw new AppError('找不到這個編號', 'not-found');
        const p = snap.data();
        if (item) {
          if (!STACKABLE[item.type] && inv(p)[SLOT_KEY[item.type]].indexOf(item.id) >= 0) throw new AppError('他已經有這個物品了', 'owned');
          grant(p, item, qty);
          fuseBowls(p);
        }
        if (stars) {
          const next = (p.stars || 0) + stars;
          if (next < 0) throw new AppError('他只有 ' + (p.stars || 0) + ' 星幣', 'poor');
          p.stars = next;
        }
        tx.update(playerRef(pid), playerPatch(p));
        tx.set(playerRef(pid).collection('logs').doc(), { kind: 'grant', itemId: item ? item.id : null, qty, stars, by: a.pid, at: now() });
        return { ok: true };
      });
    },

    /* 收回物品（管理員處理退款、誤發） */
    async adminRevoke(req) {
      const a = await requireAdmin(req);
      const d = req.data || {};
      const pid = cleanPid(d.pid);
      return db.runTransaction(async (tx) => {
        const cat = await loadCatalog(db, tx);
        const item = cat.items[d.itemId];
        if (!item) throw new AppError('找不到這個物品', 'no-item', 'invalid-argument');
        const snap = await tx.get(playerRef(pid));
        if (!snap.exists) throw new AppError('找不到這個編號', 'not-found');
        const p = snap.data();
        const refund = Math.max(0, Number(d.refund) || 0);
        if (STACKABLE[item.type]) {
          if (!((p.items || {})[item.id] > 0)) throw new AppError('他沒有這個物品', 'not-owned');
          useCard(p, item.id);
        } else {
          const u = inv(p), key = SLOT_KEY[item.type];
          if (u[key].indexOf(item.id) < 0) throw new AppError('他沒有這個物品', 'not-owned');
          u[key] = u[key].filter((x) => x !== item.id);
          p.unlocked = u;
        }
        p.stars = (p.stars || 0) + refund;
        const eq = Object.assign({}, p.equipped || {});
        if (eq[item.type] === item.id) eq[item.type] = null;
        tx.update(playerRef(pid), Object.assign(playerPatch(p), { equipped: eq }));
        tx.set(playerRef(pid).collection('logs').doc(), { kind: 'revoke', itemId: item.id, refund, by: a.pid, at: now() });
        return { ok: true };
      });
    },

    async adminCatalog(req) {
      await requireAdmin(req);
      const d = req.data || {};
      return db.runTransaction(async (tx) => {
        const cat = await loadCatalog(db, tx);
        const item = cat.items[d.itemId];
        if (!item) throw new AppError('找不到這個商品', 'no-item', 'invalid-argument');
        const patch = {}, src = d.patch || {};
        Object.keys(src).forEach((k) => {
          if (EDITABLE.indexOf(k) < 0) return;
          let v = src[k];
          if (k === 'name') { v = String(v || '').trim().slice(0, 20); if (!v) throw new AppError('名字不能空白', 'bad-config', 'invalid-argument'); }
          else if (k === 'desc' || k === 'sub') v = v == null ? null : String(v).slice(0, 80);
          else if (k === 'onSale') v = !!v;
          else if (k === 'loot') {
            if (!v || typeof v !== 'object' || !Array.isArray(v.items)) throw new AppError('寶箱內容格式不對', 'bad-config', 'invalid-argument');
            const rate = (x, label) => { const n = Number(x); if (!(n >= 0 && n <= 1)) throw new AppError(label + '要在 0 到 1 之間', 'bad-config', 'invalid-argument'); return n; };
            const sMn = Math.max(0, Math.floor(Number((v.stars || {}).min) || 0));
            const sMx = Math.max(sMn, Math.floor(Number((v.stars || {}).max) || 0));
            v = {
              stars: { min: sMn, max: sMx },
              items: v.items.map((e) => {
                if (!cat.items[e.itemId]) throw new AppError('寶箱裡的物品不存在：' + e.itemId, 'bad-config', 'invalid-argument');
                const mn = Math.max(0, Math.floor(Number(e.min) || 0));
                const mx = Math.max(mn, Math.floor(Number(e.max) || 0));
                return { itemId: e.itemId, min: mn, max: mx, p: rate(e.p === undefined ? 1 : e.p, '出現機率') };
              }),
              avatar: rate(v.avatar || 0, '頭像機率'),
              ur: rate(v.ur || 0, 'UR 頭像機率'),
              bg: rate(v.bg || 0, '背景機率'),
              dex: rate(v.dex || 0, '圖鑑機率'),
              dexFullStars: Math.max(0, Math.floor(Number(v.dexFullStars) || DEX_FULL_STARS))
            };
          }
          else if (k === 'rewards') {
            if (!Array.isArray(v) || !v.length) throw new AppError('寶箱內容至少要一項', 'bad-config', 'invalid-argument');
            v = v.map((r) => {
              const w = Number(r.weight);
              if (!(w >= 0)) throw new AppError('機率權重不對', 'bad-config', 'invalid-argument');
              if (r.kind === 'stars') {
                const mn = Number(r.min), mx = Number(r.max);
                if (!Number.isInteger(mn) || !Number.isInteger(mx) || mn < 0 || mx < mn) throw new AppError('星幣範圍不對', 'bad-config', 'invalid-argument');
                return { kind: 'stars', min: mn, max: mx, weight: w };
              }
              if (r.kind === 'item') {
                if (!cat.items[r.itemId]) throw new AppError('寶箱裡的物品不存在：' + r.itemId, 'bad-config', 'invalid-argument');
                return { kind: 'item', itemId: r.itemId, qty: Math.max(1, Math.floor(Number(r.qty) || 1)), weight: w };
              }
              throw new AppError('寶箱內容種類不對', 'bad-config', 'invalid-argument');
            });
          } else {
            if (v === '' || v === null) v = null;
            else { v = Number(v); if (!Number.isFinite(v) || v < 0) throw new AppError('「' + k + '」要是 0 以上的數字', 'bad-config', 'invalid-argument'); v = k === 'startAt' || k === 'endAt' ? Math.round(v) : Math.floor(v); }
          }
          patch[k] = v;
        });
        const items = Object.assign({}, cat.raw ? cat.raw.items : {});
        items[item.id] = Object.assign({}, items[item.id], patch);
        if (cat.raw) tx.update(catRef(), { items }); else tx.set(catRef(), { items, sold: {} });
        return { ok: true };
      });
    }
  };
}

module.exports = { createShop, grant, inv, useCard, playerPatch, fuseBowls };
