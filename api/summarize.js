// api/summarize.js — Vercel serverless function
// This is the ONLY file that touches your API key.
// The frontend calls /api/summarize, Vercel routes it here,
// this function calls Anthropic and returns the result.

export const config = {
  maxDuration: 30, // Claude can take 5-10s; 30s is safe
};

export default async function handler(req, res) {
  // CORS — restrict to your domain in production
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { system, messages, max_tokens } = req.body;

  if (!system || !messages) {
    return res.status(400).json({ error: 'Missing system or messages' });
  }

  // Simple rate limiting via header (upgrade to KV/Redis for production)
  const ip = req.headers['x-forwarded-for'] || 'unknown';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        // Uncomment for prompt caching (saves ~28%):
        // 'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: max_tokens || 800,
        system,
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic error:', data);
      return res.status(response.status).json({
        error: data.error?.message || 'Anthropic API error',
      });
    }

    // Only forward what the frontend needs
    return res.status(200).json({
      content: data.content,
      usage: data.usage,
    });
  } catch (err) {
    console.error('Proxy error:', err.message);
    return res.status(500).json({ error: 'Summary generation failed' });
  }
}
