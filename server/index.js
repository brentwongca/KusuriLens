const http = require('node:http');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

loadLocalEnv();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
let activeAiProvider = normalizeAiProvider(process.env.AI_PROVIDER || 'gemini');
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free';
const MODEL_CONFIG_PATH = path.join(__dirname, 'ai-models.json');
const LOG_FILE_PATH = path.resolve(__dirname, '..', 'server-debug.log');
const savedModelConfig = loadModelConfig();
const providerModels = {
  gemini: uniqueModels([
    ...(savedModelConfig.providerModels?.gemini || []),
    GEMINI_MODEL,
    ...parseModelList(process.env.GEMINI_MODELS),
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
  ]),
  openrouter: uniqueModels([
    ...(savedModelConfig.providerModels?.openrouter || []),
    OPENROUTER_MODEL,
    ...parseModelList(process.env.OPENROUTER_MODELS),
  ]),
};
const activeModels = {
  gemini: providerModels.gemini.includes(savedModelConfig.activeModels?.gemini)
    ? savedModelConfig.activeModels.gemini
    : providerModels.gemini[0],
  openrouter: providerModels.openrouter.includes(savedModelConfig.activeModels?.openrouter)
    ? savedModelConfig.activeModels.openrouter
    : providerModels.openrouter[0],
};
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const analysisJobs = new Map();
let exchangeRateCache = null;
let geminiUsage = {
  requestCount: 0,
  promptTokenCount: 0,
  candidatesTokenCount: 0,
  thoughtsTokenCount: 0,
  totalTokenCount: 0,
  lastRequest: null,
};

