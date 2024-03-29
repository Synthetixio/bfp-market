//SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IRewardsManagerModule} from "@synthetixio/main/contracts/interfaces/IRewardsManagerModule.sol";
import {IPerpRewardDistributor} from "./IPerpRewardDistributor.sol";

interface IPerpRewardDistributorFactoryModule {
    // --- Structs --- //

    struct CreatePerpRewardDistributorParameters {
        // The pool the distributor will be registered with.
        uint128 poolId;
        // The collateral(s) in the pool it must be registered against.
        address[] collateralTypes;
        // Name of the distributor to be created e.g, ETHPERP Distributor.
        string name;
        // The reward ERC20 token this distributor is meant to distribute.
        address token;
    }

    // --- Events --- //

    // @notice Emitted when a distributor is created.
    event RewardDistributorCreated(address distributor);

    // --- Mutations --- //

    /**
     * @notice Create a new RewardDistributor with Synthetix and initializes storage.
     *
     * The pool owner must then make a subsequent `.registerRewardDistributor` invocation against `collateralTypes`
     * specified in `PerpRewardDistributor.initialize`.
     */
    function createRewardDistributor(
        IPerpRewardDistributorFactoryModule.CreatePerpRewardDistributorParameters calldata data
    ) external returns (address);
}
