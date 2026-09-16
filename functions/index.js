'use strict';
/* Token 2.0 — Cloud Functions 入口
   所有 function 都在 asia-east1（台灣），跟 Firestore 同一區。 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ region: 'asia-east1', maxInstances: 10, memory: '256MiB' });

const { AppError } = require('./core/util');
const { createAuth } = require('./core/auth');
const { createEconomy } = require('./core/economy');
const { createPoker } = require('./games/poker');
const { createSeason } = require('./core/season');
const { createShop } = require('./core/shop');
const { createMail } = require('./core/mail');

const db = admin.firestore();
const now = () => Date.now();

const A = createAuth({ db, auth: admin.auth(), now });
const EC = createEconomy({ db, now, requireSession: A.requireSession, requireAdmin: A.requireAdmin });
const PK = createPoker({ db, now, requireSession: A.requireSession, requireAdmin: A.requireAdmin });
const SH = createShop({ db, now, requireSession: A.requireSession, requireAdmin: A.requireAdmin });
const ML = createMail({ db, now, requireSession: A.requireSession, requireAdmin: A.requireAdmin });
const SE = createSeason({ db, now, requireAdmin: A.requireAdmin, runInterest: EC.runInterest, closeTables: PK.closeSeason });

/* 把自訂錯誤轉成前端讀得到的 HttpsError，其他錯誤不外洩細節 */
function wrap(fn) {
  return onCall(async (req) => {
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof AppError) throw new HttpsError(e.kind, e.message, { reason: e.reason });
      if (e instanceof HttpsError) throw e;
      logger.error(e);
      throw new HttpsError('internal', '伺服器出錯了，稍後再試');
    }
  });
}

/* ---------- 帳號 ---------- */
exports.authRegister = wrap(A.register);
exports.authLogin = wrap(A.login);
exports.authSetPassword = wrap(A.setPassword);
exports.authSession = wrap(A.session);
exports.authLogout = wrap(A.logout);
exports.authChangePassword = wrap(A.changePassword);

exports.adminSetRegistration = wrap(A.adminSetRegistration);
exports.adminCreatePlayer = wrap(A.adminCreatePlayer);
exports.adminResetPassword = wrap(A.adminResetPassword);
exports.adminRenamePlayer = wrap(A.adminRenamePlayer);

/* ---------- 經濟 ---------- */
exports.econAccount = wrap(EC.account);
exports.econBorrow = wrap(EC.borrow);
exports.econDeposit = wrap(EC.deposit);
exports.econWithdraw = wrap(EC.withdraw);
exports.econClaimDaily = wrap(EC.claimDaily);

exports.adminAdjust = wrap(EC.adminAdjust);
exports.adminSetEcon = wrap(EC.adminSetEcon);
exports.adminLedger = wrap(EC.adminLedger);
exports.adminRunInterest = wrap(EC.adminRunInterest);

/* ---------- 德州 ---------- */
exports.pokerSit = wrap(PK.sit);
exports.pokerRebuy = wrap(PK.rebuy);
exports.pokerLeave = wrap(PK.leave);
exports.pokerSitout = wrap(PK.sitout);
exports.pokerAct = wrap(PK.act);
exports.pokerTick = wrap(PK.tick);
exports.adminPokerStart = wrap(PK.adminStart);
exports.adminPokerAbort = wrap(PK.adminAbort);
exports.adminPokerSettings = wrap(PK.adminSettings);
exports.pokerEmote = wrap(PK.emote);
exports.adminPokerKick = wrap(PK.adminKick);

/* ---------- 商店 ---------- */
exports.shopBuy = wrap(SH.buy);
exports.shopEquip = wrap(SH.equip);
exports.shopRename = wrap(SH.rename);
exports.shopVanity = wrap(SH.vanity);
exports.shopOpenChest = wrap(SH.openChest);
exports.pokerSwapSeat = wrap(PK.swapSeat);
exports.adminGrant = wrap(SH.adminGrant);
exports.adminRevoke = wrap(SH.adminRevoke);
exports.adminCatalog = wrap(SH.adminCatalog);
exports.adminSetRole = wrap(A.adminSetRole);

/* ---------- 公告、信箱 ---------- */
exports.adminAnnounce = wrap(ML.adminAnnounce);
exports.adminSendMail = wrap(ML.adminSendMail);
exports.adminDeleteMail = wrap(ML.adminDeleteMail);
exports.mailClaim = wrap(ML.claim);

/* ---------- 季 ---------- */
exports.adminSettleSeason = wrap(SE.adminSettle);
exports.adminLockSeason = wrap(SE.adminLock);
exports.adminUnlockSeason = wrap(SE.adminUnlock);
exports.adminSeasonConfig = wrap(SE.adminSeasonConfig);

/* 週日 23:00 鎖定：不能開新的一手、不能帶入 */
exports.seasonLock = onSchedule({ schedule: '0 23 * * 0', timeZone: 'Asia/Taipei', retryCount: 3 }, async () => {
  logger.info('season lock', await SE.lock(Date.now()));
});

/* 週一 00:00 結算剛結束的那一季 */
exports.seasonSettle = onSchedule({ schedule: '1 0 * * 1', timeZone: 'Asia/Taipei', retryCount: 5 }, async () => {
  logger.info('season settle', await SE.settleEnded(Date.now()));
});

/* 每 3 小時計息：台灣時間 00、03、06…21 點 */
exports.econInterest = onSchedule({ schedule: '0 */3 * * *', timeZone: 'Asia/Taipei', retryCount: 3 }, async () => {
  const r = await EC.runInterest(Date.now());
  logger.info('interest', r);
});