function loadLocalEnv() {
  const envPath = path.join(__dirname, '.env');

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

function loadModelConfig() {
  try {
    if (!fs.existsSync(MODEL_CONFIG_PATH)) {
      return {};
    }

    return JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveModelConfig() {
  fs.writeFileSync(
    MODEL_CONFIG_PATH,
    `${JSON.stringify({ providerModels, activeModels }, null, 2)}\n`,
    'utf8',
  );
}

const productSchema = {
  type: 'OBJECT',
  properties: {
    products: {
      type: 'ARRAY',
      maxItems: 8,
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          brand: { type: 'STRING' },
          size: { type: 'STRING' },
          originalJapanPriceYen: { type: 'NUMBER' },
          taxExcludedPriceYen: { type: 'NUMBER' },
          taxIncludedPriceYen: { type: 'NUMBER' },
          taxIncluded: { type: 'BOOLEAN' },
          visiblePriceText: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
        },
        required: [
          'name',
          'brand',
          'size',
          'originalJapanPriceYen',
          'taxIncluded',
          'confidence',
        ],
        propertyOrdering: [
          'name',
          'brand',
          'size',
          'originalJapanPriceYen',
          'taxExcludedPriceYen',
          'taxIncludedPriceYen',
          'taxIncluded',
          'visiblePriceText',
          'confidence',
        ],
      },
    },
  },
  required: ['products'],
  propertyOrdering: ['products'],
};

const server = http.createServer(async (request, response) => {
  setCorsHeaders(response);
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  logEvent(`${request.method} ${url.pathname}`);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      provider: getActiveProvider(),
      model: getActiveModel(),
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      hasOpenRouterKey: Boolean(process.env.OPENROUTER_API_KEY),
    });
    return;
  }

  if (request.method === 'GET' && (url.pathname === '/test-gemini' || url.pathname === '/test-ai')) {
    if (!hasActiveProviderKey()) {
      sendJson(response, 500, {
        error: `${getActiveProvider()} API key is missing. Add it to server/.env, then restart npm run ai-server.`,
      });
      return;
    }

    try {
      const reply = await testAiConnection();
      sendJson(response, 200, {
        ok: true,
        provider: getActiveProvider(),
        model: getActiveModel(),
        reply,
      });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'Gemini connection test failed.',
      });
    }

    return;
  }

  if (request.method === 'GET' && url.pathname === '/exchange-rate') {
    try {
      const rate = await getJpyToHkdRate();
      sendJson(response, 200, rate);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : 'Could not fetch exchange rate.',
      });
    }

    return;
  }

  if (request.method === 'GET' && url.pathname === '/api-usage') {
    sendJson(response, 200, {
      provider: getActiveProvider(),
      model: getActiveModel(),
      usage: geminiUsage,
      remaining: null,
      remainingNote: 'Gemini generateContent responses include token usage but do not include live remaining quota.',
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/logs') {
    const limit = Math.max(1, Math.min(80, Number(url.searchParams.get('limit') || 24)));

    sendJson(response, 200, getLogTail(limit));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/logs/open') {
    try {
      openLogFile();
      sendJson(response, 200, {
        ok: true,
        path: LOG_FILE_PATH,
      });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : 'Could not open the log file.',
      });
    }

    return;
  }

  if (request.method === 'GET' && url.pathname === '/ai-provider') {
    sendJson(response, 200, getProviderStatus());
    return;
  }

  if (request.method === 'POST' && url.pathname === '/ai-provider') {
    try {
      const body = await readJsonBody(request);
      const provider = normalizeAiProvider(String(body.provider || ''));

      activeAiProvider = provider;
      sendJson(response, 200, getProviderStatus());
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Could not update AI provider.',
      });
    }

    return;
  }

  if (request.method === 'POST' && url.pathname === '/ai-models') {
    try {
      const body = await readJsonBody(request);
      const provider = normalizeAiProvider(String(body.provider || ''));
      const model = normalizeModelName(body.model);

      addProviderModel(provider, model);
      sendJson(response, 200, getProviderStatus());
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Could not add AI model.',
      });
    }

    return;
  }

  if (request.method === 'POST' && url.pathname === '/ai-models/select') {
    try {
      const body = await readJsonBody(request);
      const provider = normalizeAiProvider(String(body.provider || ''));
      const model = normalizeModelName(body.model);

      selectProviderModel(provider, model);
      sendJson(response, 200, getProviderStatus());
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Could not select AI model.',
      });
    }

    return;
  }

  if (request.method === 'DELETE' && url.pathname === '/ai-models') {
    try {
      const provider = normalizeAiProvider(String(url.searchParams.get('provider') || ''));
      const model = normalizeModelName(url.searchParams.get('model'));

      deleteProviderModel(provider, model);
      sendJson(response, 200, getProviderStatus());
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Could not delete AI model.',
      });
    }

    return;
  }

  if (request.method === 'POST' && url.pathname === '/hk-price-sources') {
    if (!process.env.GEMINI_API_KEY) {
      sendJson(response, 500, {
        error: 'GEMINI_API_KEY is missing. Add it to server/.env, then restart npm run ai-server.',
      });
      return;
    }

    try {
      const body = await readJsonBody(request);
      const lookup = await lookupHongKongPriceSources(body.product || {});
      sendJson(response, 200, lookup);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : 'Could not fetch HK price sources.',
      });
    }

    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/analysis-jobs/')) {
    const jobId = decodeURIComponent(url.pathname.replace('/analysis-jobs/', ''));
    const job = analysisJobs.get(jobId);

    if (!job) {
      sendJson(response, 404, { error: 'Analysis job not found.' });
      return;
    }

    sendJson(response, 200, job);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/analysis-jobs') {
    if (!hasActiveProviderKey()) {
      logEvent(`analysis rejected: missing ${getActiveProvider()} key`);
      sendJson(response, 500, {
        error: `${getActiveProvider()} API key is missing. Add it to server/.env, then restart npm run ai-server.`,
      });
      return;
    }

    try {
      const body = await readJsonBody(request);
      const imageBase64 = normalizeBase64Image(String(body.imageBase64 || ''));

      if (!imageBase64) {
        logEvent('analysis rejected: imageBase64 is empty');
        sendJson(response, 400, { error: 'imageBase64 is required.' });
        return;
      }

      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      logEvent(
        `analysis job ${jobId} queued provider=${getActiveProvider()} model=${getActiveModel()} imageChars=${imageBase64.length}`,
      );

      analysisJobs.set(jobId, {
        id: jobId,
        status: 'queued',
        stage: 'queued',
        createdAt: new Date().toISOString(),
      });

      runAnalysisJob(jobId, {
        imageBase64,
        shop: body.shop || {},
        trip: body.trip || {},
      });

      sendJson(response, 202, { id: jobId, status: 'queued' });
    } catch (error) {
      logError('analysis start failed', error);
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : 'Could not start AI analysis.',
      });
    }

    return;
  }

  if (request.method !== 'POST' || url.pathname !== '/analyze-product-photo') {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  if (!hasActiveProviderKey()) {
    sendJson(response, 500, {
      error: `${getActiveProvider()} API key is missing. Add it to server/.env, then restart npm run ai-server.`,
    });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const imageBase64 = normalizeBase64Image(String(body.imageBase64 || ''));

    if (!imageBase64) {
      sendJson(response, 400, { error: 'imageBase64 is required.' });
      return;
    }

    const analysis = await analyzeProductPhoto({
      imageBase64,
      shop: body.shop || {},
      trip: body.trip || {},
    });

    sendJson(response, 200, analysis);
  } catch (error) {
    logError('direct analysis failed', error);
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'AI analysis failed.',
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`KusuriLens AI server running at http://${HOST}:${PORT}`);
});

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function logEvent(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function logError(message, error) {
  const detail = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);

  console.error(`[${new Date().toISOString()}] ${message}: ${detail}`);
}

