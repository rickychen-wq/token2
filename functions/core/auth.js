'use strict';
/* core/auth.js — 帳號、登入、主辦管理
   身分做法：前端先匿名登入拿到 Firebase uid，
   密碼驗證通過後，伺服器把 { pid, role, sv } 寫進這個 uid 的 custom claims。
   sv（session version）改密碼或被重設時 +1，舊裝置的登入就會失效。 */

const crypto = require('crypto');
const { AppError, cleanPid, cleanName, cleanPw } = require('./util');

const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1 };

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32, SCRYPT).toString('hex');
  return { salt, hash };
}

function verifyPw(pw, salt, hash) {
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(String(pw), salt, 32, SCRYPT);
  const want = Buffer.from(hash, 'hex');
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}

function newPlayer(pid, name, role, claimed, t) {
  return {
    pid, name, role, claimed, createdAt: t,
    equipped: { avatar: null, frame: null, title: null, badge: null },
    unlocked: { avatars: [], frames: [], titles: [], badges: [] },
    achievements: {},
    stats: {
      points: 0, champions: 0, top3: 0, seasonsPlayed: 0, bestRank: null,
      peakNet: 0, peakNetSeason: null, bestSeasonNet: 0, bestSeasonId: null,
      champStreak: 0, lastChampSeason: null
    },
    games: {},
    guildId: null,
    lastSettledSeason: null
  };
}

function publicProfile(p) {
  return { pid: p.pid, name: p.name, role: p.role };
}

