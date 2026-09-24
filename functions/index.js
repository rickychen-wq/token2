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
const { createMini } = require('./games/minigames');
const { createBlackjack } = require('./games/blackjack');
const { createBig2 } = require('./games/big2');
const { createRewards } = require('./core/rewards');
const { createFeedback } = require('./core/feedback');
const { createMarket } = require('./core/market');

const db = admin.firestore();
const now = () => Date.now();

const A = createAuth({ db, auth: admin.auth(), now });
const EC = createEconomy({ db, now, requireSession: A.requireSession, requireAdmin: A.requireAdmin });
const PK = createPoker({ db, now, requireSession: A.requireSession, requireAdmin: A.requireAdmin });
const SH = createShop({ db, now, requireSession: A.requireSession, requireAdmin: A.requireAdmin });
const ML = createMail({ db, now, requireSession: A.requireSession, requireAdmin: A.requireAdmin });
const MG = createMini({ db, now, requireSession: A.requireSession, requireAdmin: A.requireAdmin, mutate: EC.mutate });
const BJ = createBlackjack({ db, now, requireSession: A.requireSession, requireAdmin: A.requireAdmin });
const B2 = createBig2({ db, now, requireSession: A.requireSession, requireAdmin: A.requireAdmin });
const SE = createSeason({ db, now, requireAdmin: A.requireAdmin, runInterest: EC.runInterest,
  closeTables: async (sid) => { const r = await PK.closeSeason(sid); await BJ.closeSeason(sid); await B2.closeSeason(sid); return r; } });
