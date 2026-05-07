const fs = require('node:fs');
const path = require('node:path');

loadEnvFile(path.join(__dirname, '..', 'server', '.env'));
loadEnvFile(path.join(__dirname, '..', '.env'));

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const productName = args.name || args._.join(' ').trim();

  if (!productName) {
    printUsageAndExit();
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is missing. Add it to server/.env first.');
  }

  const result = await fetchHongKongPrices({
    name: productName,
    brand: args.brand || '',
    size: args.size || '',
    maxResults: Number(args.max || 5),
  });

  process.stdout.write(`${JSON.stringify(result, null, args.compact ? 0 : 2)}\n`);
}

async function fetchHongKongPrices({ name, brand, size, maxResults }) {
  const queryText = [brand, name, size].filter(Boolean).join(' ');
  const payload = await callGemini({
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: [
              'Find current Hong Kong retail price sources for this Japanese drugstore product.',
              'Use Google Search grounding. Prefer Hong Kong stores and marketplace pages such as HKTVmall, Watsons HK, Mannings, Sasa, official brand HK pages, or reputable HK retailers.',
              'Return only sources where the page appears to sell or list the same product or a very close match.',
              'Do not return out-of-stock pages, unavailable products, sold-out listings, discontinued pages, or pages without a working product URL.',
              'If the exact size is unavailable, include the closest matching size and explain that in notes.',
              'Return strict JSON only. Do not wrap in markdown.',
              'Schema:',
              '{"sources":[{"name":"Retailer and product title","priceHkd":123.4,"availability":"In stock|Low stock|Out of stock|Unknown","url":"https://...","matchedProductName":"Listed product name","notes":"short reason this matches"}]}',
              `Maximum sources: ${Number.isFinite(maxResults) && maxResults > 0 ? Math.min(maxResults, 8) : 5}.`,
              `Product: ${queryText}`,
            ].join('\n'),
          },
        ],
      },
    ],
    tools: [{ google_search: {} }],
  });

  const outputText = extractOutputText(payload);
  const parsed = parseJsonFromText(outputText);
  const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
  const candidateSources = sources
    .filter((source) => source && typeof source === 'object')
    .slice(0, Number.isFinite(maxResults) && maxResults > 0 ? maxResults : 5)
    .map((source) => ({
      name: String(source.name || source.matchedProductName || 'HK source'),
      priceHkd: normalizePrice(source.priceHkd),
      availability: normalizeAvailability(source.availability),
      url: typeof source.url === 'string' ? source.url : undefined,
      matchedProductName:
        typeof source.matchedProductName === 'string' ? source.matchedProductName : undefined,
      notes: typeof source.notes === 'string' ? source.notes : undefined,
    }))
    .filter(
      (source) =>
        source.priceHkd > 0 &&
        source.availability !== 'Out of stock' &&
        Boolean(source.url),
    );
  const verifiedSources = await verifyHongKongSourceUrls(candidateSources, maxResults);

  return {
    product: { name, brand, size },
    model: GEMINI_MODEL,
    sources: verifiedSources,
    usage: normalizeGeminiUsage(payload.usageMetadata),
    searchQueries: extractSearchQueries(payload),
  };
}

async function verifyHongKongSourceUrls(sources, maxResults) {
  const limit = Number.isFinite(Number(maxResults)) && Number(maxResults) > 0 ? Number(maxResults) : 5;
  const verifiedSources = [];

  for (const source of sources) {
    const verified = await verifyProductUrl(source.url);

    if (verified.ok) {
      verifiedSources.push({
        ...source,
        url: verified.url,
        verifiedStatus: verified.status,
      });
    }

    if (verifiedSources.length >= limit) {
      break;
    }
  }

  return verifiedSources;
}

async function verifyProductUrl(url) {
  if (!isHttpUrl(url)) {
    return { ok: false, url };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Range: 'bytes=0-4096',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      },
    });

    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      url: response.url || url,
    };
  } catch {
    return { ok: false, url };
  } finally {
    clearTimeout(timeout);
  }
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function callGemini(body) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  const payload = safeJson(text);

  if (!response.ok) {
    const message = payload?.error?.message || text || `Gemini request failed with ${response.status}.`;
    throw new Error(message);
  }

  return payload;
}

function parseArgs(args) {
  const parsed = { _: [] };

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];

    if (!value.startsWith('--')) {
      parsed._.push(value);
      continue;
    }

    const key = value.slice(2);

    if (key === 'compact') {
      parsed.compact = true;
      continue;
    }

    parsed[key] = args[index + 1] || '';
    index += 1;
  }

  return parsed;
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');

    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, '');

    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

function extractOutputText(payload) {
  const textParts = [];

  for (const candidate of payload.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (typeof part.text === 'string') {
        textParts.push(part.text);
      }
    }
  }

  return textParts.join('\n').trim();
}

function parseJsonFromText(text) {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const direct = safeJson(cleaned);

  if (direct) {
    return direct;
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = cleaned.slice(firstBrace, lastBrace + 1);
    const parsed = safeJson(sliced);

    if (parsed) {
      return parsed;
    }
  }

  throw new Error('Gemini returned HK price data that could not be parsed as JSON.');
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizePrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : 0;
}

function normalizeAvailability(value) {
  const allowed = new Set(['In stock', 'Low stock', 'Out of stock', 'Unknown']);
  return allowed.has(value) ? value : 'Unknown';
}

function normalizeGeminiUsage(usageMetadata = {}) {
  return {
    promptTokenCount: Number(usageMetadata.promptTokenCount || 0),
    candidatesTokenCount: Number(usageMetadata.candidatesTokenCount || 0),
    thoughtsTokenCount: Number(usageMetadata.thoughtsTokenCount || 0),
    totalTokenCount: Number(usageMetadata.totalTokenCount || 0),
  };
}

function extractSearchQueries(payload) {
  const queries = [];

  for (const candidate of payload.candidates || []) {
    const groundingMetadata = candidate.groundingMetadata || candidate.grounding_metadata;

    for (const query of groundingMetadata?.webSearchQueries || []) {
      queries.push(query);
    }
  }

  return [...new Set(queries)];
}

function printUsageAndExit() {
  process.stderr.write(
    [
      'Usage:',
      '  npm run hk-prices -- "Melano CC serum 20ml"',
      '  npm run hk-prices -- --brand "Rohto" --name "Melano CC Premium Essence" --size "20ml"',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
