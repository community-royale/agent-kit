// src/server.ts
import express, { Request, Response } from 'express';
import cors from 'cors';
import { initializeAgent } from './chatbot';
import { HumanMessage } from "@langchain/core/messages";

const app = express();

// Configure CORS
app.use(cors({
    origin: '*', // Allow all origins
    methods: ['POST'], // Only allow POST method
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

let agent: any;
let agentConfig: any;

interface ChatRequest {
    text: string;
}

interface ChatResponse {
    text: string;
}

// Initialize agent when server starts
async function setupAgent() {
    try {
        console.log('CDP_API_KEY_NAME:', process.env.CDP_API_KEY_NAME ? 'Set' : 'Not set');
        console.log('CDP_API_KEY_PRIVATE_KEY:', process.env.CDP_API_KEY_PRIVATE_KEY ? 'Set' : 'Not set');
        console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'Set' : 'Not set');
        
        const result = await initializeAgent();
        agent = result.agent;
        agentConfig = result.config;
    } catch (error) {
        console.error("Failed to initialize agent:", error);
        throw error;
    }
}

setupAgent().catch(console.error);

const chatHandler = async (
    req: Request<{}, {}, ChatRequest>,
    res: Response<ChatResponse>
): Promise<void> => {
    try {
        if (!agent) {
            res.status(500).json({ text: "Agent not initialized" });
            return;
        }

        const userInput = (req.body as ChatRequest).text;
        if (!userInput) {
            res.status(400).json({ text: "Missing text field in request body" });
            return;
        }

        const stream = await agent.stream(
            { messages: [new HumanMessage(userInput)] },
            agentConfig
        );

        let response = '';
        for await (const chunk of stream) {
            if ("agent" in chunk) {
                response += chunk.agent.messages[0].content + '\n';
            } else if ("tools" in chunk) {
                response += chunk.tools.messages[0].content + '\n';
            }
        }

        res.json({ text: response.trim() });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ text: "Internal server error" });
    }
};

app.post('/poke', chatHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});