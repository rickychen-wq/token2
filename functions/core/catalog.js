'use strict';
/* core/catalog.js — 商品目錄（預設值）
   管理員在後台改的名字、價格、上架等設定存在 config/catalog，會蓋過這裡的預設值。
   新增商品（新圖片）才需要改這個檔案。 */

/* v11：使用者確認的階級順序（傳奇高於神話）。索引就是 rarity 1~7。 */
const RARITY = ['', '稀有', '極稀有', '史詩', '神話', '傳奇', '神秘', '管理員'];

const FEMALE = ['翠影書記', '夜藍蝶結', '碧潮少女', '緋月魔女', '銀羽紫瞳', '櫻粉惡魔', '赤焰千金', '紫夜吟遊', '金輝學姊', '月光白雪'];
const MALE = ['白髮緋瞳', '赤髮狂狼', '藍夜寡言', '翡翠騎士', '紫魅學長', '金獅貴公子', '銀月劍士', '雙色惡魔', '黑夜低語', '碧影刺客'];
const MEME = ['就很爽', '嫌棄臉', '你很棒', '墨鏡大佬', '側眼瞄', '仰望天空', '已躺平', '金鍊奶茶哥', '奶茶大', '人生就是爽'];
const UR = ['深淵藍焰守護者', '銀翼機甲王牌', '太陽女帝', '月下紫晶女王', '赤焰鬼角'];
/* 測試服前三名限定頭像：不上架、不進寶箱，只能由管理員手動發放。 */
const TEST_RANK_AVATARS = [
  { id: 'av_test_1', name: '測試服第一名限定頭像', file: 'test01.webp' },
  { id: 'av_test_2', name: '測試服第二名限定頭像', file: 'test02.webp' },
  { id: 'av_test_3', name: '測試服第三名限定頭像', file: 'test03.webp' }
];
const DEX = ['缺角的聖杯', '看不懂的真跡', '成精的高麗菜', '奏樂令旗', '綠豆勇者', '藏寶圖殘卷', '見紅彎刀',
  '藍焰爪刀', '不會謝的玫瑰', '班草的求愛花束', '班花的情書', '紅線纏柄刀', '阿嬤的剁刀'];
const DEX_RARE_IDS = ['dex_06', 'dex_11', 'dex_13'];
const DEX_MAX_EQUIPPED = 3;
const DEX_COMPLETE_BONUS = 0.075;
const BACKS = ['雙鯉墨潮', '赤月折狐', '青花雲鶴', '琉璃月蛾', '黑貓紅線', '黑水夜薔'];
const LEGACY_BACKS = ['白羽神性', '赤月終焉', '深海幻夢', '神之救贖', '狂亂終局', '虛無無限'];
const BGS = ['極光冰城', '聖環殘殿', '鎏金天庭', '月下神社', '深淵聖殿', '星環遺跡', '黑洞幻境', '紫晶王國', '血月魔環', '機甲遺城'];

/* 寶箱、鑰匙依稀有度 1~7，對應圖片檔（v11 使用者逐張確認過的對應）
   稀有 k01/ch01、極稀有 k07/ch05、史詩 k02/ch02、神話 k03/ch03、傳奇 k04/ch04、神秘 k05/ch07、管理員 k06/ch06
   名稱跟著圖片走，所以順序也一起換過來。 */
const CHEST_IMG = { 1: 'ch01', 2: 'ch05', 3: 'ch02', 4: 'ch03', 5: 'ch04', 6: 'ch07', 7: 'ch06' };
const KEY_IMG = { 1: 'k01', 2: 'k07', 3: 'k02', 4: 'k03', 5: 'k04', 6: 'k05', 7: 'k06' };
const CHEST_NAME = { 1: '秘境藍晶', 2: '霜晶王座', 3: '月影紫晶', 4: '血月惡魔', 5: '天界璀璨', 6: '熔岩龍焰', 7: '星界深淵' };
const KEY_NAME = { 1: '冰霜星輝', 2: '星穹王座', 3: '月影紫晶', 4: '血月煉獄', 5: '天界神聖', 6: '熔火龍王', 7: '宇宙星辰' };
const KEY_PRICE = { 1: 5, 2: 10, 3: 20, 4: 35, 5: 50, 6: 75, 7: null };
/* 寶箱不販售，只能從排行獎勵和每週結算拿到；商店只賣鑰匙 */
const CHEST_PRICE = { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null };

