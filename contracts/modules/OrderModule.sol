//SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {Account} from "@synthetixio/main/contracts/storage/Account.sol";
import {AccountRBAC} from "@synthetixio/main/contracts/storage/AccountRBAC.sol";
import {DecimalMath} from "@synthetixio/core-contracts/contracts/utils/DecimalMath.sol";
import {SafeCastI128, SafeCastI256, SafeCastU128, SafeCastU256} from "@synthetixio/core-contracts/contracts/utils/SafeCast.sol";
import {IOrderModule} from "../interfaces/IOrderModule.sol";
import {Margin} from "../storage/Margin.sol";
import {Order} from "../storage/Order.sol";
import {PerpMarket} from "../storage/PerpMarket.sol";
import {PerpMarketConfiguration} from "../storage/PerpMarketConfiguration.sol";
import {Position} from "../storage/Position.sol";
import {ErrorUtil} from "../utils/ErrorUtil.sol";
import {MathUtil} from "../utils/MathUtil.sol";
import {PythUtil} from "../utils/PythUtil.sol";

contract OrderModule is IOrderModule {
    using DecimalMath for int256;
    using DecimalMath for int128;
    using DecimalMath for uint256;
    using DecimalMath for int64;
    using SafeCastI256 for int256;
    using SafeCastU256 for uint256;
    using SafeCastI128 for int128;
    using SafeCastU128 for uint128;
    using Order for Order.Data;
    using Position for Position.Data;
    using PerpMarket for PerpMarket.Data;

    // --- Runtime structs --- //

    struct Runtime_settleOrder {
        uint256 pythPrice;
        int256 accruedFunding;
        int256 pnl;
        uint256 fillPrice;
        Position.ValidatedTrade trade;
        Position.TradeParams params;
    }

    // --- Helpers --- //

    /**
     * @dev Reverts when `fillPrice > limitPrice` when long or `fillPrice < limitPrice` when short.
     */
    function isPriceToleranceExceeded(
        int128 sizeDelta,
        uint256 fillPrice,
        uint256 limitPrice
    ) private pure returns (bool) {
        return (sizeDelta > 0 && fillPrice > limitPrice) || (sizeDelta < 0 && fillPrice < limitPrice);
    }

    /**
     * @dev A stale order is one where time passed is max age or older (>=).
     */
    function isOrderStale(uint256 commitmentTime, uint256 maxOrderAge) private view returns (bool) {
        return block.timestamp - commitmentTime >= maxOrderAge;
    }

    /**
     * @dev Amount of time that has passed must be at least the minimum order age (>=).
     */
    function isOrderReady(uint256 commitmentTime, uint256 minOrderAge) private view returns (bool) {
        return block.timestamp - commitmentTime >= minOrderAge;
    }

    /**
     * @dev Ensures Pyth and CL prices do diverge too far.
     *
     *  e.g. A maximum of 3% price divergence with the following prices:
     * (1800, 1700) ~ 5.882353% divergence => PriceDivergenceExceeded
     * (1800, 1750) ~ 2.857143% divergence => Ok
     * (1854, 1800) ~ 3%        divergence => Ok
     * (1855, 1800) ~ 3.055556% divergence => PriceDivergenceExceeded
     */
    function isPriceDivergenceExceeded(
        uint256 onchainPrice,
        uint256 oraclePrice,
        uint256 priceDivergencePercent
    ) private pure returns (bool) {
        uint256 priceDelta = onchainPrice > oraclePrice
            ? onchainPrice.divDecimal(oraclePrice) - DecimalMath.UNIT
            : oraclePrice.divDecimal(onchainPrice) - DecimalMath.UNIT;

        return priceDelta > priceDivergencePercent;
    }

    /**
     * @dev Validates that an order can only be settled iff time and price is acceptable.
     */
    function validateOrderPriceReadiness(
        PerpMarket.Data storage market,
        PerpMarketConfiguration.GlobalData storage globalConfig,
        uint256 commitmentTime,
        Position.TradeParams memory params
    ) private view {
        if (isOrderStale(commitmentTime, globalConfig.maxOrderAge)) {
            revert ErrorUtil.OrderStale();
        }
        if (!isOrderReady(commitmentTime, globalConfig.minOrderAge)) {
            revert ErrorUtil.OrderNotReady();
        }

        uint256 onchainPrice = market.getOraclePrice();

        // Do not accept zero prices.
        if (onchainPrice == 0 || params.oraclePrice == 0) {
            revert ErrorUtil.InvalidPrice();
        }
        if (isPriceToleranceExceeded(params.sizeDelta, params.fillPrice, params.limitPrice)) {
            revert ErrorUtil.PriceToleranceExceeded(params.sizeDelta, params.fillPrice, params.limitPrice);
        }

        if (isPriceDivergenceExceeded(onchainPrice, params.oraclePrice, globalConfig.priceDivergencePercent)) {
            revert ErrorUtil.PriceDivergenceExceeded(params.oraclePrice, onchainPrice);
        }
    }

    /**
     * @dev Generic helper for funding recomputation during order management.
     */
    function recomputeFunding(PerpMarket.Data storage market, uint256 price) private {
        (int256 fundingRate, ) = market.recomputeFunding(price);
        emit FundingRecomputed(market.id, market.skew, fundingRate, market.getCurrentFundingVelocity());
    }

    /**
     * @dev Upon successful settlement, update `market` and account margin with `newPosition` details.
     */
    function stateUpdatePostSettlement(
        uint128 accountId,
        uint128 marketId,
        PerpMarket.Data storage market,
        Position.Data memory newPosition,
        uint256 newMarginUsd
    ) private {
        Position.Data storage oldPosition = market.positions[accountId];

        market.skew = market.skew + newPosition.size - oldPosition.size;
        market.size = (market.size.to256() + MathUtil.abs(newPosition.size) - MathUtil.abs(oldPosition.size)).to128();

        market.updateDebtCorrection(oldPosition, newPosition);

        // Update collateral used for margin if necessary. We only perform this if modifying an existing position.
        if (oldPosition.size != 0) {
            // @dev We're using getCollateralUsd and not marginUsd as we dont want price changes to be deducted yet.
            uint256 collateralUsd = Margin.getCollateralUsd(accountId, marketId, false /* usehaircutCollateralPrice */);
            Margin.updateAccountCollateral(accountId, market, newMarginUsd.toInt() - collateralUsd.toInt());
        }

        if (newPosition.size == 0) {
            delete market.positions[accountId];
        } else {
            market.positions[accountId].update(newPosition);
        }

        // Wipe the order, successfully settled!
        delete market.orders[accountId];
    }

    // --- Mutative --- //

    /**
     * @inheritdoc IOrderModule
     */
    function commitOrder(
        uint128 accountId,
        uint128 marketId,
        int128 sizeDelta,
        uint256 limitPrice,
        uint256 keeperFeeBufferUsd
    ) external {
        Account.loadAccountAndValidatePermission(accountId, AccountRBAC._PERPS_COMMIT_ASYNC_ORDER_PERMISSION);

        PerpMarket.Data storage market = PerpMarket.exists(marketId);

        if (market.orders[accountId].sizeDelta != 0) {
            revert ErrorUtil.OrderFound();
        }

        uint256 oraclePrice = market.getOraclePrice();

        PerpMarketConfiguration.Data storage marketConfig = PerpMarketConfiguration.load(marketId);

        // Validates whether this order would lead to a valid 'next' next position (plethora of revert errors).
        //
        // NOTE: `fee` here does _not_ matter. We recompute the actual order fee on settlement. The same is true for
        // the keeper fee. These fees provide an approximation on remaining margin and hence infer whether the subsequent
        // order will reach liquidation or insufficient margin for the desired leverage.
        Position.ValidatedTrade memory trade = Position.validateTrade(
            accountId,
            market,
            Position.TradeParams(
                sizeDelta,
                oraclePrice,
                Order.getFillPrice(market.skew, marketConfig.skewScale, sizeDelta, oraclePrice),
                marketConfig.makerFee,
                marketConfig.takerFee,
                limitPrice,
                keeperFeeBufferUsd
            )
        );

        market.orders[accountId].update(Order.Data(sizeDelta, block.timestamp, limitPrice, keeperFeeBufferUsd));
        emit OrderCommitted(accountId, marketId, block.timestamp, sizeDelta, trade.orderFee, trade.keeperFee);
    }

    /**
     * @inheritdoc IOrderModule
     */
    function settleOrder(uint128 accountId, uint128 marketId, bytes calldata priceUpdateData) external payable {
        PerpMarket.Data storage market = PerpMarket.exists(marketId);

        Order.Data storage order = market.orders[accountId];
        Position.Data storage position = market.positions[accountId];
        Runtime_settleOrder memory runtime;

        // No order available to settle.
        if (order.sizeDelta == 0) {
            revert ErrorUtil.OrderNotFound();
        }

        PerpMarketConfiguration.GlobalData storage globalConfig = PerpMarketConfiguration.load();
        PerpMarketConfiguration.Data storage marketConfig = PerpMarketConfiguration.load(marketId);

        runtime.pythPrice = PythUtil.parsePythPrice(globalConfig, marketConfig, order.commitmentTime, priceUpdateData);
        runtime.fillPrice = Order.getFillPrice(market.skew, marketConfig.skewScale, order.sizeDelta, runtime.pythPrice);
        runtime.params = Position.TradeParams(
            order.sizeDelta,
            runtime.pythPrice,
            runtime.fillPrice,
            marketConfig.makerFee,
            marketConfig.takerFee,
            order.limitPrice,
            order.keeperFeeBufferUsd
        );

        validateOrderPriceReadiness(market, globalConfig, order.commitmentTime, runtime.params);

        recomputeFunding(market, runtime.pythPrice);

        runtime.trade = Position.validateTrade(accountId, market, runtime.params);

        (, runtime.accruedFunding, runtime.pnl, ) = Position.getHealthData(
            market,
            position.size,
            position.entryPrice,
            position.entryFundingAccrued,
            runtime.trade.newMarginUsd,
            runtime.pythPrice,
            marketConfig
        );

        stateUpdatePostSettlement(
            accountId,
            marketId,
            market,
            runtime.trade.newPosition,
            // @dev This is (oldMargin - orderFee - keeperFee). Where oldMargin has pnl, accruedFunding and prev fees taken into account.
            runtime.trade.newMarginUsd
        );

        // Keeper fees can be set to zero.
        if (runtime.trade.keeperFee > 0) {
            globalConfig.synthetix.withdrawMarketUsd(marketId, msg.sender, runtime.trade.keeperFee);
        }

        emit OrderSettled(
            accountId,
            marketId,
            block.timestamp,
            runtime.params.sizeDelta,
            runtime.trade.orderFee,
            runtime.trade.keeperFee,
            runtime.accruedFunding,
            runtime.pnl,
            runtime.fillPrice
        );
    }

    /**
     * @inheritdoc IOrderModule
     */
    function cancelStaleOrder(uint128 accountId, uint128 marketId) external {
        PerpMarket.Data storage market = PerpMarket.exists(marketId);

        Order.Data storage order = market.orders[accountId];
        if (order.sizeDelta == 0) {
            revert ErrorUtil.OrderNotFound();
        }

        if (!isOrderStale(order.commitmentTime, PerpMarketConfiguration.load().maxOrderAge)) {
            revert ErrorUtil.OrderNotStale();
        }

        emit OrderCanceled(accountId, marketId, 0, order.commitmentTime);
        delete market.orders[accountId];
    }

    /**
     * @inheritdoc IOrderModule
     */
    function cancelOrder(uint128 accountId, uint128 marketId, bytes calldata priceUpdateData) external payable {
        PerpMarket.Data storage market = PerpMarket.exists(marketId);
        Account.Data storage account = Account.exists(accountId);

        Order.Data storage order = market.orders[accountId];

        // No order available to settle.
        if (order.sizeDelta == 0) {
            revert ErrorUtil.OrderNotFound();
        }
        PerpMarketConfiguration.GlobalData storage globalConfig = PerpMarketConfiguration.load();
        PerpMarketConfiguration.Data storage marketConfig = PerpMarketConfiguration.load(marketId);

        if (!isOrderReady(order.commitmentTime, globalConfig.minOrderAge)) {
            revert ErrorUtil.OrderNotReady();
        }
        bool isAccountOwner = msg.sender == account.rbac.owner;

        // If order is stale allow cancelation from owner regardless of price.
        if (isOrderStale(order.commitmentTime, globalConfig.maxOrderAge)) {
            // Only allow owner to clear stale orders
            if (!isAccountOwner) {
                revert ErrorUtil.OrderStale();
            }
        } else {
            // Order is within settlement window. Check if price tolerance has exceeded.
            uint256 pythPrice = PythUtil.parsePythPrice(
                globalConfig,
                marketConfig,
                order.commitmentTime,
                priceUpdateData
            );
            uint256 fillPrice = Order.getFillPrice(market.skew, marketConfig.skewScale, order.sizeDelta, pythPrice);
            uint256 onchainPrice = market.getOraclePrice();

            if (isPriceDivergenceExceeded(onchainPrice, pythPrice, globalConfig.priceDivergencePercent)) {
                revert ErrorUtil.PriceDivergenceExceeded(pythPrice, onchainPrice);
            }

            if (!isPriceToleranceExceeded(order.sizeDelta, fillPrice, order.limitPrice)) {
                revert ErrorUtil.PriceToleranceNotExceeded(order.sizeDelta, fillPrice, order.limitPrice);
            }
        }

        uint256 keeperFee = isAccountOwner ? 0 : Order.getSettlementKeeperFee(order.keeperFeeBufferUsd);
        if (keeperFee > 0) {
            Margin.updateAccountCollateral(accountId, market, keeperFee.toInt() * -1);
            globalConfig.synthetix.withdrawMarketUsd(marketId, msg.sender, keeperFee);
        }

        emit OrderCanceled(accountId, marketId, keeperFee, order.commitmentTime);
        delete market.orders[accountId];
    }

    // --- Views --- //

    /**
     * @inheritdoc IOrderModule
     */
    function getOrderDigest(uint128 accountId, uint128 marketId) external view returns (Order.Data memory) {
        Account.exists(accountId);
        PerpMarket.Data storage market = PerpMarket.exists(marketId);
        return market.orders[accountId];
    }

    /**
     * @inheritdoc IOrderModule
     */
    function getOrderFees(
        uint128 marketId,
        int128 sizeDelta,
        uint256 keeperFeeBufferUsd
    ) external view returns (uint256 orderFee, uint256 keeperFee) {
        PerpMarket.Data storage market = PerpMarket.exists(marketId);
        PerpMarketConfiguration.Data storage marketConfig = PerpMarketConfiguration.load(marketId);

        orderFee = Order.getOrderFee(
            sizeDelta,
            Order.getFillPrice(market.skew, marketConfig.skewScale, sizeDelta, market.getOraclePrice()),
            market.skew,
            marketConfig.makerFee,
            marketConfig.takerFee
        );
        keeperFee = Order.getSettlementKeeperFee(keeperFeeBufferUsd);
    }

    /**
     * @inheritdoc IOrderModule
     */
    function getFillPrice(uint128 marketId, int128 size) external view returns (uint256) {
        PerpMarket.Data storage market = PerpMarket.exists(marketId);
        return
            Order.getFillPrice(
                market.skew,
                PerpMarketConfiguration.load(marketId).skewScale,
                size,
                market.getOraclePrice()
            );
    }

    /**
     * @inheritdoc IOrderModule
     */
    function getOraclePrice(uint128 marketId) external view returns (uint256) {
        return PerpMarket.exists(marketId).getOraclePrice();
    }
}
