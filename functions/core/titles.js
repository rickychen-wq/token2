'use strict';
/* core/titles.js — 成就解鎖稱號、每日能力快照、展示欄與限定稱號。
   重要規則：裝備是「目前展示」，daily.activeId 是「今日生效」。一天只鎖一次，
   所以玩家無法靠反覆換稱號重複領獎或切換優惠。 */

const { AppError, cleanPid, seasonId, TW_OFFSET } = require('./util');

const LAUNCH_AT = Date.UTC(2026, 8, 27, 16, 0, 0); // 2026/09/28 00:00 Asia/Taipei
const FIRST_SEASON_END = LAUNCH_AT + 7 * 86400000;

const CATEGORY = {
  A: { name: '旅程', color: '#62dcff', completeEffect: '任務金錢永久 +10%', benefit: { taskBonus: 0.10 } },
  B: { name: '財富', color: '#ffd46b', completeEffect: '銀行利息永久 +5%', benefit: { interestBonus: 0.05 } },
  P: { name: '牌桌', color: '#8cf2bd', completeEffect: '每日固定 +500', benefit: { dailyCash: 500 } },
  C: { name: '收藏', color: '#c9a1ff', completeEffect: '商店永久 5% 折扣', benefit: { shopDiscount: 0.05 } },
  H: { name: '隱藏', color: '#ff82c7', completeEffect: '每日固定 +1,000', benefit: { dailyCash: 1000 } },
  L: { name: '限定', color: '#ff9f6e', completeEffect: '限定系列不列入全收集', benefit: {} }
};

function title(id, achievement, name, condition, effect, benefit, hidden, limited) {
  return { id, category: id.charAt(0), achievement, name, condition, effect, benefit: benefit || {}, hidden: !!hidden, limited: !!limited };
}

