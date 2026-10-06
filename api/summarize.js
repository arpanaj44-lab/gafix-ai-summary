import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

export const config = { maxDuration: 30 };

let bedrockClient;
function getBedrockClient() {
  if (!bedrockClient) {
    const config = { region: process.env.AWS_REGION || 'us-east-1' };
    if (process.env.AWS_SESSION_TOKEN) {
      config.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
      };
    }
    bedrockClient = new BedrockRuntimeClient(config);
  }
  return bedrockClient;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { system, messages, max_tokens } = req.body;
  if (!system || !messages) return res.status(400).json({ error: 'Missing system or messages' });

  try {
    const client = getBedrockClient();
    const modelId = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-sonnet-5-v1:0';

    const command = new ConverseCommand({
      modelId,
      system: [{ text: system }],
      messages: messages.map(m => ({ role: m.role, content: [{ text: m.content }] })),
      inferenceConfig: { maxTokens: max_tokens || 2048 },
    });

    const response = await client.send(command);
    const outputContent = response.output?.message?.content || [];
    let text = '';
    for (const block of outputContent) {
      if (block.text) text += block.text;
      else if (typeof block === 'string') text += block;
    }
    if (!text) console.error('[bedrock] Empty text. Raw:', JSON.stringify(response.output));

    return res.status(200).json({
      content: [{ type: 'text', text }],
      usage: { input_tokens: response.usage?.inputTokens || 0, output_tokens: response.usage?.outputTokens || 0 },
    });
  } catch (err) {
    console.error('Proxy error:', err.message);
    return res.status(500).json({ error: 'Summary generation failed' });
  }
}
