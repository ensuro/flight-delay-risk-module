// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {IPremiumsAccount} from "@ensuro/core/contracts/interfaces/IPremiumsAccount.sol";
import {Policy} from "@ensuro/core/contracts/Policy.sol";
import {RiskModule} from "@ensuro/core/contracts/RiskModule.sol";
import {Chainlink} from "@chainlink/contracts/src/v0.8/Chainlink.sol";
import {ChainlinkClientUpgradeable} from "./dependencies/ChainlinkClientUpgradeable.sol";

/**
 * @title Flight Delay Risk Module
 * @dev Risk Module that resolves policy based in actual arrival date of flight
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract FlightDelayRiskModule is RiskModule, ChainlinkClientUpgradeable {
  using Chainlink for Chainlink.Request;

  bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");
  bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");
  // Multiplier to calculate expiration = expectedArrival + tolerance + delayTime * DELAY_EXPIRATION_TIMES
  uint40 public constant DELAY_EXPIRATION_TIMES = 5;

  struct PolicyData {
    Policy.PolicyData ensuroPolicy;
    string flight;
    uint40 departure;
    uint40 expectedArrival;
    uint40 tolerance;
  }

  struct OracleParams {
    address oracle;
    uint96 delayTime;
    uint256 fee;
    bytes16 dataJobId;
    bytes16 sleepJobId;
  }

  OracleParams internal _oracleParams;

  mapping(bytes32 => uint256) internal _pendingQueries;
  mapping(uint256 => PolicyData) internal _policies;

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_, IPremiumsAccount premiumsAccount_)
    RiskModule(policyPool_, premiumsAccount_)
  {} // solhint-disable-line no-empty-blocks

  /**
   * @dev Initializes the RiskModule
   * @param name_ Name of the Risk Module
   * @param collRatio_ Collateralization ratio to compute solvency requirement as % of payout (in ray)
   * @param ensuroPpFee_ % of pure premium that will go for Ensuro treasury (in ray)
   * @param srRoc_ return on capital paid to Senior LPs (annualized percentage - in ray)
   * @param maxPayoutPerPolicy_ Maximum payout per policy (in wad)
   * @param exposureLimit_ Max exposure (sum of payouts) to be allocated to this module (in wad)
   * @param wallet_ Address of the RiskModule provider
   * @param linkToken_ Address of ChainLink LINK token
   * @param oracleParams_ Parameters of the Oracle
   */
  function initialize(
    string memory name_,
    uint256 collRatio_,
    uint256 ensuroPpFee_,
    uint256 srRoc_,
    uint256 maxPayoutPerPolicy_,
    uint256 exposureLimit_,
    address wallet_,
    address linkToken_,
    OracleParams memory oracleParams_
  ) public initializer {
    __RiskModule_init(
      name_,
      collRatio_,
      ensuroPpFee_,
      srRoc_,
      maxPayoutPerPolicy_,
      exposureLimit_,
      wallet_
    );
    __ChainlinkClient_init();
    __FlightDelayRiskModule_init_unchained(linkToken_, oracleParams_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __FlightDelayRiskModule_init_unchained(
    address linkToken_,
    OracleParams memory oracleParams_
  ) internal initializer {
    setChainlinkToken(linkToken_);
    _oracleParams = oracleParams_;
  }

  function setOracleParams(OracleParams memory newParams)
    external
    onlyComponentRole(ORACLE_ADMIN_ROLE)
  {
    _oracleParams = newParams;
  }

  function oracleParams() external view returns (OracleParams memory) {
    return _oracleParams;
  }

  /**
   * @dev Creates a new policy
   * @param flight Flight Number as String (ex: NAX105)
   * @param departure Departure in epoch seconds (ex: 1631817600)
   * @param expectedArrival Expected arrival in epoch seconds (ex: 1631824800)
   * @param tolerance In seconds, the tolerance margin after expectedArrival before trigger the policy
   * @param payout Payout for customer in case policy is triggered
   * @param premium Premium the customer pays
   * @param lossProb Probability of policy being triggered
   * @param customer Customer address (to take premium from and send payout)
   */
  function newPolicy(
    string memory flight,
    uint40 departure,
    uint40 expectedArrival,
    uint40 tolerance,
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    address customer,
    uint96 internalId
  ) external onlyComponentRole(PRICER_ROLE) returns (uint256) {
    require(expectedArrival > block.timestamp, "expectedArrival can't be in the past");
    require(departure != 0 && expectedArrival > departure, "expectedArrival <= departure!");
    uint40 expiration = expectedArrival +
      tolerance +
      uint40(_oracleParams.delayTime) *
      DELAY_EXPIRATION_TIMES;
    Policy.PolicyData memory ensuroPolicy = _newPolicy(
      payout,
      premium,
      lossProb,
      expiration,
      customer,
      internalId
    );
    PolicyData storage policy = _policies[ensuroPolicy.id];
    policy.ensuroPolicy = ensuroPolicy;
    policy.flight = flight;
    policy.departure = departure;
    policy.expectedArrival = expectedArrival;
    policy.tolerance = tolerance;

    uint256 until = expectedArrival + tolerance + uint256(_oracleParams.delayTime);
    _chainlinkRequest(ensuroPolicy.id, policy, until);
    return ensuroPolicy.id;
  }

  function _chainlinkRequest(
    uint256 policyId,
    PolicyData storage policy,
    uint256 until
  ) internal {
    // request takes a JobID, a callback address, and callback function as input
    Chainlink.Request memory req = buildChainlinkRequest(
      until == 0 ? _oracleParams.dataJobId : _oracleParams.sleepJobId,
      address(this),
      this.fulfill.selector
    );
    req.add("flight", policy.flight);
    req.add("endpoint", "actualarrivaldate");
    req.addUint("departure", policy.departure);
    if (until > 0) {
      req.addUint("until", until);
    }

    // Sends the request with the amount of payment specified to the oracle
    // (results will arrive with the callback = later)
    bytes32 queryId = sendChainlinkRequestTo(_oracleParams.oracle, req, _oracleParams.fee);
    _pendingQueries[queryId] = policyId;
  }

  /**
   * @dev Forces the resolution of the policy (without waiting Chainlink scheduled on creation)
   * @param policyId The id of the policy previously created (in newPolicy)
   */
  function resolvePolicy(uint256 policyId)
    external
    onlyComponentRole(PRICER_ROLE)
    returns (uint256)
  {
    PolicyData storage policy = _policies[policyId];
    require(policy.expectedArrival != 0, "Policy not found!");
    _chainlinkRequest(policyId, policy, 0);
    return policyId;
  }

  function fulfill(bytes32 queryId, int256 actualArrivalDate)
    public
    recordChainlinkFulfillment(queryId)
  {
    uint256 policyId = _pendingQueries[queryId];
    require(policyId != 0, "queryId not found!");
    PolicyData storage policy = _policies[policyId];

    if (actualArrivalDate == 0) {
      if (block.timestamp > (policy.expectedArrival + policy.tolerance)) {
        // Treat as arrived after tolerance
        actualArrivalDate = int256(uint256((policy.expectedArrival + policy.tolerance) + 1));
      } else {
        // Not arrived yet
        return;
      }
    }
    bool customerWon = (actualArrivalDate <= 0 || // cancelled
      uint256(actualArrivalDate) > uint256(policy.expectedArrival + policy.tolerance)); // arrived after tolerance

    _policyPool.resolvePolicyFullPayout(policy.ensuroPolicy, customerWon);
  }
}