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

    // Trade from JTK to MTK
    console.log("Testing JTK -> MTK trade");
    const result = await tradeProvider.trade(walletProvider, {
        amount: "10", // Start with a modest amount
        fromAssetId: "0x258C99F2B71629C1Dd555bfFd7EA837Be5552a49",  // JTK
        toAssetId: "0x43C6cbD925a6e2cA502fD858865Ab64d6e0277CD",   // MTK
        fromAssetTicker: "JTK",
        toAssetTicker: "MTK"
    });

    console.log(result);
}

main().catch(console.error);