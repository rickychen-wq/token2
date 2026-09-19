'use strict';
/* core/tasks.js — v12 任務系統

   39 個任務：每日 5、每週 10、生涯 24。
   全部的進度都存在玩家永久文件的 p.tasks，分三桶：
     daily  — 換日歸零（台灣時間 00:00）
     weekly — 換季歸零（賽季就是一週，週一 00:00）
     career — 永遠累積

   場數這種「本日／本週」的數字直接沿用季帳戶已經有的 daily.plays 和 plays，
   不另外再記一份，避免兩邊對不起來。

   獎勵是手動領取：完成只是解鎖「領取」按鈕，按了才進帳。
   這樣玩家看得到錢從哪來，也不會被一堆自動入帳洗版。 */

const { AppError, seasonId } = require('./util');
const E = require('./econ');

/* 任務從哪一週開始算。9/21 是 2026-W39，在那之前是測試期，
   不計進度也不能領獎，避免大家在測試週先把生涯任務刷滿。
   後台可以用 config/app.tasksFrom 改。 */
const DEFAULT_FROM = '2026-W39';
function tasksFrom(rawCfg) {
  const v = (rawCfg || {}).tasksFrom;
  return /^\d{4}-W\d{2}$/.test(String(v || '')) ? String(v) : DEFAULT_FROM;
}
function active(rawCfg, t) {
  return seasonId(t) >= tasksFrom(rawCfg);
}

/* ---------- 任務表 ---------- */
/* need 是門檻；key 是進度要看哪個數字（在 progress() 裡算）。
   money / stars 是獎勵。 */
const DAILY = [
  { id: 'd_login', name: '今日報到', desc: '當天登入一次', key: 'login', need: 1, money: 50, stars: 0 },
  { id: 'd_play1', name: '先來一場', desc: '完成 1 場平台活動', key: 'plays', need: 1, money: 100, stars: 0 },
  { id: 'd_play10', name: '漸入佳境', desc: '當天完成 10 場平台活動', key: 'plays', need: 10, money: 150, stars: 1 },
  { id: 'd_emote', name: '有話要說', desc: '使用 1 次表情', key: 'emotes', need: 1, money: 50, stars: 0 },
  { id: 'd_all', name: '今日全清', desc: '完成前面 4 個每日任務', key: 'dailyDone4', need: 4, money: 300, stars: 2 }
];

const WEEKLY = [
  { id: 'w_login3', name: '本週常客', desc: '本週登入 3 天', key: 'loginDays', need: 3, money: 300, stars: 1 },
  { id: 'w_login5', name: '五日簽到', desc: '本週登入 5 天', key: 'loginDays', need: 5, money: 450, stars: 1 },
  { id: 'w_login7', name: '全勤玩家', desc: '本週登入 7 天', key: 'loginDays', need: 7, money: 0, stars: 2 },
  { id: 'w_play25', name: '小試身手', desc: '本週完成 25 場平台活動', key: 'plays', need: 25, money: 500, stars: 0 },
  { id: 'w_play50', name: '活動達人', desc: '本週完成 50 場平台活動', key: 'plays', need: 50, money: 1000, stars: 0 },
  { id: 'w_daily10', name: '任務起步', desc: '本週完成 10 個每日任務', key: 'dailyDone', need: 10, money: 450, stars: 1 },
  { id: 'w_daily20', name: '任務狂人', desc: '本週完成 20 個每日任務', key: 'dailyDone', need: 20, money: 550, stars: 2 },
  { id: 'w_emote3', name: '班級氣氛組', desc: '本週在不同 3 天使用表情', key: 'emoteDays', need: 3, money: 300, stars: 1 },
  { id: 'w_skin', name: '今天換風格', desc: '更換或裝備任意外觀 1 次', key: 'skin', need: 1, money: 1000, stars: 0 },
  { id: 'w_all', name: '本週全能王', desc: '完成前面 9 項中的任意 8 項', key: 'weekDone9', need: 8, money: 1500, stars: 5 }
];

