'use strict';
/* core/catalog.js — 商品目錄（預設值）
   管理員在後台改的名字、價格、上架等設定存在 config/catalog，會蓋過這裡的預設值。
   新增商品（新圖片）才需要改這個檔案。 */

const RARITY = ['', '稀有', '極稀有', '史詩', '傳奇', '神話', '神秘', '管理員'];

const FEMALE = ['翠影書記', '夜藍蝶結', '碧潮少女', '緋月魔女', '銀羽紫瞳', '櫻粉惡魔', '赤焰千金', '紫夜吟遊', '金輝學姊', '月光白雪'];
const MALE = ['白髮緋瞳', '赤髮狂狼', '藍夜寡言', '翡翠騎士', '紫魅學長', '金獅貴公子', '銀月劍士', '雙色惡魔', '黑夜低語', '碧影刺客'];
const MEME = ['就很爽', '嫌棄臉', '你很棒', '墨鏡大佬', '側眼瞄', '仰望天空', '已躺平', '金鍊奶茶哥', '奶茶大', '人生就是爽'];
const UR = ['深淵藍焰守護者', '銀翼機甲王牌', '太陽女帝', '月下紫晶女王', '赤焰鬼角'];
const DEX = ['缺角的聖杯', '看不懂的真跡', '成精的高麗菜', '奏樂令旗', '綠豆勇者', '藏寶圖殘卷', '見紅彎刀'];
const BACKS = ['白羽神性', '赤月終焉', '深海幻夢', '神之救贖', '狂亂終局', '虛無無限'];
const BGS = ['極光冰城', '聖環殘殿', '鎏金天庭', '月下神社', '深淵聖殿', '星環遺跡', '黑洞幻境', '紫晶王國', '血月魔環', '機甲遺城'];

/* 寶箱、鑰匙依稀有度 1~7，對應圖片檔 */
const CHEST_IMG = { 1: 'ch01', 2: 'ch02', 3: 'ch03', 4: 'ch05', 5: 'ch04', 6: 'ch06', 7: 'ch07' };
const KEY_IMG = { 1: 'k01', 2: 'k02', 3: 'k03', 4: 'k07', 5: 'k04', 6: 'k06', 7: 'k05' };
const CHEST_NAME = { 1: '秘境藍晶', 2: '月影紫晶', 3: '血月惡魔', 4: '霜晶王座', 5: '天界璀璨', 6: '星界深淵', 7: '熔岩龍焰' };
const KEY_NAME = { 1: '冰霜星輝', 2: '月影紫晶', 3: '血月煉獄', 4: '星穹王座', 5: '天界神聖', 6: '宇宙星辰', 7: '熔火龍王' };
const KEY_PRICE = { 1: 5, 2: 10, 3: 20, 4: 35, 5: 50, 6: null, 7: null };
/* 寶箱內容先放星幣，內容物下一版討論後在後台改 */
const CHEST_REWARD = { 1: [20, 40], 2: [40, 80], 3: [80, 150], 4: [150, 250], 5: [250, 400], 6: [400, 700], 7: [700, 1000] };

function pad(n) { return String(n).padStart(2, '0'); }

const DEFAULTS = [];
FEMALE.forEach((n, i) => DEFAULTS.push({ id: 'av_f' + pad(i + 1), type: 'avatar', sub: 'female', tier: 1, name: n, price: 120, onSale: true, img: 'assets/av/f' + pad(i + 1) + '.webp' }));
MALE.forEach((n, i) => DEFAULTS.push({ id: 'av_m' + pad(i + 1), type: 'avatar', sub: 'male', tier: 1, name: n, price: 120, onSale: true, img: 'assets/av/m' + pad(i + 1) + '.webp' }));
MEME.forEach((n, i) => DEFAULTS.push({ id: 'av_e' + pad(i + 1), type: 'avatar', sub: 'meme', tier: 1, name: n, price: 10, onSale: true, img: 'assets/av/e' + pad(i + 1) + '.webp' }));
UR.forEach((n, i) => DEFAULTS.push({ id: 'av_u' + pad(i + 1), type: 'avatar', sub: 'ur', tier: 2, name: n, price: 500, onSale: false, img: 'assets/av/u' + pad(i + 1) + '.webp' }));
DEFAULTS.push({ id: 'av_x01', type: 'avatar', sub: 'god', tier: 4, name: '終焉神域', price: null, onSale: false, img: 'assets/av/x01.webp' });
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
for (let r = 1; r <= 7; r++) {
  DEFAULTS.push({ id: 'key_' + r, type: 'key', rarity: r, name: RARITY[r] + '鑰匙・' + KEY_NAME[r], price: KEY_PRICE[r], onSale: KEY_PRICE[r] != null, img: 'assets/item/' + KEY_IMG[r] + '.webp' });
  DEFAULTS.push({ id: 'chest_' + r, type: 'chest', rarity: r, name: RARITY[r] + '寶箱・' + CHEST_NAME[r], price: null, onSale: false, img: 'assets/item/' + CHEST_IMG[r] + '.webp',
    rewards: [{ kind: 'stars', min: CHEST_REWARD[r][0], max: CHEST_REWARD[r][1], weight: 1 }] });
}

DEX.forEach((n, i) => DEFAULTS.push({ id: 'dex_' + pad(i + 1), type: 'dex', sub: 'doodle', name: n, price: null, onSale: false, img: 'assets/dex/d' + pad(i + 1) + '.png', desc: '塗鴉秘寶館收藏' }));

const BASIC_EMOTES = ['👍', '😂', '😮', '😡', '🤡', '🔥', '🙏', '😭'];
const SLOT_KEY = { avatar: 'avatars', frame: 'frames', bg: 'bgs', back: 'backs', emote: 'emotes', dex: 'dex' };
const STACKABLE = { card: 1, key: 1, chest: 1 };   // 可以累積數量的物品

/* 後台可以改的欄位 */
const EDITABLE = ['name', 'price', 'onSale', 'tier', 'desc', 'stock', 'perUser', 'startAt', 'endAt', 'salvage', 'rewards', 'sub'];

function merge(overrides) {
  const o = overrides || {};
  const out = {};
  DEFAULTS.forEach((d) => {
    const x = Object.assign({}, d);
    if (o[d.id]) EDITABLE.forEach((k) => { if (o[d.id][k] !== undefined) x[k] = o[d.id][k]; });
    out[x.id] = x;
  });
  return out;
}

async function loadCatalog(db, tx) {
  const ref = db.collection('config').doc('catalog');
  const snap = tx ? await tx.get(ref) : await ref.get();
  return { items: merge(snap.exists ? snap.data().items : null), sold: snap.exists ? (snap.data().sold || {}) : {}, raw: snap.exists ? snap.data() : null };
}

module.exports = { DEFAULTS, RARITY, BASIC_EMOTES, SLOT_KEY, STACKABLE, EDITABLE, merge, loadCatalog };