function getLogTail(limit) {
  if (!fs.existsSync(LOG_FILE_PATH)) {
    return {
      path: LOG_FILE_PATH,
      lines: [],
      updatedAt: null,
    };
  }

  const content = readLogFileText();
  const lines = content.split(/\r?\n/).filter(Boolean).slice(-limit);
  const stats = fs.statSync(LOG_FILE_PATH);

  return {
    path: LOG_FILE_PATH,
    lines,
    updatedAt: stats.mtime.toISOString(),
  };
}

function readLogFileText() {
  const bytes = fs.readFileSync(LOG_FILE_PATH);

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.toString('utf16le').replace(/^\uFEFF/, '');
  }

  const sampleLength = Math.min(bytes.length, 80);
  let nullByteCount = 0;

  for (let index = 0; index < sampleLength; index += 1) {
    if (bytes[index] === 0) {
      nullByteCount += 1;
    }
  }

  return nullByteCount > sampleLength / 4
    ? bytes.toString('utf16le').replace(/^\uFEFF/, '')
    : bytes.toString('utf8').replace(/^\uFEFF/, '');
}

function openLogFile() {
  if (!fs.existsSync(LOG_FILE_PATH)) {
    fs.writeFileSync(LOG_FILE_PATH, '', 'utf8');
  }

  if (process.platform === 'win32') {
    const child = childProcess.spawn(
      'cmd.exe',
      ['/c', 'start', '', LOG_FILE_PATH],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    return;
  }

  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = childProcess.spawn(opener, [LOG_FILE_PATH], { detached: true, stdio: 'ignore' });
  child.unref();
}

function getActiveProvider() {
  return activeAiProvider;
}

function getActiveModel() {
  return activeModels[getActiveProvider()];
}

function hasActiveProviderKey() {
  return hasProviderKey(getActiveProvider());
}

function hasProviderKey(provider) {
  return provider === 'openrouter'
    ? Boolean(process.env.OPENROUTER_API_KEY)
    : Boolean(process.env.GEMINI_API_KEY);
}

function normalizeAiProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();

  if (normalized === 'openrouter') {
    return 'openrouter';
  }

  if (normalized === 'gemini') {
    return 'gemini';
  }

  throw new Error('AI provider must be gemini or openrouter.');
}

