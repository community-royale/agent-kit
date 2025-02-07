import { ViemWalletProvider } from "@coinbase/agentkit";
import { testnetTradeActionProvider } from "../src/actions/customDexTrade";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { config } from "dotenv";
config();

async function main() {
    const privateKey = process.env.ETH_PRIV_KEY;
    if (!privateKey) throw new Error("ETH_PRIV_KEY not set");
    
    // Ensure private key has 0x prefix
    const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    
    const account = privateKeyToAccount(formattedKey as `0x${string}`);
    
    const client = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http("https://sepolia.base.org")
    });

    const walletProvider = new ViemWalletProvider(client);
    const tradeProvider = testnetTradeActionProvider();

    const result = await tradeProvider.trade(walletProvider, {
        amount: "0.1",  // Try 0.1 ETH
        fromAssetId: "0x4200000000000000000000000000000000000006",
        toAssetId: "0x78F942F8F9110067c08183183c45903e5Dc2763A",
        fromAssetTicker: "ETH",
        toAssetTicker: "WBTC"
    });

    console.log(result);
}

main().catch(console.error);