/* ---------- 六個新道具（名稱與檔名依使用者規格，不可改） ---------- */
const ITEMS = [
  { id: 'bankruptcy_protection', name: '破產防護卷', sub: 'revive', file: 'revive.webp', tier: 3,
    desc: '總資產低於 1000 時使用，錢包直接回到 5000。持有期間不能跟銀行借款。' },
  { id: 'forced_duel', name: '強制幹錢券', sub: 'duel', file: 'duel.webp', tier: 5,
    desc: '對同桌玩家發動抽卡對決，雙方各抽一張比大小，贏的拿 1000、輸的拿 200。' },
  { id: 'forced_action', name: '強制下注卷', sub: 'forcebet', file: 'forcebet.webp', tier: 2,
    desc: '指定同桌玩家下一回合必須跟到你的下注額（上限 500），錢不夠就 all-in。' },
  { id: 'premium_dry_shampoo', name: '頂級的乾洗髮', sub: 'shampoo', file: 'shampoo.webp', tier: 2,
    desc: '選一個還沒永久擁有的普通頭像，暫時解鎖 24 小時，到期自動換回原本的頭像。' },
  { id: 'iron_bowl', name: '保硬的鐵碗公', sub: 'guard', file: 'guard.webp', tier: 4,
    desc: '被干擾型道具指定時可以選擇擋下來，一次消耗一個。' },
  { id: 'broken_bowl', name: '破損的陶碗', sub: 'shard', file: 'shard.webp', tier: 1,
    desc: '合成碎片，湊滿 2 個會自動合成 1 個保硬的鐵碗公。' }
];

/* ---------- 寶箱內容（v11）----------
   一次全部開出：星幣 + 下面每一項各自擲一次。
   p 是出現機率（沒寫 = 100% 一定給），min/max 是命中後的數量範圍。
   avatar / ur / bg / dex 是額外的獨立加抽，不佔道具格。
   全部都可以在後台改。 */
const CHEST_LOOT = {
  1: { stars: [3, 5],     items: [['forced_duel', 1, 1, 0.2], ['forced_action', 1, 2], ['premium_dry_shampoo', 1, 1], ['iron_bowl', 1, 1, 0.2], ['broken_bowl', 1, 3]], avatar: 0, ur: 0, bg: 0, dex: 0 },
  2: { stars: [5, 7],     items: [['forced_duel', 1, 1, 0.5], ['forced_action', 3, 3], ['premium_dry_shampoo', 2, 2], ['iron_bowl', 1, 1, 0.5], ['broken_bowl', 3, 6]], avatar: 0.02, ur: 0, bg: 0.005, dex: 0 },
  3: { stars: [7, 10],    items: [['bankruptcy_protection', 0, 1], ['forced_duel', 1, 2], ['forced_action', 3, 3], ['premium_dry_shampoo', 2, 2], ['iron_bowl', 2, 2], ['broken_bowl', 3, 6]], avatar: 0.03, ur: 0, bg: 0.01, dex: 0.2 },
  4: { stars: [10, 20],   items: [['bankruptcy_protection', 1, 2], ['forced_duel', 3, 3], ['forced_action', 3, 3], ['premium_dry_shampoo', 3, 3], ['iron_bowl', 3, 3], ['broken_bowl', 3, 6]], avatar: 0.1, ur: 0, bg: 0.035, dex: 0.35 },
  5: { stars: [20, 25],   items: [['bankruptcy_protection', 1, 3], ['forced_duel', 5, 5], ['forced_action', 3, 3], ['premium_dry_shampoo', 3, 3], ['iron_bowl', 3, 3], ['broken_bowl', 3, 6]], avatar: 0.2, ur: 0.05, bg: 0.075, dex: 0.6 },
  6: { stars: [25, 50],   items: [['bankruptcy_protection', 5, 5], ['forced_duel', 5, 5], ['forced_action', 3, 3], ['premium_dry_shampoo', 3, 3], ['iron_bowl', 3, 3], ['broken_bowl', 3, 6]], avatar: 0.3, ur: 0.1, bg: 0.1, dex: 0.75 },
  7: { stars: [150, 150], items: [['bankruptcy_protection', 20, 20], ['forced_duel', 10, 10], ['forced_action', 10, 10], ['premium_dry_shampoo', 10, 10], ['iron_bowl', 10, 10], ['broken_bowl', 50, 50]], avatar: 1, ur: 1, bg: 1, dex: 1 }
};
const DEX_FULL_STARS = 30;   // 圖鑑已經收集完時，dex 那一抽改發的星幣