const CAREER = [
  { id: 'c_login1', name: '初來乍到', desc: '第一次登入平台', key: 'loginDays', need: 1, money: 500, stars: 1 },
  { id: 'c_login7', name: '熟面孔', desc: '累積登入 7 天', key: 'loginDays', need: 7, money: 1200, stars: 3 },
  { id: 'c_login30', name: '班級常駐', desc: '累積登入 30 天', key: 'loginDays', need: 30, money: 2500, stars: 5 },
  { id: 'c_login100', name: '元老玩家', desc: '累積登入 100 天', key: 'loginDays', need: 100, money: 5000, stars: 20 },

  { id: 'c_daily1', name: '第一份工作', desc: '完成 1 個每日任務', key: 'dailyDone', need: 1, money: 500, stars: 0 },
  { id: 'c_daily10', name: '任務新手', desc: '累積完成 10 個每日任務', key: 'dailyDone', need: 10, money: 500, stars: 1 },
  { id: 'c_daily120', name: '任務熟手', desc: '累積完成 120 個每日任務', key: 'dailyDone', need: 120, money: 1500, stars: 3 },
  { id: 'c_daily200', name: '任務大師', desc: '累積完成 200 個每日任務', key: 'dailyDone', need: 200, money: 2000, stars: 8 },
  { id: 'c_daily500', name: '永動機', desc: '累積完成 500 個每日任務', key: 'dailyDone', need: 500, money: 3000, stars: 15 },

  { id: 'c_week1', name: '第一週目標', desc: '完成 1 個每週任務', key: 'weeklyDone', need: 1, money: 100, stars: 1 },
  { id: 'c_week10', name: '穩定發揮', desc: '累積完成 10 個每週任務', key: 'weeklyDone', need: 10, money: 500, stars: 3 },
  { id: 'c_week25', name: '長期規劃', desc: '累積完成 25 個每週任務', key: 'weeklyDone', need: 25, money: 1200, stars: 8 },
  { id: 'c_week50', name: '週任務專家', desc: '累積完成 50 個每週任務', key: 'weeklyDone', need: 50, money: 2500, stars: 15 },

  { id: 'c_play10', name: '第一次參加', desc: '完成 10 場平台活動', key: 'plays', need: 10, money: 1000, stars: 0 },
  { id: 'c_play100', name: '暖身完成', desc: '累積完成 100 場平台活動', key: 'plays', need: 100, money: 2500, stars: 10 },
  { id: 'c_play300', name: '身經百戰', desc: '累積完成 300 場平台活動', key: 'plays', need: 300, money: 5000, stars: 25 },
  { id: 'c_play700', name: '活動傳說', desc: '累積完成 700 場平台活動', key: 'plays', need: 700, money: 10000, stars: 75 },

  { id: 'c_avatar', name: '第一個造型', desc: '第一次裝備頭像', key: 'firstAvatar', need: 1, money: 1000, stars: 10 },
  { id: 'c_bg', name: '背景也重要', desc: '第一次裝備背景板', key: 'firstBg', need: 1, money: 2000, stars: 20 },
  { id: 'c_skin5', name: '小小收藏家', desc: '永久擁有 5 個外觀', key: 'skins', need: 5, money: 5000, stars: 35 },

  { id: 'c_item', name: '第一道具', desc: '第一次取得任意道具', key: 'firstItem', need: 1, money: 1000, stars: 3 },
  { id: 'c_fuse', name: '動手合成', desc: '第一次成功合成道具', key: 'firstFuse', need: 1, money: 1000, stars: 3 },
  { id: 'c_emote10', name: '氣氛製造機', desc: '在不同 10 天使用過表情', key: 'emoteDays', need: 10, money: 1000, stars: 5 },
  { id: 'c_perfect30', name: '每日模範生', desc: '累積 30 天完成全部每日任務', key: 'perfectDays', need: 30, money: 7500, stars: 15 }
];

const ALL = { daily: DAILY, weekly: WEEKLY, career: CAREER };
const BY_ID = {};
Object.keys(ALL).forEach((cat) => ALL[cat].forEach((x) => { BY_ID[x.id] = Object.assign({ cat }, x); }));

