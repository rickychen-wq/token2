'use strict';
/* Token 2.0 — Cloud Functions 入口
   所有 function 都在 asia-east1（台灣），跟 Firestore 同一區。 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ region: 'asia-east1', maxInstances: 10, memory: '256MiB' });

const { AppError } = require('./core/util');
const { createAuth } = require('./core/auth');

const A = createAuth({
  db: admin.firestore(),
  auth: admin.auth(),
  now: () => Date.now()
});

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