function lootOf(r) {
  const L = CHEST_LOOT[r];
  return {
    stars: { min: L.stars[0], max: L.stars[1] },
    items: L.items.map((x) => ({ itemId: x[0], min: x[1], max: x[2], p: x[3] === undefined ? 1 : x[3] })),
    avatar: L.avatar, ur: L.ur, bg: L.bg, dex: L.dex, dexFullStars: DEX_FULL_STARS
  };
}

function pad(n) { return String(n).padStart(2, '0'); }

const DEFAULTS = [];
FEMALE.forEach((n, i) => DEFAULTS.push({ id: 'av_f' + pad(i + 1), type: 'avatar', sub: 'female', tier: 1, name: n, price: 120, onSale: true, img: 'assets/av/f' + pad(i + 1) + '.webp' }));
MALE.forEach((n, i) => DEFAULTS.push({ id: 'av_m' + pad(i + 1), type: 'avatar', sub: 'male', tier: 1, name: n, price: 120, onSale: true, img: 'assets/av/m' + pad(i + 1) + '.webp' }));
MEME.forEach((n, i) => DEFAULTS.push({ id: 'av_e' + pad(i + 1), type: 'avatar', sub: 'meme', tier: 1, name: n, price: 10, onSale: true, img: 'assets/av/e' + pad(i + 1) + '.webp' }));
UR.forEach((n, i) => DEFAULTS.push({ id: 'av_u' + pad(i + 1), type: 'avatar', sub: 'ur', tier: 2, name: n, price: 500, onSale: false, img: 'assets/av/u' + pad(i + 1) + '.webp' }));
DEFAULTS.push({ id: 'av_x01', type: 'avatar', sub: 'god', tier: 4, name: '終焉神域', price: null, onSale: false, img: 'assets/av/x01.webp' });
TEST_RANK_AVATARS.forEach((x) => DEFAULTS.push({
  id: x.id, type: 'avatar', sub: 'test_rank', tier: 1, name: x.name,
  price: null, onSale: false, img: 'assets/av/' + x.file,
  desc: '測試服排行限定，只能由管理員手動發放。'
}));
BGS.forEach((n, i) => DEFAULTS.push({ id: 'bg_' + pad(i + 1), type: 'bg', tier: 1, name: n, price: 450, onSale: true, img: 'assets/bg/g' + pad(i + 1) + '.webp' }));
BACKS.forEach((n, i) => DEFAULTS.push({ id: 'bk_' + pad(i + 1), type: 'back', tier: 3, name: n, price: null, onSale: false, img: 'assets/back/b' + pad(i + 1) + '.webp' }));
DEFAULTS.push(
  { id: 'em_taunt', type: 'emote', name: '嘲諷包', price: 30, onSale: true, list: ['就這？', '謝謝老闆', '你在怕', '穩了'] },
  { id: 'em_drama', type: 'emote', name: '戲劇包', price: 30, onSale: true, list: ['我的天', '心臟不好', '這也能跟？', '再來一把'] },
  { id: 'card_rename', type: 'card', sub: 'rename', name: '星輝改名卡', price: 30, onSale: true, img: 'assets/item/c01.webp', desc: '改一次名字' },
  { id: 'card_seat', type: 'card', sub: 'seat', name: '星界換座位卡', price: 10, onSale: true, img: 'assets/item/c02.webp', desc: '兩手之間跟桌上任何人換位子，對方有卡的話會被擋下' },
  { id: 'card_vanity', type: 'card', sub: 'vanity', name: '全新身份卡', price: 100, onSale: true, img: 'assets/item/c05.webp', desc: '設定 1 到 7 位數的靚號，顯示在牌桌、排行榜和個人頁' },
  { id: 'card_wild', type: 'card', sub: 'wild', name: '萬象隨心', price: null, onSale: false, img: 'assets/item/c04.webp', desc: '功能尚未開放' }
);
/* 隱藏個人領域：不上架、不進圖鑑或寶箱；所有玩家衣櫃固定顯示欄位，物品由管理員發放。 */
DEFAULTS.push({
  id: 'fx_astral_dragon', type: 'effect', sub: 'profile', tier: 5, name: '星界龍皇・領域降臨',
  price: null, onSale: false, hidden: true, img: 'assets/fx/astral-guardian-dragon.webp',
  desc: '點開個人資料時，召喚星界龍皇並展開領域。'
});
for (let r = 1; r <= 7; r++) {
  DEFAULTS.push({ id: 'key_' + r, type: 'key', rarity: r, name: RARITY[r] + '鑰匙・' + KEY_NAME[r], price: KEY_PRICE[r], onSale: KEY_PRICE[r] != null, img: 'assets/item/' + KEY_IMG[r] + '.webp' });
  DEFAULTS.push({ id: 'chest_' + r, type: 'chest', rarity: r, name: RARITY[r] + '寶箱・' + CHEST_NAME[r], price: CHEST_PRICE[r], onSale: CHEST_PRICE[r] != null, img: 'assets/item/' + CHEST_IMG[r] + '.webp', loot: lootOf(r) });
}
ITEMS.forEach((it) => DEFAULTS.push({ id: it.id, type: 'card', sub: it.sub, tier: it.tier, name: it.name, price: null, onSale: false, img: 'assets/item/' + it.file, desc: it.desc }));

