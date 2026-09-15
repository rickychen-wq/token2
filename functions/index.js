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

const db = admin.firestore();
const now = () => Date.now();

const A = createAuth({ db, auth: admin.auth(), now });
const EC = createEconomy({ db, now, requireSession: A.requireSession, requireAdmin: A.requireAdmin });

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

/* 每 3 小時計息：台灣時間 00、03、06…21 點 */
exports.econInterest = onSchedule({ schedule: '0 */3 * * *', timeZone: 'Asia/Taipei', retryCount: 3 }, async () => {
  const r = await EC.runInterest(Date.now());
  logger.info('interest', r);
});