const RW = createRewards({ db, now, requireAdmin: A.requireAdmin });
const FB = createFeedback({ db, now, requireSession: A.requireSession, requireAdmin: A.requireAdmin });
const MK = createMarket({
  db, now, requireSession: A.requireSession, requireAdmin: A.requireAdmin,
  mutate: EC.mutate, FieldValue: admin.firestore.FieldValue
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
exports.econUseRevive = wrap(EC.useRevive);
exports.taskList = wrap(EC.taskList);
exports.taskClaim = wrap(EC.taskClaim);

exports.adminAdjust = wrap(EC.adminAdjust);
exports.adminSetEcon = wrap(EC.adminSetEcon);
exports.adminLedger = wrap(EC.adminLedger);
exports.adminRunInterest = wrap(EC.adminRunInterest);

/* ---------- 星界交易所 ---------- */
exports.marketState = wrap(MK.state);
exports.marketTrade = wrap(MK.trade);
exports.marketLeverageOpen = wrap(MK.leverageOpen);
exports.marketLeverageClose = wrap(MK.leverageClose);
exports.adminMarketMove = wrap(MK.adminMove);
exports.adminMarketSignals = wrap(MK.adminSignals);

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
exports.shopUseShampoo = wrap(SH.useShampoo);
exports.pokerUseCard = wrap(PK.useCard);
exports.pokerContestRespond = wrap(PK.contestRespond);
exports.pokerContestPick = wrap(PK.contestPick);
exports.adminGrant = wrap(SH.adminGrant);
exports.adminRevoke = wrap(SH.adminRevoke);
exports.adminCatalog = wrap(SH.adminCatalog);
exports.adminSetRole = wrap(A.adminSetRole);

/* ---------- 小遊戲 ---------- */
exports.gateDeal = wrap(MG.gateDeal);
exports.gateShoot = wrap(MG.gateShoot);
exports.slotSpin = wrap(MG.slotSpin);
exports.diceRoll = wrap(MG.diceRoll);
exports.bjSit = wrap(BJ.sit);
exports.bjLeave = wrap(BJ.leave);
exports.bjBet = wrap(BJ.bet);
exports.bjAct = wrap(BJ.act);
exports.bjTick = wrap(BJ.tick);
exports.adminBjKick = wrap(BJ.adminKick);
exports.bjUseCard = wrap(BJ.useCard);
exports.bjContestRespond = wrap(BJ.contestRespond);
exports.bjContestPick = wrap(BJ.contestPick);
exports.big2Sit = wrap(B2.sit);
exports.big2Leave = wrap(B2.leave);
exports.big2Play = wrap(B2.play);
exports.big2Pass = wrap(B2.pass);
exports.big2Tick = wrap(B2.tick);
exports.adminBig2Start = wrap(B2.adminStart);
exports.adminGames = wrap(MG.adminGames);

/* ---------- 公告、信箱 ---------- */
exports.adminAnnounce = wrap(ML.adminAnnounce);
exports.adminSendMail = wrap(ML.adminSendMail);
exports.adminDeleteMail = wrap(ML.adminDeleteMail);
exports.mailClaim = wrap(ML.claim);

/* ---------- 意見箱 ---------- */
exports.feedbackSubmit = wrap(FB.submit);
exports.feedbackMine = wrap(FB.mine);
exports.adminFeedbackList = wrap(FB.adminList);
exports.adminFeedbackAction = wrap(FB.adminAction);

/* ---------- 季 ---------- */
exports.adminSettleSeason = wrap(SE.adminSettle);
exports.adminLockSeason = wrap(SE.adminLock);
exports.adminUnlockSeason = wrap(SE.adminUnlock);
exports.adminSeasonConfig = wrap(SE.adminSeasonConfig);

/* 週日 23:00 鎖定：不能開新的一手、不能帶入 */
exports.seasonLock = onSchedule({ schedule: '0 23 * * 0', timeZone: 'Asia/Taipei', retryCount: 3 }, async () => {
  logger.info('season lock', await SE.lock(Date.now()));
});

/* 週一 00:01 結算剛結束的那一季；成功後立刻發週獎勵。 */
exports.seasonSettle = onSchedule({ schedule: '1 0 * * 1', timeZone: 'Asia/Taipei', retryCount: 5 }, async () => {
  const settled = await SE.settleEnded(Date.now());
  const rewards = await RW.runWeekly(Date.now());
  logger.info('season settle', { settled, rewards });
});

/* ---------- v13 排行榜自動發獎 ---------- */
exports.adminSetRewards = wrap(RW.adminSetRewards);
exports.adminRunRewards = wrap(RW.adminRunRewards);

/* 每天 00:05 發前一天的排行獎勵（週一跳過，那天由週獎勵負責） */
exports.rewardsDaily = onSchedule({ schedule: '5 0 * * *', timeZone: 'Asia/Taipei', retryCount: 3 }, async () => {
  logger.info('rewards daily', await RW.runDaily(Date.now()));
});

/* 週一 00:15 備援補發；正常情況 seasonSettle 結束後已經發完。 */
exports.rewardsWeekly = onSchedule({ schedule: '15 0 * * 1', timeZone: 'Asia/Taipei', retryCount: 5 }, async () => {
  logger.info('rewards weekly', await RW.runWeekly(Date.now()));
});

/* 每 3 小時計息：台灣時間 00、03、06…21 點 */
exports.econInterest = onSchedule({ schedule: '0 */3 * * *', timeZone: 'Asia/Taipei', retryCount: 3 }, async () => {
  const r = await EC.runInterest(Date.now());
  logger.info('interest', r);
});

/* 每 5 分鐘更新虛擬股價，並同步持股玩家的當季淨資產。 */
exports.marketTick = onSchedule({ schedule: '*/5 * * * *', timeZone: 'Asia/Taipei', retryCount: 3 }, async () => {
  logger.info('market tick', await MK.tick(Date.now()));
});

/* 每個交易日 06:55 依帳戶實際持股校正市場比例，再於 07:00 開盤。 */
exports.marketSupplySync = onSchedule({ schedule: '55 6 * * 1-5', timeZone: 'Asia/Taipei', retryCount: 3 }, async (event) => {
  const scheduledAt = Date.parse(event.scheduleTime) || Date.now();
  logger.info('market supply sync', await MK.syncSupply(scheduledAt));
});

/* 星期五 17:30 收盤：所有持股與槓桿按固定收盤價換回現金，行情本身跨週延續。 */
exports.marketWeeklyClose = onSchedule({ schedule: '30 17 * * 5', timeZone: 'Asia/Taipei', retryCount: 5 }, async (event) => {
  const scheduledAt = Date.parse(event.scheduleTime) || Date.now();
  logger.info('market weekly close', await MK.closeWeek(scheduledAt));
});

/* 情報網：每天台灣時間 08、10、12、14、16 點各發布五則消息與管理員建議。 */
exports.marketIntel = onSchedule({ schedule: '0 8,10,12,14,16 * * *', timeZone: 'Asia/Taipei', retryCount: 3 }, async (event) => {
  const scheduledAt = Date.parse(event.scheduleTime) || Date.now();
  logger.info('market intel', await MK.publishIntel(scheduledAt));
});