DEX.forEach((n, i) => {
  const id = 'dex_' + pad(i + 1);
  const rare = DEX_RARE_IDS.indexOf(id) >= 0;
  DEFAULTS.push({
    id, type: 'dex', sub: 'doodle', name: n, price: null, onSale: false,
    img: 'assets/dex/d' + pad(i + 1) + '.png', bankBonus: rare ? 0.01 : 0.005,
    doodleTier: rare ? 'rare' : 'normal',
    desc: (rare ? '稀有塗鴉・' : '') + '塗鴉秘寶館收藏'
  });
});

const BASIC_EMOTES = ['👍', '😂', '😮', '😡', '🤡', '🔥', '🙏', '😭'];
const SLOT_KEY = { avatar: 'avatars', frame: 'frames', bg: 'bgs', back: 'backs', emote: 'emotes', dex: 'dex', effect: 'effects' };
const STACKABLE = { card: 1, key: 1, chest: 1 };   // 可以累積數量的物品

/* 後台可以改的欄位 */
const EDITABLE = ['name', 'price', 'onSale', 'tier', 'desc', 'stock', 'perUser', 'startAt', 'endAt', 'salvage', 'rewards', 'loot', 'sub'];

const LEGACY_REVIVE_LOOT = { 1: [1, 1], 2: [1, 2], 3: [3, 3], 4: [5, 5], 5: [5, 5], 6: [5, 5], 7: [10, 10] };
const TARGET_REVIVE_LOOT = { 1: null, 2: null, 3: [0, 1], 4: [1, 2], 5: [1, 3], 6: [5, 5], 7: [20, 20] };