/* ---------- 進度容器 ---------- */
function blankDaily(day) {
  return { day, emotes: 0, claimed: {} };
}
function blankWeek(week) {
  return { week, loginDays: [], emoteDays: [], dailyDone: 0, skin: false, claimed: {} };
}
function blankCareer() {
  return {
    loginDays: 0, lastLogin: '', dailyDone: 0, weeklyDone: 0, plays: 0,
    emoteDays: 0, lastEmote: '', perfectDays: 0, lastPerfect: '',
    firstAvatar: 0, firstBg: 0, firstItem: 0, firstFuse: 0, claimed: {}
  };
}

/* 換日／換季就把對應的桶歸零。任何一次讀寫玩家資料時都會先跑這個。 */
function roll(p, t) {
  const day = E.twDay(t), week = seasonId(t);
  const tk = p.tasks && typeof p.tasks === 'object' ? p.tasks : {};
  if (!tk.daily || tk.daily.day !== day) tk.daily = blankDaily(day);
  if (!tk.week || tk.week.week !== week) tk.week = blankWeek(week);
  if (!tk.career) tk.career = blankCareer();
  else tk.career = Object.assign(blankCareer(), tk.career);
  p.tasks = tk;
  return tk;
}

/* ---------- 記錄事件 ----------
   what: login | emote | skin | firstAvatar | firstBg | firstItem | firstFuse | play
   回傳有沒有真的改到東西，沒改到就不用寫回資料庫。 */
function bump(p, t, what, n, rawCfg) {
  if (rawCfg !== undefined && !active(rawCfg, t)) return false;   // 測試週不計進度
  const tk = roll(p, t), day = E.twDay(t);
  const c = tk.career;
  let changed = false;
  if (what === 'login') {
    if (tk.week.loginDays.indexOf(day) < 0) { tk.week.loginDays = tk.week.loginDays.concat([day]); changed = true; }
    if (c.lastLogin !== day) { c.lastLogin = day; c.loginDays += 1; changed = true; }
  } else if (what === 'emote') {
    tk.daily.emotes += (n || 1);
    if (tk.week.emoteDays.indexOf(day) < 0) tk.week.emoteDays = tk.week.emoteDays.concat([day]);
    if (c.lastEmote !== day) { c.lastEmote = day; c.emoteDays += 1; }
    changed = true;
  } else if (what === 'skin') {
    if (!tk.week.skin) { tk.week.skin = true; changed = true; }
  } else if (what === 'play') {
    c.plays += (n || 1);
    changed = true;
  } else if (['firstAvatar', 'firstBg', 'firstItem', 'firstFuse'].indexOf(what) >= 0) {
    if (!c[what]) { c[what] = t; changed = true; }
  }
  return changed;
}

/* ---------- 進度計算 ---------- */
function skinCount(p) {
  const u = p.unlocked || {};
  return ((u.avatars || []).length) + ((u.bgs || []).length) + ((u.backs || []).length);
}

/* 每日前 4 項完成幾項（給「今日全清」用；看的是完成，不是領取） */
function dailyDone4(p, acc, t, tk) {
  let n = 0;
  DAILY.slice(0, 4).forEach((x) => { if (rawHave(BY_ID[x.id], p, acc, tk) >= x.need) n += 1; });
  return n;
}
/* 每週前 9 項完成幾項（給「本週全能王」用） */
function weekDone9(p, acc, t, tk) {
  let n = 0;
  WEEKLY.slice(0, 9).forEach((x) => { if (rawHave(BY_ID[x.id], p, acc, tk) >= x.need) n += 1; });
  return n;
}

