import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

// Allow up to 60s on Vercel. We abort our own Bedrock call at 52s so that, even in the
// worst case, the browser receives a clean JSON error instead of Vercel's plain-text 504 page.
export const config = { maxDuration: 60 };

const ABORT_AFTER_MS = 48000; // leaves room for the scrape (below) inside the 52s/60s budget
const SCRAPE_TIMEOUT_MS = 4000; // homepage fetch gets its own short, separate budget
const MAX_OUTPUT_TOKENS = 2400; // hard ceiling: keeps latency and cost bounded (~34s worst case at measured throughput)

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

// ── Homepage scrape for business context ──
// Scoped to ONE job only: tell the AI what the business actually is, so it stops
// guessing from the domain name alone. Cached per domain for the life of this
// serverless instance (free on repeat calls within that window).
const siteCache = new Map();

async function getBusinessContext(url) {
  if (!url) return null;
  let domain;
  try { domain = new URL(url).hostname; } catch { return null; }
  if (siteCache.has(domain)) return siteCache.get(domain);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'GAfix-Audit-Bot/1.0 (business-context-check)', 'Accept': 'text/html' },
    });
    if (!resp.ok) { siteCache.set(domain, null); return null; }

    // Only read the first ~50KB — title/meta/h1 are always near the top of <head>/<body>
    const reader = resp.body.getReader();
    let html = '', received = 0;
    const decoder = new TextDecoder();
    while (received < 50000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      received += value.length;
    }
    try { await reader.cancel(); } catch {}

    const grab = (pattern) => {
      const m = html.match(pattern);
      return m ? m[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    };

    const title = grab(/<title[^>]*>([^<]+)<\/title>/i);
    const description = grab(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)
      || grab(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
    const ogDescription = grab(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)/i);
    const h1 = grab(/<h1[^>]*>([^<]+)/i);

    let summary = '';
    if (title) summary += `Page title: "${title}". `;
    if (description || ogDescription) summary += `Meta description: "${description || ogDescription}". `;
    if (h1 && h1 !== title) summary += `Main heading: "${h1}". `;

    const result = summary ? summary.trim() : null;
    siteCache.set(domain, result);
    console.log(`[scrape] ${domain}: ${result ? result.length + ' chars cached' : 'no usable signals found'}`);
    return result;
  } catch (err) {
    console.log(`[scrape] Skipped for ${domain}: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
    siteCache.set(domain, null);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { system, messages, max_tokens, site_url } = req.body || {};
  if (!system || !messages) return res.status(400).json({ error: 'Missing system or messages' });

  const started = Date.now();

  // Scrape (if we have a URL) before building the final prompt — cheap, and
  // a failed/slow scrape never blocks the AI call since it has its own timeout.
  const businessContext = await getBusinessContext(site_url);

  let finalMessages = messages;
  if (businessContext) {
    finalMessages = messages.map((m, i) => {
      if (i === messages.length - 1 && m.role === 'user') {
        return {
          ...m,
          content:
            m.content +
            '\n\nREAL WEBSITE CONTENT (scraped from their homepage just now — trust this over any guess based on the domain name):\n' +
            businessContext,
        };
      }
      return m;
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ABORT_AFTER_MS);

  try {
    const client = getBedrockClient();
    const modelId = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-sonnet-5-v1:0';

    const command = new ConverseCommand({
      modelId,
      system: [{ text: system }],
      messages: finalMessages.map(m => ({ role: m.role, content: [{ text: m.content }] })),
      inferenceConfig: { maxTokens: Math.min(Number(max_tokens) || 1500, MAX_OUTPUT_TOKENS) },
    });

    const response = await client.send(command, { abortSignal: controller.signal });

    let text = '';
    for (const block of response.output?.message?.content || []) {
      if (block.text) text += block.text;
    }

    console.log(
      `[bedrock] ok ${Date.now() - started}ms in=${response.usage?.inputTokens} out=${response.usage?.outputTokens} stop=${response.stopReason} scraped=${!!businessContext}`
    );
    if (!text) console.error('[bedrock] Empty text. Raw:', JSON.stringify(response.output));

    return res.status(200).json({
      content: [{ type: 'text', text }],
      usage: { input_tokens: response.usage?.inputTokens || 0, output_tokens: response.usage?.outputTokens || 0 },
      stop_reason: response.stopReason,
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
