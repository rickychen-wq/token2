'use strict';
/* core/catalog.js — 商店商品目錄
   ⚠️ 前端 index.html 裡的 CATALOG 是同一份資料的複本，改這裡時兩邊要一起改。
   art 是還沒放圖片前的預設樣式；之後放圖片就在 img 填路徑（例如 assets/avatars/wolf.webp）。 */

const CATALOG = [
  // 頭像
  { id: 'av_wolf',   type: 'avatar', name: '霜狼', price: 120, art: { c1: '#8FE3FF', c2: '#1A4A7E', glyph: '狼' } },
  { id: 'av_flame',  type: 'avatar', name: '赤焰', price: 120, art: { c1: '#FFB38A', c2: '#8A2330', glyph: '焰' } },
  { id: 'av_star',   type: 'avatar', name: '星塵', price: 150, art: { c1: '#E3D1FF', c2: '#3F2A7A', glyph: '星' } },
  { id: 'av_shadow', type: 'avatar', name: '暗影', price: 150, art: { c1: '#9AA7B8', c2: '#12161F', glyph: '影' } },
  { id: 'av_mecha',  type: 'avatar', name: '機甲', price: 200, art: { c1: '#B9FFD9', c2: '#135A45', glyph: '甲' } },
  { id: 'av_dragon', type: 'avatar', name: '龍瞳', price: 300, art: { c1: '#FFE7A3', c2: '#7A4A0C', glyph: '龍' } },
  // 頭像框
  { id: 'fr_cyan',     type: 'frame', name: '青光框',     price: 80,  art: { color: '#3FC7FF' } },
  { id: 'fr_gold',     type: 'frame', name: '黃金框',     price: 200, art: { color: '#FFD37A' } },
  { id: 'fr_volt',     type: 'frame', name: '紫電框',     price: 250, art: { color: '#B983FF', anim: true } },
  { id: 'fr_champion', type: 'frame', name: '冠軍框',     price: null, limited: true, desc: '拿下正式季冠軍自動獲得', art: { color: '#FFD37A', anim: true, crown: true } },
  { id: 'fr_launch',   type: 'frame', name: '開服紀念框', price: null, limited: true, desc: '主辦發放的限定框', art: { color: '#4BE38F', anim: true } },
  // 背景板
  { id: 'bg_aurora', type: 'bg', name: '極光',     price: 100, art: { g: 'linear-gradient(160deg,#0B3B4A 0%,#136F63 45%,#3A2A6E 100%)' } },
  { id: 'bg_neon',   type: 'bg', name: '霓虹賭城', price: 150, art: { g: 'linear-gradient(150deg,#2A0A3A 0%,#7A1450 50%,#0E2A5A 100%)' } },
  { id: 'bg_nebula', type: 'bg', name: '星雲',     price: 180, art: { g: 'radial-gradient(circle at 30% 30%,#5B3FA8 0%,#1B1340 45%,#060814 100%)' } },
  { id: 'bg_hall',   type: 'bg', name: '冠軍殿堂', price: null, limited: true, desc: '主辦發放的限定背景', art: { g: 'linear-gradient(160deg,#3A2A08 0%,#8A6A1C 50%,#2A1C04 100%)' } },
  // 表情包
  { id: 'em_taunt', type: 'emote', name: '嘲諷包', price: 120, list: ['就這？', '謝謝老闆', '你在怕', '穩了'] },
  { id: 'em_drama', type: 'emote', name: '戲劇包', price: 120, list: ['我的天', '心臟不好', '這也能跟？', '再來一把'] },
  // 消耗品
  { id: 'rename', type: 'consumable', name: '改名卡', price: 60, desc: '使用後可以改一次名字' }
];

const BASIC_EMOTES = ['👍', '😂', '😮', '😡', '🤡', '🔥', '🙏', '😭'];
const SLOT_KEY = { avatar: 'avatars', frame: 'frames', bg: 'bgs', emote: 'emotes' };
const byId = {};
CATALOG.forEach((x) => { byId[x.id] = x; });

module.exports = { CATALOG, BASIC_EMOTES, SLOT_KEY, byId };
