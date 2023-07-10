//SPDX-License-Identifier: MIT
pragma solidity >=0.8.11 <0.9.0;

import "@synthetixio/core-contracts/contracts/interfaces/IERC20.sol";
import {Account} from "@synthetixio/main/contracts/storage/Account.sol";
import {SafeCastU256, SafeCastI256} from "@synthetixio/core-contracts/contracts/utils/SafeCast.sol";
import {PerpMarketFactoryConfiguration} from "../storage/PerpMarketFactoryConfiguration.sol";
import {PerpMarket} from "../storage/PerpMarket.sol";
import {PerpCollateral} from "../storage/PerpCollateral.sol";
import {Order} from "../storage/Order.sol";
import {Position} from "../storage/Position.sol";
import {PerpErrors} from "../storage/PerpErrors.sol";
import {MathUtil} from "../utils/MathUtil.sol";
import "../interfaces/IPerpCollateralModule.sol";

contract PerpCollateralModule is IPerpCollateralModule {
    using PerpMarket for PerpMarket.Data;
    using Position for Position.Data;
    using SafeCastU256 for uint256;
    using SafeCastI256 for int256;

    /**
     * @inheritdoc IPerpCollateralModule
     */
    function transferTo(uint128 accountId, uint128 marketId, address collateral, int256 amountDelta) external {
        // Ensure account actually exists (reverts with `AccountNotFound`).
        Account.exists(accountId);

        PerpMarket.Data storage market = PerpMarket.load(marketId);
        PerpCollateral.Data storage collaterals = PerpCollateral.load(accountId, marketId);

        // Prevent collateral transfers when there's a pending order.
        Order.Data storage order = market.orders[accountId];
        if (order.sizeDelta != 0) {
            revert PerpErrors.OrderFound(accountId);
        }

        PerpMarketFactoryConfiguration.Data storage config = PerpMarketFactoryConfiguration.load();
        uint256 absAmountDelta = MathUtil.abs(amountDelta);
        uint256 availableAmount = collaterals.available[collateral];

        // TODO: Check if collateral is supported by bfp-markets (not just Synthetix Core)

        if (amountDelta > 0) {
            // Positive means to deposit into the markets.
            uint256 maxAllowed = config.maxCollaterals[collateral];

            // Verify whether this will exceed the maximum allowable collateral amount.
            if (availableAmount + absAmountDelta > maxAllowed) {
                revert PerpErrors.MaxCollateralExceeded(amountDelta, maxAllowed);
            }

            collaterals.available[collateral] += absAmountDelta;
            IERC20(collateral).transferFrom(msg.sender, address(this), absAmountDelta);
            emit Transfer(msg.sender, address(this), amountDelta);
        } else if (amountDelta < 0) {
            // Negative means to withdraw from the markets.

            // Verify the collateral previously associated to this account is enough to cover withdraws.
            if (availableAmount < absAmountDelta) {
                revert PerpErrors.InsufficientCollateral(availableAmount.toInt(), amountDelta);
            }

            collaterals.available[collateral] -= absAmountDelta;

            // If an open position exists, verify this does _not_ place them into instant liquidation.
            Position.Data storage position = market.positions[accountId];
            if (position.size != 0) {
                uint256 oraclePrice = market.oraclePrice();
                if (position.canLiquidate(oraclePrice)) {
                    revert PerpErrors.CanLiquidatePosition(accountId);
                }
            }

            IERC20(collateral).transferFrom(address(this), msg.sender, absAmountDelta);
            emit Transfer(address(this), msg.sender, amountDelta);
        } else {
            // A zero amount is a no-op.
            return;
        }
    }
}