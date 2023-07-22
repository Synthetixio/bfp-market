import assertRevert from '@synthetixio/core-utils/utils/assertions/assert-revert';
import assertEvent from '@synthetixio/core-utils/utils/assertions/assert-event';
import assertBn from '@synthetixio/core-utils/utils/assertions/assert-bignumber';
import assert from 'assert';
import { bootstrap } from '../../bootstrap';
import { genAddress, genBootstrap, genBytes32, genInt, genListOf, bn, shuffle } from '../../generators';

describe('MarketCollateralModule', async () => {
  const { markets, collaterals, traders, owner, systems, restore } = bootstrap(genBootstrap());

  beforeEach(restore);

  describe('transferTo()', () => {
    it('should noop with a transfer amount of 0', async () => {
      const { PerpMarketProxy } = systems();

      const trader = traders()[0];
      const market = markets()[0];
      const collateral = shuffle(collaterals())[0].contract.connect(trader.signer);
      const amountDelta = bn(0);

      const tx = await PerpMarketProxy.connect(trader.signer).transferTo(
        trader.accountId,
        market.marketId(),
        collateral.address,
        amountDelta
      );
      const receipt = await tx.wait();

      assert.equal(receipt.events?.length, 0);
    });

    it('should revert transfers when an order is pending');

    describe('deposit', () => {
      it('should allow deposit of collateral to an existing accountId', async () => {
        const { PerpMarketProxy } = systems();

        const trader = traders()[0];
        const traderAddress = await trader.signer.getAddress();

        const market = markets()[0];
        const collateral = collaterals()[0].contract.connect(trader.signer);

        const amountDelta = bn(genInt(50, 100_000));
        await collateral.mint(trader.signer.getAddress(), amountDelta);
        await collateral.approve(PerpMarketProxy.address, amountDelta);

        const balanceBefore = await collateral.balanceOf(traderAddress);
        const tx = await PerpMarketProxy.connect(trader.signer).transferTo(
          trader.accountId,
          market.marketId(),
          collateral.address,
          amountDelta
        );

        await assertEvent(
          tx,
          `Transfer("${traderAddress}", "${PerpMarketProxy.address}", ${amountDelta})`,
          PerpMarketProxy
        );

        const expectedBalanceAfter = balanceBefore.sub(amountDelta);
        assertBn.equal(await collateral.balanceOf(traderAddress), expectedBalanceAfter);
      });

      it('should affect an existing position when depositing');

      it('should revert deposit to an account that does not exist', async () => {
        const { PerpMarketProxy } = systems();

        const trader = traders()[0];
        const invalidAccountId = genInt(42069, 50000);

        const market = markets()[0];
        const collateral = shuffle(collaterals())[0].contract.connect(trader.signer);

        const amountDelta = bn(genInt(50, 100_000));
        await collateral.mint(trader.signer.getAddress(), amountDelta);
        await collateral.approve(PerpMarketProxy.address, amountDelta);

        await assertRevert(
          PerpMarketProxy.connect(trader.signer).transferTo(
            invalidAccountId,
            market.marketId(),
            collateral.address,
            amountDelta
          ),
          `AccountNotFound("${invalidAccountId}")`
        );
      });

      it('should revert deposit of unsupported collateral', async () => {
        const { PerpMarketProxy } = systems();

        const trader = traders()[0];
        const market = markets()[0];
        const invalidCollateralAddress = genAddress();
        const amountDelta = bn(genInt(10, 100));

        await assertRevert(
          PerpMarketProxy.connect(trader.signer).transferTo(
            trader.accountId,
            market.marketId(),
            invalidCollateralAddress,
            amountDelta
          ),
          `UnsupportedCollateral("${invalidCollateralAddress}")`
        );
      });

      it('should revert when depositing an address(0) collateral');

      it('should revert deposit that exceeds max cap', async () => {
        const { PerpMarketProxy } = systems();

        const trader = traders()[0];
        const market = markets()[0];

        // Shuffle the available collaterals and sample `.head`.
        const { contract, max: maxAllowable } = shuffle(collaterals())[0];
        const collateral = contract.connect(trader.signer);

        // Add one extra to max allowable to exceed max cap.
        const amountDelta = maxAllowable.add(bn(1));
        await collateral.mint(trader.signer.getAddress(), amountDelta);
        await collateral.approve(PerpMarketProxy.address, amountDelta);

        await assertRevert(
          PerpMarketProxy.connect(trader.signer).transferTo(
            trader.accountId,
            market.marketId(),
            collateral.address,
            amountDelta
          ),
          `MaxCollateralExceeded("${amountDelta}", "${maxAllowable}")`
        );
      });

      it('should revert deposit of perp market approved collateral but not system approved');

      it('should revert when insufficient amount of collateral in msg.sender', async () => {
        const { PerpMarketProxy } = systems();

        const trader = traders()[0];
        const market = markets()[0];

        // Shuffle the available collaterals and sample `.head`.
        const collateral = shuffle(collaterals())[0].contract.connect(trader.signer);

        // Ensure the amount available is lower than amount to deposit (i.e. depositing more than available).
        const amountToDeposit = bn(genInt(100, 1000));
        const amountAvailable = amountToDeposit.sub(bn(genInt(50, 500)));

        await collateral.mint(trader.signer.getAddress(), amountAvailable);
        await collateral.approve(PerpMarketProxy.address, amountAvailable);

        await assertRevert(
          PerpMarketProxy.connect(trader.signer).transferTo(
            trader.accountId,
            market.marketId(),
            collateral.address,
            amountToDeposit
          ),
          `InsufficientAllowance("${amountToDeposit}", "${amountAvailable}")`
        );
      });

      it('should revert when account is flagged for liquidation');
    });

    describe('withdraw', () => {
      it('should allow full withdraw of collateral to my account', async () => {
        const { PerpMarketProxy } = systems();

        const trader = traders()[0];
        const traderAddress = await trader.signer.getAddress();
        const market = markets()[0];
        const marketId = market.marketId();
        const collateral = collaterals()[0].contract.connect(trader.signer);

        const amountDelta = bn(genInt(500, 1000));
        await collateral.mint(trader.signer.getAddress(), amountDelta);
        await collateral.approve(PerpMarketProxy.address, amountDelta);

        // Perform the deposit.
        await PerpMarketProxy.connect(trader.signer).transferTo(
          trader.accountId,
          marketId,
          collateral.address,
          amountDelta
        );

        // Perform the withdraw (entire amount)
        const tx = await PerpMarketProxy.connect(trader.signer).transferTo(
          trader.accountId,
          marketId,
          collateral.address,
          amountDelta.mul(-1)
        );

        await assertEvent(
          tx,
          `Transfer("${PerpMarketProxy.address}", "${traderAddress}", ${amountDelta})`,
          PerpMarketProxy
        );
      });

      it('should allow partial withdraw of collateral to my account');

      it('should affect an existing position when withdrawing');
      it('should revert withdraw on address(0) collateral');
      it('should revert withdraw to an account that does not exist');
      it('should revert withdraw of unsupported collateral');
      it('should revert withdraw of more than what is available');
      it('should revert withdraw when position can be liquidated');
      it('should revert when account is flagged for liquidation');
    });
  });

  describe('setCollateralConfiguration()', () => {
    it('should successfully configure many collaterals', async () => {
      const { PerpMarketProxy, Collateral2Mock, Collateral3Mock } = systems();
      const from = owner();

      // Unfortunately `collateralTypes` must be a real ERC20 contract otherwise this will fail due to the `.approve`.
      const collateralTypes = shuffle([Collateral2Mock.address, Collateral3Mock.address]);
      const n = collateralTypes.length;
      const oracleNodeIds = genListOf(n, () => genBytes32());
      const maxAllowables = genListOf(n, () => bn(genInt(10_000, 100_000)));

      const tx = await PerpMarketProxy.connect(from).setCollateralConfiguration(
        collateralTypes,
        oracleNodeIds,
        maxAllowables
      );
      const collaterals = await PerpMarketProxy.getConfiguredCollaterals();

      assert.equal(collaterals.length, n);
      collaterals.forEach((collateral, i) => {
        const { maxAllowable, collateralType, oracleNodeId } = collateral;
        assertBn.equal(maxAllowable, maxAllowables[i]);
        assert.equal(collateralType, collateralTypes[i]);
        assert.equal(oracleNodeId, oracleNodeIds[i]);
      });

      await assertEvent(tx, `CollateralConfigured("${await from.getAddress()}", ${n})`, PerpMarketProxy);
    });

    it('should reset existing collaterals when new config is empty', async () => {
      const { PerpMarketProxy } = systems();
      const from = owner();

      await PerpMarketProxy.connect(from).setCollateralConfiguration([], [], []);
      const collaterals = await PerpMarketProxy.getConfiguredCollaterals();

      assert.equal(collaterals.length, 0);
    });

    it('should revert when non-owners configuring collateral', async () => {
      const { PerpMarketProxy } = systems();
      const from = await traders()[0].signer.getAddress();
      await assertRevert(
        PerpMarketProxy.connect(from).setCollateralConfiguration([], [], []),
        `Unauthorized("${from}")`
      );
    });

    it('should revert when max allowable is negative', async () => {
      const { PerpMarketProxy } = systems();
      const from = owner();
      await assertRevert(
        PerpMarketProxy.connect(from).setCollateralConfiguration([genAddress()], [genBytes32()], [bn(-1)]),
        'Error: value out-of-bounds'
      );
    });

    it('should revert when type is address(0)', async () => {
      const { PerpMarketProxy } = systems();
      const from = owner();
      const zeroAddress = '0x0000000000000000000000000000000000000000';
      await assertRevert(
        PerpMarketProxy.connect(from).setCollateralConfiguration([zeroAddress], [genBytes32()], [bn(genInt())]),
        'ZeroAddress'
      );
    });

    it('should revoke/approve collateral with 0/maxAllowable');
  });
});
