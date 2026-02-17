import { PoolFactory } from "generated";
import type {
  LiquidityPoolAggregator,
  PoolFactory_PoolCreated_event,
  contractRegistrations,
  PoolFactory_SetCustomFee_event,
  handlerContext,
} from "generated";
import {
  createLiquidityPoolAggregatorEntity,
  updateLiquidityPoolAggregator,
} from "../Aggregators/LiquidityPoolAggregator";
import {
  DEFAULT_SAMM_FEE_BPS,
  DEFAULT_VAMM_FEE_BPS,
  PoolId,
  ROOT_POOL_FACTORY_ADDRESS_OPTIMISM,
  TokenIdByChain,
} from "../Constants";
import { getRootPoolAddress } from "../Effects/RootPool";
import { createTokenEntity } from "../PriceOracle";
import type { TokenEntityMapping } from "./../CustomTypes";

PoolFactory.PoolCreated.contractRegister(({ event, context }: { event: PoolFactory_PoolCreated_event, context: contractRegistrations }) => {
  context.addPool(event.params.pool);
});

PoolFactory.PoolCreated.handler(async ({ event, context }: { event: PoolFactory_PoolCreated_event, context: handlerContext }) => {
  // Load token instances efficiently
  const [poolToken0, poolToken1] = await Promise.all([
    context.Token.get(TokenIdByChain(event.params.token0, event.chainId)),
    context.Token.get(TokenIdByChain(event.params.token1, event.chainId)),
  ]);

  const poolTokenSymbols: string[] = [];
  const poolTokenAddressMappings: TokenEntityMapping[] = [
    { address: event.params.token0, tokenInstance: poolToken0 },
    { address: event.params.token1, tokenInstance: poolToken1 },
  ];

  // Collect missing tokens and create them in parallel for better performance
  const missingTokenMappings = poolTokenAddressMappings.filter(
    (mapping) => mapping.tokenInstance === undefined,
  );

  if (missingTokenMappings.length > 0) {
    const createTokenPromises = missingTokenMappings.map((mapping) =>
      createTokenEntity(
        mapping.address,
        event.chainId,
        event.block.number,
        context,
      ).catch((error) => {
        context.log.error(
          `Error in pool factory fetching token details for ${mapping.address} on chain ${event.chainId}: ${error}`,
        );
        return null;
      }),
    );

    const createdTokens = await Promise.all(createTokenPromises);

    // Update mappings with created tokens
    for (let i = 0; i < missingTokenMappings.length; i++) {
      if (createdTokens[i]) {
        missingTokenMappings[i].tokenInstance = createdTokens[i] ?? undefined;
      }
    }
  }

  // Build symbol array
  for (const poolTokenAddressMapping of poolTokenAddressMappings) {
    if (poolTokenAddressMapping.tokenInstance) {
      poolTokenSymbols.push(poolTokenAddressMapping.tokenInstance.symbol);
    }
  }

  const fee = event.params.stable ? DEFAULT_SAMM_FEE_BPS : DEFAULT_VAMM_FEE_BPS;

  const pool = createLiquidityPoolAggregatorEntity({
    poolAddress: event.params.pool,
    chainId: event.chainId,
    isCL: false,
    isStable: event.params.stable,
    token0Address: event.params.token0,
    token1Address: event.params.token1,
    token0Symbol: poolTokenSymbols[0],
    token1Symbol: poolTokenSymbols[1],
    timestamp: new Date(event.block.timestamp * 1000),
    baseFee: fee,
    currentFee: fee,
  });

  // For new pool creation, set the entity directly (updateLiquidityPoolAggregator is for updates, not creation)
  context.LiquidityPoolAggregator.set(pool);

  // For non-Optimism and non-Base pools, set the RootPool_LeafPool entity
  // Mapping RootPool (on optimism) to Pool (on superchain)
  // This is only need for non-CL pools
  // The mapping between RootCLPool and CLPool is made in RootCLPoolFactory.ts without the need of a RPC call
  // RPC call is needed here because RootPoolCreated event for non-CL pools doesn't have leafChainId
  // For non-Optimism and non-Base pools, set the RootPool_LeafPool entity
  // Mapping RootPool (on optimism) to Pool (on superchain)
  // This is only need for non-CL pools
  // The mapping between RootCLPool and CLPool is made in RootCLPoolFactory.ts without the need of a RPC call
  // RPC call is needed here because RootPoolCreated event for non-CL pools doesn't have leafChainId
  /* 
   * Monad specific: Removed cross-chain logic. 
   * If strictly needed later, reimplement. For now, assuming standalone. 
   */
});

PoolFactory.SetCustomFee.handler(async ({ event, context }: { event: PoolFactory_SetCustomFee_event, context: handlerContext }) => {
  const poolId = PoolId(event.chainId, event.params.pool);
  const poolEntity = await context.LiquidityPoolAggregator.get(poolId);

  if (!poolEntity) {
    context.log.warn(`Pool ${poolId} not found for SetCustomFee event`);
    return;
  }

  const diff: Partial<LiquidityPoolAggregator> = {
    baseFee: BigInt(event.params.fee),
    currentFee: BigInt(event.params.fee), // When custom fee is set, both baseFee and currentFee are updated
  };

  await updateLiquidityPoolAggregator(
    diff,
    poolEntity,
    new Date(event.block.timestamp * 1000),
    context,
    event.chainId,
    event.block.number,
  );
});
