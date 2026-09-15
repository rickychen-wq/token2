'use strict';
/* core/util.js — 共用工具：錯誤型別、輸入檢查、台灣時間 */

class AppError extends Error {
  /* kind 對應 HttpsError 的 code；reason 給前端判斷用 */
  constructor(message, reason, kind) {
    super(message);
    this.reason = reason || null;
    this.kind = kind || 'failed-precondition';
  }
}

const PID_RE = /^\d{2}$/;

function cleanPid(v) {
  const s = String(v == null ? '' : v).trim();
  if (!PID_RE.test(s)) throw new AppError('編號要是兩位數字', 'bad-pid', 'invalid-argument');
  return s;
}

function cleanName(v) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) throw new AppError('名字不能空白', 'bad-name', 'invalid-argument');
  if (Array.from(s).length > 12) throw new AppError('名字最多 12 個字', 'bad-name', 'invalid-argument');
  return s;
}

function cleanPw(v) {
  const s = String(v == null ? '' : v);
  if (s.length < 4) throw new AppError('密碼至少 4 碼', 'bad-pw', 'invalid-argument');
  if (s.length > 32) throw new AppError('密碼最多 32 碼', 'bad-pw', 'invalid-argument');
  return s;
}

const TW_OFFSET = 8 * 3600 * 1000;

/* 台灣時間的本季範圍（週一 00:00 到下週一 00:00），回傳 UTC 毫秒 */
function seasonRange(ms) {
  const tw = new Date(ms + TW_OFFSET);
  const dow = (tw.getUTCDay() + 6) % 7;          // 週一 = 0
  const startTw = Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate()) - dow * 86400000;
  const start = startTw - TW_OFFSET;
  return { start: start, end: start + 7 * 86400000 };
}

/* ISO 週編號（台灣時間），例如 2026-W38 */
function seasonId(ms) {
  const r = seasonRange(ms);
  const thu = new Date(r.start + TW_OFFSET + 3 * 86400000);   // 該週週四決定年份
  const year = thu.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Mon = Date.UTC(year, 0, 4) - ((jan4.getUTCDay() + 6) % 7) * 86400000;
  const week = Math.round((Date.UTC(thu.getUTCFullYear(), thu.getUTCMonth(), thu.getUTCDate()) - 3 * 86400000 - jan4Mon) / (7 * 86400000)) + 1;
  return year + '-W' + String(week).padStart(2, '0');
}

module.exports = { AppError, cleanPid, cleanName, cleanPw, seasonRange, seasonId, TW_OFFSET };
