// src/actions/customDexTrade.ts
import { z } from "zod";
import { ActionProvider, CreateAction, EvmWalletProvider } from "@coinbase/agentkit";
import type { Network } from "@coinbase/agentkit";
import { Token, CurrencyAmount, TradeType, Percent } from "@uniswap/sdk-core";
import { AlphaRouter, SwapType, SwapOptionsSwapRouter02 } from '@uniswap/smart-order-router';
import { providers } from 'ethers';
import { baseSepolia } from 'viem/chains';
import JSBI from 'jsbi';

// Schema matches the original CDP trade interface
export const TestnetTradeSchema = z
  .object({
    amount: z.string().describe("The amount of the from asset to trade"),
    fromAssetId: z.string().describe("The from asset ID to trade"),
    toAssetId: z.string().describe("The to asset ID to receive from the trade"),
    fromAssetTicker: z.string().optional().describe("The ticker symbol of the from asset"),
    toAssetTicker: z.string().optional().describe("The ticker symbol of the to asset"),
  })
  .strip()
  .describe("Instructions for trading assets on Base Sepolia testnet");

// Constants
const CHAIN_ID = baseSepolia.id;
const V3_SWAP_ROUTER_ADDRESS = "0x4648a43B2C14Da09FdF82B161150d3F634f40491" as const;
const BASE_SEPOLIA_RPC = baseSepolia.rpcUrls.default.http[0];

// ABI for ERC20 decimals() and symbol()
const ERC20_ABI = [{
    inputs: [],
    name: "decimals",
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
    type: "function"
}, {
    inputs: [],
    name: "symbol",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function"
}] as const;

class TestnetTradeActionProvider extends ActionProvider<EvmWalletProvider> {
    constructor() {
        super("testnet-trade-provider", []);
    }

    @CreateAction({
        name: "testnet_trade",
        description: `Trade tokens on Base Sepolia testnet using Uniswap V3.
Provide:
- The amount to trade (in human-readable format)
- The input token address and optional ticker
- The output token address and optional ticker
The trade will be routed optimally through Uniswap V3 pools.`,
        schema: TestnetTradeSchema,
    })
    async trade(
        walletProvider: EvmWalletProvider,
        args: z.infer<typeof TestnetTradeSchema>
    ): Promise<string> {
        try {
            const { fromAssetId, toAssetId, amount } = args;

            // Convert addresses to checksum format
            const fromAddress = this.normalizeAddress(fromAssetId);
            const toAddress = this.normalizeAddress(toAssetId);

            // Get token information
            const [fromToken, toToken] = await Promise.all([
                this.getTokenInfo(walletProvider, fromAddress, args.fromAssetTicker),
                this.getTokenInfo(walletProvider, toAddress, args.toAssetTicker)
            ]);

            // Setup ethers provider for the router
            const provider = new providers.JsonRpcProvider(BASE_SEPOLIA_RPC);

            // Create router instance
            const router = new AlphaRouter({
                chainId: CHAIN_ID,
                provider,
            });

            // Convert amount to proper format
            const parsedAmount = JSBI.BigInt(this.parseUnits(amount, fromToken.decimals));
            const currencyAmount = CurrencyAmount.fromRawAmount(fromToken, parsedAmount);

            // Setup swap options
            const swapOptions: SwapOptionsSwapRouter02 = {
                recipient: await walletProvider.getAddress(),
                slippageTolerance: new Percent(50, 10_000), // 0.5%
                deadline: Math.floor(Date.now() / 1000 + 1800), // 30 minutes
                type: SwapType.SWAP_ROUTER_02
            };

            // Get the best route
            const route = await router.route(
                currencyAmount,
                toToken,
                TradeType.EXACT_INPUT,
                swapOptions
            );

            if (!route || !route.methodParameters) {
                throw new Error("No route found for this trade");
            }

            // Execute the trade
            const txHash = await walletProvider.sendTransaction({
                to: V3_SWAP_ROUTER_ADDRESS as `0x${string}`,
                data: route.methodParameters.calldata as `0x${string}`,
                value: BigInt(route.methodParameters.value)
            });

            const receipt = await walletProvider.waitForTransactionReceipt(txHash);

            if (receipt.status === "success") {
                const expectedOutput = this.formatUnits(route.quote.toString(), toToken.decimals);
                return `Successfully traded ${amount} ${fromToken.symbol} for approximately ${expectedOutput} ${toToken.symbol}.\nTransaction hash: ${txHash}`;
            } else {
                return `Transaction failed. Hash: ${txHash}`;
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            return `Error trading assets: ${errorMessage}`;
        }
    }

    // Helper function to normalize addresses
    private normalizeAddress(address: string): `0x${string}` {
        return address.toLowerCase() as `0x${string}`;
    }

    // Helper function to parse units
    private parseUnits(value: string, decimals: number): string {
        const [whole, fraction = ''] = value.split('.');
        const paddedFraction = fraction.padEnd(decimals, '0');
        return `${whole}${paddedFraction}`;
    }

    // Helper function to format units
    private formatUnits(value: string, decimals: number): string {
        if (value.length <= decimals) {
            value = value.padStart(decimals + 1, '0');
        }
        const whole = value.slice(0, -decimals);
        const fraction = value.slice(-decimals).replace(/0+$/, '');
        return fraction ? `${whole}.${fraction}` : whole;
    }

    // Get complete token information
    private async getTokenInfo(
        walletProvider: EvmWalletProvider, 
        tokenAddress: `0x${string}`,
        providedSymbol?: string
    ): Promise<Token> {
        // Get decimals
        const decimals = await walletProvider.readContract({
            address: tokenAddress,
            abi: ERC20_ABI,
            functionName: "decimals"
        }) as number;

        // Get symbol if not provided
        let symbol = providedSymbol;
        if (!symbol) {
            try {
                symbol = await walletProvider.readContract({
                    address: tokenAddress,
                    abi: ERC20_ABI,
                    functionName: "symbol"
                }) as string;
            } catch {
                symbol = tokenAddress.slice(2, 8);
            }
        }

        return new Token(
            CHAIN_ID,
            tokenAddress,
            decimals,
            symbol,
            symbol
        );
    }

    // Support all networks for testing
    supportsNetwork = (_: Network): boolean => true;
}

// Export the provider factory function
export const testnetTradeActionProvider = () => new TestnetTradeActionProvider();