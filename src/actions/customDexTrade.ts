import { z } from "zod";
import { ActionProvider, CreateAction, EvmWalletProvider } from "@coinbase/agentkit";
import type { Network } from "@coinbase/agentkit";
import { Token, CurrencyAmount, TradeType, Percent } from "@uniswap/sdk-core";
import { AlphaRouter, SwapType, SwapOptionsUniversalRouter } from '@uniswap/smart-order-router';
import { UniversalRouterVersion } from '@uniswap/universal-router-sdk';
import { providers } from 'ethers';
import JSBI from 'jsbi';

export const TestnetTradeSchema = z
  .object({
    amount: z.string().describe("The amount of the from asset to trade"),
    fromAssetId: z.string().describe("The from asset ID to trade"),
    toAssetId: z.string().describe("The to asset ID to receive from the trade"),
    fromAssetTicker: z.string().optional().describe("The ticker symbol of the from asset"),
    toAssetTicker: z.string().optional().describe("The ticker symbol of the to asset")
  })
  .describe("Instructions for trading assets on Base Sepolia testnet");

const CHAIN_ID = 84532;
const BASE_SEPOLIA_CONTRACTS = {
    UNIVERSAL_ROUTER: "0x050E797f3625EC8785265e1d9BDd4799b97528A1" as const,
    QUOTER_V2: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27" as const,
    WETH9: "0x4200000000000000000000000000000000000006" as const
} as const;

const BASE_SEPOLIA_RPC = "https://sepolia.base.org";

class DexError extends Error {
    constructor(
        message: string,
        public readonly code: 'NO_ROUTE' | 'NO_LIQUIDITY' | 'EXECUTION_ERROR' | 'UNKNOWN' | 'AMOUNT_TOO_SMALL' | 'INSUFFICIENT_BALANCE',
        public readonly details?: any
    ) {
        super(message);
        this.name = 'DexError';
    }
}

export class TestnetTradeActionProvider extends ActionProvider<EvmWalletProvider> {
    constructor() {
        super("testnet-trade-provider", []);
    }

