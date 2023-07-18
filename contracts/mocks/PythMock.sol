//SPDX-License-Identifier: MIT
pragma solidity >=0.8.11 <0.9.0;

import {MockPyth as BaseMockPyth} from "@synthetixio/oracle-manager/contracts/mocks/pyth/MockPyth.sol";

// solhint-disable-next-line no-empty-blocks
contract PythMock is BaseMockPyth {
    constructor(
        uint _validTimePeriod,
        uint _singleUpdateFeeInWei
    ) BaseMockPyth(_validTimePeriod, _singleUpdateFeeInWei) {}
}