function parseModelList(value) {
  return String(value || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}

function uniqueModels(models) {
  return [...new Set(models.map((model) => String(model || '').trim()).filter(Boolean))];
}

function normalizeModelName(model) {
  const normalized = String(model || '').trim();

  if (!normalized) {
    throw new Error('Model name is required.');
  }

  if (normalized.length > 160) {
    throw new Error('Model name is too long.');
  }

  return normalized;
}

function addProviderModel(provider, model) {
  providerModels[provider] = uniqueModels([model, ...providerModels[provider]]);
  activeModels[provider] = model;
  saveModelConfig();
}

function selectProviderModel(provider, model) {
  if (!providerModels[provider].includes(model)) {
    addProviderModel(provider, model);
    return;
  }

  activeModels[provider] = model;
  saveModelConfig();
}

function deleteProviderModel(provider, model) {
  if (providerModels[provider].length <= 1) {
    throw new Error('Keep at least one model for each provider.');
  }

  providerModels[provider] = providerModels[provider].filter((item) => item !== model);

  if (activeModels[provider] === model) {
    activeModels[provider] = providerModels[provider][0];
  }

  saveModelConfig();
}

function getModelsForAttempt(provider) {
  return uniqueModels([activeModels[provider], ...providerModels[provider]]);
}

function getProviderStatus() {
  return {
    provider: getActiveProvider(),
    model: getActiveModel(),
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    hasOpenRouterKey: Boolean(process.env.OPENROUTER_API_KEY),
    availableProviders: [
      {
        provider: 'gemini',
        model: activeModels.gemini,
        models: providerModels.gemini,
        configured: Boolean(process.env.GEMINI_API_KEY),
      },
      {
        provider: 'openrouter',
        model: activeModels.openrouter,
        models: providerModels.openrouter,
        configured: Boolean(process.env.OPENROUTER_API_KEY),
      },
    ],
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on('data', (chunk) => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        reject(new Error('Image upload is too large. Try a smaller photo.'));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });

    request.on('error', reject);
  });
}

async function runAnalysisJob(jobId, input) {
  logEvent(`analysis job ${jobId} started`);
  analysisJobs.set(jobId, {
    ...analysisJobs.get(jobId),
    status: 'running',
    stage: 'recognizing-image',
    startedAt: new Date().toISOString(),
  });

  try {
    const analysis = await analyzeProductPhoto(input);
    const products = Array.isArray(analysis.products) ? analysis.products : [];
    logEvent(
      `analysis job ${jobId} recognized ${products.length} product(s) provider=${analysis.provider || getActiveProvider()} model=${analysis.model || getActiveModel()}`,
    );

    analysisJobs.set(jobId, {
      ...analysisJobs.get(jobId),
      status: 'running',
      stage: 'looking-up-hk-prices',
      recognizedProductCount: products.length,
      hkLookupProductName: products[0]?.name || null,
    });

    const enrichedProducts = await enrichProductsWithHongKongPrices(products, (product) => {
      analysisJobs.set(jobId, {
        ...analysisJobs.get(jobId),
        status: 'running',
        stage: 'looking-up-hk-prices',
        hkLookupProductName: product?.name || 'Unknown product',
      });
    });

    analysisJobs.set(jobId, {
      ...analysisJobs.get(jobId),
      status: 'completed',
      stage: 'completed',
      completedAt: new Date().toISOString(),
      result: {
        ...analysis,
        products: enrichedProducts,
      },
    });
    logEvent(`analysis job ${jobId} completed with ${enrichedProducts.length} product(s)`);
  } catch (error) {
    logError(`analysis job ${jobId} failed`, error);
    analysisJobs.set(jobId, {
      ...analysisJobs.get(jobId),
      status: 'failed',
      stage: 'failed',
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'AI analysis failed.',
    });
  }
}