const TITLES = [
  title('A01', '初次報到', '新手上路', '累積登入 1 天', '每日固定獲得 100', { dailyCash: 100 }),
  title('A02', '一週常駐', '星界居民', '累積登入 7 天', '每日固定獲得 200', { dailyCash: 200 }),
  title('A03', '月度常客', '老面孔', '累積登入 30 天', '每日固定獲得 300', { dailyCash: 300 }),
  title('A04', '百戰之身', '身經百戰', '累積完成 100 場遊戲', '每日固定獲得 500', { dailyCash: 500 }),
  title('A05', '任務達人', '使命必達', '累積完成 100 個每日任務', '每日任務金錢 +5%', { taskBonus: 0.05 }),

  title('B01', '六位數人生', '十萬戶', '歷史最高資產達到 100,000', '每日固定獲得 200', { dailyCash: 200 }),
  title('B02', '半百萬俱樂部', '資產新貴', '歷史最高資產達到 500,000', '商店 2% 折扣', { shopDiscount: 0.02 }),
  title('B03', '百萬富翁', '百萬富翁', '歷史最高資產達到 1,000,000', '每日固定獲得 500', { dailyCash: 500 }),
  title('B04', '星界財閥', '星界財閥', '歷史最高資產達到 5,000,000', '商店 3% 折扣', { shopDiscount: 0.03 }),
  title('B05', '深不見底', '金庫本身', '歷史最高資產達到 10,000,000', '每日固定獲得 1,000', { dailyCash: 1000 }),

  title('P01', '第一個底池', '牌桌新人', '德州撲克累積獲勝 1 次', '每日固定獲得 100', { dailyCash: 100 }),
  title('P02', '十勝', '小試身手', '德州撲克累積獲勝 10 次', '每日固定獲得 200', { dailyCash: 200 }),
  title('P03', '百勝', '底池掠奪者', '德州撲克累積獲勝 100 次', '每日固定獲得 500', { dailyCash: 500 }),
  title('P04', '全押成功', '梭哈之王', '德州撲克全押獲勝 1 次', '每日固定獲得 500', { dailyCash: 500 }),
  title('P05', '一手致富', '一手定江山', '德州撲克單手最大底池達到 100,000', '每日固定獲得 800', { dailyCash: 800 }),

  title('C01', '塗鴉入門', '街頭新人', '收藏 1 個塗鴉', '每日固定獲得 100', { dailyCash: 100 }),
  title('C02', '三件套', '街頭藝術家', '同時裝備 3 個塗鴉', '每日固定獲得 200', { dailyCash: 200 }),
  title('C03', '塗鴉半圖鑑', '塗鴉收藏家', '收藏 7 個塗鴉', '每日固定獲得 300', { dailyCash: 300 }),
  title('C04', '全塗鴉圖鑑', '塗鴉大師', '收藏全部 13 個塗鴉', '每日固定獲得 800', { dailyCash: 800 }),
  title('C05', '神話開箱', '神話見證者', '親手開啟神話寶箱', '每日固定獲得 400', { dailyCash: 400 }),
  title('C06', '傳奇開箱', '傳奇收藏家', '親手開啟傳奇寶箱', '每日固定獲得 900', { dailyCash: 900 }),
  title('C07', '管理員寶箱', '禁區訪客', '親手開啟管理員寶箱', '每日固定獲得 2,000', { dailyCash: 2000 }),

  title('H01', '午夜來客', '夜行者', '？？？', '？？？', { dailyCash: 200 }, true),
  title('H02', '天選牌型', '皇家裁決', '？？？', '？？？', { dailyCash: 800 }, true),
  title('H03', '百戰一日', '永不下桌', '？？？', '？？？', { dailyCash: 1000 }, true),

  title('L01', '封測先驅', '封測先驅', '在稱號系統開放前已建立帳號', '每日固定獲得 500', { dailyCash: 500 }, false, true),
  title('L02', '管理員', '管理員', '由系統辨識管理員身分', '每日固定獲得 1,500', { dailyCash: 1500 }, false, true),
  title('L03', '首季見證者', '首季見證者', '在稱號系統首個賽季登入', '每日固定獲得 300', { dailyCash: 300 }, false, true),
  title('L04', '榮譽玩家', '榮譽玩家', '由管理員頒發', '每日固定獲得 500', { dailyCash: 500 }, false, true),
  title('L05', '活動冠軍', '活動冠軍', '由管理員頒發', '每日固定獲得 1,000', { dailyCash: 1000 }, false, true),
  title('L06', '漏洞獵人', '漏洞獵人', '由管理員頒發', '商店 3% 折扣', { shopDiscount: 0.03 }, false, true)
];
const BY_ID = Object.fromEntries(TITLES.map((x) => [x.id, x]));
const MANUAL = ['L04', 'L05', 'L06'];

