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

describe("Test PriceRiskModule contract", function () {
  let currency;
  let linkToken;
  let pool;
  let poolConfig;
  let _A;

  beforeEach(async () => {
    [owner, lp, cust] = await ethers.getSigners();

    _A = amountFunction(6);

    currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust],
      [_A(5000), _A(500)]
    );

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

  it("has a test", () => {
    expect(1).to.equal(0);
  });
});