/* 舊版後台若存著原始寶箱內容，只遷移破產防護卷的舊預設；管理員另行調過的數值不覆蓋。 */
function migrateReviveLoot(x) {
  if (!x || x.type !== 'chest' || !x.loot || !Array.isArray(x.loot.items)) return;
  const legacy = LEGACY_REVIVE_LOOT[x.rarity], target = TARGET_REVIVE_LOOT[x.rarity];
  if (!legacy) return;
  const items = x.loot.items.map((e) => Object.assign({}, e));
  const at = items.findIndex((e) => e.itemId === 'bankruptcy_protection');
  if (at < 0) return;
  const e = items[at], oldDefault = Number(e.min) === legacy[0] && Number(e.max) === legacy[1] && (e.p === undefined || Number(e.p) >= 1);
  if (!oldDefault) return;
  if (target) items[at] = Object.assign({}, e, { min: target[0], max: target[1] });
  else items.splice(at, 1);
  x.loot = Object.assign({}, x.loot, { items });
}
function merge(overrides) {
  const o = overrides || {};
  const out = {};
  DEFAULTS.forEach((d) => {
    const x = Object.assign({}, d);
    if (o[d.id]) EDITABLE.forEach((k) => { if (o[d.id][k] !== undefined) x[k] = o[d.id][k]; });
    // 舊版名稱若曾被寫進 config/catalog，隨新版圖片一起遷移；之後手動改的新名稱仍會保留。
    if (x.type === 'back' && LEGACY_BACKS.indexOf(x.name) >= 0) x.name = d.name;
    migrateReviveLoot(x);
    out[x.id] = x;
  });
  return out;
}

async function loadCatalog(db, tx) {
  const ref = db.collection('config').doc('catalog');
  const snap = tx ? await tx.get(ref) : await ref.get();
  return { items: merge(snap.exists ? snap.data().items : null), sold: snap.exists ? (snap.data().sold || {}) : {}, raw: snap.exists ? snap.data() : null };
}

/* 塗鴉利率只信任玩家確實擁有、且仍存在目錄裡的前三個不重複裝備。 */
function dexInterest(p, items) {
  p = p || {};
  items = items || merge(null);
  const owned = Array.isArray((p.unlocked || {}).dex) ? p.unlocked.dex : [];
  const ownedSet = new Set(owned);
  const raw = Array.isArray((p.equipped || {}).dex) ? p.equipped.dex : [];
  const equipped = [];
  raw.forEach((id) => {
    const item = items[id];
    if (equipped.length < DEX_MAX_EQUIPPED && equipped.indexOf(id) < 0 && ownedSet.has(id) && item && item.type === 'dex') equipped.push(id);
  });
  const equipmentBonus = equipped.reduce((sum, id) => sum + Math.max(0, Number(items[id].bankBonus) || 0), 0);
  const allDex = Object.keys(items).filter((id) => items[id] && items[id].type === 'dex');
  const complete = allDex.length > 0 && allDex.every((id) => ownedSet.has(id));
  const collectionBonus = complete ? DEX_COMPLETE_BONUS : 0;
  return { equipped, equipmentBonus, collectionBonus, complete, total: equipmentBonus + collectionBonus };
}

module.exports = {
  DEFAULTS, RARITY, BASIC_EMOTES, SLOT_KEY, STACKABLE, EDITABLE, ITEMS, TEST_RANK_AVATARS, CHEST_LOOT,
  DEX_FULL_STARS, DEX_RARE_IDS, DEX_MAX_EQUIPPED, DEX_COMPLETE_BONUS, dexInterest, merge, loadCatalog
};
