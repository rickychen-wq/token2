'use strict';

const assert = require('assert');
const E = require('./core/econ');
const {
  freshState, positionRawEquity, positionEquity, maintenanceMargin,
  shouldLiquidate, leverageCloseFee, liquidationPrice, settlePortfolio,
  MAINTENANCE_MARGIN_RATE, MAX_LEVERAGE_MARGIN, MAX_LEVERAGE_POSITIONS
} = require('./core/market');

const t = Date.UTC(2026, 8, 28, 1, 0, 0);
const state = freshState(t);
state.feeRate = 0.01;
state.stocks.TKN.price = 100;

function position(side, leverage) {
  return { symbol: 'TKN', side, leverage, margin: 1000, notional: 1000 * leverage, entryPrice: 100, openedAt: t };
}

assert.strictEqual(MAINTENANCE_MARGIN_RATE, 0.6);
assert.strictEqual(MAX_LEVERAGE_MARGIN, 25000);
assert.strictEqual(MAX_LEVERAGE_POSITIONS, 2);

const long5 = position('long', 5);
assert.strictEqual(maintenanceMargin(long5), 600);
assert.strictEqual(liquidationPrice(long5), 92);
state.stocks.TKN.price = 93;
assert.strictEqual(positionRawEquity(long5, state), 650);
assert.strictEqual(positionEquity(long5, state), 650);
assert.strictEqual(shouldLiquidate(long5, state), false);
state.stocks.TKN.price = 92;
assert.strictEqual(positionRawEquity(long5, state), 600);
assert.strictEqual(shouldLiquidate(long5, state), true);

const short5 = position('short', 5);
assert.strictEqual(liquidationPrice(short5), 108);
state.stocks.TKN.price = 107;
assert.strictEqual(positionEquity(short5, state), 650);
assert.strictEqual(shouldLiquidate(short5, state), false);
state.stocks.TKN.price = 108;
assert.strictEqual(positionEquity(short5, state), 600);
assert.strictEqual(shouldLiquidate(short5, state), true);

state.stocks.TKN.price = 104;
assert.strictEqual(positionEquity(long5, state), 1200);
assert.strictEqual(leverageCloseFee(long5, state), 50);

const cfg = E.cfgOf(null);
const winning = E.newAccount('test-win', cfg, t);
winning.wallet = 0;
winning.market = { holdings: {}, positions: { TKN: long5 }, value: 1200, realized: 0, fees: 50 };
const winResult = settlePortfolio(winning, state, cfg, t);
assert.strictEqual(winResult.leverageEquity, 1150);
assert.strictEqual(winResult.leverageFees, 50);
assert.strictEqual(winResult.credited, 1150);
assert.strictEqual(winResult.pnl, 150);
assert.strictEqual(winning.wallet, 1150);
assert.strictEqual(winning.market.fees, 100);
assert.deepStrictEqual(winning.market.positions, {});

state.stocks.TKN.price = 92;
const busted = E.newAccount('test-bust', cfg, t);
busted.wallet = 0;
busted.market = { holdings: {}, positions: { TKN: long5 }, value: 600, realized: 0, fees: 50 };
const bustResult = settlePortfolio(busted, state, cfg, t);
assert.strictEqual(bustResult.leverageEquity, 0);
assert.strictEqual(bustResult.leverageFees, 0);
assert.strictEqual(bustResult.credited, 0);
assert.strictEqual(bustResult.pnl, -1000);
assert.strictEqual(busted.wallet, 0);
assert.deepStrictEqual(busted.market.positions, {});

console.log('market tests passed');