    @CreateAction({
        name: "testnet_trade",
        description: "Trade tokens on Base Sepolia testnet using Uniswap V3",
        schema: TestnetTradeSchema,
    })
    async trade(
        walletProvider: EvmWalletProvider,
        args: z.infer<typeof TestnetTradeSchema>
    ): Promise<string> {
        try {
            const { fromAssetId, toAssetId, amount } = args;
            const fromAddress = this.normalizeAddress(fromAssetId);
            const toAddress = this.normalizeAddress(toAssetId);

            // Validate addresses
            if (!fromAddress || !toAddress) {
                throw new DexError(
                    "Invalid token addresses provided",
                    'UNKNOWN'
                );
            }

            console.log(`Preparing to trade ${amount} from ${fromAddress} to ${toAddress}`);

            const provider = new providers.JsonRpcProvider(BASE_SEPOLIA_RPC);
            const router = new AlphaRouter({
                chainId: CHAIN_ID,
                provider,
            });

            // Create token instances with basic validation
            try {
                const [fromToken, toToken] = await Promise.all([
                    this.createToken(fromAddress, args.fromAssetTicker || "Token A"),
                    this.createToken(toAddress, args.toAssetTicker || "Token B")
                ]);

                console.log("Tokens validated:");
                console.log(`From: ${fromToken.symbol} (${fromToken.address})`);
                console.log(`To: ${toToken.symbol} (${toToken.address})`);

                const parsedAmount = JSBI.BigInt(this.parseUnits(amount, 18));
                const currencyAmount = CurrencyAmount.fromRawAmount(fromToken, parsedAmount);

                const options: SwapOptionsUniversalRouter = {
                    recipient: await walletProvider.getAddress(),
                    slippageTolerance: new Percent(50, 100), // 50% slippage for testing
                    deadlineOrPreviousBlockhash: Math.floor(Date.now() / 1000 + 1800),
                    type: SwapType.UNIVERSAL_ROUTER,
                    version: UniversalRouterVersion.V2_0
                };

                console.log("Finding best route...");
                console.log("Checking pool existence and liquidity...");
            const route = await router.route(
                    currencyAmount,
                    toToken,
                    TradeType.EXACT_INPUT,
                    options
                ).catch((error) => {
                    console.error("Route finding error:", error);
                    if (error.message?.includes("no route found")) {
                        throw new DexError(
                            "No valid trading route found. This likely means there is no liquidity pool for this pair.",
                            'NO_ROUTE'
                        );
                    }
                    if (error.message?.includes("insufficient liquidity")) {
                        throw new DexError(
                            "Insufficient liquidity in the pool for this trade.",
                            'NO_LIQUIDITY'
                        );
                    }
                    throw error;
                });

                if (!route || !route.methodParameters || !route.quote) {
                    throw new DexError(
                        "Failed to compute a valid trading route",
                        'NO_ROUTE'
                    );
                }

                const firstRoute = route.route[0];
                if (firstRoute.protocol !== 'V3') {
                    throw new DexError(
                        "Only V3 routes are supported",
                        'NO_ROUTE'
                    );
                }

                const poolAddress = firstRoute.poolIdentifiers[0];
                const poolInfo = firstRoute.route;
                if (!poolInfo || !poolInfo.pools || poolInfo.pools.length === 0) {
                    throw new DexError(
                        "No pool information found",
                        'NO_ROUTE'
                    );
                }
                
                const pool = poolInfo.pools[0];
                
                console.log("\nPool details:");
                console.log(`Address: ${poolAddress}`);
                console.log(`Liquidity: ${pool.liquidity.toString()}`);
                console.log(`Current tick: ${pool.tickCurrent}`);
                console.log(`Fee: ${pool.fee / 10000}%`);
                
                const quoteAmount = route.quote.toFixed(18);  // Show full precision
                console.log(`Raw quote amount: ${quoteAmount}`);
                
                if (parseFloat(quoteAmount) < 0.000001) {
                    throw new DexError(
                        `Quote too small (${quoteAmount}). The minimum tradeable amount might be higher, try increasing the input amount.`,
                        'AMOUNT_TOO_SMALL'
                    );
                }

                console.log(`\nExpected output: ${quoteAmount} ${args.toAssetTicker || "tokens"}`);

                // Check balance before attempting trade
                const balance = await walletProvider.getBalance();
                const requiredAmount = fromAddress.toLowerCase() === BASE_SEPOLIA_CONTRACTS.WETH9.toLowerCase() 
                    ? BigInt(parsedAmount.toString())
                    : 0n;
                    
                if (balance < requiredAmount) {
                    throw new DexError(
                        `Insufficient balance. Have ${balance.toString()} wei, need ${requiredAmount.toString()} wei`,
                        'INSUFFICIENT_BALANCE'
                    );
                }

                const value = fromAddress.toLowerCase() === BASE_SEPOLIA_CONTRACTS.WETH9.toLowerCase() 
                    ? BigInt(parsedAmount.toString())
                    : 0n;

                const txHash = await walletProvider.sendTransaction({
                    to: BASE_SEPOLIA_CONTRACTS.UNIVERSAL_ROUTER,
                    data: route.methodParameters.calldata as `0x${string}`,
                    value
                }).catch((error) => {
                    console.error("Transaction error:", error);
                    if (error.message?.includes("insufficient funds")) {
                        throw new DexError(
                            "Insufficient funds to execute the trade",
                            'EXECUTION_ERROR'
                        );
                    }
                    throw new DexError(
                        "Failed to execute the trade",
                        'EXECUTION_ERROR',
                        error
                    );
                });

                const receipt = await walletProvider.waitForTransactionReceipt(txHash);

                if (receipt.status === "success") {
                    const expectedOutput = this.formatUnits(route.quote.toString(), 18);
                    return `Successfully traded ${amount} ${args.fromAssetTicker || "tokens"} for approximately ${expectedOutput} ${args.toAssetTicker || "tokens"}.\nTransaction hash: ${txHash}`;
                } else {
                    throw new DexError(
                        `Transaction failed. Hash: ${txHash}`,
                        'EXECUTION_ERROR'
                    );
                }
            } catch (error: unknown) {
                if (error instanceof DexError) {
                    throw error;
                }
                const message = error instanceof Error ? error.message : String(error);
                throw new DexError(
                    `Failed to initialize trade: ${message}`,
                    'UNKNOWN',
                    error
                );
            }
        } catch (error: unknown) {
            if (error instanceof DexError) {
                switch (error.code) {
                    case 'NO_ROUTE':
                        return `Trade failed: No valid trading route found. This usually means there is no liquidity pool available for this token pair.`;
                    case 'NO_LIQUIDITY':
                        return `Trade failed: The pool exists but has insufficient liquidity for this trade.`;
                    case 'AMOUNT_TOO_SMALL':
                        return `Trade failed: ${error.message}`;
                    case 'INSUFFICIENT_BALANCE':
                        return `Trade failed: ${error.message}`;
                    case 'EXECUTION_ERROR':
                        return `Trade failed during execution: ${error.message}`;
                    default:
                        return `Trade failed with an unknown error: ${error.message}`;
                }
            }
            const message = error instanceof Error ? error.message : String(error);
            return `Unexpected error during trade: ${message}`;
        }
    }

    private normalizeAddress(address: string): `0x${string}` {
        return address.toLowerCase() as `0x${string}`;
    }

    private parseUnits(value: string, decimals: number): string {
        const [whole, fraction = ''] = value.split('.');
        const paddedFraction = fraction.padEnd(decimals, '0');
        return `${whole}${paddedFraction}`;
    }

    private formatUnits(value: string, decimals: number): string {
        if (value.length <= decimals) {
            value = value.padStart(decimals + 1, '0');
        }
        const whole = value.slice(0, -decimals);
        const fraction = value.slice(-decimals).replace(/0+$/, '');
        return fraction ? `${whole}.${fraction}` : whole;
    }

    private async createToken(address: string, symbol: string): Promise<Token> {
        return new Token(
            CHAIN_ID,
            address as `0x${string}`,
            18,  // Using 18 decimals as default for testing
            symbol,
            symbol
        );
    }

    supportsNetwork = (_: Network): boolean => true;
}

export const testnetTradeActionProvider = () => new TestnetTradeActionProvider();