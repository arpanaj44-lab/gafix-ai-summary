// api/summarize.js — Vercel serverless function
//
// DUAL-PROVIDER: set LLM_PROVIDER=anthropic (default) or LLM_PROVIDER=bedrock.
// Keep using "anthropic" right now while you wait for AWS access — everything
// still works exactly as before. The moment Bedrock credentials land, set
// LLM_PROVIDER=bedrock + the three AWS_* vars below and redeploy. No code
// changes needed either way.

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

export const config = {
  maxDuration: 30,
};

const PROVIDER = process.env.LLM_PROVIDER || 'bedrock';

// Bedrock client is only constructed if actually needed — no cost or
// cold-start penalty while you're still on the Anthropic path.
let bedrockClient;
function getBedrockClient() {
  if (!bedrockClient) {
    const config = { region: process.env.AWS_REGION || 'us-east-1' };
    // Only needed if your cloud team issues temporary/STS credentials
    // (you'll know because you'll also have an AWS_SESSION_TOKEN value).
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
    if (PROVIDER === 'bedrock') {
      return await handleBedrock(req, res, { system, messages, max_tokens });
    }
    return await handleAnthropic(req, res, { system, messages, max_tokens });
  } catch (err) {
    console.error(`[${PROVIDER}] Proxy error:`, err.message);
    return res.status(500).json({ error: 'Summary generation failed' });
  }
}

// ── Anthropic direct (current, working path) ──
async function handleAnthropic(req, res, { system, messages, max_tokens }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      max_tokens: max_tokens || 800,
      system,
      messages,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('Anthropic error:', data);
    return res.status(response.status).json({ error: data.error?.message || 'Anthropic API error' });
  }
  return res.status(200).json({ content: data.content, usage: data.usage });
}

// ── Bedrock (ready to go once AWS access lands) ──
async function handleBedrock(req, res, { system, messages, max_tokens }) {
  const client = getBedrockClient();

  // IMPORTANT: confirm this exact ID in the Bedrock console once you have access —
  // Model catalog → Claude Sonnet 5 → "API request" tab shows the literal modelId
  // string AWS expects. It sometimes includes a date suffix. Override via env var
  // if the hardcoded default below turns out to be wrong.
  const modelId = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-sonnet-5-v1:0';

  const command = new ConverseCommand({
    modelId,
    system: [{ text: system }],
    messages: messages.map(m => ({
      role: m.role,
      content: [{ text: m.content }],
    })),
    inferenceConfig: { maxTokens: max_tokens || 2048 },
  });

  const response = await client.send(command);

  // Extract text from Bedrock's response — handle multiple possible shapes
  const outputContent = response.output?.message?.content || [];
  let text = '';
  for (const block of outputContent) {
    if (block.text) { text += block.text; }
    else if (typeof block === 'string') { text += block; }
  }

  // Log for debugging if text is empty
  if (!text) {
    console.error('[bedrock] Empty text. Raw output:', JSON.stringify(response.output));
  }

  return res.status(200).json({
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: response.usage?.inputTokens || 0,
      output_tokens: response.usage?.outputTokens || 0,
    },
  });
}