function dayOf(ms) {
  const d = new Date(ms + TW_OFFSET);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function hourOf(ms) { return new Date(ms + TW_OFFSET).getUTCHours(); }
function ownedTitles(p) {
  const list = ((p.unlocked || {}).titles || []).filter((id) => BY_ID[id]);
  return Array.from(new Set(list));
}
function pokerOf(p) { return ((p.games || {}).poker) || {}; }
function taskOf(p, bucket) { return ((p.tasks || {})[bucket]) || {}; }
function statOf(p, key) { return Number(((p.stats || {})[key]) || 0); }
function dexOf(p) { return Array.isArray((p.unlocked || {}).dex) ? p.unlocked.dex : []; }
function equippedDexOf(p) { return Array.isArray((p.equipped || {}).dex) ? p.equipped.dex : []; }

function automaticUnlocks(p, t) {
  const c = taskOf(p, 'career'), s = taskOf(p, 'special'), pk = pokerOf(p);
  const peak = Math.max(statOf(p, 'peakNet'), Number(pk.peakNet || 0));
  const maxChest = Number(((p.titleStats || {}).maxChestRarity) || 0);
  const tests = {
    A01: Number(c.loginDays || 0) >= 1,
    A02: Number(c.loginDays || 0) >= 7,
    A03: Number(c.loginDays || 0) >= 30,
    A04: Number(c.plays || 0) >= 100,
    A05: Number(c.dailyDone || 0) >= 100,
    B01: peak >= 100000, B02: peak >= 500000, B03: peak >= 1000000, B04: peak >= 5000000, B05: peak >= 10000000,
    P01: Number(pk.wins || 0) >= 1, P02: Number(pk.wins || 0) >= 10, P03: Number(pk.wins || 0) >= 100,
    P04: Number(pk.allInWins || 0) >= 1, P05: Number(pk.biggestPot || 0) >= 100000,
    C01: dexOf(p).length >= 1, C02: equippedDexOf(p).length >= 3, C03: dexOf(p).length >= 7, C04: dexOf(p).length >= 13,
    C05: maxChest >= 4, C06: maxChest >= 5, C07: maxChest >= 7,
    H01: t >= LAUNCH_AT && hourOf(t) < 4,
    H02: !!s.straightFlush, H03: !!s.pokerDay100,
    L01: Number(p.createdAt || 0) > 0 && Number(p.createdAt) < LAUNCH_AT,
    L02: p.role === 'admin',
    L03: t >= LAUNCH_AT && t < FIRST_SEASON_END
  };
  return Object.keys(tests).filter((id) => tests[id]);
}

function completedCategories(unlocked) {
  const set = new Set(unlocked || []), out = [];
  Object.keys(CATEGORY).forEach((cat) => {
    if (cat === 'L') return;
    const ids = TITLES.filter((x) => x.category === cat).map((x) => x.id);
    if (ids.length && ids.every((id) => set.has(id))) out.push(cat);
  });
  return out;
}

function addBenefits(base, add) {
  Object.keys(add || {}).forEach((k) => { base[k] = Number(base[k] || 0) + Number(add[k] || 0); });
  return base;
}

function benefitsOf(p, t) {
  const unlocked = ownedTitles(p);
  const daily = ((p.titleState || {}).daily) || {};
  const b = { dailyCash: 0, dailyStars: 0, taskBonus: 0, shopDiscount: 0, interestBonus: 0 };
  const at = Number.isFinite(t) ? t : Date.now();
  if (at < LAUNCH_AT) return b;
  if (daily.day === dayOf(at) && daily.activeId && unlocked.indexOf(daily.activeId) >= 0 && BY_ID[daily.activeId]) addBenefits(b, BY_ID[daily.activeId].benefit);
  completedCategories(unlocked).forEach((cat) => addBenefits(b, CATEGORY[cat].benefit));
  // 百分比類只做全系統安全上限；每次或每日可省下的金額沒有上限。
  b.shopDiscount = Math.min(0.30, b.shopDiscount);
  b.interestBonus = Math.min(0.50, b.interestBonus);
  return b;
}

const HIDDEN_REVEAL = {
  H01: { condition: '台灣時間 00:00～03:59 開啟稱號頁', effect: '每日固定獲得 200' },
  H02: { condition: '在德州完成一次同花順', effect: '每日固定獲得 800' },
  H03: { condition: '台灣時間同一天完成 100 場德州', effect: '每日固定獲得 1,000' }
};
function publicTitle(x, unlocked, admin) {
  const secret = x.hidden && !unlocked && !admin;
  return {
    id: x.id, category: x.category, achievement: x.achievement, name: x.name,
    condition: secret ? '？？？' : x.condition,
    effect: secret ? '？？？' : x.effect,
    condition: secret ? '？？？' : ((HIDDEN_REVEAL[x.id] || {}).condition || x.condition),
    effect: secret ? '？？？' : ((HIDDEN_REVEAL[x.id] || {}).effect || x.effect),
    hidden: x.hidden, limited: x.limited, unlocked: !!unlocked
  };
}

function ensureShapes(p) {
  p.unlocked = Object.assign({}, p.unlocked || {});
  if (!Array.isArray(p.unlocked.titles)) p.unlocked.titles = [];
  p.equipped = Object.assign({}, p.equipped || {});
  p.titleState = Object.assign({ showcase: [], daily: null }, p.titleState || {});
  if (!Array.isArray(p.titleState.showcase)) p.titleState.showcase = [];
}

function createTitles({ db, now, requireSession, requireAdmin }) {
  const playerRef = (pid) => db.collection('players').doc(pid);
  const accRef = (pid, t) => db.collection('seasons').doc(seasonId(t)).collection('accounts').doc(pid);

  async function sync(pid, isAdmin) {
    const t = now(), day = dayOf(t), launched = t >= LAUNCH_AT;
    return db.runTransaction(async (tx) => {
      const pRef = playerRef(pid), aRef = accRef(pid, t);
      const [pSnap, aSnap] = await Promise.all([tx.get(pRef), tx.get(aRef)]);
      if (!pSnap.exists) throw new AppError('找不到這個編號', 'not-found');
      const p = pSnap.data();
      ensureShapes(p);
      const unlocked = ownedTitles(p);
      automaticUnlocks(p, t).forEach((id) => { if (unlocked.indexOf(id) < 0) unlocked.push(id); });
      p.unlocked.titles = unlocked;

      if (!p.equipped.title && unlocked.length) p.equipped.title = unlocked[0];
      let daily = p.titleState.daily;
      if (launched && (!daily || daily.day !== day)) {
        daily = { day, activeId: unlocked.indexOf(p.equipped.title) >= 0 ? p.equipped.title : null, cashPaid: 0, starsPaid: 0 };
        p.titleState.daily = daily;
      }

      // 管理員可提前看介面，但正式開放前不鎖能力、不發獎。
      if (launched && daily && daily.day === day && !daily.paid) {
        const b = benefitsOf(p, t);
        if (b.dailyCash > 0 && aSnap.exists) {
          const acc = aSnap.data();
          acc.wallet = Number(acc.wallet || 0) + Math.floor(b.dailyCash);
          acc.net = Number(acc.net || 0) + Math.floor(b.dailyCash);
          acc.peakNet = Math.max(Number(acc.peakNet || 0), acc.net);
          tx.set(aRef, acc);
          tx.set(aRef.collection('ledger').doc(), { type: 'title-daily', amount: Math.floor(b.dailyCash), wallet: acc.wallet, bank: (acc.bank || {}).balance || 0, loans: acc.loans || 0, titleId: daily.activeId || null, at: t, by: 'system', note: '稱號每日效果' });
          daily.cashPaid = Math.floor(b.dailyCash);
        }
        if (b.dailyStars > 0) {
          p.stars = Number(p.stars || 0) + Math.floor(b.dailyStars);
          daily.starsPaid = Math.floor(b.dailyStars);
        }
        // 帳戶尚未建立時不標記，econAccount 完成後再次讀取就會補發。
        if (aSnap.exists || b.dailyCash <= 0) daily.paid = true;
      }

      p.titleState.daily = daily || null;
      tx.update(pRef, { unlocked: p.unlocked, equipped: p.equipped, titleState: p.titleState, stars: Number(p.stars || 0) });
      const owned = new Set(unlocked);
      return {
        now: t, launchAt: LAUNCH_AT, locked: !launched && !isAdmin, adminPreview: !launched && !!isAdmin,
        categories: CATEGORY,
        titles: TITLES.map((x) => publicTitle(x, owned.has(x.id), isAdmin)),
        equippedId: p.equipped.title || null,
        activeId: daily && daily.day === day ? daily.activeId : null,
        showcase: p.titleState.showcase.filter((id) => owned.has(id)).slice(0, 3),
        completedCategories: completedCategories(unlocked), benefits: benefitsOf(p, t),
        dailyReward: daily && daily.day === day ? { cash: daily.cashPaid || 0, stars: daily.starsPaid || 0 } : { cash: 0, stars: 0 }
      };
    });
  }

  return {
    async state(req) {
      const s = await requireSession(req);
      return sync(s.pid, s.player.role === 'admin');
    },

    async equip(req) {
      const s = await requireSession(req), id = String((req.data || {}).id || '');
      const t = now();
      if (t < LAUNCH_AT && s.player.role !== 'admin') throw new AppError('稱號系統將於下一賽季開啟', 'title-locked');
      if (id && !BY_ID[id]) throw new AppError('找不到這個稱號', 'bad-title', 'invalid-argument');
      await db.runTransaction(async (tx) => {
        const ref = playerRef(s.pid), snap = await tx.get(ref);
        if (!snap.exists) throw new AppError('找不到這個編號', 'not-found');
        const p = snap.data(); ensureShapes(p);
        if (id && ownedTitles(p).indexOf(id) < 0) throw new AppError('這個稱號還沒解鎖', 'title-not-owned');
        p.equipped.title = id || null;
        tx.update(ref, { equipped: p.equipped });
      });
      return sync(s.pid, s.player.role === 'admin');
    },

    async showcase(req) {
      const s = await requireSession(req), ids = Array.isArray((req.data || {}).ids) ? req.data.ids.map(String) : [];
      const t = now();
      if (t < LAUNCH_AT && s.player.role !== 'admin') throw new AppError('稱號系統將於下一賽季開啟', 'title-locked');
      if (ids.length > 3 || new Set(ids).size !== ids.length) throw new AppError('最多展示三個不同成就', 'bad-showcase', 'invalid-argument');
      await db.runTransaction(async (tx) => {
        const ref = playerRef(s.pid), snap = await tx.get(ref);
        if (!snap.exists) throw new AppError('找不到這個編號', 'not-found');
        const p = snap.data(); ensureShapes(p);
        const owned = ownedTitles(p);
        if (ids.some((id) => owned.indexOf(id) < 0)) throw new AppError('只能展示已解鎖的成就', 'title-not-owned');
        p.titleState.showcase = ids;
        tx.update(ref, { titleState: p.titleState });
      });
      return sync(s.pid, s.player.role === 'admin');
    },

    async adminGrant(req) {
      const a = await requireAdmin(req), d = req.data || {}, pid = cleanPid(d.pid), id = String(d.id || '');
      if (MANUAL.indexOf(id) < 0) throw new AppError('只能頒發人工限定稱號', 'bad-title', 'invalid-argument');
      const grant = d.grant !== false;
      await db.runTransaction(async (tx) => {
        const ref = playerRef(pid), snap = await tx.get(ref);
        if (!snap.exists) throw new AppError('找不到這個編號', 'not-found');
        const p = snap.data(); ensureShapes(p);
        let list = ownedTitles(p);
        if (grant && list.indexOf(id) < 0) list.push(id);
        if (!grant) list = list.filter((x) => x !== id);
        p.unlocked.titles = list;
        if (!grant && p.equipped.title === id) p.equipped.title = null;
        p.titleState.showcase = p.titleState.showcase.filter((x) => list.indexOf(x) >= 0);
        tx.update(ref, { unlocked: p.unlocked, equipped: p.equipped, titleState: p.titleState });
        tx.set(ref.collection('logs').doc(), { kind: grant ? 'title-grant' : 'title-revoke', titleId: id, by: a.pid, at: now() });
      });
      return { ok: true, pid, id, grant };
    }
  };
}

module.exports = {
  LAUNCH_AT, FIRST_SEASON_END, CATEGORY, TITLES, BY_ID, MANUAL,
  dayOf, automaticUnlocks, completedCategories, benefitsOf, createTitles
};
