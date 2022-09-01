// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/*
This contract is just here to force ForwardProxy into hardhat's artifact list to be used in tests
*/

import {ForwardProxy} from "@ensuro/core/contracts/mocks/ForwardProxy.sol";

abstract contract MyForwardProxy is ForwardProxy {}