async function analyzeProductPhoto(input) {
  const activeProvider = getActiveProvider();

  try {
    return await analyzeWithProviderModels(activeProvider, input);
  } catch (error) {
    const fallbackProvider = activeProvider === 'openrouter' ? 'gemini' : 'openrouter';

    if (hasProviderKey(fallbackProvider)) {
      const fallbackAnalysis = await analyzeWithProviderModels(fallbackProvider, input);
      return {
        ...fallbackAnalysis,
        providerFallback: {
          from: activeProvider,
          to: fallbackProvider,
          reason: error instanceof Error ? error.message : `${activeProvider} was unavailable.`,
        },
      };
    }

    throw error;
  }
}

async function analyzeWithProviderModels(provider, input) {
  const errors = [];

  for (const model of getModelsForAttempt(provider)) {
    try {
      const analysis = provider === 'openrouter'
        ? await analyzeWithOpenRouter(input, model)
        : await analyzeWithGemini(input, model);

      activeModels[provider] = model;
      saveModelConfig();

      return {
        ...analysis,
        provider,
        model,
      };
    } catch (error) {
      errors.push(`${model}: ${error instanceof Error ? error.message : 'failed'}`);
    }
  }

  throw new Error(`${provider} models failed. ${errors.join(' | ')}`);
}

function buildProductAnalysisPrompt({ shop, trip }) {
  return [
    'You extract products from Japanese drugstore shelf photos for a personal trip price database.',
    'Analyze this image. It may contain one or more Japanese drugstore products.',
    'Create one separate products array item for each distinct product package or shelf label you can identify.',
    'If several products appear in the same photo, do not merge them into one record.',
    'For each visible product, identify product name, brand, size, and original Japan shelf price in yen.',
    'Match each product to its own visible price when possible.',
    'Japanese shelf labels often show two prices. Zeinuki or base-price labels mean tax excluded/pre-tax. Zeikomi labels mean tax included/after-tax.',
    'If both tax-excluded and tax-included prices are visible, fill both taxExcludedPriceYen and taxIncludedPriceYen.',
    'If only one price is visible, fill originalJapanPriceYen with that visible price and set taxIncluded according to the label.',
    'Use originalJapanPriceYen as the best shelf price for saving: prefer taxIncludedPriceYen when visible, otherwise taxExcludedPriceYen, otherwise the clearest visible yen price.',
    'Copy the important visible price label text into visiblePriceText, for example "tax included 1,980 / pre-tax 1,800".',
    'The Japan price must be the original shelf price visible in the image, before app tax-free/coupon calculations.',
    'Do not browse the web in this step. Only use visual evidence from the photo and the provided shop/trip context.',
    'Return only product facts that are visible or strongly inferable from the image.',
    `Selected shop context: ${shop.chain || 'unknown'} ${shop.branch || ''}, ${shop.area || ''}.`,
    `Selected trip context: ${trip.name || 'unknown'}, ${trip.city || ''}.`,
  ].join('\n');
}

async function analyzeWithGemini({ imageBase64, shop, trip }, model = activeModels.gemini) {
  const payload = await callGemini({
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: buildProductAnalysisPrompt({ shop, trip }),
          },
          {
            inline_data: {
              mime_type: 'image/jpeg',
              data: imageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: productSchema,
    },
  }, model);

  const outputText = extractOutputText(payload);

  if (!outputText) {
    throw new Error('Gemini returned no structured product analysis.');
  }

  try {
    return {
      ...JSON.parse(outputText),
      apiUsage: normalizeGeminiUsage(payload.usageMetadata),
    };
  } catch {
    throw new Error('Gemini returned product data that could not be parsed.');
  }
}

