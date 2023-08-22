import { BigNumber } from 'ethers';
import Wei, { wei } from '@synthetixio/wei';
import type { Bs } from './typed';

/** Calculates order fees and keeper fees associated to settle the order. */
export const calcOrderFees = async (bs: Bs, marketId: BigNumber, sizeDelta: BigNumber) => {
  if (sizeDelta.eq(0)) {
    throw new Error('A sizeDelta of 0 will result in a NilOrder revert');
  }

  const { systems } = bs;
  const { PerpMarketProxy } = systems();

  const fillPrice = await PerpMarketProxy.getFillPrice(marketId, sizeDelta);
  const { skew } = await PerpMarketProxy.getMarketDigest(marketId);
  const { makerFee, takerFee } = await PerpMarketProxy.getMarketConfigurationById(marketId);

  const isSameSide = (a: Wei | BigNumber, b: Wei | BigNumber) => a.eq(0) || b.eq(0) || a.gt(0) == b.gt(0);

  let [makerSizeRatio, takerSizeRatio] = [wei(0), wei(0)];
  const marketSkewBefore = wei(skew);
  const marketSkewAfter = marketSkewBefore.add(sizeDelta);

  if (isSameSide(marketSkewAfter, marketSkewBefore)) {
    // Either a full maker or taker fee is charged on the entire size.
    if (isSameSide(sizeDelta, skew)) {
      [takerSizeRatio, makerSizeRatio] = [wei(1), wei(0)];
    } else {
      [takerSizeRatio, makerSizeRatio] = [wei(0), wei(1)];
    }
  } else {
    // Mixed. Reduced skew to 0 and then a bit more causing it to expand in the other dierction. Infer
    // the portion of size that is maker vs taker and calculate fees appropriately.
    takerSizeRatio = marketSkewBefore.add(sizeDelta).div(sizeDelta);
    makerSizeRatio = wei(1).sub(takerSizeRatio);
  }

  const notional = wei(sizeDelta).abs().mul(fillPrice);
  const orderFee = notional.mul(takerSizeRatio).mul(takerFee).add(notional.mul(makerSizeRatio).mul(makerFee)).toBN();
  const keeperFee = wei(0).toBN(); // TODO

  return { notional, orderFee, keeperFee };
};