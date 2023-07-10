//SPDX-License-Identifier: MIT
pragma solidity >=0.8.11 <0.9.0;

library PerpCollateral {
    // --- Storage --- //

    struct Data {
        // {collateralAddress: amount} (Amount of collateral deposited into this account).
        mapping(address => uint256) available;
    }

    function load(uint128 accountId, uint128 marketId) internal pure returns (PerpCollateral.Data storage collateral) {
        bytes32 s = keccak256(abi.encode("io.synthetix.bfp-market.PerpCollateral", accountId, marketId));

        assembly {
            collateral.slot := s
        }
    }
}