async function analyzeWithOpenRouter({ imageBase64, shop, trip }, model = activeModels.openrouter) {
  const payload = await callOpenRouter({
    model,
    messages: [
      {
        role: 'system',
        content: [
          'Return strict JSON only. Do not wrap the response in markdown.',
          'The JSON shape must be {"products":[{"name":"","brand":"","size":"","originalJapanPriceYen":0,"taxExcludedPriceYen":0,"taxIncludedPriceYen":0,"taxIncluded":true,"visiblePriceText":"","confidence":0.8}]}',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildProductAnalysisPrompt({ shop, trip }),
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${imageBase64}`,
            },
          },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 2000,
  });
  const outputText = extractOpenRouterOutputText(payload);

  if (!outputText) {
    throw new Error('OpenRouter returned no structured product analysis.');
  }

  try {
    return {
      ...parseJsonFromText(outputText),
      apiUsage: normalizeOpenRouterUsage(payload.usage),
    };
  } catch {
    throw new Error('OpenRouter returned product data that could not be parsed.');
  }
}

async function callOpenRouter(body) {
  const headers = {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost',
    'X-Title': process.env.OPENROUTER_APP_NAME || 'KusuriLens',
  };
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const payload = await readGeminiJson(response);

  if (!response.ok) {
    const errorDetails = [
      payload?.error?.message,
      payload?.error?.code ? `code: ${payload.error.code}` : null,
      payload?.error?.metadata?.provider_name ? `provider: ${payload.error.metadata.provider_name}` : null,
      payload?.error?.metadata?.raw ? String(payload.error.metadata.raw).slice(0, 400) : null,
    ].filter(Boolean);
    const message = errorDetails.length > 0
      ? errorDetails.join(' ')
      : `OpenRouter request failed with ${response.status}.`;
    throw new Error(message);
  }

  recordGeminiUsage(normalizeOpenRouterUsage(payload.usage));

  return payload;
}

function extractOpenRouterOutputText(payload) {
  return String(payload.choices?.[0]?.message?.content || '').trim();
}

function normalizeOpenRouterUsage(usage = {}) {
  return {
    promptTokenCount: Number(usage.prompt_tokens || 0),
    candidatesTokenCount: Number(usage.completion_tokens || 0),
    thoughtsTokenCount: Number(usage.reasoning_tokens || 0),
    totalTokenCount: Number(usage.total_tokens || 0),
  };
}

async function enrichProductsWithHongKongPrices(products, onLookupProduct = () => {}) {
  const productsToLookup = products.slice(0, 4);
  const enrichedProducts = [];

  for (const product of productsToLookup) {
    try {
      onLookupProduct(product);
      const lookup = await lookupHongKongPriceSources(product);

      enrichedProducts.push({
        ...product,
        hkSources: lookup.sources,
      });
    } catch {
      enrichedProducts.push({
        ...product,
        hkSources: [],
      });
    }
  }

  return [
    ...enrichedProducts,
    ...products.slice(productsToLookup.length).map((product) => ({
      ...product,
      hkSources: [],
    })),
  ];
}

async function lookupHongKongPriceSources(product) {
  const queryText = [product.brand, product.name, product.size].filter(Boolean).join(' ');
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
              'Maximum sources: 3.',
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
    .map((source, index) => ({
      id: `hk-${Date.now()}-${index}`,
      name: String(source.name || source.matchedProductName || 'HK source'),
      priceHkd: normalizePrice(source.priceHkd),
      availability: normalizeAvailability(source.availability),
      url: typeof source.url === 'string' ? source.url : undefined,
    }))
    .filter(
      (source) =>
        source.priceHkd > 0 &&
        source.availability !== 'Out of stock' &&
        Boolean(source.url),
    );
  const verifiedSources = await verifyHongKongSourceUrls(candidateSources);

  return {
    sources: verifiedSources.slice(0, 3),
    usage: normalizeGeminiUsage(payload.usageMetadata),
  };
}

async function verifyHongKongSourceUrls(sources) {
  const verifiedSources = [];

  for (const source of sources) {
    const verified = await verifyProductUrl(source.url);

    if (verified.ok) {
      verifiedSources.push({
        ...source,
        url: verified.url,
      });
    }

    if (verifiedSources.length >= 3) {
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

async function testAiConnection() {
  return getActiveProvider() === 'openrouter'
    ? testOpenRouterConnection()
    : testGeminiConnection();
}

async function testOpenRouterConnection() {
  const payload = await callOpenRouter({
    model: activeModels.openrouter,
    messages: [
      {
        role: 'user',
        content: 'Reply with exactly: KusuriLens OpenRouter backend connected.',
      },
    ],
    temperature: 0,
    max_tokens: 32,
  });
  const outputText = extractOpenRouterOutputText(payload);

  if (!outputText) {
    throw new Error('OpenRouter returned an empty test response.');
  }

  return outputText;
}

async function testGeminiConnection() {
  const payload = await callGemini({
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'Reply with exactly: KusuriLens Gemini backend connected.',
          },
        ],
      },
    ],
  }, activeModels.gemini);

  const outputText = extractOutputText(payload);

  if (!outputText) {
    throw new Error('Gemini returned an empty test response.');
  }

  return outputText;
}

async function getJpyToHkdRate() {
  const now = Date.now();

  if (exchangeRateCache && now - exchangeRateCache.fetchedAtMs < 30 * 60 * 1000) {
    return exchangeRateCache.payload;
  }

  const response = await fetch('https://api.frankfurter.app/latest?from=JPY&to=HKD');
  const payload = await readGeminiJson(response);

  if (!response.ok) {
    const message = payload?.message || payload?.error || `Exchange-rate request failed with ${response.status}.`;
    throw new Error(message);
  }

  const rate = Number(payload?.rates?.HKD);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('Exchange-rate source returned an invalid JPY to HKD rate.');
  }

  exchangeRateCache = {
    fetchedAtMs: now,
    payload: {
      base: 'JPY',
      target: 'HKD',
      rate,
      source: 'Frankfurter',
      sourceDate: payload.date,
      fetchedAt: new Date(now).toISOString(),
    },
  };

  return exchangeRateCache.payload;
}

async function callGemini(body, model = activeModels.gemini) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
    method: 'POST',
    headers: {
      'x-goog-api-key': process.env.GEMINI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    },
  );

  const payload = await readGeminiJson(response);

  if (!response.ok) {
    const message = payload?.error?.message || `Gemini request failed with ${response.status}.`;
    throw new Error(message);
  }

  recordGeminiUsage(payload.usageMetadata);

  return payload;
}

function normalizeGeminiUsage(usageMetadata = {}) {
  return {
    promptTokenCount: Number(usageMetadata.promptTokenCount || 0),
    candidatesTokenCount: Number(usageMetadata.candidatesTokenCount || 0),
    thoughtsTokenCount: Number(usageMetadata.thoughtsTokenCount || 0),
    totalTokenCount: Number(usageMetadata.totalTokenCount || 0),
  };
}

function recordGeminiUsage(usageMetadata) {
  const usage = normalizeGeminiUsage(usageMetadata);

  geminiUsage = {
    requestCount: geminiUsage.requestCount + 1,
    promptTokenCount: geminiUsage.promptTokenCount + usage.promptTokenCount,
    candidatesTokenCount: geminiUsage.candidatesTokenCount + usage.candidatesTokenCount,
    thoughtsTokenCount: geminiUsage.thoughtsTokenCount + usage.thoughtsTokenCount,
    totalTokenCount: geminiUsage.totalTokenCount + usage.totalTokenCount,
    lastRequest: {
      ...usage,
      at: new Date().toISOString(),
    },
  };
}

async function readGeminiJson(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return {
      error: {
        message: text || `Gemini returned a non-JSON response with ${response.status}.`,
      },
    };
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

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }
  }

  throw new Error('Gemini returned HK price data that could not be parsed.');
}

function normalizePrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : 0;
}

function normalizeAvailability(value) {
  const allowed = new Set(['In stock', 'Low stock', 'Out of stock', 'Unknown']);
  return allowed.has(value) ? value : 'Unknown';
}

function normalizeBase64Image(imageBase64) {
  return imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').trim();
}
