import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

// Allow up to 60s on Vercel. We abort our own Bedrock call at 52s so that, even in the
// worst case, the browser receives a clean JSON error instead of Vercel's plain-text 504 page.
export const config = { maxDuration: 60 };

const ABORT_AFTER_MS = 52000;
const MAX_OUTPUT_TOKENS = 2000; // hard ceiling: keeps latency and cost bounded

let bedrockClient;
function getBedrockClient() {
  if (!bedrockClient) {
    const cfg = {
      region: process.env.AWS_REGION || 'us-east-1',
      maxAttempts: 2, // default is 3; retries on throttling can silently eat the time budget
    };
    if (process.env.AWS_SESSION_TOKEN) {
      cfg.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
      };
    }
    bedrockClient = new BedrockRuntimeClient(cfg);
  }
  return bedrockClient;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { system, messages, max_tokens } = req.body || {};
  if (!system || !messages) return res.status(400).json({ error: 'Missing system or messages' });

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ABORT_AFTER_MS);

  try {
    const client = getBedrockClient();
    const modelId = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-sonnet-5-v1:0';

    const command = new ConverseCommand({
      modelId,
      system: [{ text: system }],
      messages: messages.map(m => ({ role: m.role, content: [{ text: m.content }] })),
      inferenceConfig: { maxTokens: Math.min(Number(max_tokens) || 1500, MAX_OUTPUT_TOKENS) },
    });

    const response = await client.send(command, { abortSignal: controller.signal });

    let text = '';
    for (const block of response.output?.message?.content || []) {
      if (block.text) text += block.text;
    }

    console.log(
      `[bedrock] ok ${Date.now() - started}ms in=${response.usage?.inputTokens} out=${response.usage?.outputTokens} stop=${response.stopReason}`
    );
    if (!text) console.error('[bedrock] Empty text. Raw:', JSON.stringify(response.output));

    return res.status(200).json({
      content: [{ type: 'text', text }],
      usage: { input_tokens: response.usage?.inputTokens || 0, output_tokens: response.usage?.outputTokens || 0 },
      stop_reason: response.stopReason, // "max_tokens" means the output was cut off
    });
  } catch (err) {
    const elapsed = Date.now() - started;
    console.error(`[bedrock] FAILED after ${elapsed}ms: ${err.name}: ${err.message}`);

    if (err.name === 'AbortError' || controller.signal.aborted) {
      return res.status(504).json({ error: 'The AI took too long to respond. Please try again.', code: 'TIMEOUT' });
    }
    if (err.name === 'ThrottlingException') {
      return res.status(429).json({ error: 'The AI service is busy right now. Wait a few seconds and try again.', code: err.name });
    }
    return res.status(500).json({ error: 'Summary generation failed', code: err.name || 'ERROR' });
  } finally {
    clearTimeout(timer);
  }
}
