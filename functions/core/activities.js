'use strict';

const crypto = require('crypto');
const { AppError } = require('./util');

/* 效果依每一次結算的伺服器時間判斷，不靠排程撤銷，30 秒活動也能準時到期。 */
function activeActivity(raw, game, t) {
  const event = ((raw || {}).gameActivities || {})[game];
  if (!event || !Number.isFinite(t) || !(event.startsAt <= t && t < event.endsAt)) return null;
  return event;
}

function applyActivities(games, raw, t) {
  const gate = activeActivity(raw, 'gate', t);
  const mine = activeActivity(raw, 'mine', t);
  games.gate.payoutMult = gate ? gate.payoutMult : 1;
  games.gate.activity = gate;
  games.mine.trapReduction = mine ? mine.trapReduction : 0;
  games.mine.activity = mine;
  if (mine && mine.specialChance !== null) {
    games.mine.safeSpecialChance = mine.specialChance;
    games.mine.treasureSpecialChance = mine.specialChance;
  }
  return games;
}

function cleanActivity(data, pid, t) {
  const d = data || {};
  if (!['gate', 'mine'].includes(d.game)) throw new AppError('請選射龍門或礦洞探險', 'bad-activity', 'invalid-argument');
  const seconds = Number(d.durationSec);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 604800) {
    throw new AppError('持續時間要在 1 秒到 7 天之間', 'bad-activity', 'invalid-argument');
  }
  const number = (value, lo, hi, label) => {
    const n = Number(value);
    if (value === null || value === '' || !Number.isFinite(n) || n < lo || n > hi) {
      throw new AppError(label + '要在 ' + lo + ' 到 ' + hi + ' 之間', 'bad-activity', 'invalid-argument');
    }
    return n;
  };
  const event = {
    id: crypto.randomUUID(), game: d.game, title: String(d.title || '').trim().slice(0, 40) || (d.game === 'gate' ? '射龍門獎金加倍' : '礦洞尋寶祭'),
    startsAt: t, endsAt: t + seconds * 1000, by: pid
  };
  if (d.game === 'gate') event.payoutMult = number(d.payoutMult, 1, 10, '獎金倍率');
  else {
    event.trapReduction = number(d.trapReduction, 0, 100, '陷阱機率降低幅度') / 100;
    event.specialChance = d.specialChance === null || d.specialChance === undefined || d.specialChance === ''
      ? null : number(d.specialChance, 0, 100, '特殊寶物機率') / 100;
  }
  return event;
}

function createActivities({ db, now, requireAdmin }) {
  const ref = db.collection('config').doc('app');
  return {
    async start(req) {
      const admin = await requireAdmin(req);
      const event = cleanActivity(req.data, admin.pid, now());
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const events = Object.assign({}, snap.exists ? snap.data().gameActivities : {});
        events[event.game] = event;
        if (snap.exists) tx.update(ref, { gameActivities: events });
        else tx.set(ref, { gameActivities: events, registrationOpen: false });
        tx.set(ref.collection('activityLogs').doc(event.id), Object.assign({ action: 'start' }, event));
      });
      return { event, serverNow: now() };
    },
    async stop(req) {
      const admin = await requireAdmin(req);
      const d = req.data || {};
      if (!['gate', 'mine'].includes(d.game) || !d.id) throw new AppError('缺少活動編號', 'bad-activity', 'invalid-argument');
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const events = Object.assign({}, snap.exists ? snap.data().gameActivities : {});
        const current = events[d.game];
        if (!current || current.id !== d.id) throw new AppError('活動已變更，請重新開啟活動管理', 'stale-activity');
        const t = now();
        events[d.game] = Object.assign({}, current, { endsAt: Math.min(current.endsAt, t), stoppedAt: t });
        tx.update(ref, { gameActivities: events });
        tx.set(ref.collection('activityLogs').doc(), { action: 'stop', eventId: d.id, game: d.game, at: t, by: admin.pid });
        return { event: events[d.game], serverNow: t };
      });
    }
  };
}

module.exports = { activeActivity, applyActivities, cleanActivity, createActivities };
