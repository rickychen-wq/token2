'use strict';
/* 全服大事件：集中放在 config/highlights，前端只能讀，伺服器負責寫。
   每筆事件用固定 id 去重，只保留最新 30 筆。寫入失敗不能反過來讓已完成的牌局報錯。 */

const LIMIT = 30;

function cleanEvent(e) {
  if (!e || !e.id || !e.type || !e.pid || !e.at) return null;
  const out = {
    id: String(e.id).slice(0, 120),
    type: String(e.type).slice(0, 20),
    pid: String(e.pid).slice(0, 20),
    name: String(e.name || e.pid).slice(0, 30),
    at: Math.floor(Number(e.at) || Date.now())
  };
  ['amount', 'stake', 'payout', 'mult', 'bet', 'handNo'].forEach((k) => {
    if (Number.isFinite(Number(e[k]))) out[k] = Number(e[k]);
  });
  return out;
}

async function publishHighlights(db, events) {
  const incoming = (events || []).map(cleanEvent).filter(Boolean);
  if (!incoming.length) return;
  const ref = db.collection('config').doc('highlights');
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists && Array.isArray(snap.data().events) ? snap.data().events : [];
      const seen = {};
      const merged = incoming.concat(current).filter((e) => {
        if (!e || !e.id || seen[e.id]) return false;
        seen[e.id] = true;
        return true;
      }).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, LIMIT);
      tx.set(ref, { events: merged, updatedAt: Date.now() });
    });
  } catch (e) {
    // 大事件是附加顯示，不能因為它失敗而讓已完成的遊戲被前端重送。
    console.error('publish highlights failed', e);
  }
}

module.exports = { LIMIT, publishHighlights };