/* 單一任務目前的進度數字 */
function rawHave(task, p, acc, tk) {
  const d = acc && acc.daily ? acc.daily : {};
  switch (task.cat + '.' + task.key) {
    case 'daily.login': return tk.week.loginDays.indexOf(tk.daily.day) >= 0 ? 1 : 0;
    case 'daily.plays': return d.plays || 0;
    case 'daily.emotes': return tk.daily.emotes || 0;
    case 'daily.dailyDone4': return dailyDone4(p, acc, 0, tk);

    case 'weekly.loginDays': return tk.week.loginDays.length;
    case 'weekly.plays': return (acc && acc.plays) || 0;
    case 'weekly.dailyDone': return tk.week.dailyDone;
    case 'weekly.emoteDays': return tk.week.emoteDays.length;
    case 'weekly.skin': return tk.week.skin ? 1 : 0;
    case 'weekly.weekDone9': return weekDone9(p, acc, 0, tk);

    case 'career.loginDays': return tk.career.loginDays;
    case 'career.dailyDone': return tk.career.dailyDone;
    case 'career.weeklyDone': return tk.career.weeklyDone;
    case 'career.plays': return tk.career.plays;
    case 'career.emoteDays': return tk.career.emoteDays;
    case 'career.perfectDays': return tk.career.perfectDays;
    case 'career.skins': return skinCount(p);
    case 'career.firstAvatar': return tk.career.firstAvatar ? 1 : 0;
    case 'career.firstBg': return tk.career.firstBg ? 1 : 0;
    case 'career.firstItem': return tk.career.firstItem ? 1 : 0;
    case 'career.firstFuse': return tk.career.firstFuse ? 1 : 0;
    default: return 0;
  }
}

function claimedMap(tk, cat) {
  if (cat === 'daily') return tk.daily.claimed || {};
  if (cat === 'weekly') return tk.week.claimed || {};
  return tk.career.claimed || {};
}

/* 回傳整份任務列表（含進度、能不能領、領過沒） */
function progress(p, acc, t, rawCfg) {
  const tk = roll(p, t);
  const out = { active: active(rawCfg, t), startsFrom: tasksFrom(rawCfg) };
  Object.keys(ALL).forEach((cat) => {
    const cl = claimedMap(tk, cat);
    out[cat] = ALL[cat].map((x) => {
      const task = Object.assign({ cat }, x);
      const have = Math.min(rawHave(task, p, acc, tk), x.need);
      const claimed = !!cl[x.id];
      return {
        id: x.id, name: x.name, desc: x.desc, need: x.need, have,
        done: have >= x.need, claimed, money: x.money, stars: x.stars
      };
    });
  });
  out.summary = {
    daily: out.daily.filter((x) => x.done && !x.claimed).length,
    weekly: out.weekly.filter((x) => x.done && !x.claimed).length,
    career: out.career.filter((x) => x.done && !x.claimed).length
  };
  out.summary.total = out.summary.daily + out.summary.weekly + out.summary.career;
  return out;
}

/* ---------- 領獎 ----------
   改 p（背包／星幣／任務狀態）和 acc（遊戲幣），回傳流水帳陣列。 */
function claim(p, acc, t, id, rawCfg) {
  const task = BY_ID[id];
  if (!task) throw new AppError('沒有這個任務', 'no-task', 'invalid-argument');
  if (!active(rawCfg, t)) throw new AppError('任務系統從 ' + tasksFrom(rawCfg) + ' 那一週才開始', 'not-open');
  const tk = roll(p, t);
  const cl = claimedMap(tk, task.cat);
  if (cl[id]) throw new AppError('這個任務已經領過了', 'claimed');
  const have = rawHave(task, p, acc, tk);
  if (have < task.need) throw new AppError('還沒完成：' + have + ' / ' + task.need, 'not-done');

  cl[id] = t;
  if (task.cat === 'daily') {
    tk.daily.claimed = cl;
    tk.week.dailyDone += 1;
    tk.career.dailyDone += 1;
    // 今日全清領完就記一天「模範生」
    if (id === 'd_all' && tk.career.lastPerfect !== tk.daily.day) {
      tk.career.lastPerfect = tk.daily.day;
      tk.career.perfectDays += 1;
    }
  } else if (task.cat === 'weekly') {
    tk.week.claimed = cl;
    tk.career.weeklyDone += 1;
  } else {
    tk.career.claimed = cl;
  }

  const entries = [];
  if (task.money > 0) {
    acc.wallet += task.money;
    entries.push({ type: 'task', amount: task.money, note: task.name });
  }
  if (task.stars > 0) p.stars = (p.stars || 0) + task.stars;
  return { entries, task: { id, name: task.name, money: task.money, stars: task.stars } };
}

module.exports = { DAILY, WEEKLY, CAREER, ALL, BY_ID, roll, bump, progress, claim, rawHave, blankCareer, active, tasksFrom, DEFAULT_FROM };