function createAuth({ db, auth, now }) {
  const cfgRef = () => db.collection('config').doc('app');
  const playerRef = (pid) => db.collection('players').doc(pid);
  const authRef = (pid) => db.collection('players').doc(pid).collection('private').doc('auth');

  function requireUid(req) {
    if (!req.auth || !req.auth.uid) throw new AppError('連線身分遺失，請重新整理頁面', 'no-auth', 'unauthenticated');
    return req.auth.uid;
  }

  function setClaims(uid, pid, role, sv) {
    return auth.setCustomUserClaims(uid, { pid, role, sv });
  }

  /* 驗證目前登入仍然有效，回傳玩家資料 */
  async function requireSession(req) {
    requireUid(req);
    const tk = req.auth.token || {};
    if (!tk.pid) throw new AppError('請先登入', 'no-session', 'unauthenticated');
    const [pSnap, aSnap] = await Promise.all([playerRef(tk.pid).get(), authRef(tk.pid).get()]);
    const a = aSnap.exists ? aSnap.data() : null;
    if (!pSnap.exists || !a || !a.hash || a.sv !== tk.sv) {
      throw new AppError('登入已失效，請重新登入', 'session-expired', 'unauthenticated');
    }
    return { pid: tk.pid, player: pSnap.data(), authData: a };
  }

  async function requireAdmin(req) {
    const s = await requireSession(req);
    if (s.player.role !== 'admin') throw new AppError('只有主辦可以做這件事', 'not-admin', 'permission-denied');
    return s;
  }

  return {
    requireSession,
    requireAdmin,

    /* 註冊。資料庫還沒有設定檔時，第一個註冊的人成為主辦 */
    async register(req) {
      const uid = requireUid(req);
      const d = req.data || {};
      const pid = cleanPid(d.pid), name = cleanName(d.name), pw = cleanPw(d.pw);
      const t = now();
      const { salt, hash } = hashPw(pw);

      const res = await db.runTransaction(async (tx) => {
        const cfg = await tx.get(cfgRef());
        const p = await tx.get(playerRef(pid));
        if (p.exists) throw new AppError('這個編號已經有人用了', 'taken');
        let role = 'player';
        if (!cfg.exists) {
          role = 'admin';
          tx.set(cfgRef(), { registrationOpen: false, createdAt: t, bootstrapPid: pid });
        } else if (!cfg.data().registrationOpen) {
          throw new AppError('目前沒有開放註冊，請找主辦開帳號', 'closed');
        }
        tx.set(playerRef(pid), newPlayer(pid, name, role, true, t));
        tx.set(authRef(pid), { salt, hash, sv: 1, fails: 0, lockUntil: 0, updatedAt: t });
        return { pid, name, role, sv: 1 };
      });

      await setClaims(uid, res.pid, res.role, res.sv);
      return { pid: res.pid, name: res.name, role: res.role };
    },

    async login(req) {
      const uid = requireUid(req);
      const d = req.data || {};
      const pid = cleanPid(d.pid);
      const pw = String(d.pw == null ? '' : d.pw);
      if (!pw) throw new AppError('要打密碼', 'bad-pw', 'invalid-argument');
      const t = now();

      const out = await db.runTransaction(async (tx) => {
        const p = await tx.get(playerRef(pid));
        const aSnap = await tx.get(authRef(pid));
        if (!p.exists) throw new AppError('這個編號還沒開通', 'not-found');
        const a = aSnap.exists ? aSnap.data() : null;
        if (!a || !a.hash) throw new AppError('這個帳號還沒設密碼', 'needs-password');
        if (a.lockUntil > t) {
          const min = Math.ceil((a.lockUntil - t) / 60000);
          throw new AppError('密碼錯太多次，' + min + ' 分鐘後再試', 'locked');
        }
        if (!verifyPw(pw, a.salt, a.hash)) {
          const fails = (a.fails || 0) + 1;
          if (fails >= MAX_FAILS) tx.update(authRef(pid), { fails: 0, lockUntil: t + LOCK_MS });
          else tx.update(authRef(pid), { fails });
          return { ok: false, left: MAX_FAILS - fails };
        }
        if (a.fails || a.lockUntil) tx.update(authRef(pid), { fails: 0, lockUntil: 0 });
        return { ok: true, player: p.data(), sv: a.sv };
      });

      if (!out.ok) {
        throw new AppError(out.left <= 0
          ? '密碼錯太多次，5 分鐘後再試'
          : '密碼不對，還可以試 ' + out.left + ' 次', out.left <= 0 ? 'locked' : 'bad-password');
      }
      await setClaims(uid, pid, out.player.role, out.sv);
      return publicProfile(out.player);
    },

    /* 主辦開好的帳號，本人第一次登入時設定密碼 */
    async setPassword(req) {
      const uid = requireUid(req);
      const d = req.data || {};
      const pid = cleanPid(d.pid), pw = cleanPw(d.pw);
      const t = now();
      const { salt, hash } = hashPw(pw);

      const res = await db.runTransaction(async (tx) => {
        const p = await tx.get(playerRef(pid));
        const aSnap = await tx.get(authRef(pid));
        if (!p.exists) throw new AppError('這個編號還沒開通', 'not-found');
        const a = aSnap.exists ? aSnap.data() : null;
        if (a && a.hash) throw new AppError('這個帳號已經設過密碼了', 'already-claimed');
        const sv = ((a && a.sv) || 0) + 1;
        tx.set(authRef(pid), { salt, hash, sv, fails: 0, lockUntil: 0, updatedAt: t });
        tx.update(playerRef(pid), { claimed: true });
        return { player: p.data(), sv };
      });

      await setClaims(uid, pid, res.player.role, res.sv);
      return publicProfile(res.player);
    },

    async session(req) {
      const s = await requireSession(req);
      return publicProfile(s.player);
    },

    async logout(req) {
      if (req.auth && req.auth.uid) await auth.setCustomUserClaims(req.auth.uid, null);
      return { ok: true };
    },

    async changePassword(req) {
      const uid = requireUid(req);
      const s = await requireSession(req);
      const d = req.data || {};
      if (!verifyPw(d.oldPw, s.authData.salt, s.authData.hash)) {
        throw new AppError('目前的密碼不對', 'bad-password');
      }
      const pw = cleanPw(d.newPw);
      const { salt, hash } = hashPw(pw);
      const sv = (s.authData.sv || 0) + 1;
      await authRef(s.pid).update({ salt, hash, sv, fails: 0, lockUntil: 0, updatedAt: now() });
      await setClaims(uid, s.pid, s.player.role, sv);
      return { ok: true };
    },

    /* ---------- 主辦 ---------- */

    async adminSetRegistration(req) {
      await requireAdmin(req);
      const open = !!(req.data && req.data.open);
      await cfgRef().update({ registrationOpen: open });
      return { registrationOpen: open };
    },

    async adminCreatePlayer(req) {
      await requireAdmin(req);
      const d = req.data || {};
      const pid = cleanPid(d.pid), name = cleanName(d.name);
      const t = now();
      await db.runTransaction(async (tx) => {
        const p = await tx.get(playerRef(pid));
        if (p.exists) throw new AppError('這個編號已經有人用了', 'taken');
        tx.set(playerRef(pid), newPlayer(pid, name, 'player', false, t));
      });
      return { pid, name };
    },

    async adminResetPassword(req) {
      const s = await requireAdmin(req);
      const pid = cleanPid(req.data && req.data.pid);
      if (pid === s.pid) throw new AppError('不能重設自己，請用「改密碼」', 'self');
      await db.runTransaction(async (tx) => {
        const p = await tx.get(playerRef(pid));
        const aSnap = await tx.get(authRef(pid));
        if (!p.exists) throw new AppError('找不到這個編號', 'not-found');
        const sv = ((aSnap.exists && aSnap.data().sv) || 0) + 1;
        tx.set(authRef(pid), { salt: null, hash: null, sv, fails: 0, lockUntil: 0, updatedAt: now() });
        tx.update(playerRef(pid), { claimed: false });
      });
      return { ok: true };
    },

    async adminSetRole(req) {
      const s = await requireAdmin(req);
      const d = req.data || {};
      const pid = cleanPid(d.pid);
      const role = d.role === 'admin' ? 'admin' : 'player';
      if (pid === s.pid) throw new AppError('不能改自己的權限', 'self');
      const ref = playerRef(pid);
      const snap = await ref.get();
      if (!snap.exists) throw new AppError('找不到這個編號', 'not-found');
      await ref.update({ role });
      return { pid, role };
    },

    async adminRenamePlayer(req) {
      await requireAdmin(req);
      const d = req.data || {};
      const pid = cleanPid(d.pid), name = cleanName(d.name);
      const ref = playerRef(pid);
      const snap = await ref.get();
      if (!snap.exists) throw new AppError('找不到這個編號', 'not-found');
      await ref.update({ name });
      return { pid, name };
    }
  };
}

module.exports = { createAuth, hashPw, verifyPw };
