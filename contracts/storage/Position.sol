//SPDX-License-Identifier: MIT
pragma solidity >=0.8.11 <0.9.0;

import {DecimalMath} from "@synthetixio/core-contracts/contracts/utils/DecimalMath.sol";
import {SafeCastI256, SafeCastU256, SafeCastU128} from "@synthetixio/core-contracts/contracts/utils/SafeCast.sol";
import {INodeModule} from "@synthetixio/oracle-manager/contracts/interfaces/INodeModule.sol";
import {PerpErrors} from "./PerpErrors.sol";
import {Order} from "./Order.sol";
import {PerpMarket} from "./PerpMarket.sol";
import {PerpMarketConfiguration} from "./PerpMarketConfiguration.sol";
import {PerpCollateral} from "./PerpCollateral.sol";
import {MathUtil} from "../utils/MathUtil.sol";

/**
 * @dev An open position on a specific perp market within bfp-market.
 */
library Position {
    using DecimalMath for uint256;
    using DecimalMath for int256;
    using DecimalMath for int128;
    using SafeCastU128 for uint128;
    using SafeCastI256 for int256;
    using SafeCastU256 for uint256;
    using PerpMarket for PerpMarket.Data;

    // --- Structs --- //

    struct TradeParams {
        int128 sizeDelta;
        uint256 oraclePrice;
        uint256 fillPrice;
        uint128 makerFee;
        uint128 takerFee;
        uint256 limitPrice;
        uint256 keeperFeeBufferUsd;
    }

    // --- Storage --- //

    struct Data {
        // Owner of position.
        uint128 accountId;
        // Market this position belongs to (e.g. wstETHPERP)
        uint128 marketId;
        // Size (in native units e.g. wstETH)
        int128 size;
        // The market's accumulated accrued funding at position open.
        int256 entryFundingAccrued;
        // The fill price at which this position was opened with.
        uint256 entryPrice;
        // Cost in USD to open this positions (e.g. keeper + order fees).
        uint256 feesIncurredUsd;
    }

    /**
     * @dev Return whether a change in a position's size would violate the max market value constraint.
     *
     * A perp market has one configurable variable `maxMarketSize` which constraints the maximum open interest
     * a market can have on either side.
     */
    function validateMaxOi(
        uint256 maxMarketSize,
        int256 marketSkew,
        uint256 marketSize,
        int256 currentSize,
        int256 newSize
    ) internal pure {
        // Allow users to reduce an order no matter the market conditions.
        if (MathUtil.sameSide(currentSize, newSize) && MathUtil.abs(newSize) <= MathUtil.abs(currentSize)) {
            return;
        }

        // Either the user is flipping sides, or they are increasing an order on the same side they're already on;
        // we check that the side of the market their order is on would not break the limit.
        int256 newSkew = marketSkew - currentSize + newSize;
        int256 newMarketSize = (marketSize - MathUtil.abs(currentSize) + MathUtil.abs(newSize)).toInt();

        int256 newSideSize;
        if (0 < newSize) {
            // long case: marketSize + skew
            //            = (|longSize| + |shortSize|) + (longSize + shortSize)
            //            = 2 * longSize
            newSideSize = newMarketSize + newSkew;
        } else {
            // short case: marketSize - skew
            //            = (|longSize| + |shortSize|) - (longSize + shortSize)
            //            = 2 * -shortSize
            newSideSize = newMarketSize - newSkew;
        }

        // newSideSize still includes an extra factor of 2 here, so we will divide by 2 in the actual condition.
        if (maxMarketSize < MathUtil.abs(newSideSize / 2)) {
            revert PerpErrors.MaxMarketSizeExceeded();
        }
    }

    /**
     * @dev Given an open position (same account) and trade params return the subsequent position.
     */
    function validateTrade(
        uint128 accountId,
        uint128 marketId,
        Position.TradeParams memory params
    ) internal view returns (Position.Data memory newPosition, uint256 fee, uint256 keeperFee) {
        if (params.sizeDelta == 0) {
            revert PerpErrors.NilOrder();
        }

        PerpMarket.Data storage market = PerpMarket.exists(marketId);
        Position.Data storage currentPosition = market.positions[accountId];

        // Check if the `currentPosition` can be immediately liquidated.
        if (canLiquidate(currentPosition, params.fillPrice)) {
            revert PerpErrors.CanLiquidatePosition(accountId);
        }

        PerpMarketConfiguration.GlobalData storage globalConfig = PerpMarketConfiguration.load();
        PerpMarketConfiguration.Data storage marketConfig = PerpMarketConfiguration.load(marketId);

        // Derive fees incurred if this order were to be settled successfully.
        fee = Order.getOrderFee(params.sizeDelta, params.fillPrice, market.skew, params.makerFee, params.takerFee);
        keeperFee = Order.getKeeperFee(params.keeperFeeBufferUsd, params.oraclePrice);

        // Assuming there is an existing position (no open position will be a noop), determine if they have enough
        // margin to continue this operation. Ensuring we do not allow them to place an open position into instant
        // liquidation. This can be done by inferring their "remainingMargin".
        //
        // We do this by inferring the `remainingMargin = (sum(collateral * price)) + pnl + fundingAccrued - fee` such that
        // if remainingMargin < minMarginThreshold then this must revert.
        //
        // NOTE: The use of fillPrice and not oraclePrice to perform calculations below. Also consider this is the
        // "raw" remaining margin which does not account for fees (liquidation fees, penalties, liq premium fees etc.).
        int256 _remainingMargin = getRemainingMargin(currentPosition, params.fillPrice);
        if (_remainingMargin < 0) {
            revert PerpErrors.InsufficientMargin();
        }

        // Checks whether the current position's margin (if above 0), doesn't fall below min margin for liquidations.
        uint256 _liquidationMargin = getLiquidationMargin(currentPosition, params.fillPrice);
        if (MathUtil.abs(currentPosition.size) != 0 && _remainingMargin.toUint() <= _liquidationMargin) {
            revert PerpErrors.CanLiquidatePosition(accountId);
        }

        newPosition = Position.Data({
            accountId: accountId,
            marketId: marketId,
            size: currentPosition.size + params.sizeDelta,
            entryFundingAccrued: market.currentFundingAccruedComputed,
            entryPrice: params.fillPrice,
            feesIncurredUsd: fee + keeperFee
        });

        // Minimum position margin checks, however if a position is decreasing (i.e. derisking by lowering size), we
        // avoid this completely due to positions at min margin would never be allowed to lower size.
        bool positionDecreasing = MathUtil.sameSide(currentPosition.size, newPosition.size) &&
            MathUtil.abs(newPosition.size) < MathUtil.abs(currentPosition.size);
        if (!positionDecreasing) {
            // Again, to deal with positions at minMarginUsd, we add back to fee (keeper and order) because
            // position may never be able to open on the first trade due to fees deducted on entry.
            //
            // minMargin + fee <= margin is equivalent to minMargin <= margin - fee
            if (_remainingMargin.toUint() < globalConfig.minMarginUsd) {
                revert PerpErrors.InsufficientMargin();
            }
        }

        // TODO: Check that the resulting new postion's margin is above liquidationMargin + liqPremium
        //
        // Check on liqMargin + liqPremium is from PerpsV2. This may change so leaving it TODO for now. Might add
        // this back temporarily for completeness.
        //
        // ---
        //
        // check that new position margin is above liquidation margin
        // (above, in _recomputeMarginWithDelta() we checked the old position, here we check the new one)
        //
        // Liquidation margin is considered without a fee (but including premium), because it wouldn't make sense to allow
        // a trade that will make the position liquidatable.
        //
        // note: we use `oraclePrice` here as `liquidationPremium` calcs premium based not current skew.
        // uint liqPremium = _liquidationPremium(newPos.size, params.oraclePrice);
        // uint liqMargin = _liquidationMargin(newPos.size, params.oraclePrice).add(liqPremium);
        // if (newMargin <= liqMargin) {
        //     return (newPos, 0, Status.CanLiquidate);
        // }

        // Check the new position hasn't hit max leverage.
        //
        // NOTE: We also consider including the paid fee as part of the margin, again due to UX. Otherwise,
        // maxLeverage would always below position leverage due to fees paid out to open trade. We'll allow
        // a little extra headroom for rounding errors.
        //
        // NOTE: maxLeverage is stored as a uint8 but leverage is uint256
        int256 leverage = (newPosition.size * params.fillPrice.toInt()) /
            (_remainingMargin + fee.toInt() + keeperFee.toInt());
        if (marketConfig.maxLeverage < MathUtil.abs(leverage)) {
            revert PerpErrors.MaxLeverageExceeded();
        }

        // Check the new position hasn't hit max OI on either side.
        validateMaxOi(marketConfig.maxMarketSize, market.skew, market.size, currentPosition.size, newPosition.size);
    }

    // --- Member --- //

    /**
     * @dev Returns a position's accrued funding.
     */
    function getAccruedFunding(Position.Data storage self, uint256 price) internal view returns (int256) {
        if (self.size == 0) {
            return 0;
        }

        PerpMarket.Data storage market = PerpMarket.load(self.marketId);
        int256 netFundingPerUnit = market.getNextFunding(price) - self.entryFundingAccrued;
        return self.size * netFundingPerUnit;
    }

    /**
     * @dev Returns the "raw" margin in USD before fees, `sum(p.collaterals.map(c => c.amount * c.price))`.
     */
    function getCollateralUsd(Position.Data storage self) internal view returns (uint256) {
        PerpMarketConfiguration.GlobalData storage globalConfig = PerpMarketConfiguration.load();
        PerpCollateral.GlobalData storage globalCollateralConfig = PerpCollateral.load();

        uint256 collateralValueUsd = 0;
        uint256 length = globalCollateralConfig.availableAddresses.length;
        PerpCollateral.Data storage accountCollaterals = PerpCollateral.load(self.accountId, self.marketId);

        PerpCollateral.CollateralType memory currentCollateral;
        address currentCollateralType;
        for (uint256 i = 0; i < length; ) {
            currentCollateralType = globalCollateralConfig.availableAddresses[i];
            currentCollateral = globalCollateralConfig.available[currentCollateralType];
            uint256 price = INodeModule(globalConfig.oracleManager)
                .process(currentCollateral.oracleNodeId)
                .price
                .toUint();
            collateralValueUsd += accountCollaterals.available[currentCollateralType] * price;
            unchecked {
                i++;
            }
        }

        return collateralValueUsd;
    }

    /**
     * @dev Return a position's remaining margin.
     *
     * The remaining margin is defined as sum(collateral * price) + PnL + funding in USD.
     *
     * We return an `int` here as after all fees and PnL, this can be negative. The caller should verify that this
     * is positive before proceeding with further operations.
     */
    function getRemainingMargin(Position.Data storage self, uint256 price) internal view returns (int256) {
        int256 margin = getCollateralUsd(self).toInt();
        int256 funding = getAccruedFunding(self, price);

        // Calculate this position's PnL
        int256 priceDelta = price.toInt() - self.entryPrice.toInt();
        int256 pnl = self.size * priceDelta;

        // Ensure we also deduct the realized losses in fees to open trade.
        return margin + pnl + funding - self.feesIncurredUsd.toInt();
    }

    /**
     * @dev Returns a number in USD which if a position's remaining margin is lte then position can be liquidated.
     */
    function getLiquidationMargin(Position.Data storage self, uint256 price) internal view returns (uint256) {
        PerpMarketConfiguration.GlobalData storage globalConfig = PerpMarketConfiguration.load();
        PerpMarketConfiguration.Data storage marketConfig = PerpMarketConfiguration.load(self.marketId);

        uint256 absSize = MathUtil.abs(self.size);

        // Calculates the liquidation buffer (penalty).
        //
        // e.g. 3 * 1800 * 0.0075 = 40.5
        uint256 liquidationBuffer = absSize * price * marketConfig.liquidationBufferPercent;

        // Calculates the liquidation fee.
        //
        // This is a fee charged against the margin on liquidation and paid to LPers. The fee is proportional to
        // the position size and bounded by `min >= liqFee <= max`. This proportion is based on each market's
        // configured liquidation fee ratio.
        //
        // e.g. 3 * 1800 * 0.0002 = 1.08
        uint256 proportionalFee = absSize * price * marketConfig.liquidationFeePercent;
        uint256 maxKeeperFee = globalConfig.maxKeeperFeeUsd;
        uint256 boundedProportionalFee = proportionalFee > maxKeeperFee ? maxKeeperFee : proportionalFee;
        uint256 minKeeperFee = globalConfig.minKeeperFeeUsd;
        uint256 boundedLiquidationFee = boundedProportionalFee > minKeeperFee ? boundedProportionalFee : minKeeperFee;

        // If the remainingMargin is <= this number then position can be liquidated.
        //
        // e.g. 40.5 + 1.08 + 2 = 43.58
        return liquidationBuffer + boundedLiquidationFee + globalConfig.keeperLiquidationFeeUsd;
    }

    /**
     * @dev This is the additional premium we charge upon liquidation.
     *
     * Similar to fillPrice, but we disregard the skew (by assuming it's zero). Which is basically the calculation
     * when we compute as if taking the position from 0 to x. In practice, the premium component of the
     * liquidation will just be (size / skewScale) * (size * price).
     *
     * It adds a configurable multiplier that can be used to increase the margin that goes to feePool.
     *
     * For instance, if size of the liquidation position is 100, oracle price is 1200 and skewScale is 1M then,
     *  size    = abs(-100)
     *          = 100
     *  premium = 100 / 1,000,000 * (100 * 1200) * multiplier
     *          = 12 * multiplier
     */
    function getLiquidationPremium(Position.Data storage self, uint256 price) internal view returns (uint256) {
        if (self.size == 0) {
            return 0;
        }

        PerpMarketConfiguration.Data storage marketConfig = PerpMarketConfiguration.load(self.marketId);
        uint256 notionalUsd = MathUtil.abs(self.size) * price;
        return
            (MathUtil.abs(self.size) / (marketConfig.skewScale)) *
            notionalUsd *
            marketConfig.liquidationPremiumMultiplier;
    }

    /**
     * @dev Returns whether this position can be liquidated given the current `price`.
     */
    function canLiquidate(Position.Data storage self, uint256 price) internal view returns (bool) {
        // No liquidating empty positions.
        if (self.size == 0) {
            return false;
        }
        uint256 remaining = MathUtil
            .max(0, getRemainingMargin(self, price) - getLiquidationPremium(self, price).toInt())
            .toUint();
        return remaining <= getLiquidationMargin(self, price);
    }

    /**
     * @dev Clears the current position struct in-place of any stored data.
     */
    function update(Position.Data storage self, Position.Data memory data) internal {
        self.accountId = data.accountId;
        self.marketId = data.marketId;
        self.size = data.size;
        self.entryFundingAccrued = data.entryFundingAccrued;
        self.entryPrice = data.entryPrice;
        self.feesIncurredUsd = data.feesIncurredUsd;
    }
}
