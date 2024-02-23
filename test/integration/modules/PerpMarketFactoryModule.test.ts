import assert from 'assert';
import assertRevert from '@synthetixio/core-utils/utils/assertions/assert-revert';
import assertBn from '@synthetixio/core-utils/utils/assertions/assert-bignumber';
import { fastForward } from '@synthetixio/core-utils/utils/hardhat/rpc';
import { wei } from '@synthetixio/wei';
import forEach from 'mocha-each';
import { BigNumber } from 'ethers';
import { bootstrap } from '../../bootstrap';
import {
  bn,
  genAddress,
  genBootstrap,
  genBytes32,
  genNumber,
  genOneOf,
  genOrder,
  genOrderFromSizeDelta,
  genSide,
  genTrader,
  toRoundRobinGenerators,
} from '../../generators';
import {
  SECONDS_ONE_DAY,
  SECONDS_ONE_HR,
  commitAndSettle,
  depositMargin,
  fastForwardBySec,
  setMarketConfiguration,
  setMarketConfigurationById,
} from '../../helpers';
import { Collateral, Market, Trader } from '../../typed';
import { isSameSide } from '../../calculations';
import { shuffle, times } from 'lodash';

describe('PerpMarketFactoryModule', () => {
  const bs = bootstrap(genBootstrap());
  const { traders, owner, markets, collaterals, collateralsWithoutSusd, systems, provider, restore } = bs;

  beforeEach(restore);

  describe('setSynthetix', () => {
    it('should revert when invalid synthetix addr (due to needing USD token)', async () => {
      const { PerpMarketProxy } = systems();
      const from = owner();

      const address = genAddress();
      try {
        // assertRevert couldn't handle this error.
        await PerpMarketProxy.connect(from).setSynthetix(address);
        assert.fail('should have reverted');
      } catch (error: any) {
        assert.ok(error.error.reason.includes('transaction reverted in contract unknown'));
      }
    });

    it('should revert when not owner', async () => {
      const { PerpMarketProxy } = systems();
      const from = traders()[0].signer;
      const address = genAddress();
      await assertRevert(
        PerpMarketProxy.connect(from).setSynthetix(address),
        `Unauthorized("${await from.getAddress()}")`,
        PerpMarketProxy
      );
    });
  });

  describe('setSpotMarket', () => {
    it('should set successfully', async () => {
      const { PerpMarketProxy } = systems();
      const from = owner();

      const address = genAddress();
      await PerpMarketProxy.connect(from).setSpotMarket(address);
      const config = await PerpMarketProxy.getMarketConfiguration();

      assert(config.spotMarket, address);
    });

    it('should revert when not owner', async () => {
      const { PerpMarketProxy } = systems();
      const from = traders()[0].signer;
      const address = genAddress();
      await assertRevert(
        PerpMarketProxy.connect(from).setSpotMarket(address),
        `Unauthorized("${await from.getAddress()}")`,
        PerpMarketProxy
      );
    });
  });

  describe('setPyth', () => {
    it('should set successfully', async () => {
      const { PerpMarketProxy } = systems();
      const from = owner();

      const address = genAddress();
      await PerpMarketProxy.connect(from).setPyth(address);
      const config = await PerpMarketProxy.getMarketConfiguration();

      assert(config.pyth, address);
    });

    it('should revert when not owner', async () => {
      const { PerpMarketProxy } = systems();
      const from = traders()[0].signer;
      const address = genAddress();
      await assertRevert(
        PerpMarketProxy.connect(from).setPyth(address),
        `Unauthorized("${await from.getAddress()}")`,
        PerpMarketProxy
      );
    });
  });

  describe('setEthOracleNodeId', () => {
    it('should set successfully', async () => {
      const { PerpMarketProxy } = systems();
      const from = owner();

      const nodeId = genBytes32();
      await PerpMarketProxy.connect(from).setEthOracleNodeId(nodeId);
      const config = await PerpMarketProxy.getMarketConfiguration();

      assert(config.ethOracleNodeId, nodeId);
    });

    it('should revert when not owner', async () => {
      const { PerpMarketProxy } = systems();
      const from = traders()[0].signer;
      const nodeId = genBytes32();
      await assertRevert(
        PerpMarketProxy.connect(from).setEthOracleNodeId(nodeId),
        `Unauthorized("${await from.getAddress()}")`,
        PerpMarketProxy
      );
    });
  });

  describe('setRewardDistributorImplementation', async () => {
    it('should set successfully', async () => {
      const { PerpMarketProxy } = systems();
      const from = owner();

      const implementation = genAddress();
      await PerpMarketProxy.connect(from).setRewardDistributorImplementation(implementation);
      const config = await PerpMarketProxy.getMarketConfiguration();

      assert(config.rewardDistributorImplementation, implementation);
    });

    it('should revert when not owner', async () => {
      const { PerpMarketProxy } = systems();
      const from = traders()[0].signer;
      const implementation = genAddress();
      await assertRevert(
        PerpMarketProxy.connect(from).setRewardDistributorImplementation(implementation),
        `Unauthorized("${await from.getAddress()}")`,
        PerpMarketProxy
      );
    });
  });

  describe('getActiveMarketIds', () => {
    it('should return market ids', async () => {
      const { PerpMarketProxy } = systems();
      const marketIds = await PerpMarketProxy.getActiveMarketIds();
      assertBn.equal(marketIds.length, markets().length);
    });
  });

  describe('getMarketDigest', () => {
    it('should revert when marketId does not exist', async () => {
      const { PerpMarketProxy } = systems();

      const invalidMarketId = bn(genNumber(42069, 50_000));

      await assertRevert(
        PerpMarketProxy.getMarketDigest(invalidMarketId),
        `MarketNotFound("${invalidMarketId}")`,
        PerpMarketProxy
      );
    });

    describe('{fundingRate,fundingVelocity}', () => {
      const depositMarginToTraders = async (
        traders: Trader[],
        market: Market,
        collateral: Collateral,
        marginUsdDepositAmount: number
      ) => {
        for (const trader of traders) {
          await depositMargin(
            bs,
            genTrader(bs, {
              desiredTrader: trader,
              desiredCollateral: collateral,
              desiredMarket: market,
              desiredMarginUsdDepositAmount: marginUsdDepositAmount,
            })
          );
        }
      };

      it('should have 0 velocity if skew is small enough', async () => {
        const { PerpMarketProxy } = systems();
        const market = genOneOf(markets());
        const { fundingVelocityClamp, skewScale } = await PerpMarketProxy.getMarketConfigurationById(market.marketId());
        const minSkewFundingVelocity = wei(fundingVelocityClamp).mul(skewScale);

        const { answer: marketPrice } = await market.aggregator().latestRoundData();
        const { trader, marketId, collateral, collateralDepositAmount } = await depositMargin(
          bs,
          genTrader(bs, {
            desiredMarket: market,
            desiredMarginUsdDepositAmount: minSkewFundingVelocity.abs().mul(marketPrice).mul(2).toNumber(),
          })
        );

        const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
          // Make sure the initial funding velocity is not zero
          desiredSize: bn(
            genNumber(minSkewFundingVelocity.abs().toNumber(), minSkewFundingVelocity.abs().mul(2).toNumber())
          ),
        });
        await commitAndSettle(bs, marketId, trader, order);

        const { fundingVelocity } = await PerpMarketProxy.getMarketDigest(marketId);
        // Assert fundingVelocity is not zero
        assertBn.notEqual(fundingVelocity, bn(0));

        const skewNeededForZeroVelocity = wei(minSkewFundingVelocity).sub(order.sizeDelta).abs();

        const secondOrderSizeAbs = minSkewFundingVelocity.gt(0)
          ? genNumber(skewNeededForZeroVelocity.toNumber(), wei(order.sizeDelta).abs().toNumber())
          : genNumber(wei(order.sizeDelta).abs().toNumber(), skewNeededForZeroVelocity.toNumber());
        const orderSize = order.sizeDelta.gt(0) ? secondOrderSizeAbs * -1 : secondOrderSizeAbs;
        const sizeWorth50Dollar = wei(order.sizeDelta.gt(0) ? -50 : 50)
          .div(marketPrice)
          .toNumber();

        // Add 50 dollar extra to the size, to avoid creating exactly the same skew and to avoid NilOrder
        const orderSizeWithBuffers = bn(orderSize + sizeWorth50Dollar);
        await commitAndSettle(
          bs,
          marketId,
          trader,
          genOrder(bs, market, collateral, collateralDepositAmount, {
            desiredSize: orderSizeWithBuffers,
          })
        );
        const { fundingVelocity: fundingVelocity1 } = await PerpMarketProxy.getMarketDigest(marketId);

        assertBn.equal(fundingVelocity1, 0);
      });

      it('should compute current funding rate relative to time (concrete)', async () => {
        // This test is pulled directly from a concrete example developed for PerpsV2.
        //
        // @see: https://github.com/davidvuong/perpsv2-funding/blob/master/main.ipynb
        // @see: https://github.com/Synthetixio/synthetix/blob/develop/test/contracts/PerpsV2Market.js#L3631
        const { PerpMarketProxy } = systems();

        // Use static market and traders for concrete example.
        const market = markets()[0];
        const collateral = collaterals()[0];
        const trader1 = traders()[0];
        const trader2 = traders()[1];
        const trader3 = traders()[2];

        // Configure funding and velocity specific parameters so we get deterministic results.
        await setMarketConfigurationById(bs, market.marketId(), {
          skewScale: bn(100_000),
          maxFundingVelocity: bn(0.25),
          maxMarketSize: bn(500_000),
        });

        // Set the market price as funding is denominated in USD.
        const marketOraclePrice = bn(100);
        await market.aggregator().mockSetCurrentPrice(marketOraclePrice);

        // A static list of traders and amount of time to pass by trader and its expected funding.
        const trades = [
          // skew = long, r = (t 1000, s 1000)
          {
            sizeDelta: bn(1000),
            account: trader1,
            fastForwardInSec: 1000,
            expectedFundingRate: bn(0),
            expectedFundingVelocity: bn(0.0025),
          },
          // skew = even more long, r = (t 30000, s 3000)
          {
            sizeDelta: bn(2000),
            account: trader2,
            fastForwardInSec: 29_000,
            expectedFundingRate: bn(0.00083912),
            expectedFundingVelocity: bn(0.0075),
          },
          // skew = balanced but funding rate sticks, r (t 50000, s 0)
          {
            sizeDelta: bn(-3000),
            account: trader3,
            fastForwardInSec: 20_000,
            expectedFundingRate: bn(0.00257546),
            expectedFundingVelocity: bn(0),
          },
          // See below for one final fundingRate observation without a trade (no change in rate).
        ];

        // Deposit margin into each trader's account before opening trades.
        await depositMarginToTraders(
          trades.map(({ account }) => account),
          market,
          collateral,
          1_500_000 // 1.5M USD margin
        );

        let lastFundingRate = bn(0);
        const { minOrderAge } = await PerpMarketProxy.getMarketConfiguration();

        for (const trade of trades) {
          const { sizeDelta, account, fastForwardInSec, expectedFundingRate, expectedFundingVelocity } = trade;

          // Fastforward by static seconds, excluding the settlement required min (minOrderAge) and 2s (for the commitment block).
          await fastForwardBySec(provider(), fastForwardInSec - minOrderAge.toNumber() - 2);

          const order = await genOrderFromSizeDelta(bs, market, sizeDelta, { desiredKeeperFeeBufferUsd: 0 });
          await commitAndSettle(bs, market.marketId(), account, order);

          const { fundingVelocity, fundingRate } = await PerpMarketProxy.getMarketDigest(market.marketId());

          assertBn.near(fundingRate, expectedFundingRate, bn(0.000001));
          assertBn.equal(fundingVelocity, expectedFundingVelocity);

          lastFundingRate = fundingRate;
        }

        // No change in skew (zero) and velocity/funding should remain the same.
        await fastForward(SECONDS_ONE_DAY, provider()); // 1 day
        const { fundingVelocity, fundingRate } = await PerpMarketProxy.getMarketDigest(market.marketId());

        assertBn.equal(fundingRate, lastFundingRate);
        assertBn.equal(fundingVelocity, bn(0));
      });

      it('should demonstrate a balance market can have a non-zero funding', async () => {
        const { PerpMarketProxy } = systems();
        const market = genOneOf(markets());
        const { fundingVelocityClamp, skewScale } = await PerpMarketProxy.getMarketConfigurationById(market.marketId());
        const minSkewFundingVelocity = wei(fundingVelocityClamp).mul(skewScale);

        const { answer: marketPrice } = await market.aggregator().latestRoundData();
        const {
          trader: trader1,
          collateral,
          collateralDepositAmount,
        } = await depositMargin(
          bs,
          genTrader(bs, {
            desiredMarket: market,
            desiredMarginUsdDepositAmount: minSkewFundingVelocity.mul(marketPrice).mul(2).toNumber(),
          })
        );

        const order1 = await genOrder(bs, market, collateral, collateralDepositAmount, {
          desiredSize: bn(genNumber(minSkewFundingVelocity.toNumber(), minSkewFundingVelocity.mul(2).toNumber())),
        });

        await commitAndSettle(bs, market.marketId(), trader1, order1);
        await fastForwardBySec(provider(), genNumber(15_000, 30_000));

        const d1 = await PerpMarketProxy.getMarketDigest(market.marketId());

        assert.notEqual(d1.fundingRate.toString(), '0');
        const { trader: trader2 } = await depositMargin(
          bs,
          genTrader(bs, {
            desiredMarket: market,
            desiredMarginUsdDepositAmount: minSkewFundingVelocity.mul(marketPrice).mul(2).toNumber(),
          })
        );
        const order2 = await genOrder(bs, market, collateral, collateralDepositAmount, {
          desiredSize: order1.sizeDelta.mul(-1),
        });
        await commitAndSettle(bs, market.marketId(), trader2, order2);
        await fastForwardBySec(provider(), genNumber(15_000, 30_000));

        const d2 = await PerpMarketProxy.getMarketDigest(market.marketId());
        assert.notEqual(d2.fundingRate.toString(), '0');
      });

      it('should have zero funding when market is new and empty', async () => {
        const { PerpMarketProxy } = systems();

        // Use static market and traders for concrete example.
        const market = genOneOf(markets());

        // Expect zero values.
        const d1 = await PerpMarketProxy.getMarketDigest(market.marketId());
        assertBn.isZero(d1.size);
        assertBn.isZero(d1.fundingRate);
        assertBn.isZero(d1.fundingVelocity);

        await fastForward(60 * 60 * 24, provider());

        // Should still be zero values with no market changes.
        const d2 = await PerpMarketProxy.getMarketDigest(market.marketId());
        assertBn.isZero(d2.size);
        assertBn.isZero(d2.fundingRate);
        assertBn.isZero(d2.fundingVelocity);
      });

      it('should change funding direction when skew flips', async () => {
        const { PerpMarketProxy } = systems();

        const market = genOneOf(markets());
        const collateral = genOneOf(collaterals());

        const marginUsdDepositAmount = 500_000; // 1M USD.
        const { trader } = await depositMargin(
          bs,
          genTrader(bs, {
            desiredCollateral: collateral,
            desiredMarket: market,
            desiredMarginUsdDepositAmount: marginUsdDepositAmount,
          })
        );

        const { fundingVelocityClamp, skewScale } = await PerpMarketProxy.getMarketConfigurationById(market.marketId());
        const minSkewFundingVelocity = wei(fundingVelocityClamp).mul(skewScale);

        // Go short.
        const order1 = await genOrderFromSizeDelta(
          bs,
          market,
          bn(genNumber(minSkewFundingVelocity.toNumber(), minSkewFundingVelocity.mul(2).toNumber())).mul(-1),
          {
            desiredKeeperFeeBufferUsd: 0,
          }
        );
        await commitAndSettle(bs, market.marketId(), trader, order1);
        await fastForwardBySec(provider(), SECONDS_ONE_DAY);
        const d1 = await PerpMarketProxy.getMarketDigest(market.marketId());
        assertBn.lt(d1.fundingRate, bn(0));

        // Go long.

        const minSkewFundingVelocityDelta = wei(order1.sizeDelta).abs().add(minSkewFundingVelocity);
        const order2 = await genOrderFromSizeDelta(
          bs,
          market,
          bn(genNumber(minSkewFundingVelocityDelta.toNumber(), minSkewFundingVelocityDelta.mul(2).toNumber())),
          {
            desiredKeeperFeeBufferUsd: 0,
          }
        );
        await commitAndSettle(bs, market.marketId(), trader, order2);
        await fastForwardBySec(provider(), SECONDS_ONE_DAY);
        const d2 = await PerpMarketProxy.getMarketDigest(market.marketId());

        // New funding rate should be trending towards zero or positive.
        assertBn.gt(d2.fundingRate, d1.fundingRate);
      });

      forEach(['long', 'short']).it('should result in max funding velocity when %s skewed', async (side: string) => {
        const { PerpMarketProxy } = systems();

        const market = genOneOf(markets());
        const collateral = genOneOf(collaterals());

        // Set the price of market oracle to be something relatively small to avoid hitting insufficient margin.
        await market.aggregator().mockSetCurrentPrice(bn(genNumber(50, 100)));

        const marginUsdDepositAmount = 500_000; // 500k USD.
        const { trader } = await depositMargin(
          bs,
          genTrader(bs, {
            desiredCollateral: collateral,
            desiredMarket: market,
            desiredMarginUsdDepositAmount: marginUsdDepositAmount,
          })
        );

        // Velocity is skew/skewScale * maxVelocity. So in order in order to get max velocity of 1 * max then
        // skew must be equal to skewScale. Here we force the size to equal skewScale to test that it's capped
        // at and above.
        const skewScale = bn(1000);
        await setMarketConfigurationById(bs, market.marketId(), { skewScale });
        const sizeSide = side === 'long' ? 1 : -1;
        const sizeDelta = skewScale.add(bn(genNumber(1, 10))).mul(sizeSide);

        const order = await genOrderFromSizeDelta(bs, market, sizeDelta, {
          desiredKeeperFeeBufferUsd: 0,
          desiredPriceImpactPercentage: 1, // 100% above/below oraclePrice e.g. $1000 oracle -> $2000 or $0
        });
        await commitAndSettle(bs, market.marketId(), trader, order);

        const { maxFundingVelocity } = await PerpMarketProxy.getMarketConfigurationById(market.marketId());
        const { fundingVelocity } = await PerpMarketProxy.getMarketDigest(market.marketId());

        assertBn.equal(fundingVelocity.abs(), maxFundingVelocity);
      });

      forEach(['long', 'short']).it(
        'should continue to increase (%s) funding in same direction insofar as market is skewed',
        async (side: string) => {
          const { PerpMarketProxy } = systems();

          const market = genOneOf(markets());
          const collateral = genOneOf(collaterals());

          const marginUsdDepositAmount = 500_000; // 500k USD.
          const { trader } = await depositMargin(
            bs,
            genTrader(bs, {
              desiredCollateral: collateral,
              desiredMarket: market,
              desiredMarginUsdDepositAmount: marginUsdDepositAmount,
            })
          );

          const sizeSide = side === 'long' ? 1 : -1;
          const sizeDelta = bn(genNumber(1, 10)).mul(sizeSide);

          const order = await genOrderFromSizeDelta(bs, market, sizeDelta, {
            desiredKeeperFeeBufferUsd: 0,
          });
          await commitAndSettle(bs, market.marketId(), trader, order);

          await fastForwardBySec(provider(), SECONDS_ONE_HR);

          const d1 = await PerpMarketProxy.getMarketDigest(market.marketId());

          await fastForwardBySec(provider(), SECONDS_ONE_DAY);

          const d2 = await PerpMarketProxy.getMarketDigest(market.marketId());

          // Funding rate should be expanding from skew in the same direction.
          assert.ok(isSameSide(d1.fundingRate, d2.fundingRate));
        }
      );
    });
  });

  describe('reportedDebt', () => {
    const getTotalPositionPnl = async (traders: Trader[], marketId: BigNumber) => {
      const { PerpMarketProxy } = systems();
      const positions = await Promise.all(traders.map((t) => PerpMarketProxy.getPositionDigest(t.accountId, marketId)));
      return positions.reduce((acc, p) => acc.add(p.pnl).sub(p.accruedFeesUsd), bn(0));
    };

    it('should have a debt of zero when first initialized', async () => {
      const { PerpMarketProxy } = systems();

      const market = genOneOf(markets());
      const reportedDebt = await PerpMarketProxy.reportedDebt(market.marketId());

      assertBn.isZero(reportedDebt);
    });

    it('should report usd value of margin as report when depositing into system', async () => {
      const { PerpMarketProxy } = systems();

      // Remove any collateral discount to minimise subtle differences in deposit values.
      await setMarketConfiguration(bs, {
        minCollateralDiscount: bn(0),
        maxCollateralDiscount: bn(0),
      });

      const { market, marginUsdDepositAmount } = await depositMargin(bs, genTrader(bs));
      const reportedDebt = await PerpMarketProxy.reportedDebt(market.marketId());

      assertBn.near(reportedDebt, marginUsdDepositAmount, bn(0.00001));
    });

    it('should expect sum of pnl to eq market debt', async () => {
      const { PerpMarketProxy } = systems();

      const collateral = collaterals()[0];
      const { trader, marketId, market, collateralDepositAmount } = await depositMargin(
        bs,
        genTrader(bs, { desiredCollateral: collateral, desiredMarginUsdDepositAmount: 10_000 })
      );

      const openOrder = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredSide: 1,
        desiredLeverage: 1,
      });
      await commitAndSettle(bs, marketId, trader, openOrder);

      const d1 = await PerpMarketProxy.getMarketDigest(marketId);
      const expectedReportedDebtAfterOpen = d1.totalCollateralValueUsd.add(
        await getTotalPositionPnl([trader], marketId)
      );
      const reportedDebt = await PerpMarketProxy.reportedDebt(market.marketId());
      assertBn.near(reportedDebt, expectedReportedDebtAfterOpen, bn(0.0000000001));
    });

    it('should expect sum of remaining all pnl to eq market debt (multiple markets)', async () => {
      const { PerpMarketProxy } = systems();

      const reportedDebts: BigNumber[] = [];
      let accumulatedReportedDebt = bn(0);
      for (const market of markets()) {
        const { trader, marketId, collateral, collateralDepositAmount } = await depositMargin(
          bs,
          genTrader(bs, { desiredMarket: market, desiredMarginUsdDepositAmount: 10_000 })
        );

        const openOrder = await genOrder(bs, market, collateral, collateralDepositAmount, {
          desiredSide: 1,
          desiredLeverage: 1,
        });
        await commitAndSettle(bs, marketId, trader, openOrder);

        const d1 = await PerpMarketProxy.getMarketDigest(marketId);
        const expectedReportedDebtAfterOpen = d1.totalCollateralValueUsd.add(
          await getTotalPositionPnl([trader], marketId)
        );
        const reportedDebt = await PerpMarketProxy.reportedDebt(marketId);
        assertBn.near(reportedDebt, expectedReportedDebtAfterOpen, bn(0.0000000001));

        reportedDebts.push(reportedDebt);
        accumulatedReportedDebt = accumulatedReportedDebt.add(reportedDebt);
      }

      // Markets are isolated so debt is not shared between them.
      reportedDebts.forEach((debt) => assertBn.gt(accumulatedReportedDebt, debt));
    });

    it('should expect sum of remaining all pnl to eq debt after a long period of trading');

    it('should expect reportedDebt/totalDebt to be updated appropriately sUSD (concrete)');

    it('should expect reportedDebt/totalDebt to be updated appropriately non-sUSD (concrete)', async () => {
      const { PerpMarketProxy, Core } = systems();

      const collateral = collateralsWithoutSusd()[0];
      const market = markets()[1]; // ETHPERP.
      const marketId = market.marketId();
      const trader = traders()[0];

      // Create a frictionless market for simplicity.
      await setMarketConfigurationById(bs, marketId, {
        makerFee: bn(0),
        takerFee: bn(0),
        maxFundingVelocity: bn(0),
        skewScale: bn(1_000_000_000), // An extremely large skewScale to minimise price impact.
      });
      await setMarketConfiguration(bs, {
        keeperProfitMarginPercent: bn(0),
        maxKeeperFeeUsd: bn(0),
        minCollateralDiscount: bn(0),
        maxCollateralDiscount: bn(0),
      });

      await market.aggregator().mockSetCurrentPrice(bn(2000));
      await collateral.setPrice(bn(1));

      // Deposit 1k USD worth of collateral into market for accountId.
      const { collateralDepositAmount, marginUsdDepositAmount } = await depositMargin(
        bs,
        genTrader(bs, {
          desiredMarginUsdDepositAmount: 1000,
          desiredCollateral: collateral,
          desiredMarket: market,
          desiredTrader: trader,
        })
      );

      // No debt should be in the same system.
      assertBn.equal(await PerpMarketProxy.reportedDebt(marketId), marginUsdDepositAmount);
      assertBn.isZero(await Core.getMarketTotalDebt(marketId));

      const openOrder = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredSide: 1,
        desiredLeverage: 1,
        desiredKeeperFeeBufferUsd: 0,
      });

      // Open a 1x long with deposit. This should also incur zero debt.
      //
      // NOTE: There is a slight extra in debt correction due to a tiny price impact incurred on the open order.
      //
      // reportedDebt = collateralValue + skew * (price + funding) - debtCorrection
      //              = 1000 + 0.5 * (2000 + 0) - 1000
      //              = 1000
      //
      // totalDebt = reportedDebt + netIssuance - collateralValue
      //           = 1000 + 0 - 1000
      //           = 0
      await commitAndSettle(bs, marketId, trader, openOrder);
      assertBn.near(await PerpMarketProxy.reportedDebt(marketId), bn(1000), bn(0.0001));
      assertBn.near(await Core.getMarketTotalDebt(marketId), bn(0), bn(0.0001));

      // Market does a 2x. Debt should increase appropriately.
      //
      // reportedDebt = collateralValue + skew * (price + funding) - debtCorrection
      //              = 1000 + 0.5 * (4000 + 0) - 1000
      //              = 2000
      //
      // totalDebt = reportedDebt + netIssuance - collateralValue
      //           = 2000 + 0 - 1000
      //           = 1000
      await market.aggregator().mockSetCurrentPrice(bn(4000));
      assertBn.near(await PerpMarketProxy.reportedDebt(marketId), bn(2000), bn(0.0001));
      assertBn.near(await Core.getMarketTotalDebt(marketId), bn(1000), bn(0.0001));

      // Close out the position without withdrawing profits.
      //
      // We expect no change to the debt.
      const closeOrder = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredSize: wei(openOrder.sizeDelta).mul(-1).toBN(),
        desiredKeeperFeeBufferUsd: 0,
      });
      await commitAndSettle(bs, marketId, trader, closeOrder);
      assertBn.near(await PerpMarketProxy.reportedDebt(marketId), bn(2000), bn(0.0001));
      assertBn.near(await Core.getMarketTotalDebt(marketId), bn(1000), bn(0.0001));

      // Withdraw all margin and exit.
      //
      // Expecting debt to stay at 1000 but also netIssuance to increase.
      //
      // reportedDebt = collateralValue + 0 * (price + funding) - debtCorrection
      //              = 0 + 0 - 0
      //              = 0
      //
      // totalDebt = reportedDebt + netIssuance - collateralValue
      //           = 0 + 1000 - 0
      //           = 1000
      await PerpMarketProxy.connect(trader.signer).withdrawAllCollateral(trader.accountId, marketId);
      assertBn.near(await PerpMarketProxy.reportedDebt(marketId), bn(0), bn(0.0001));
      assertBn.near(await Core.getMarketTotalDebt(marketId), bn(1000), bn(0.0001));
    });

    it('should incur debt when a profitable position exits and withdraws all', async () => {
      const { PerpMarketProxy, Core } = systems();

      const orderSide = genSide();
      const marginUsdDepositAmount = 10_000;
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(
        bs,
        genTrader(bs, { desiredMarginUsdDepositAmount: marginUsdDepositAmount })
      );

      const openOrder = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredSide: orderSide,
        desiredLeverage: 1,
      });
      await commitAndSettle(bs, marketId, trader, openOrder);

      // 10% Profit meaning there _must_ be some debt incurred after everything is withdrawn.
      const newMarketOraclePrice = wei(openOrder.oraclePrice)
        .mul(orderSide === 1 ? 1.1 : 0.9)
        .toBN();
      await market.aggregator().mockSetCurrentPrice(newMarketOraclePrice);

      // Close out the position with profit.
      const closeOrder = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredSize: wei(openOrder.sizeDelta).mul(-1).toBN(),
      });
      await commitAndSettle(bs, marketId, trader, closeOrder);

      // Verify there is no position.
      assertBn.isZero((await PerpMarketProxy.getPositionDigest(trader.accountId, marketId)).size);

      // Withdraw all collateral out of perp market.
      await PerpMarketProxy.connect(trader.signer).withdrawAllCollateral(trader.accountId, marketId);

      // Note reportedDebt is ZERO however total market debt is gt 0.
      const reportedDebt = await PerpMarketProxy.reportedDebt(marketId);
      assertBn.isZero(reportedDebt);

      // Market reportable debt includes issued sUSD paid out to the trader.
      const totalMarketDebt = await Core.getMarketTotalDebt(marketId);
      assertBn.gt(totalMarketDebt, 0);
      assertBn.lt(totalMarketDebt, bn(marginUsdDepositAmount));
    });

    forEach(times(5, () => genNumber(0.1, 0.3) * genOneOf([1, -1]))).it(
      'should reported same debt when skew=0 but with price fluctuations (%0.5f)',
      async (priceDeviation: number) => {
        const { PerpMarketProxy } = systems();

        const tradersGenerator = toRoundRobinGenerators(shuffle(traders()));
        const trader1 = tradersGenerator.next().value;
        const trader2 = tradersGenerator.next().value;

        const market = genOneOf(markets());
        const marketId = market.marketId();
        const marginUsdDepositAmount = genOneOf([5000, 10_000, 15_000]);
        const orderSide = genSide();

        // Deposit and open position for trader1.
        const deposit1 = await depositMargin(
          bs,
          genTrader(bs, {
            desiredMarket: market,
            desiredTrader: trader1,
            desiredMarginUsdDepositAmount: marginUsdDepositAmount,
          })
        );
        const order1 = await genOrder(bs, market, deposit1.collateral, deposit1.collateralDepositAmount, {
          desiredLeverage: 1,
          desiredSide: orderSide,
        });
        await commitAndSettle(bs, marketId, trader1, order1);

        // Deposit and open position for trader2 (other side).
        const deposit2 = await depositMargin(
          bs,
          genTrader(bs, {
            desiredMarket: market,
            desiredTrader: trader2,
            desiredMarginUsdDepositAmount: marginUsdDepositAmount,
          })
        );
        const order2 = await genOrder(bs, market, deposit2.collateral, deposit2.collateralDepositAmount, {
          desiredSize: order1.sizeDelta.mul(-1),
        });
        await commitAndSettle(bs, marketId, trader2, order2);

        const { skew, debtCorrection, totalCollateralValueUsd } = await PerpMarketProxy.getMarketDigest(marketId);
        const expectedReportedDebt = totalCollateralValueUsd.sub(debtCorrection);

        assertBn.isZero(skew);
        assertBn.equal(await PerpMarketProxy.reportedDebt(marketId), expectedReportedDebt);

        // Move the price.
        await market.aggregator().mockSetCurrentPrice(
          wei(order1.oraclePrice)
            .mul(1 + priceDeviation)
            .toBN()
        );

        // Expect reportedDebt to not change.
        assertBn.equal(await PerpMarketProxy.reportedDebt(marketId), expectedReportedDebt);
      }
    );

    it('should report collateral - debtCorrection when skew is zero (dn market, some positions)', async () => {
      const { PerpMarketProxy } = systems();

      const tradersGenerator = toRoundRobinGenerators(shuffle(traders()));
      const trader1 = tradersGenerator.next().value;
      const trader2 = tradersGenerator.next().value;

      const market = genOneOf(markets());
      const marketId = market.marketId();
      const marginUsdDepositAmount = genOneOf([5000, 10_000, 15_000]);
      const orderSide = genSide();

      // Deposit and open position for trader1.
      const deposit1 = await depositMargin(
        bs,
        genTrader(bs, {
          desiredMarket: market,
          desiredTrader: trader1,
          desiredMarginUsdDepositAmount: marginUsdDepositAmount,
        })
      );
      const order1 = await genOrder(bs, market, deposit1.collateral, deposit1.collateralDepositAmount, {
        desiredLeverage: 1,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader1, order1);

      // Deposit and open position for trader2 (other side).
      const deposit2 = await depositMargin(
        bs,
        genTrader(bs, {
          desiredMarket: market,
          desiredTrader: trader2,
          desiredMarginUsdDepositAmount: marginUsdDepositAmount,
        })
      );
      const order2 = await genOrder(bs, market, deposit2.collateral, deposit2.collateralDepositAmount, {
        desiredSize: order1.sizeDelta.mul(-1),
      });
      await commitAndSettle(bs, marketId, trader2, order2);

      const { skew, debtCorrection, totalCollateralValueUsd } = await PerpMarketProxy.getMarketDigest(marketId);
      const expectedReportedDebt = totalCollateralValueUsd.sub(debtCorrection);
      assertBn.isZero(skew);
      assertBn.equal(await PerpMarketProxy.reportedDebt(marketId), expectedReportedDebt);
    });

    it('should incur debt when trader is paid funding to hold position');

    it('should incur credit when trader pays funding to hold position');

    it('should reflect debt/credit in real time while position is still open');

    it('should generate credit when a neg pnl position exists and withdraws all');

    it('should generate credit when an underwater position is liquidated');

    it('should generate credit when price does not move and only fees and paid in/out');

    it('should incur no debt in a delta neutral market with high when price volatility');

    it('should incur small debt proportional to skew with high price volatility');

    it('should revert when marketId does not exist', async () => {
      const { PerpMarketProxy } = systems();
      const invalidMarketId = 42069;
      await assertRevert(
        PerpMarketProxy.reportedDebt(invalidMarketId),
        `MarketNotFound("${invalidMarketId}")`,
        PerpMarketProxy
      );
    });
  });
});
