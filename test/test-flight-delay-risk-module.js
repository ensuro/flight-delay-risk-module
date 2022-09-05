const { expect } = require("chai");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  _E,
  _W,
  addRiskModule,
  amountFunction,
  grantComponentRole,
  addEToken,
  getTransactionEvent,
} = require("@ensuro/core/js/test-utils");
const { ethers } = require("hardhat");
const { getComponentRole, accessControlMessage, makePolicyId } = require("./local_utils");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

describe("FlightDelayRiskModule contract", function () {
  const ORACLE_FEE = _W("0.1");

  let currency;
  let linkToken;
  let pool;
  let poolConfig;
  let _A;
  let owner, lp, cust, oracle, backend;
  let FlighDelayRiskModule;

  beforeEach(async () => {
    [owner, lp, cust, oracle, backend] = await ethers.getSigners();

    _A = amountFunction(6);

    currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust],
      [_A(5000), _A(500)]
    );

    linkToken = await deployLinkToken();

    pool = await deployPool(hre, {
      currency: currency.address,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    pool._A = _A;

    etk = await addEToken(pool, {});

    premiumsAccount = await deployPremiumsAccount(hre, pool, { srEtkAddr: etk.address });

    poolConfig = await ethers.getContractAt("PolicyPoolConfig", await pool.config());

    FlighDelayRiskModule = await ethers.getContractFactory("FlightDelayRiskModule");

    await currency.connect(lp).approve(pool.address, _A(5000));
    await pool.connect(lp).deposit(etk.address, _A(5000));
  });

  it("Allows only oracle admin to set oracle params", async () => {
    const rm = await addRiskModule(pool, premiumsAccount, FlighDelayRiskModule, {
      extraArgs: [
        linkToken.address,
        [oracle.address, 30, ORACLE_FEE, "0x2fb0c3a36f924e4ab43040291e14e0b7", "0xb93734c968d741a4930571586f30d0e0"],
      ],
    });

    const oracleParams = {};
    [oracleParams.oracle, oracleParams.delayTime, oracleParams.fee, oracleParams.dataJobId, oracleParams.sleepJobId] =
      await rm.oracleParams();
    expect(oracleParams.oracle).to.equal(oracle.address);
    expect(oracleParams.sleepJobId).to.equal("0xb93734c968d741a4930571586f30d0e0");
    expect(oracleParams.dataJobId).to.equal("0x2fb0c3a36f924e4ab43040291e14e0b7");
    expect(oracleParams.delayTime).to.equal(30);
    expect(oracleParams.fee).to.equal(ORACLE_FEE);

    const newOracleParams = { ...oracleParams };
    newOracleParams.fee = _W("0.05");

    const componentRole = getComponentRole(rm.address, "ORACLE_ADMIN_ROLE");
    await expect(rm.setOracleParams(newOracleParams)).to.be.revertedWith(
      accessControlMessage(owner.address, rm.address, "ORACLE_ADMIN_ROLE")
    );

    await poolConfig.grantComponentRole(rm.address, await rm.ORACLE_ADMIN_ROLE(), owner.address);

    await rm.connect(owner).setOracleParams(newOracleParams);

    const [oracleAddress, _, oracleFee] = await rm.oracleParams();
    expect(oracleAddress).to.equal(oracle.address);
    expect(oracleFee).to.equal(_W("0.05"));
  });

  it("Allows only PRICER_ROLE to add new policies", async () => {
    const { rm, oracleMock, oracleRm } = await deployRiskModuleWithOracleMock();
    const policy = await makePolicy({});
    await expect(rm.newPolicy(...policy.toArgs())).to.be.revertedWith(
      accessControlMessage(owner.address, rm.address, "PRICER_ROLE")
    );

    await expect(rm.connect(backend).newPolicy(...policy.toArgs())).not.to.be.reverted;
  });

  it("Performs the oracle request and receive cycle", async () => {
    const { rm, oracleMock, oracleRm } = await deployRiskModuleWithOracleMock();
    const now = await helpers.time.latest();

    const policy = await makePolicy({});

    const tx = await rm.connect(backend).newPolicy(...policy.toArgs());

    await expect(tx).to.emit(rm, "ChainlinkRequested");

    const [chainlinkRequestId] = getTransactionEvent(rm.interface, await tx.wait(), "ChainlinkRequested").args;

    const fulfillTx = await oracleRm.connect(owner).fulfill(chainlinkRequestId, policy.expectedArrival + 300);
    await expect(fulfillTx).to.emit(rm, "ChainlinkFulfilled").withArgs(chainlinkRequestId);
  });

  it("Transfers the oracle fee for new policies", async () => {
    const { rm, oracleMock, oracleRm } = await deployRiskModuleWithOracleMock();

    const policy = await makePolicy({});

    const tx = await rm.connect(backend).newPolicy(...policy.toArgs());

    expect(await linkToken.lastTransferTo()).to.equal(oracleMock.address);
    expect(await linkToken.lastTransferValue()).to.equal(ORACLE_FEE);
  });

  it("Allows only PRICER_ROLE to resolve policies", async () => {
    const { rm, oracleMock, oracleRm } = await deployRiskModuleWithOracleMock();

    const policy = await makePolicy({});

    const tx = await rm.connect(backend).newPolicy(...policy.toArgs());

    const [chainlinkRequestId] = getTransactionEvent(rm.interface, await tx.wait(), "ChainlinkRequested").args;

    await expect(rm.resolvePolicy(makePolicyId(rm, policy.internalId))).to.be.revertedWith(
      accessControlMessage(owner.address, rm.address, "PRICER_ROLE")
    );

    await expect(rm.connect(backend).resolvePolicy(makePolicyId(rm, policy.internalId))).to.not.be.reverted;
  });

  it("Resolves policy with no payout when flight arrives on time", async () => {
    const { rm, oracleMock, oracleRm } = await deployRiskModuleWithOracleMock();

    const policy = await makePolicy({});

    const tx = await rm.connect(backend).newPolicy(...policy.toArgs());
    const receipt = await tx.wait();

    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    expect(newPolicyEvt.args.policy.id).to.equal(makePolicyId(rm, policy.internalId));

    const [chainlinkRequestId] = getTransactionEvent(rm.interface, receipt, "ChainlinkRequested").args;
    const fulfillTx = await oracleRm.connect(owner).fulfill(chainlinkRequestId, policy.expectedArrival + 300);
    await expect(fulfillTx).to.emit(pool, "PolicyResolved");

    const policyResolvedEvt = getTransactionEvent(pool.interface, await fulfillTx.wait(), "PolicyResolved");
    expect(policyResolvedEvt.args.payout).to.equal(0);
  });

  it("Resolves policy with full payout when flight arrives too late", async () => {
    const { rm, oracleMock, oracleRm } = await deployRiskModuleWithOracleMock();

    const policy = await makePolicy({});

    const tx = await rm.connect(backend).newPolicy(...policy.toArgs());
    const receipt = await tx.wait();

    const [chainlinkRequestId] = getTransactionEvent(rm.interface, receipt, "ChainlinkRequested").args;
    const fulfillTx = await oracleRm.connect(owner).fulfill(
      chainlinkRequestId,
      policy.expectedArrival + policy.tolerance + 100 // way too late
    );
    await expect(fulfillTx).to.emit(pool, "PolicyResolved");

    const policyResolvedEvt = getTransactionEvent(pool.interface, await fulfillTx.wait(), "PolicyResolved");
    expect(policyResolvedEvt.args.payout).to.equal(_A(1000));
  });

  it("Resolves policy with full payout when flight is cancelled", async () => {
    const { rm, oracleMock, oracleRm } = await deployRiskModuleWithOracleMock();

    const policy = await makePolicy({});

    const tx = await rm.connect(backend).newPolicy(...policy.toArgs());
    const receipt = await tx.wait();

    const [chainlinkRequestId] = getTransactionEvent(rm.interface, receipt, "ChainlinkRequested").args;
    const fulfillTx = await oracleRm.connect(owner).fulfill(
      chainlinkRequestId,
      -1 // No arrival: flight cancelled
    );
    await expect(fulfillTx).to.emit(pool, "PolicyResolved");

    const policyResolvedEvt = getTransactionEvent(pool.interface, await fulfillTx.wait(), "PolicyResolved");
    expect(policyResolvedEvt.args.payout).to.equal(_A(1000));
  });

  it("Resolves policy with full payout when oracle is missing arrival past tolerance", async () => {
    const { rm, oracleMock, oracleRm } = await deployRiskModuleWithOracleMock();

    const policy = await makePolicy({});

    const tx = await rm.connect(backend).newPolicy(...policy.toArgs());
    const receipt = await tx.wait();

    const [chainlinkRequestId] = getTransactionEvent(rm.interface, receipt, "ChainlinkRequested").args;
    const fulfillTx = await oracleRm.connect(owner).fulfill(
      chainlinkRequestId,
      0 // 0 means missing data?
    );

    // The policy was not resolved because theres no arrival data and we're within tolerance
    await expect(fulfillTx).to.emit(rm, "ChainlinkFulfilled");
    await expect(fulfillTx).to.not.emit(pool, "PolicyResolved");

    // Fast forward past tolerance (but before expiration)
    await helpers.time.increaseTo(policy.expectedArrival + policy.tolerance + 100);

    // Resolving the policy should repeat oracle query
    const resolveTx = await rm.connect(backend).resolvePolicy(makePolicyId(rm, policy.internalId));
    const [secondChainlinkRequestId] = getTransactionEvent(
      rm.interface,
      await resolveTx.wait(),
      "ChainlinkRequested"
    ).args;

    // Fulfilling query with no data again should resolve the policy this time
    const secondFulfillTx = await oracleRm.connect(owner).fulfill(secondChainlinkRequestId, 0);
    await expect(secondFulfillTx).to.emit(rm, "ChainlinkFulfilled");
    await expect(secondFulfillTx).to.emit(pool, "PolicyResolved");

    // Full payout on customer's behalf
    const policyResolvedEvt = getTransactionEvent(pool.interface, await secondFulfillTx.wait(), "PolicyResolved");
    expect(policyResolvedEvt.args.payout).to.equal(_A(1000));
  });

  it("Resolves with full payout on manual resolve for cancelled flight", async () => {
    const { rm, oracleMock, oracleRm } = await deployRiskModuleWithOracleMock();

    const policy = await makePolicy({});

    await rm.connect(backend).newPolicy(...policy.toArgs());

    const tx = await rm.connect(backend).resolvePolicy(makePolicyId(rm, policy.internalId));

    // Policy is not resolved because oracle needs to be queried
    await expect(tx).to.not.emit(pool, "PolicyResolved");

    const [chainlinkRequestId] = getTransactionEvent(rm.interface, await tx.wait(), "ChainlinkRequested").args;
    const fulfillTx = await oracleRm.connect(owner).fulfill(
      chainlinkRequestId,
      -1 // flight cancelled
    );
    await expect(fulfillTx).to.emit(pool, "PolicyResolved");

    const policyResolvedEvt = getTransactionEvent(pool.interface, await fulfillTx.wait(), "PolicyResolved");
    expect(policyResolvedEvt.args.payout).to.equal(_A(1000));
  });

  it("Resolves with zero payout on manual resolve for on-time flight", async () => {
    const { rm, oracleMock, oracleRm } = await deployRiskModuleWithOracleMock();

    const policy = await makePolicy({});

    await rm.connect(backend).newPolicy(...policy.toArgs());

    const tx = await rm.connect(backend).resolvePolicy(makePolicyId(rm, policy.internalId));

    // Policy is not resolved because oracle needs to be queried
    await expect(tx).to.not.emit(pool, "PolicyResolved");

    const [chainlinkRequestId] = getTransactionEvent(rm.interface, await tx.wait(), "ChainlinkRequested").args;
    const fulfillTx = await oracleRm.connect(owner).fulfill(chainlinkRequestId, policy.expectedArrival - 60);
    await expect(fulfillTx).to.emit(pool, "PolicyResolved");

    const policyResolvedEvt = getTransactionEvent(pool.interface, await fulfillTx.wait(), "PolicyResolved");
    expect(policyResolvedEvt.args.payout).to.equal(_A(0));
  });

  it("Rejects policies with expected arrival in the past", async () => {
    const { rm, oracleMock, oracleRm } = await deployRiskModuleWithOracleMock();

    const policy = await makePolicy({ expectedArrival: (await helpers.time.latest()) - 20 });

    await expect(rm.connect(backend).newPolicy(...policy.toArgs())).to.be.revertedWith(
      "expectedArrival can't be in the past"
    );
  });

  it("Rejects policies with expected arrival before departure", async () => {
    const { rm, oracleMock, oracleRm } = await deployRiskModuleWithOracleMock();

    const policy = await makePolicy({});
    policy.expectedArrival = policy.departure - 10;

    await expect(rm.connect(backend).newPolicy(...policy.toArgs())).to.be.revertedWith("expectedArrival <= departure!");
  });

  it("Reverts when resolving unknown policy", async () => {
    const { rm, oracleMock, oracleRm } = await deployRiskModuleWithOracleMock();

    await expect(rm.connect(backend).resolvePolicy(makePolicyId(rm, 123))).to.be.revertedWith("Policy not found!");
  });

  async function deployRiskModuleWithOracleMock() {
    // Need to deploy the contract first
    const rm = await addRiskModule(pool, premiumsAccount, FlighDelayRiskModule, {
      maxScrPerPolicy: 1000,
      extraArgs: [
        linkToken.address,
        [oracle.address, 30, ORACLE_FEE, "0x2fb0c3a36f924e4ab43040291e14e0b7", "0xb93734c968d741a4930571586f30d0e0"],
      ],
    });

    // Then deploy the oracle mock
    const ForwardProxy = await ethers.getContractFactory("@ensuro/core/contracts/mocks/ForwardProxy.sol:ForwardProxy");
    const oracleMock = await ForwardProxy.deploy(rm.address);
    await oracleMock.deployed();

    //
    await poolConfig.grantComponentRole(rm.address, await rm.ORACLE_ADMIN_ROLE(), owner.address);

    // Then change the contract to use the mock
    const oracleParams = {};
    [oracleParams.oracle, oracleParams.delayTime, oracleParams.fee, oracleParams.dataJobId, oracleParams.sleepJobId] =
      await rm.oracleParams();
    oracleParams.oracle = oracleMock.address;
    await rm.connect(owner).setOracleParams(oracleParams);

    // Also grant a default PRICER_ROLE
    await poolConfig.grantComponentRole(rm.address, await rm.PRICER_ROLE(), backend.address);

    //
    await currency.connect(cust).approve(pool.address, _W(100));

    // Setup the oracle mock to call the risk module
    oracleRm = await ethers.getContractAt("FlightDelayRiskModule", oracleMock.address);

    return { rm, oracleMock, oracleRm };
  }

  async function deployLinkToken(name = "Mock Link", symbol = "mLINK", initialSupply = _W("1000")) {
    const LinkTokenMock = await ethers.getContractFactory("LinkTokenMock");

    const linkToken = await LinkTokenMock.deploy(name, symbol, initialSupply);

    await linkToken.deployed();

    return linkToken;
  }

  async function makePolicy({
    flight,
    departure,
    expectedArrival,
    tolerance,
    payout,
    premium,
    lossProbability,
    customer,
    internalId,
  }) {
    const now = await helpers.time.latest();
    const policy = {
      flight: flight || "AR 1234",
      departure: departure || now + 3600,
      expectedArrival: expectedArrival || now + 3600 * 5,
      tolerance: tolerance || 1800,
      payout: payout || _A(1000),
      premium: premium || _A(110),
      lossProbability: lossProbability || ORACLE_FEE,
      customer: customer || cust.address,
      internalId: internalId || 123,
    };
    policy.toArgs = () => [
      policy.flight,
      policy.departure,
      policy.expectedArrival,
      policy.tolerance,
      policy.payout,
      policy.premium,
      policy.lossProbability,
      policy.customer,
      policy.internalId,
    ];
    return policy;
  }
});
