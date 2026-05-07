import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import * as SQLite from 'expo-sqlite';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ComponentProps } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { GestureResponderEvent } from 'react-native';

type ActiveTab = 'overall' | 'products' | 'shops' | 'settings';
type ProductStatus = 'Needs review' | 'Verified';
type PriceEntryMode = 'manual' | 'authorized';
type AddMode = 'gallery' | 'camera';
type IoniconName = ComponentProps<typeof Ionicons>['name'];

const AI_JOBS_URL = 'http://127.0.0.1:8788/analysis-jobs';
const API_USAGE_URL = 'http://127.0.0.1:8788/api-usage';
const AI_PROVIDER_URL = 'http://127.0.0.1:8788/ai-provider';
const AI_MODELS_URL = 'http://127.0.0.1:8788/ai-models';
const LOGS_URL = 'http://127.0.0.1:8788/logs';
const EXCHANGE_RATE_URL = 'http://127.0.0.1:8788/exchange-rate';
const HK_PRICE_SOURCES_URL = 'http://127.0.0.1:8788/hk-price-sources';
const DATABASE_NAME = 'kusurilens.db';

type Trip = {
  id: string;
  name: string;
  dateRange: string;
  city: string;
};

type JapanShop = {
  id: string;
  chain: string;
  branch: string;
  area: string;
  address: string;
  discountNote: string;
  discountRate: number;
  discountThresholdYen: number;
};

type HkSource = {
  id: string;
  name: string;
  priceHkd: number;
  availability: 'In stock' | 'Low stock' | 'Unknown' | 'Out of stock';
  url?: string;
};

type ProductRecord = {
  id: string;
  tripId: string;
  name: string;
  brand: string;
  size: string;
  shopId: string;
  store: string;
  capturedAt: string;
  photoUri?: string;
  originalJapanPriceYen: number;
  taxExcludedPriceYen?: number | null;
  taxIncludedPriceYen?: number | null;
  visiblePriceText?: string | null;
  taxIncluded: boolean;
  discountEligible: boolean;
  status: ProductStatus;
  confidence: number;
  hkSources: HkSource[];
};

type TripSettings = {
  exchangeRate: number;
  exchangeRateSource?: string | null;
  exchangeRateSourceDate?: string | null;
  exchangeRateFetchedAt?: string | null;
  taxRate: number;
  taxFree: boolean;
  priceEntryMode: PriceEntryMode;
};

type AiProduct = {
  name?: string;
  brand?: string;
  size?: string;
  originalJapanPriceYen?: number;
  taxExcludedPriceYen?: number;
  taxIncludedPriceYen?: number;
  visiblePriceText?: string;
  taxIncluded?: boolean;
  confidence?: number;
  hkSources?: Array<{
    name?: string;
    priceHkd?: number;
    availability?: HkSource['availability'];
    url?: string;
  }>;
};

type AiAnalysisResponse = {
  products?: AiProduct[];
  apiUsage?: GeminiUsage;
  provider?: AiProviderName;
  model?: string;
  providerFallback?: {
    from: AiProviderName;
    to: AiProviderName;
    reason?: string;
  };
};

type GeminiUsage = {
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount?: number;
  totalTokenCount: number;
};

type AiAnalysisJobStartResponse = {
  id: string;
  status: 'queued' | 'running';
};

type AiAnalysisJobResponse = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  stage?: 'queued' | 'recognizing-image' | 'looking-up-hk-prices' | 'completed' | 'failed';
  hkLookupProductName?: string | null;
  result?: AiAnalysisResponse;
  error?: string;
};

type PendingAnalysis = {
  jobId: string;
  imageUri?: string;
  trip: Trip;
  shop: JapanShop;
  stage?: AiAnalysisJobResponse['stage'];
  hkLookupProductName?: string | null;
};

type AnalysisNotice = {
  kind: 'error' | 'info';
  message: string;
};

type ExchangeRateResponse = {
  rate: number;
  source: string;
  sourceDate?: string;
};

type ApiUsageResponse = {
  provider: string;
  model: string;
  usage: {
    requestCount: number;
    promptTokenCount: number;
    candidatesTokenCount: number;
    thoughtsTokenCount: number;
    totalTokenCount: number;
    lastRequest: (GeminiUsage & { at: string }) | null;
  };
  remaining: null;
  remainingNote: string;
};

type HkPriceSourcesResponse = {
  sources: HkSource[];
  usage?: GeminiUsage;
};

type ServerLogsResponse = {
  path: string;
  lines: string[];
  updatedAt: string | null;
};

type AiProviderName = 'gemini' | 'openrouter';

type AiProviderStatus = {
  provider: AiProviderName;
  model: string;
  hasGeminiKey: boolean;
  hasOpenRouterKey: boolean;
  availableProviders: Array<{
    provider: AiProviderName;
    model: string;
    models: string[];
    configured: boolean;
  }>;
};

type ProductRow = Omit<ProductRecord, 'taxIncluded' | 'discountEligible' | 'hkSources'> & {
  taxIncluded: number;
  discountEligible: number;
};

type HkSourceRow = HkSource & {
  productId: string;
};

type TableColumnRow = {
  name: string;
};

const initialSettings: TripSettings = {
  exchangeRate: 0.052,
  exchangeRateSource: null,
  exchangeRateSourceDate: null,
  exchangeRateFetchedAt: null,
  taxRate: 0.1,
  taxFree: true,
  priceEntryMode: 'authorized',
};

const sampleShops: JapanShop[] = [
  {
    id: 's1',
    chain: 'Matsumoto Kiyoshi',
    branch: 'Shinjuku Sanchome',
    area: 'Tokyo / Shinjuku',
    address: 'Shinjuku 3-chome, Tokyo',
    discountNote: 'Tax-free plus coupon possible over JPY 10,000',
    discountRate: 0.05,
    discountThresholdYen: 10000,
  },
  {
    id: 's2',
    chain: 'Don Quijote',
    branch: 'Ikebukuro East Exit',
    area: 'Tokyo / Ikebukuro',
    address: 'Ikebukuro, Toshima City, Tokyo',
    discountNote: 'Tax-free counter; coupon varies by campaign',
    discountRate: 0,
    discountThresholdYen: 0,
  },
  {
    id: 's3',
    chain: 'Tsuruha Drug',
    branch: 'Ueno Okachimachi',
    area: 'Tokyo / Ueno',
    address: 'Ueno, Taito City, Tokyo',
    discountNote: 'Store app discounts may apply',
    discountRate: 0.03,
    discountThresholdYen: 5000,
  },
];

const sampleTrips: Trip[] = [
  {
    id: 't1',
    name: 'Spring 2026',
    dateRange: 'Apr 2026',
    city: 'Tokyo',
  },
  {
    id: 't2',
    name: 'Autumn 2025',
    dateRange: 'Nov 2025',
    city: 'Osaka / Kyoto',
  },
  {
    id: 't3',
    name: 'Spring 2025',
    dateRange: 'Mar 2025',
    city: 'Tokyo',
  },
];

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let databaseInitializedPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDatabase() {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync(DATABASE_NAME);
  }

  return databasePromise;
}

async function initializeDatabase() {
  if (databaseInitializedPromise) {
    return databaseInitializedPromise;
  }

  databaseInitializedPromise = createDatabaseSchema().catch((error) => {
    databaseInitializedPromise = null;
    throw error;
  });

  return databaseInitializedPromise;
}

async function createDatabaseSchema() {
  const database = await getDatabase();

  await schemaExec(database, 'PRAGMA journal_mode = WAL');
  await schemaExec(database, `
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY NOT NULL,
      tripId TEXT NOT NULL,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      size TEXT NOT NULL,
      shopId TEXT NOT NULL,
      store TEXT NOT NULL,
      capturedAt TEXT NOT NULL,
      photoUri TEXT,
      originalJapanPriceYen REAL NOT NULL,
      taxExcludedPriceYen REAL,
      taxIncludedPriceYen REAL,
      visiblePriceText TEXT,
      taxIncluded INTEGER NOT NULL,
      discountEligible INTEGER NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL
    )
  `);

  await schemaExec(database, `
    CREATE TABLE IF NOT EXISTS hk_sources (
      id TEXT PRIMARY KEY NOT NULL,
      productId TEXT NOT NULL,
      name TEXT NOT NULL,
      priceHkd REAL NOT NULL,
      availability TEXT NOT NULL,
      url TEXT,
      FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE
    )
  `);

  return ensureProductColumns(database);
}

function isExpoSqliteNativeNpe(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return (message.includes('NativeDatabase.execAsync')
    || message.includes('NativeDatabase.prepareAsync'))
    && message.includes('NullPointerException');
}

function explainLocalDatabaseError(error: unknown) {
  if (isExpoSqliteNativeNpe(error)) {
    return [
      'The save is failing inside Expo SQLite on Android before SQLite returns a normal database error.',
      'The native module is throwing java.lang.NullPointerException from NativeDatabase.prepareAsync/execAsync.',
      'That usually means the Expo Go SQLite bridge/database handle is broken or unstable in this session, not that this product row is invalid.',
      'The screen change is kept, but local persistence may not stick until the native SQLite bridge is reset or rebuilt.',
    ].join(' ');
  }

  return error instanceof Error ? error.message : 'Unknown local database error.';
}

async function schemaExec(database: SQLite.SQLiteDatabase, sql: string) {
  try {
    await database.execAsync(sql);
  } catch (error) {
    if (isExpoSqliteNativeNpe(error)) {
      return;
    }

    throw error;
  }
}

async function ensureProductColumns(database: SQLite.SQLiteDatabase) {
  let columns: TableColumnRow[] = [];

  try {
    columns = await database.getAllAsync<TableColumnRow>("PRAGMA table_info('products')");
  } catch (error) {
    if (isRecoverableSqliteStartupError(error)) {
      return database;
    }

    throw error;
  }

  const existingColumns = new Set(columns.map((column) => column.name));
  const missingColumns = [
    { name: 'tripId', sql: "ALTER TABLE products ADD COLUMN tripId TEXT NOT NULL DEFAULT 't1'" },
    { name: 'brand', sql: "ALTER TABLE products ADD COLUMN brand TEXT NOT NULL DEFAULT 'Unknown brand'" },
    { name: 'size', sql: "ALTER TABLE products ADD COLUMN size TEXT NOT NULL DEFAULT 'Unknown size'" },
    { name: 'shopId', sql: "ALTER TABLE products ADD COLUMN shopId TEXT NOT NULL DEFAULT 's1'" },
    { name: 'store', sql: "ALTER TABLE products ADD COLUMN store TEXT NOT NULL DEFAULT 'Matsumoto Kiyoshi Shinjuku Sanchome'" },
    { name: 'capturedAt', sql: "ALTER TABLE products ADD COLUMN capturedAt TEXT NOT NULL DEFAULT ''" },
    { name: 'photoUri', sql: 'ALTER TABLE products ADD COLUMN photoUri TEXT' },
    { name: 'originalJapanPriceYen', sql: 'ALTER TABLE products ADD COLUMN originalJapanPriceYen REAL NOT NULL DEFAULT 0' },
    { name: 'taxExcludedPriceYen', sql: 'ALTER TABLE products ADD COLUMN taxExcludedPriceYen REAL' },
    { name: 'taxIncludedPriceYen', sql: 'ALTER TABLE products ADD COLUMN taxIncludedPriceYen REAL' },
    { name: 'visiblePriceText', sql: 'ALTER TABLE products ADD COLUMN visiblePriceText TEXT' },
    { name: 'taxIncluded', sql: 'ALTER TABLE products ADD COLUMN taxIncluded INTEGER NOT NULL DEFAULT 1' },
    { name: 'discountEligible', sql: 'ALTER TABLE products ADD COLUMN discountEligible INTEGER NOT NULL DEFAULT 0' },
    { name: 'status', sql: "ALTER TABLE products ADD COLUMN status TEXT NOT NULL DEFAULT 'Needs review'" },
    { name: 'confidence', sql: 'ALTER TABLE products ADD COLUMN confidence REAL NOT NULL DEFAULT 0.6' },
  ];

  for (const column of missingColumns) {
    if (!existingColumns.has(column.name)) {
      await schemaExec(database, column.sql);
    }
  }

  await schemaExec(
    database,
    `UPDATE products SET capturedAt = ${sqlText(new Date().toISOString())} WHERE capturedAt = ''`,
  );

  return database;
}

async function loadProductRecords() {
  const database = await initializeDatabase();

  let productRows: ProductRow[] = [];
  let sourceRows: HkSourceRow[] = [];

  try {
    productRows = await database.getAllAsync<ProductRow>(
      'SELECT * FROM products ORDER BY capturedAt DESC, id DESC',
    );
    sourceRows = await database.getAllAsync<HkSourceRow>(
      'SELECT * FROM hk_sources ORDER BY id ASC',
    );
  } catch (error) {
    if (isRecoverableSqliteStartupError(error)) {
      return [];
    }

    throw error;
  }

  return productRows.map((product) => ({
    ...product,
    taxIncluded: Boolean(product.taxIncluded),
    discountEligible: Boolean(product.discountEligible),
    hkSources: sourceRows
      .filter((source) => source.productId === product.id)
      .filter((source) => source.availability !== 'Out of stock' && Boolean(source.url))
      .map(({ productId, ...source }) => source),
  }));
}

function isRecoverableSqliteStartupError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return isExpoSqliteNativeNpe(error)
    || message.includes('no such table')
    || message.includes('NativeDatabase.prepareAsync');
}

async function saveProductRecords(products: ProductRecord[]) {
  const database = await getDatabase();
  await ensureProductColumns(database);

  await database.withTransactionAsync(async () => {
    for (const product of products) {
      await database.runAsync(
        `INSERT OR REPLACE INTO products (
          id,
          tripId,
          name,
          brand,
          size,
          shopId,
          store,
          capturedAt,
          photoUri,
          originalJapanPriceYen,
          taxExcludedPriceYen,
          taxIncludedPriceYen,
          visiblePriceText,
          taxIncluded,
          discountEligible,
          status,
          confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        product.id,
        product.tripId,
        product.name,
        product.brand,
        product.size,
        product.shopId,
        product.store,
        product.capturedAt,
        product.photoUri ?? null,
        product.originalJapanPriceYen,
        product.taxExcludedPriceYen ?? null,
        product.taxIncludedPriceYen ?? null,
        product.visiblePriceText ?? null,
        product.taxIncluded ? 1 : 0,
        product.discountEligible ? 1 : 0,
        product.status,
        product.confidence,
      );

      await database.runAsync('DELETE FROM hk_sources WHERE productId = ?', product.id);

      for (const source of product.hkSources) {
        await database.runAsync(
          `INSERT INTO hk_sources (
            id,
            productId,
            name,
            priceHkd,
            availability,
            url
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          source.id,
          product.id,
          source.name,
          source.priceHkd,
          source.availability,
          source.url ?? null,
        );
      }
    }
  });
}

function sqlText(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlNullableText(value?: string | null) {
  return value ? sqlText(value) : 'NULL';
}

function sqlNumber(value?: number | null) {
  return Number.isFinite(value) ? String(value) : 'NULL';
}

async function updateSavedProductStatus(id: string, status: ProductStatus) {
  const database = await getDatabase();
  await ensureProductColumns(database);
  await schemaExec(
    database,
    `UPDATE products SET status = ${sqlText(status)} WHERE id = ${sqlText(id)}`,
  );
}

async function updateSavedProduct(product: ProductRecord) {
  const database = await getDatabase();
  await ensureProductColumns(database);

  await database.execAsync(
    `UPDATE products SET
      name = ${sqlText(product.name)},
      brand = ${sqlText(product.brand)},
      size = ${sqlText(product.size)},
      originalJapanPriceYen = ${sqlNumber(product.originalJapanPriceYen)},
      taxExcludedPriceYen = ${sqlNumber(product.taxExcludedPriceYen)},
      taxIncludedPriceYen = ${sqlNumber(product.taxIncludedPriceYen)},
      visiblePriceText = ${sqlNullableText(product.visiblePriceText)},
      taxIncluded = ${product.taxIncluded ? 1 : 0},
      discountEligible = ${product.discountEligible ? 1 : 0},
      status = ${sqlText(product.status)},
      confidence = ${sqlNumber(product.confidence)}
    WHERE id = ${sqlText(product.id)}`,
  );
}

async function deleteSavedProduct(id: string) {
  const database = await getDatabase();

  await schemaExec(database, `DELETE FROM hk_sources WHERE productId = ${sqlText(id)}`);
  await schemaExec(database, `DELETE FROM products WHERE id = ${sqlText(id)}`);
}

function afterTaxJapanPriceYen(product: ProductRecord, settings: TripSettings) {
  if (product.taxIncludedPriceYen) {
    return product.taxIncludedPriceYen;
  }

  if (product.taxIncluded) {
    return product.originalJapanPriceYen;
  }

  const pretaxPrice = product.taxExcludedPriceYen ?? product.originalJapanPriceYen;

  return Math.round(pretaxPrice * (1 + settings.taxRate));
}

function shopDiscountApplies(shelfPriceYen: number, shop?: JapanShop) {
  if (!shop || shop.discountRate <= 0) {
    return false;
  }

  return shelfPriceYen >= shop.discountThresholdYen;
}

function effectiveJapanPriceYen(product: ProductRecord, settings: TripSettings, shop?: JapanShop) {
  const shelfPriceYen = afterTaxJapanPriceYen(product, settings);
  const discountRate = shopDiscountApplies(shelfPriceYen, shop)
    ? shop?.discountRate ?? 0
    : 0;
  const discountedPrice = shelfPriceYen * (1 - discountRate);

  return Math.round(discountedPrice);
}

function yenToHkd(yen: number, exchangeRate: number) {
  return yen * exchangeRate;
}

function formatYen(value: number) {
  return `JPY ${Math.round(value).toLocaleString('en-US')}`;
}

function formatHkd(value: number) {
  return `HK$${value.toFixed(1)}`;
}

function lowestHkPrice(product: ProductRecord) {
  const availableSources = visibleHkSources(product);

  if (availableSources.length === 0) {
    return null;
  }

  return Math.min(...availableSources.map((source) => source.priceHkd));
}

function visibleHkSources(product: ProductRecord) {
  return product.hkSources.filter((source) => source.availability !== 'Out of stock' && source.url);
}

async function openProductLink(url?: string) {
  if (!url) {
    return;
  }

  try {
    const canOpen = await Linking.canOpenURL(url);

    if (canOpen) {
      await Linking.openURL(url);
      return;
    }

    Alert.alert('Link unavailable', 'This product link could not be opened.');
  } catch (error) {
    Alert.alert(
      'Link unavailable',
      error instanceof Error ? error.message : 'This product link could not be opened.',
    );
  }
}

function normalizePrice(value: unknown) {
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : 0;
}

function optionalPrice(value: unknown) {
  const price = normalizePrice(value);
  return price > 0 ? price : null;
}

function bestShelfPrice(product: AiProduct) {
  return (
    optionalPrice(product.taxIncludedPriceYen) ??
    optionalPrice(product.originalJapanPriceYen) ??
    optionalPrice(product.taxExcludedPriceYen) ??
    0
  );
}

async function startProductPhotoAnalysis(imageBase64: string, shop: JapanShop, trip: Trip) {
  const response = await fetch(AI_JOBS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      imageBase64,
      shop: {
        chain: shop.chain,
        branch: shop.branch,
        area: shop.area,
      },
      trip: {
        name: trip.name,
        city: trip.city,
      },
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error ?? 'The AI server could not start image analysis.');
  }

  return payload as AiAnalysisJobStartResponse;
}

async function getProductPhotoAnalysis(jobId: string) {
  const response = await fetch(`${AI_JOBS_URL}/${encodeURIComponent(jobId)}`);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error ?? 'The AI server could not check this image analysis.');
  }

  return payload as AiAnalysisJobResponse;
}

async function fetchJpyToHkdRate() {
  const response = await fetch(EXCHANGE_RATE_URL);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error ?? 'The exchange-rate source could not be reached.');
  }

  return payload as ExchangeRateResponse;
}

async function fetchApiUsage() {
  const response = await fetch(API_USAGE_URL);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error ?? 'The API usage source could not be reached.');
  }

  return payload as ApiUsageResponse;
}

async function fetchAiProviderStatus() {
  const response = await fetch(AI_PROVIDER_URL);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error ?? 'The AI provider status could not be reached.');
  }

  return payload as AiProviderStatus;
}

async function updateAiProvider(provider: AiProviderName) {
  const response = await fetch(AI_PROVIDER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ provider }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error ?? 'The AI provider could not be updated.');
  }

  return payload as AiProviderStatus;
}

async function addAiModel(provider: AiProviderName, model: string) {
  const response = await fetch(AI_MODELS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ provider, model }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error ?? 'The AI model could not be added.');
  }

  return payload as AiProviderStatus;
}

async function selectAiModel(provider: AiProviderName, model: string) {
  const response = await fetch(`${AI_MODELS_URL}/select`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ provider, model }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error ?? 'The AI model could not be selected.');
  }

  return payload as AiProviderStatus;
}

async function deleteAiModel(provider: AiProviderName, model: string) {
  const response = await fetch(
    `${AI_MODELS_URL}?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`,
    { method: 'DELETE' },
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error ?? 'The AI model could not be deleted.');
  }

  return payload as AiProviderStatus;
}

async function fetchServerLogs() {
  const response = await fetch(`${LOGS_URL}?limit=24`);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error ?? 'The log file could not be read.');
  }

  return payload as ServerLogsResponse;
}

async function openServerLogFile() {
  const response = await fetch(`${LOGS_URL}/open`, { method: 'POST' });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error ?? 'The log file could not be opened.');
  }

  return payload as { ok: boolean; path: string };
}

async function fetchHongKongPriceSources(product: ProductRecord) {
  const response = await fetch(HK_PRICE_SOURCES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      product: {
        name: product.name,
        brand: product.brand,
        size: product.size,
      },
    }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error ?? 'The HK price source could not be reached.');
  }

  return payload as HkPriceSourcesResponse;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <KusuriLensApp />
    </SafeAreaProvider>
  );
}

function KusuriLensApp() {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<ActiveTab>('overall');
  const [addMenuVisible, setAddMenuVisible] = useState(false);
  const [tripSelectorVisible, setTripSelectorVisible] = useState(false);
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [trips] = useState(sampleTrips);
  const [shops] = useState(sampleShops);
  const [settings, setSettings] = useState(initialSettings);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTripId, setSelectedTripId] = useState(sampleTrips[0].id);
  const [selectedShopId, setSelectedShopId] = useState(sampleShops[0].id);
  const [isAnalyzingPhoto, setIsAnalyzingPhoto] = useState(false);
  const [isDatabaseReady, setIsDatabaseReady] = useState(false);
  const [pendingAnalysis, setPendingAnalysis] = useState<PendingAnalysis | null>(null);
  const [analysisNotice, setAnalysisNotice] = useState<AnalysisNotice | null>(null);
  const [apiUsage, setApiUsage] = useState<ApiUsageResponse | null>(null);
  const [aiProviderStatus, setAiProviderStatus] = useState<AiProviderStatus | null>(null);
  const [serverLogs, setServerLogs] = useState<ServerLogsResponse | null>(null);
  const [isUpdatingAiProvider, setIsUpdatingAiProvider] = useState(false);
  const [isRefreshingLogs, setIsRefreshingLogs] = useState(false);
  const [fetchingHkSourceId, setFetchingHkSourceId] = useState<string | null>(null);
  const [previewImageUri, setPreviewImageUri] = useState<string | null>(null);
  const [editingProduct, setEditingProduct] = useState<ProductRecord | null>(null);
  const hasSyncedDefaultRate = useRef(false);

  const selectedTrip = trips.find((trip) => trip.id === selectedTripId) ?? trips[0];
  const tripProducts = products.filter((product) => product.tripId === selectedTrip.id);
  const selectedProduct =
    tripProducts.find((product) => product.id === selectedId) ?? tripProducts[0] ?? null;
  const selectedProductShop = selectedProduct
    ? shops.find((shop) => shop.id === selectedProduct.shopId)
    : undefined;

  useEffect(() => {
    let mounted = true;

    async function loadDatabase() {
      try {
        await initializeDatabase();
        const savedProducts = await loadProductRecords();

        if (!mounted) {
          return;
        }

        setProducts(savedProducts);
        setSelectedId(savedProducts[0]?.id ?? null);
        setIsDatabaseReady(true);
        refreshApiUsage();
        refreshAiProviderStatus();
      } catch (error) {
        setIsDatabaseReady(true);
        Alert.alert(
          'Database unavailable',
          error instanceof Error ? error.message : 'KusuriLens could not open the local database.',
        );
      }
    }

    loadDatabase();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (
      hasSyncedDefaultRate.current ||
      settings.priceEntryMode !== 'authorized' ||
      settings.exchangeRateSource
    ) {
      return;
    }

    hasSyncedDefaultRate.current = true;

    async function syncDefaultSourceRate() {
      try {
        const nextRate = await fetchJpyToHkdRate();

        setSettings((current) => ({
          ...current,
          exchangeRate: nextRate.rate,
          exchangeRateSource: nextRate.source,
          exchangeRateSourceDate: nextRate.sourceDate ?? null,
          exchangeRateFetchedAt: new Date().toISOString(),
          priceEntryMode: 'authorized',
        }));
      } catch {
        // Keep the seeded rate if the local backend is not ready yet.
      }
    }

    syncDefaultSourceRate();
  }, [settings.exchangeRateSource, settings.priceEntryMode]);

  async function refreshApiUsage() {
    try {
      const nextUsage = await fetchApiUsage();
      setApiUsage(nextUsage);
    } catch {
      setApiUsage(null);
    }
  }

  async function refreshAiProviderStatus() {
    try {
      const nextStatus = await fetchAiProviderStatus();
      setAiProviderStatus(nextStatus);
    } catch {
      setAiProviderStatus(null);
    }
  }

  async function refreshServerLogs() {
    setIsRefreshingLogs(true);

    try {
      setServerLogs(await fetchServerLogs());
    } catch (error) {
      showAnalysisNotice(
        'error',
        error instanceof Error ? error.message : 'The log file could not be read.',
      );
    } finally {
      setIsRefreshingLogs(false);
    }
  }

  async function openServerLogs() {
    try {
      const result = await openServerLogFile();
      showAnalysisNotice('info', `Opened log file: ${result.path}`);
    } catch (error) {
      showAnalysisNotice(
        'error',
        error instanceof Error ? error.message : 'The log file could not be opened.',
      );
    }
  }

  async function changeAiProvider(provider: AiProviderName) {
    if (isUpdatingAiProvider) {
      return;
    }

    setIsUpdatingAiProvider(true);

    try {
      const nextStatus = await updateAiProvider(provider);
      setAiProviderStatus(nextStatus);
      await refreshApiUsage();
      showAnalysisNotice('info', `AI provider switched to ${provider}.`);
    } catch (error) {
      showAnalysisNotice(
        'error',
        error instanceof Error ? error.message : 'The AI provider could not be updated.',
      );
    } finally {
      setIsUpdatingAiProvider(false);
    }
  }

  async function saveAiProviderStatus(action: () => Promise<AiProviderStatus>, successMessage?: string) {
    try {
      const nextStatus = await action();
      setAiProviderStatus(nextStatus);
      await refreshApiUsage();

      if (successMessage) {
        showAnalysisNotice('info', successMessage);
      }
    } catch (error) {
      showAnalysisNotice(
        'error',
        error instanceof Error ? error.message : 'The AI model setting could not be updated.',
      );
    }
  }

  function addModelForProvider(provider: AiProviderName, model: string) {
    const trimmedModel = model.trim();

    if (!trimmedModel) {
      showAnalysisNotice('error', 'Enter a model ID first.');
      return;
    }

    saveAiProviderStatus(
      () => addAiModel(provider, trimmedModel),
      `${provider === 'gemini' ? 'Gemini' : 'OpenRouter'} model added.`,
    );
  }

  function selectModelForProvider(provider: AiProviderName, model: string) {
    saveAiProviderStatus(
      () => selectAiModel(provider, model),
      `${provider === 'gemini' ? 'Gemini' : 'OpenRouter'} model selected.`,
    );
  }

  function deleteModelForProvider(provider: AiProviderName, model: string) {
    saveAiProviderStatus(
      () => deleteAiModel(provider, model),
      `${provider === 'gemini' ? 'Gemini' : 'OpenRouter'} model deleted.`,
    );
  }

  useEffect(() => {
    if (activeTab === 'settings') {
      refreshServerLogs();
    }
  }, [activeTab]);

  useEffect(() => {
    if (!pendingAnalysis) {
      return;
    }

    let cancelled = false;
    const activeAnalysis = pendingAnalysis;

    async function pollAnalysis() {
      try {
        const job = await getProductPhotoAnalysis(activeAnalysis.jobId);

        if (cancelled || job.status === 'queued' || job.status === 'running') {
          if (!cancelled && job.stage) {
            setPendingAnalysis((currentAnalysis) =>
              currentAnalysis?.jobId === activeAnalysis.jobId
                ? {
                    ...currentAnalysis,
                    stage: job.stage,
                    hkLookupProductName: job.hkLookupProductName ?? currentAnalysis.hkLookupProductName,
                  }
                : currentAnalysis,
            );
          }
          return;
        }

        if (job.status === 'failed') {
          setPendingAnalysis(null);
          showAnalysisNotice(
            'error',
            job.error ?? 'The AI server could not analyze this photo.',
          );
          return;
        }

        const aiProducts = job.result?.products ?? [];

        if (aiProducts.length === 0) {
          setPendingAnalysis(null);
          showAnalysisNotice(
            'info',
            'No products were found in that photo. You can keep using the app.',
          );
          return;
        }

        const timestamp = Date.now();
        const capturedAt = new Date(timestamp).toISOString();
        const nextProducts: ProductRecord[] = aiProducts.map((product, index) => {
          const taxExcludedPriceYen = optionalPrice(product.taxExcludedPriceYen);
          const taxIncludedPriceYen = optionalPrice(product.taxIncludedPriceYen);
          const originalJapanPriceYen = bestShelfPrice(product);
          const taxIncluded = product.taxIncluded ?? Boolean(taxIncludedPriceYen);
          const shelfPriceYen = taxIncludedPriceYen ?? originalJapanPriceYen;

          return {
            id: `p${timestamp}-${index}`,
            tripId: activeAnalysis.trip.id,
            name: product.name?.trim() || 'Unknown product',
            brand: product.brand?.trim() || 'Unknown brand',
            size: product.size?.trim() || 'Unknown size',
            shopId: activeAnalysis.shop.id,
            store: `${activeAnalysis.shop.chain} ${activeAnalysis.shop.branch}`,
            capturedAt,
            photoUri: activeAnalysis.imageUri,
            originalJapanPriceYen,
            taxExcludedPriceYen,
            taxIncludedPriceYen,
            visiblePriceText: product.visiblePriceText?.trim() || null,
            taxIncluded,
            discountEligible: shopDiscountApplies(shelfPriceYen, activeAnalysis.shop),
            status: 'Needs review',
            confidence: Math.max(0, Math.min(1, Number(product.confidence ?? 0.6))),
            hkSources: (product.hkSources ?? [])
              .filter((source) => source.name && Number.isFinite(Number(source.priceHkd)))
              .slice(0, 5)
              .map((source, sourceIndex) => ({
                id: `h${timestamp}-${index}-${sourceIndex}`,
                name: source.name ?? 'HK source',
                priceHkd: normalizePrice(source.priceHkd),
                availability: source.availability ?? 'Unknown',
                url: source.url,
              })),
          };
        });

        if (cancelled) {
          return;
        }

        setProducts((currentProducts) => [...nextProducts, ...currentProducts]);
        setSelectedId(nextProducts[0].id);
        setActiveTab('overall');
        setPendingAnalysis(null);
        let localSaveFailed = false;

        try {
          await saveProductRecords(nextProducts);
        } catch (error) {
          localSaveFailed = true;
          showAnalysisNotice(
            'error',
            `Products were recognized on screen, but local database save failed. ${explainLocalDatabaseError(error)}`,
          );
        }

        const jobApiUsage = job.result?.apiUsage;

        if (jobApiUsage) {
          setApiUsage((currentUsage) => ({
            provider: currentUsage?.provider ?? 'gemini',
            model: currentUsage?.model ?? 'gemini-2.5-flash',
            remaining: null,
            remainingNote:
              currentUsage?.remainingNote ??
              'Gemini generateContent responses include token usage but do not include live remaining quota.',
            usage: {
              requestCount: (currentUsage?.usage.requestCount ?? 0) + 1,
              promptTokenCount:
                (currentUsage?.usage.promptTokenCount ?? 0) + jobApiUsage.promptTokenCount,
              candidatesTokenCount:
                (currentUsage?.usage.candidatesTokenCount ?? 0) +
                jobApiUsage.candidatesTokenCount,
              thoughtsTokenCount:
                (currentUsage?.usage.thoughtsTokenCount ?? 0) +
                (jobApiUsage.thoughtsTokenCount ?? 0),
              totalTokenCount:
                (currentUsage?.usage.totalTokenCount ?? 0) + jobApiUsage.totalTokenCount,
              lastRequest: {
                ...jobApiUsage,
                at: new Date().toISOString(),
              },
            },
          }));
        } else {
          refreshApiUsage();
        }
        if (!localSaveFailed) {
          showAnalysisNotice(
            'info',
            `${nextProducts.length} product${nextProducts.length === 1 ? '' : 's'} added from the photo.${
              job.result?.providerFallback
                ? ` OpenRouter was busy, so ${job.result.providerFallback.to} handled this image.`
                : ''
            }`,
          );
        }
      } catch (error) {
        if (!cancelled) {
          setPendingAnalysis(null);
          showAnalysisNotice(
            'error',
            error instanceof Error ? error.message : 'The AI server could not analyze this photo.',
          );
        }
      }
    }

    const timeout = setTimeout(pollAnalysis, 1200);
    const interval = setInterval(pollAnalysis, 3000);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [pendingAnalysis]);

  const tripSummary = useMemo(() => {
    const totalOriginalYen = tripProducts.reduce(
      (sum, product) => sum + afterTaxJapanPriceYen(product, settings),
      0,
    );
    const totalComparisonHkd = tripProducts.reduce((sum, product) => {
      const productShop = shops.find((shop) => shop.id === product.shopId);
      const effectiveYen = effectiveJapanPriceYen(product, settings, productShop);
      return sum + yenToHkd(effectiveYen, settings.exchangeRate);
    }, 0);
    const needsReview = tripProducts.filter((product) => product.status === 'Needs review').length;

    return { totalOriginalYen, totalComparisonHkd, needsReview };
  }, [tripProducts, settings, shops]);

  const bottomInset = Math.max(18, Math.round(insets.bottom));
  const screenPaddingBottom = 104 + bottomInset;

  async function verifyProduct(id: string) {
    setProducts((currentProducts) =>
      currentProducts.map((product) =>
        product.id === id ? { ...product, status: 'Verified' } : product,
      ),
    );

    try {
      await updateSavedProductStatus(id, 'Verified');
    } catch (error) {
      showAnalysisNotice(
        'error',
        `Marked verified on screen, but local database save failed. ${explainLocalDatabaseError(error)}`,
      );
    }
  }

  function confirmDeleteProduct(id: string) {
    const product = products.find((item) => item.id === id);

    Alert.alert(
      'Delete product',
      product ? `Remove ${product.name} from this trip?` : 'Remove this product from this trip?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteProduct(id);
          },
        },
      ],
    );
  }

  async function deleteProduct(id: string) {
    const nextProducts = products.filter((product) => product.id !== id);

    setProducts(nextProducts);

    if (selectedId === id) {
      const nextTripProduct = nextProducts.find((product) => product.tripId === selectedTrip.id);
      setSelectedId(nextTripProduct?.id ?? null);
    }

    try {
      await deleteSavedProduct(id);
    } catch (error) {
      showAnalysisNotice(
        'error',
        `Removed from screen, but local database delete failed. ${explainLocalDatabaseError(error)}`,
      );
    }
  }

  async function saveProductEdits(updatedProduct: ProductRecord) {
    setProducts((currentProducts) =>
      currentProducts.map((product) =>
        product.id === updatedProduct.id ? updatedProduct : product,
      ),
    );
    setEditingProduct(null);

    try {
      await updateSavedProduct(updatedProduct);
    } catch (error) {
      showAnalysisNotice(
        'error',
        `Updated on screen, but local database save failed. ${explainLocalDatabaseError(error)}`,
      );
      const savedProducts = await loadProductRecords();
      setProducts(savedProducts);
      setSelectedId(savedProducts.find((product) => product.id === updatedProduct.id)?.id ?? null);
    }
  }

  async function fetchProductHkPrices(product: ProductRecord) {
    if (fetchingHkSourceId) {
      return;
    }

    setFetchingHkSourceId(product.id);

    try {
      const lookup = await fetchHongKongPriceSources(product);
      const availableSources = lookup.sources.filter(
        (source) => source.availability !== 'Out of stock' && Boolean(source.url),
      );
      const nextProduct: ProductRecord = {
        ...product,
        hkSources: availableSources.map((source, index) => ({
          ...source,
          id: source.id || `hk-${product.id}-${Date.now()}-${index}`,
        })),
      };

      setProducts((currentProducts) =>
        currentProducts.map((currentProduct) =>
          currentProduct.id === product.id ? nextProduct : currentProduct,
        ),
      );
      await updateSavedProduct(nextProduct);
      await refreshApiUsage();
      showAnalysisNotice(
        'info',
        nextProduct.hkSources.length > 0
          ? `${nextProduct.hkSources.length} HK price source${nextProduct.hkSources.length === 1 ? '' : 's'} added.`
          : 'No HK price sources were found for this product.',
      );
    } catch (error) {
      showAnalysisNotice(
        'error',
        error instanceof Error ? error.message : 'Could not fetch HK price sources.',
      );
    } finally {
      setFetchingHkSourceId(null);
    }
  }

  function showAnalysisNotice(kind: AnalysisNotice['kind'], message: string) {
    setAnalysisNotice({ kind, message });
  }

  async function addAiDraft(mode: AddMode) {
    if (isAnalyzingPhoto) {
      return;
    }

    const permission =
      mode === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      return;
    }

    const pickerResult =
      mode === 'camera'
        ? await ImagePicker.launchCameraAsync({
            allowsEditing: false,
            base64: true,
            quality: 0.7,
          })
        : await ImagePicker.launchImageLibraryAsync({
            allowsMultipleSelection: false,
            base64: true,
            mediaTypes: ['images'],
            quality: 0.7,
          });

    if (pickerResult.canceled) {
      return;
    }

    const selectedShop = shops.find((shop) => shop.id === selectedShopId) ?? shops[0];
    const imageAsset = pickerResult.assets[0];

    if (!imageAsset?.base64) {
      Alert.alert('Photo unavailable', 'The selected image could not be prepared for AI analysis.');
      return;
    }

    setIsAnalyzingPhoto(true);

    try {
      const job = await startProductPhotoAnalysis(imageAsset.base64, selectedShop, selectedTrip);

      setPendingAnalysis({
        jobId: job.id,
        imageUri: imageAsset.uri,
        trip: selectedTrip,
        shop: selectedShop,
      });
      showAnalysisNotice('info', 'Analyzing photo in the background...');
      setActiveTab('overall');
      setAddMenuVisible(false);
    } catch (error) {
      showAnalysisNotice(
        'error',
        error instanceof Error ? error.message : 'The AI server could not analyze this photo.',
      );
      setAddMenuVisible(false);
    } finally {
      setIsAnalyzingPhoto(false);
    }
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.appShell}>
        <ScrollView contentContainerStyle={[styles.screen, { paddingBottom: screenPaddingBottom }]}>
          <Header
            selectedTrip={selectedTrip}
            onOpenTripSelector={() => setTripSelectorVisible(true)}
          />

          {(pendingAnalysis || analysisNotice) && (
            <View
              style={[
                styles.backgroundBanner,
                analysisNotice?.kind === 'error' && styles.backgroundBannerError,
              ]}
            >
              {pendingAnalysis ? (
                <ActivityIndicator color="#0D9488" />
              ) : (
                <Ionicons
                  name={analysisNotice?.kind === 'error' ? 'alert-circle-outline' : 'checkmark-circle-outline'}
                  size={20}
                  color={analysisNotice?.kind === 'error' ? '#B42318' : '#0F766E'}
                />
              )}
              <Text
                style={[
                  styles.backgroundBannerText,
                  analysisNotice?.kind === 'error' && styles.backgroundBannerErrorText,
                ]}
              >
                {pendingAnalysis
                  ? pendingAnalysis.stage === 'looking-up-hk-prices'
                    ? `Looking up HK prices${pendingAnalysis.hkLookupProductName ? ` for ${pendingAnalysis.hkLookupProductName}` : ''}...`
                    : 'Analyzing photo in the background...'
                  : analysisNotice?.message}
              </Text>
              {analysisNotice && !pendingAnalysis && (
                <Pressable
                  accessibilityLabel="Close notice"
                  style={styles.backgroundBannerClose}
                  onPress={() => setAnalysisNotice(null)}
                >
                  <Ionicons
                    name="close"
                    size={18}
                    color={analysisNotice.kind === 'error' ? '#B42318' : '#0F766E'}
                  />
                </Pressable>
              )}
            </View>
          )}

          {activeTab === 'overall' && (
            <OverallScreen
              products={tripProducts}
              selectedProduct={selectedProduct}
              selectedProductShop={selectedProductShop}
              shops={shops}
              isDatabaseReady={isDatabaseReady}
              settings={settings}
              setSettings={setSettings}
              tripSummary={tripSummary}
              onSelectProduct={setSelectedId}
              onVerify={() => selectedProduct && verifyProduct(selectedProduct.id)}
              onDeleteProduct={confirmDeleteProduct}
              onEditProduct={setEditingProduct}
              onPreviewImage={setPreviewImageUri}
              onFetchHkPrices={fetchProductHkPrices}
              fetchingHkSourceId={fetchingHkSourceId}
            />
          )}

          {activeTab === 'products' && (
            <ProductsScreen
              products={tripProducts}
              settings={settings}
              shops={shops}
              onSelectProduct={setSelectedId}
              onDeleteProduct={confirmDeleteProduct}
            />
          )}

          {activeTab === 'shops' && (
            <ShopsScreen shops={shops} products={tripProducts} selectedShopId={selectedShopId} onSelectShop={setSelectedShopId} />
          )}

          {activeTab === 'settings' && (
            <SettingsScreen
              settings={settings}
              setSettings={setSettings}
              apiUsage={apiUsage}
              onRefreshApiUsage={refreshApiUsage}
              aiProviderStatus={aiProviderStatus}
              isUpdatingAiProvider={isUpdatingAiProvider}
              onChangeAiProvider={changeAiProvider}
              onAddAiModel={addModelForProvider}
              onSelectAiModel={selectModelForProvider}
              onDeleteAiModel={deleteModelForProvider}
              serverLogs={serverLogs}
              isRefreshingLogs={isRefreshingLogs}
              onRefreshLogs={refreshServerLogs}
              onOpenLogs={openServerLogs}
            />
          )}
        </ScrollView>

        <BottomNavigation
          activeTab={activeTab}
          onTabPress={setActiveTab}
          onAddPress={() => setAddMenuVisible(true)}
          bottomInset={bottomInset}
        />
      </View>

      <AddMenu
        visible={addMenuVisible}
        onClose={() => setAddMenuVisible(false)}
        shops={shops}
        trips={trips}
        selectedTrip={selectedTrip}
        onOpenTripSelector={() => setTripSelectorVisible(true)}
        selectedShopId={selectedShopId}
        onSelectShop={setSelectedShopId}
        onPickGallery={() => addAiDraft('gallery')}
        onCapture={() => addAiDraft('camera')}
        isAnalyzing={isAnalyzingPhoto}
      />

      <TripSelector
        visible={tripSelectorVisible}
        trips={trips}
        selectedTrip={selectedTrip}
        onClose={() => setTripSelectorVisible(false)}
        onSelectTrip={(tripId) => {
          setSelectedTripId(tripId);
          const nextProduct = products.find((product) => product.tripId === tripId);
          setSelectedId(nextProduct?.id ?? null);
          setTripSelectorVisible(false);
        }}
      />

      <ImagePreview
        imageUri={previewImageUri}
        onClose={() => setPreviewImageUri(null)}
      />

      <ProductEditSheet
        product={editingProduct}
        onClose={() => setEditingProduct(null)}
        onSave={saveProductEdits}
      />
    </SafeAreaView>
  );
}

function Header({
  selectedTrip,
  onOpenTripSelector,
}: {
  selectedTrip: Trip;
  onOpenTripSelector: () => void;
}) {
  return (
    <View style={styles.headerBlock}>
      <View style={styles.header}>
        <View>
          <Text style={styles.kicker}>Japan trip database</Text>
          <Text style={styles.title}>KusuriLens</Text>
        </View>
      </View>
      <TripDropdown selectedTrip={selectedTrip} onPress={onOpenTripSelector} />
    </View>
  );
}

function TripDropdown({
  selectedTrip,
  onPress,
  compact = false,
}: {
  selectedTrip: Trip;
  onPress: () => void;
  compact?: boolean;
}) {
  return (
    <Pressable style={[styles.dropdownButton, compact && styles.dropdownButtonCompact]} onPress={onPress}>
      <View style={styles.dropdownCopy}>
        <Text style={styles.dropdownLabel}>Trip</Text>
        <Text style={styles.dropdownValue}>{selectedTrip.name}</Text>
        <Text style={styles.dropdownMeta}>
          {selectedTrip.dateRange} / {selectedTrip.city}
        </Text>
      </View>
      <Ionicons name="chevron-down" size={22} color="#0F766E" />
    </Pressable>
  );
}

function TripSelector({
  visible,
  trips,
  selectedTrip,
  onClose,
  onSelectTrip,
}: {
  visible: boolean;
  trips: Trip[];
  selectedTrip: Trip;
  onClose: () => void;
  onSelectTrip: (id: string) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.selectorSheet}>
          <Text style={styles.sectionTitle}>Select trip</Text>
          <View style={styles.selectorList}>
            {trips.map((trip) => {
              const selected = trip.id === selectedTrip.id;

              return (
                <Pressable
                  key={trip.id}
                  style={[styles.selectorRow, selected && styles.selectorRowSelected]}
                  onPress={() => onSelectTrip(trip.id)}
                >
                  <View>
                    <Text style={styles.selectorTitle}>{trip.name}</Text>
                    <Text style={styles.selectorMeta}>
                      {trip.dateRange} / {trip.city}
                    </Text>
                  </View>
                  {selected && <Ionicons name="checkmark-circle" size={24} color="#0D9488" />}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ImagePreview({
  imageUri,
  onClose,
}: {
  imageUri: string | null;
  onClose: () => void;
}) {
  const [zoomScale, setZoomScale] = useState(1);
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 });
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const zoomScaleRef = useRef(1);
  const imageOffsetRef = useRef({ x: 0, y: 0 });
  const pinchStartDistance = useRef<number | null>(null);
  const pinchStartScale = useRef(1);
  const panStartOffset = useRef({ x: 0, y: 0 });
  const panStartTouch = useRef<{ x: number; y: number } | null>(null);

  function applyZoomScale(nextScale: number) {
    const clampedScale = Math.max(1, Math.min(4, nextScale));
    zoomScaleRef.current = clampedScale;
    setZoomScale(clampedScale);

    if (clampedScale === 1) {
      imageOffsetRef.current = { x: 0, y: 0 };
      setImageOffset({ x: 0, y: 0 });
    } else {
      applyImageOffset(imageOffsetRef.current, clampedScale);
    }
  }

  function clampImageOffset(nextOffset: { x: number; y: number }, scale = zoomScaleRef.current) {
    if (scale <= 1) {
      return { x: 0, y: 0 };
    }

    const maxX = Math.max(0, (previewSize.width * (scale - 1)) / 2);
    const maxY = Math.max(0, (previewSize.height * 0.88 * (scale - 1)) / 2);

    return {
      x: Math.max(-maxX, Math.min(maxX, nextOffset.x)),
      y: Math.max(-maxY, Math.min(maxY, nextOffset.y)),
    };
  }

  function applyImageOffset(nextOffset: { x: number; y: number }, scale = zoomScaleRef.current) {
    const clampedOffset = clampImageOffset(nextOffset, scale);
    imageOffsetRef.current = clampedOffset;
    setImageOffset(clampedOffset);
  }

  useEffect(() => {
    zoomScaleRef.current = zoomScale;
  }, [zoomScale]);

  useEffect(() => {
    imageOffsetRef.current = imageOffset;
  }, [imageOffset]);

  useEffect(() => {
    setZoomScale(1);
    setImageOffset({ x: 0, y: 0 });
    zoomScaleRef.current = 1;
    imageOffsetRef.current = { x: 0, y: 0 };
    pinchStartDistance.current = null;
    pinchStartScale.current = 1;
    panStartOffset.current = { x: 0, y: 0 };
    panStartTouch.current = null;
  }, [imageUri]);

  function handlePreviewTouchStart(event: GestureResponderEvent) {
    const touches = event.nativeEvent.touches;
    const distance = getTouchDistance(touches);

    if (distance) {
      pinchStartDistance.current = distance;
      pinchStartScale.current = zoomScaleRef.current;
      panStartTouch.current = null;
      return;
    }

    const touch = touches[0];
    if (touch) {
      panStartTouch.current = { x: touch.pageX, y: touch.pageY };
      panStartOffset.current = imageOffsetRef.current;
    }
  }

  function handlePreviewTouchMove(event: GestureResponderEvent) {
    const touches = event.nativeEvent.touches;
    const distance = getTouchDistance(touches);

    if (distance) {
      if (!pinchStartDistance.current) {
        pinchStartDistance.current = distance;
        pinchStartScale.current = zoomScaleRef.current;
      }

      const nextScale = pinchStartScale.current * (distance / pinchStartDistance.current);
      applyZoomScale(nextScale);
      return;
    }

    const touch = touches[0];
    if (!touch || zoomScaleRef.current <= 1) {
      return;
    }

    if (!panStartTouch.current) {
      panStartTouch.current = { x: touch.pageX, y: touch.pageY };
      panStartOffset.current = imageOffsetRef.current;
    }

    applyImageOffset({
      x: panStartOffset.current.x + touch.pageX - panStartTouch.current.x,
      y: panStartOffset.current.y + touch.pageY - panStartTouch.current.y,
    });
  }

  function handlePreviewTouchEnd(event: GestureResponderEvent) {
    const touches = event.nativeEvent.touches;
    const distance = getTouchDistance(touches);

    if (distance) {
      pinchStartDistance.current = distance;
      pinchStartScale.current = zoomScaleRef.current;
      return;
    }

    pinchStartDistance.current = null;
    pinchStartScale.current = zoomScaleRef.current;

    const touch = touches[0];
    if (touch) {
      panStartTouch.current = { x: touch.pageX, y: touch.pageY };
      panStartOffset.current = imageOffsetRef.current;
      return;
    }

    panStartTouch.current = null;
    panStartOffset.current = imageOffsetRef.current;
  }

  return (
    <Modal visible={Boolean(imageUri)} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.imagePreviewBackdrop}>
        <Pressable style={styles.imagePreviewClose} onPress={onClose} hitSlop={16}>
          <Ionicons name="close" size={26} color="#17202A" />
        </Pressable>
        <View
          style={styles.imagePreviewGestureLayer}
          onLayout={(event) => {
            setPreviewSize({
              width: event.nativeEvent.layout.width,
              height: event.nativeEvent.layout.height,
            });
          }}
          onTouchStart={handlePreviewTouchStart}
          onTouchMove={handlePreviewTouchMove}
          onTouchEnd={handlePreviewTouchEnd}
          onTouchCancel={handlePreviewTouchEnd}
        >
          {imageUri && (
            <View pointerEvents="none" style={styles.imagePreviewFrame}>
              <Image
                source={{ uri: imageUri }}
                resizeMode="contain"
                style={[
                  styles.imagePreview,
                  {
                    transform: [
                      { translateX: imageOffset.x },
                      { translateY: imageOffset.y },
                      { scale: zoomScale },
                    ],
                  },
                ]}
              />
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

function getTouchDistance(touches: Array<{ pageX: number; pageY: number }>) {
  if (touches.length < 2) {
    return null;
  }

  const [first, second] = touches;
  return Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY);
}

function ProductEditSheet({
  product,
  onClose,
  onSave,
}: {
  product: ProductRecord | null;
  onClose: () => void;
  onSave: (product: ProductRecord) => void;
}) {
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [size, setSize] = useState('');
  const [priceYen, setPriceYen] = useState('');
  const [confidence, setConfidence] = useState('');
  const [taxIncluded, setTaxIncluded] = useState(true);
  const [status, setStatus] = useState<ProductStatus>('Needs review');

  useEffect(() => {
    if (!product) {
      return;
    }

    setName(product.name);
    setBrand(product.brand);
    setSize(product.size);
    setPriceYen(String(Math.round(product.originalJapanPriceYen)));
    setConfidence(String(Math.round(product.confidence * 100)));
    setTaxIncluded(product.taxIncluded);
    setStatus(product.status);
  }, [product]);

  function saveEdits() {
    if (!product) {
      return;
    }

    const nextPrice = normalizePrice(priceYen);
    const nextConfidence = Math.max(0, Math.min(1, Number(confidence) / 100));

    onSave({
      ...product,
      name: name.trim() || 'Unknown product',
      brand: brand.trim() || 'Unknown brand',
      size: size.trim() || 'Unknown size',
      originalJapanPriceYen: nextPrice,
      taxIncluded,
      status,
      confidence: Number.isFinite(nextConfidence) ? nextConfidence : product.confidence,
    });
  }

  return (
    <Modal visible={Boolean(product)} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.editSheet}>
          <View style={styles.editHeader}>
            <Text style={styles.sectionTitle}>Edit product</Text>
            <Pressable style={styles.iconButton} onPress={onClose}>
              <Ionicons name="close" size={24} color="#334155" />
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled">
            <EditTextField label="Name" value={name} onChangeText={setName} />
            <EditTextField label="Brand" value={brand} onChangeText={setBrand} />
            <EditTextField label="Size" value={size} onChangeText={setSize} />
            <EditTextField
              label="Shelf price JPY"
              value={priceYen}
              keyboardType="number-pad"
              onChangeText={setPriceYen}
            />
            <EditTextField
              label="AI confidence %"
              value={confidence}
              keyboardType="number-pad"
              onChangeText={setConfidence}
            />

            <View style={styles.editToggleRow}>
              <Pressable
                style={[styles.toggle, taxIncluded && styles.toggleActive]}
                onPress={() => setTaxIncluded(!taxIncluded)}
              >
                <Text style={[styles.toggleText, taxIncluded && styles.toggleTextActive]}>
                  Tax included
                </Text>
              </Pressable>
              <Pressable
                style={[styles.toggle, status === 'Verified' && styles.toggleActive]}
                onPress={() => setStatus(status === 'Verified' ? 'Needs review' : 'Verified')}
              >
                <Text style={[styles.toggleText, status === 'Verified' && styles.toggleTextActive]}>
                  {status}
                </Text>
              </Pressable>
            </View>
          </ScrollView>

          <View style={styles.editActions}>
            <Pressable style={styles.secondaryButton} onPress={onClose}>
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </Pressable>
            <Pressable style={styles.verifyButton} onPress={saveEdits}>
              <Text style={styles.verifyButtonText}>Save changes</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function EditTextField({
  label,
  value,
  keyboardType = 'default',
  onChangeText,
}: {
  label: string;
  value: string;
  keyboardType?: 'default' | 'number-pad' | 'decimal-pad';
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={styles.editField}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        value={value}
        keyboardType={keyboardType}
        onChangeText={onChangeText}
        style={styles.input}
      />
    </View>
  );
}

function OverallScreen({
  products,
  selectedProduct,
  selectedProductShop,
  shops,
  isDatabaseReady,
  settings,
  setSettings,
  tripSummary,
  onSelectProduct,
  onVerify,
  onDeleteProduct,
  onEditProduct,
  onPreviewImage,
  onFetchHkPrices,
  fetchingHkSourceId,
}: {
  products: ProductRecord[];
  selectedProduct: ProductRecord | null;
  selectedProductShop?: JapanShop;
  shops: JapanShop[];
  isDatabaseReady: boolean;
  settings: TripSettings;
  setSettings: React.Dispatch<React.SetStateAction<TripSettings>>;
  tripSummary: { totalOriginalYen: number; totalComparisonHkd: number; needsReview: number };
  onSelectProduct: (id: string) => void;
  onVerify: () => void;
  onDeleteProduct: (id: string) => void;
  onEditProduct: (product: ProductRecord) => void;
  onPreviewImage: (imageUri: string) => void;
  onFetchHkPrices: (product: ProductRecord) => void;
  fetchingHkSourceId: string | null;
}) {
  return (
    <>
      <View style={styles.summaryGrid}>
        <MetricCard label="Products" value={`${products.length}`} />
        <MetricCard label="Review" value={`${tripSummary.needsReview}`} />
        <MetricCard label="Japan shelf total" value={formatYen(tripSummary.totalOriginalYen)} />
        <MetricCard label="Compare total" value={formatHkd(tripSummary.totalComparisonHkd)} />
      </View>

      <TripPriceSettings settings={settings} setSettings={setSettings} compact />

      <View style={styles.panel}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>AI review queue</Text>
          <Text style={styles.sectionMeta}>photo can contain multiple products</Text>
        </View>
        {products.length === 0 ? (
          <EmptyState
            icon="sparkles-outline"
            title={isDatabaseReady ? 'Clean database ready' : 'Opening database'}
            body={
              isDatabaseReady
                ? 'Use Add to capture or choose a product photo. Recognized items will be saved here.'
                : 'Preparing local SQLite storage.'
            }
          />
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.productRail}>
              {products.map((product) => (
                <ProductChip
                  key={product.id}
                  product={product}
                  selected={product.id === selectedProduct?.id}
                  onPress={() => onSelectProduct(product.id)}
                  onDelete={() => onDeleteProduct(product.id)}
                />
              ))}
            </View>
          </ScrollView>
        )}
      </View>

      {selectedProduct && (
        <ProductDetail
          product={selectedProduct}
          shop={selectedProductShop}
          settings={settings}
          onVerify={onVerify}
          onEdit={() => onEditProduct(selectedProduct)}
          onPreviewImage={onPreviewImage}
          onFetchHkPrices={() => onFetchHkPrices(selectedProduct)}
          isFetchingHkPrices={fetchingHkSourceId === selectedProduct.id}
        />
      )}
    </>
  );
}

function ProductsScreen({
  products,
  settings,
  shops,
  onSelectProduct,
  onDeleteProduct,
}: {
  products: ProductRecord[];
  settings: TripSettings;
  shops: JapanShop[];
  onSelectProduct: (id: string) => void;
  onDeleteProduct: (id: string) => void;
}) {
  const shopGroups = shops
    .map((shop) => {
      const shopProducts = products.filter((product) => product.shopId === shop.id);
      const shelfTotalYen = shopProducts.reduce(
        (sum, product) => sum + afterTaxJapanPriceYen(product, settings),
        0,
      );
      const finalTotalYen = shopProducts.reduce(
        (sum, product) => sum + effectiveJapanPriceYen(product, settings, shop),
        0,
      );

      return {
        shop,
        products: shopProducts,
        shelfTotalYen,
        finalTotalYen,
      };
    })
    .filter((group) => group.products.length > 0);

  return (
    <View style={styles.panel}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Product table</Text>
        <Text style={styles.sectionMeta}>{products.length} saved records</Text>
      </View>
      <View style={styles.tableHeader}>
        <Text style={[styles.tableHeading, styles.tableProduct]}>Product</Text>
        <Text style={styles.tableHeading}>JP</Text>
        <Text style={styles.tableHeading}>HK</Text>
      </View>
      {products.length === 0 && (
        <EmptyState
          icon="file-tray-outline"
          title="No saved products"
          body="AI-recognized products will appear here after you test a photo."
        />
      )}
      {shopGroups.map((group) => (
        <View key={group.shop.id} style={styles.shopProductGroup}>
          <View style={styles.shopGroupHeader}>
            <View style={styles.shopGroupCopy}>
              <Text style={styles.shopGroupTitle}>{group.shop.chain}</Text>
              <Text style={styles.shopGroupMeta}>
                {group.shop.branch}
                {' / '}
                {group.shop.discountRate > 0
                  ? `${Math.round(group.shop.discountRate * 100)}% off over ${formatYen(group.shop.discountThresholdYen)}`
                  : 'No shop discount'}
              </Text>
            </View>
            <View style={styles.shopGroupTotals}>
              <Text style={styles.shopGroupTotalValue}>{formatYen(group.finalTotalYen)}</Text>
              <Text style={styles.shopGroupTotalMeta}>
                {formatHkd(yenToHkd(group.finalTotalYen, settings.exchangeRate))}
              </Text>
            </View>
          </View>
          {group.products.map((product) => {
            const shelfPriceYen = afterTaxJapanPriceYen(product, settings);
            const japanYen = effectiveJapanPriceYen(product, settings, group.shop);
            const japanHkd = yenToHkd(japanYen, settings.exchangeRate);
            const hkLowest = lowestHkPrice(product);
            const cheaperInJapan = hkLowest === null ? false : hkLowest > japanHkd;

            return (
              <Pressable
                key={product.id}
                style={styles.tableRow}
                onPress={() => onSelectProduct(product.id)}
              >
                <View style={styles.tableProduct}>
                  <View>
                    <Text numberOfLines={2} style={styles.tableName}>
                      {product.name}
                    </Text>
                  </View>
                  <Text style={styles.tableMeta}>
                    {product.brand} / {product.size}
                  </Text>
                  <Text style={product.status === 'Verified' ? styles.verified : styles.needsReview}>
                    {product.status}
                  </Text>
                </View>
                <View style={styles.tableCell}>
                  <Text style={styles.tablePrice}>{formatYen(japanYen)}</Text>
                  <Text style={styles.tableMeta}>Shelf {formatYen(shelfPriceYen)}</Text>
                </View>
                <View style={styles.tableCell}>
                  <Text style={styles.tablePrice}>{hkLowest === null ? 'Pending' : formatHkd(hkLowest)}</Text>
                  <Text style={cheaperInJapan ? styles.goodDeal : styles.needsReview}>
                    {hkLowest === null ? formatHkd(japanHkd) : cheaperInJapan ? 'JP wins' : 'HK wins'}
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel={`Delete ${product.name}`}
                  style={styles.tableDeleteButton}
                  onPress={(event) => {
                    event.stopPropagation();
                    onDeleteProduct(product.id);
                  }}
                >
                  <Ionicons name="trash-outline" size={20} color="#B42318" />
                </Pressable>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: IoniconName;
  title: string;
  body: string;
}) {
  return (
    <View style={styles.emptyState}>
      <Ionicons name={icon} size={30} color="#0F766E" />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

function ShopsScreen({
  shops,
  products,
  selectedShopId,
  onSelectShop,
}: {
  shops: JapanShop[];
  products: ProductRecord[];
  selectedShopId: string;
  onSelectShop: (id: string) => void;
}) {
  return (
    <View style={styles.panel}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Japan shops</Text>
        <Text style={styles.sectionMeta}>{shops.length} branches</Text>
      </View>
      <Text style={styles.bodyCopy}>
        New products will use the selected branch until you change it.
      </Text>
      <View style={styles.shopList}>
        {shops.map((shop) => {
          const productCount = products.filter((product) => product.shopId === shop.id).length;
          const selected = shop.id === selectedShopId;

          return (
            <Pressable
              key={shop.id}
              style={[styles.shopCard, selected && styles.shopCardSelected]}
              onPress={() => onSelectShop(shop.id)}
            >
              <View style={styles.shopCardHeader}>
                <View>
                  <Text style={styles.shopChain}>{shop.chain}</Text>
                  <Text style={styles.shopBranch}>{shop.branch}</Text>
                </View>
                {selected ? (
                  <View style={styles.selectedShopBadge}>
                    <Text style={styles.selectedShopBadgeText}>Selected</Text>
                  </View>
                ) : (
                  <Text style={styles.sourceBadge}>{productCount} items</Text>
                )}
              </View>
              <Text style={styles.tableMeta}>{shop.area}</Text>
              <Text style={styles.tableMeta}>{shop.address}</Text>
              <Text style={styles.shopDiscount}>{shop.discountNote}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function SettingsScreen({
  settings,
  setSettings,
  apiUsage,
  onRefreshApiUsage,
  aiProviderStatus,
  isUpdatingAiProvider,
  onChangeAiProvider,
  onAddAiModel,
  onSelectAiModel,
  onDeleteAiModel,
  serverLogs,
  isRefreshingLogs,
  onRefreshLogs,
  onOpenLogs,
}: {
  settings: TripSettings;
  setSettings: React.Dispatch<React.SetStateAction<TripSettings>>;
  apiUsage: ApiUsageResponse | null;
  onRefreshApiUsage: () => void;
  aiProviderStatus: AiProviderStatus | null;
  isUpdatingAiProvider: boolean;
  onChangeAiProvider: (provider: AiProviderName) => void;
  onAddAiModel: (provider: AiProviderName, model: string) => void;
  onSelectAiModel: (provider: AiProviderName, model: string) => void;
  onDeleteAiModel: (provider: AiProviderName, model: string) => void;
  serverLogs: ServerLogsResponse | null;
  isRefreshingLogs: boolean;
  onRefreshLogs: () => void;
  onOpenLogs: () => void;
}) {
  const [modelDrafts, setModelDrafts] = useState<Record<AiProviderName, string>>({
    gemini: '',
    openrouter: '',
  });

  return (
    <>
      <TripPriceSettings settings={settings} setSettings={setSettings} />
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>AI provider</Text>
        <View style={styles.providerSegmented}>
          {(['gemini', 'openrouter'] as AiProviderName[]).map((provider) => {
            const providerInfo = aiProviderStatus?.availableProviders.find(
              (item) => item.provider === provider,
            );
            const selected = aiProviderStatus?.provider === provider;
            const hasProviderStatus = Boolean(aiProviderStatus);
            const configured = providerInfo?.configured ?? true;
            const disabled = isUpdatingAiProvider || (hasProviderStatus && !configured);

            return (
              <Pressable
                key={provider}
                style={[
                  styles.providerButton,
                  selected && styles.providerButtonActive,
                  disabled && styles.providerButtonDisabled,
                ]}
                disabled={disabled}
                onPress={() => onChangeAiProvider(provider)}
              >
                <Text
                  style={[
                    styles.providerButtonText,
                    selected && styles.providerButtonTextActive,
                    disabled && styles.providerButtonTextDisabled,
                  ]}
                >
                  {provider === 'gemini' ? 'Gemini' : 'OpenRouter'}
                </Text>
                <Text
                  style={[
                    styles.providerModelText,
                    selected && styles.providerButtonTextActive,
                    disabled && styles.providerButtonTextDisabled,
                  ]}
                  numberOfLines={1}
                >
                  {providerInfo?.model ?? 'Not loaded'}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.bodyCopy}>
          {aiProviderStatus
            ? `Current model: ${aiProviderStatus.model}`
            : 'Provider status will appear when the backend responds.'}
        </Text>
        {aiProviderStatus && (
          <View style={styles.modelManager}>
            {aiProviderStatus.availableProviders.map((providerInfo) => {
              const models = providerInfo.models?.length ? providerInfo.models : [providerInfo.model];

              return (
                <View key={providerInfo.provider} style={styles.modelProviderBlock}>
                  <Text style={styles.modelProviderTitle}>
                    {providerInfo.provider === 'gemini' ? 'Gemini models' : 'OpenRouter models'}
                  </Text>
                  {models.filter(Boolean).map((model) => {
                    const selected = providerInfo.model === model;
                    const canDelete = models.length > 1;

                    return (
                      <View key={model} style={styles.modelRow}>
                        <Pressable
                          style={[styles.modelSelectButton, selected && styles.modelSelectButtonActive]}
                          onPress={() => onSelectAiModel(providerInfo.provider, model)}
                        >
                          <Ionicons
                            name={selected ? 'radio-button-on' : 'radio-button-off'}
                            size={18}
                            color={selected ? '#0F766E' : '#64717B'}
                          />
                          <Text
                            style={[
                              styles.modelName,
                              selected && styles.modelNameActive,
                            ]}
                            numberOfLines={1}
                          >
                            {model}
                          </Text>
                        </Pressable>
                        <Pressable
                          accessibilityLabel={`Delete ${model}`}
                          disabled={!canDelete}
                          style={[styles.modelDeleteButton, !canDelete && styles.modelDeleteButtonDisabled]}
                          onPress={() => onDeleteAiModel(providerInfo.provider, model)}
                        >
                          <Ionicons name="trash-outline" size={18} color={canDelete ? '#B42318' : '#94A3B8'} />
                        </Pressable>
                      </View>
                    );
                  })}
                  <View style={styles.modelAddRow}>
                    <TextInput
                      autoCapitalize="none"
                      autoCorrect={false}
                      placeholder={
                        providerInfo.provider === 'gemini'
                          ? 'gemini-2.5-flash'
                          : 'google/gemma-4-31b-it:free'
                      }
                      value={modelDrafts[providerInfo.provider]}
                      onChangeText={(text) =>
                        setModelDrafts((current) => ({
                          ...current,
                          [providerInfo.provider]: text,
                        }))
                      }
                      style={styles.modelInput}
                    />
                    <Pressable
                      style={styles.modelAddButton}
                      onPress={() => {
                        onAddAiModel(providerInfo.provider, modelDrafts[providerInfo.provider]);
                        setModelDrafts((current) => ({
                          ...current,
                          [providerInfo.provider]: '',
                        }));
                      }}
                    >
                      <Ionicons name="add" size={21} color="#FFFFFF" />
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </View>
      <View style={styles.panel}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>AI API usage</Text>
          <Pressable style={styles.iconButton} onPress={onRefreshApiUsage}>
            <Ionicons name="refresh" size={22} color="#0F766E" />
          </Pressable>
        </View>
        {apiUsage ? (
          <>
            <View style={styles.apiUsageGrid}>
              <PriceBlock label="Requests" value={`${apiUsage.usage.requestCount}`} />
              <PriceBlock label="Total tokens" value={`${apiUsage.usage.totalTokenCount}`} />
              <PriceBlock label="Input tokens" value={`${apiUsage.usage.promptTokenCount}`} />
              <PriceBlock label="Output tokens" value={`${apiUsage.usage.candidatesTokenCount}`} />
            </View>
            <Text style={styles.bodyCopy}>
              Remaining quota is not provided by Gemini generation responses.
            </Text>
          </>
        ) : (
          <Text style={styles.bodyCopy}>Usage will appear after the backend responds.</Text>
        )}
      </View>
      <View style={styles.panel}>
        <View style={styles.sectionHeader}>
          <View>
            <Text style={styles.sectionTitle}>Logs</Text>
            <Text style={styles.sectionMeta}>
              {serverLogs?.updatedAt ? `Updated ${new Date(serverLogs.updatedAt).toLocaleTimeString()}` : 'Backend log'}
            </Text>
          </View>
          <View style={styles.logActions}>
            <Pressable style={styles.iconButton} onPress={onRefreshLogs} disabled={isRefreshingLogs}>
              {isRefreshingLogs ? (
                <ActivityIndicator size="small" color="#0F766E" />
              ) : (
                <Ionicons name="refresh" size={22} color="#0F766E" />
              )}
            </Pressable>
            <Pressable style={styles.iconButton} onPress={onOpenLogs}>
              <Ionicons name="open-outline" size={22} color="#0F766E" />
            </Pressable>
          </View>
        </View>
        <Text style={styles.bodyCopy} numberOfLines={1}>
          {serverLogs?.path ?? 'server-debug.log'}
        </Text>
        <ScrollView
          style={styles.logBox}
          contentContainerStyle={styles.logBoxContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          {serverLogs?.lines.length ? (
            serverLogs.lines.map((line, index) => (
              <Text key={`${line}-${index}`} style={styles.logLine}>
                {line}
              </Text>
            ))
          ) : (
            <Text style={styles.logEmpty}>No log lines yet.</Text>
          )}
        </ScrollView>
      </View>
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>Authorized sources</Text>
        <Text style={styles.bodyCopy}>
          Source mode syncs JPY to HKD from Frankfurter. HK store sources can be added as a
          separate lookup step after product recognition.
        </Text>
        <View style={styles.sourceBadgeRow}>
          <Text style={styles.sourceBadge}>HKTVmall</Text>
          <Text style={styles.sourceBadge}>Watsons HK</Text>
          <Text style={styles.sourceBadge}>Mannings</Text>
          <Text style={styles.sourceBadge}>Sasa</Text>
        </View>
      </View>
    </>
  );
}

function TripPriceSettings({
  settings,
  setSettings,
  compact = false,
}: {
  settings: TripSettings;
  setSettings?: React.Dispatch<React.SetStateAction<TripSettings>>;
  compact?: boolean;
}) {
  const canEdit = settings.priceEntryMode === 'manual' && Boolean(setSettings);
  const [isSyncingRate, setIsSyncingRate] = useState(false);
  const fxSourceText = settings.exchangeRateSource
    ? `${settings.exchangeRateSource}${settings.exchangeRateSourceDate ? ` / ${settings.exchangeRateSourceDate}` : ''}`
    : settings.priceEntryMode === 'authorized'
      ? 'Source sync pending'
      : 'Manual entry';
  const fxFetchedText = settings.exchangeRateFetchedAt
    ? new Date(settings.exchangeRateFetchedAt).toLocaleString()
    : null;

  function updateSettings(next: Partial<TripSettings>) {
    setSettings?.((current) => ({ ...current, ...next }));
  }

  async function syncExchangeRate() {
    if (!setSettings || isSyncingRate) {
      return;
    }

    setIsSyncingRate(true);

    try {
      const nextRate = await fetchJpyToHkdRate();
      updateSettings({
        exchangeRate: nextRate.rate,
        exchangeRateSource: nextRate.source,
        exchangeRateSourceDate: nextRate.sourceDate ?? null,
        exchangeRateFetchedAt: new Date().toISOString(),
        priceEntryMode: 'authorized',
      });
    } catch (error) {
      Alert.alert(
        'Rate source unavailable',
        error instanceof Error ? error.message : 'Could not update JPY to HKD.',
      );
    } finally {
      setIsSyncingRate(false);
    }
  }

  return (
    <View style={styles.panel}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Trip price settings</Text>
        {setSettings && (
          <View style={styles.segmented}>
            <Pressable
              style={[styles.segmentButton, settings.priceEntryMode === 'manual' && styles.segmentActive]}
              onPress={() => updateSettings({ priceEntryMode: 'manual' })}
            >
              <Text
                style={[
                  styles.segmentText,
                  settings.priceEntryMode === 'manual' && styles.segmentTextActive,
                ]}
              >
                Manual
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.segmentButton,
                settings.priceEntryMode === 'authorized' && styles.segmentActive,
              ]}
              onPress={syncExchangeRate}
            >
              <Text
                style={[
                  styles.segmentText,
                  settings.priceEntryMode === 'authorized' && styles.segmentTextActive,
                ]}
              >
                {isSyncingRate ? 'Syncing' : 'Source'}
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      {!compact && settings.priceEntryMode === 'authorized' && (
        <Text style={styles.bodyCopy}>
          Authorized mode locks manual fields and will sync prices from approved exchange-rate and store
          sources.
        </Text>
      )}

      <View style={styles.fxSourceBox}>
        <Text style={styles.fxSourceLabel}>FX source</Text>
        <Text style={styles.fxSourceValue}>JPY to HKD: {fxSourceText}</Text>
        {fxFetchedText && <Text style={styles.fxSourceMeta}>Updated {fxFetchedText}</Text>}
      </View>

      <View style={styles.settingsRow}>
        <SettingInput
          label="JPY to HKD"
          value={settings.exchangeRate}
          precision={3}
          disabled={!canEdit}
          onChange={(exchangeRate) => updateSettings({ exchangeRate })}
        />
        <SettingInput
          label="Tax"
          value={settings.taxRate}
          precision={2}
          disabled={!canEdit}
          onChange={(taxRate) => updateSettings({ taxRate })}
        />
      </View>

      <Text style={styles.settingsHint}>
        Final Japan price uses the after-tax shelf price. Tax rate is only used when the app has to
        derive after-tax price from a pre-tax label.
      </Text>
    </View>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function SettingInput({
  label,
  value,
  precision,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  precision: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const safeValue = Number.isFinite(value) ? value : 0;
  const [draft, setDraft] = useState(safeValue.toFixed(precision));

  useEffect(() => {
    setDraft(safeValue.toFixed(precision));
  }, [precision, safeValue]);

  return (
    <View style={styles.settingInput}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        editable={!disabled}
        keyboardType="decimal-pad"
        value={draft}
        onChangeText={(text) => {
          setDraft(text);
          const parsed = Number(text);
          if (!Number.isNaN(parsed)) {
            onChange(parsed);
          }
        }}
        style={[styles.input, disabled && styles.inputDisabled]}
      />
    </View>
  );
}

function ProductChip({
  product,
  selected,
  onPress,
  onDelete,
}: {
  product: ProductRecord;
  selected: boolean;
  onPress: () => void;
  onDelete: () => void;
}) {
  return (
    <Pressable style={[styles.productChip, selected && styles.productChipSelected]} onPress={onPress}>
      <Pressable
        accessibilityLabel={`Delete ${product.name}`}
        style={styles.chipDeleteButton}
        onPress={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        <Ionicons name="trash-outline" size={17} color="#B42318" />
      </Pressable>
      <View style={styles.photoPlaceholder}>
        {product.photoUri ? (
          <Image source={{ uri: product.photoUri }} style={styles.photoImage} />
        ) : (
          <Text style={styles.photoText}>{product.brand.slice(0, 2).toUpperCase()}</Text>
        )}
      </View>
      <Text numberOfLines={2} style={styles.chipName}>
        {product.name}
      </Text>
      <Text style={product.status === 'Verified' ? styles.verified : styles.needsReview}>
        {product.status}
      </Text>
    </Pressable>
  );
}

function ProductDetail({
  product,
  shop,
  settings,
  onVerify,
  onEdit,
  onPreviewImage,
  onFetchHkPrices,
  isFetchingHkPrices,
}: {
  product: ProductRecord;
  shop?: JapanShop;
  settings: TripSettings;
  onVerify: () => void;
  onEdit: () => void;
  onPreviewImage: (imageUri: string) => void;
  onFetchHkPrices: () => void;
  isFetchingHkPrices: boolean;
}) {
  const japanYen = effectiveJapanPriceYen(product, settings, shop);
  const shelfPriceYen = afterTaxJapanPriceYen(product, settings);
  const japanHkd = yenToHkd(japanYen, settings.exchangeRate);
  const hkLowest = lowestHkPrice(product);
  const hkSources = visibleHkSources(product);
  const savings = hkLowest === null ? null : hkLowest - japanHkd;
  const taxExcludedText = product.taxExcludedPriceYen
    ? formatYen(product.taxExcludedPriceYen)
    : 'Not read';
  const taxIncludedText = product.taxIncludedPriceYen
    ? formatYen(product.taxIncludedPriceYen)
    : product.taxIncluded
      ? formatYen(product.originalJapanPriceYen)
      : 'Not read';

  return (
    <View style={styles.detailPanel}>
      <View style={styles.detailTop}>
        <Pressable
          style={styles.largePhoto}
          onPress={() => product.photoUri && onPreviewImage(product.photoUri)}
        >
          {product.photoUri ? (
            <Image source={{ uri: product.photoUri }} style={styles.largePhotoImage} />
          ) : (
            <Text style={styles.largePhotoText}>{product.brand}</Text>
          )}
        </Pressable>
        <View style={styles.detailCopy}>
          <Text style={styles.productName}>{product.name}</Text>
          <Text style={styles.productMeta}>
            {product.brand} / {product.size}
          </Text>
          <Text style={styles.productMeta}>{product.store}</Text>
          <Text style={styles.confidence}>AI confidence {(product.confidence * 100).toFixed(0)}%</Text>
        </View>
      </View>

      <View style={styles.priceGrid}>
        <PriceBlock label="Saved shelf price" value={formatYen(shelfPriceYen)} />
        <PriceBlock label="Before tax" value={taxExcludedText} />
        <PriceBlock label="After tax" value={taxIncludedText} />
        <PriceBlock label="Final Japan price" value={formatHkd(japanHkd)} />
        <PriceBlock label="Lowest HK price" value={hkLowest === null ? 'Pending' : formatHkd(hkLowest)} />
        <PriceBlock
          label={savings === null ? 'Comparison' : savings > 0 ? 'Japan advantage' : 'HK advantage'}
          value={savings === null ? 'Pending' : formatHkd(Math.abs(savings))}
          highlight={savings !== null && savings > 0}
        />
      </View>
      <View style={styles.sourceList}>
        <View style={styles.sourceHeader}>
          <Text style={styles.sectionTitle}>HK price sources</Text>
          <Pressable
            style={[styles.smallActionButton, isFetchingHkPrices && styles.sheetButtonDisabled]}
            onPress={onFetchHkPrices}
            disabled={isFetchingHkPrices}
          >
            {isFetchingHkPrices ? (
              <ActivityIndicator color="#0F766E" size="small" />
            ) : (
              <Ionicons name="search-outline" size={17} color="#0F766E" />
            )}
            <Text style={styles.smallActionButtonText}>
              {isFetchingHkPrices ? 'Fetching' : 'Fetch HK prices'}
            </Text>
          </Pressable>
        </View>
        {hkSources.length === 0 ? (
          <Text style={styles.bodyCopy}>HK lookup is pending for this product.</Text>
        ) : (
          hkSources.slice(0, 5).map((source) => (
            <Pressable
              key={source.id}
              style={[styles.sourceRow, source.url && styles.sourceRowLinked]}
              disabled={!source.url}
              onPress={() => openProductLink(source.url)}
            >
              <View style={styles.sourceCopy}>
                <Text style={styles.sourceName}>{source.name}</Text>
                <Text style={styles.sourceAvailability}>
                  {source.availability}
                  {source.url ? ' / Product link' : ''}
                </Text>
              </View>
              <View style={styles.sourcePriceBlock}>
                <Text style={styles.sourcePrice}>{formatHkd(source.priceHkd)}</Text>
                {source.url && <Ionicons name="open-outline" size={18} color="#0F766E" />}
              </View>
            </Pressable>
          ))
        )}
      </View>

      <View style={styles.actionRow}>
        <Pressable
          style={[styles.verifyButton, product.status === 'Verified' && styles.verifyButtonDone]}
          onPress={onVerify}
        >
          <Text style={styles.verifyButtonText}>
            {product.status === 'Verified' ? 'Verified' : 'Verify and save'}
          </Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={onEdit}>
          <Text style={styles.secondaryButtonText}>Edit product</Text>
        </Pressable>
      </View>
    </View>
  );
}

function PriceBlock({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <View style={[styles.priceBlock, highlight && styles.priceBlockHighlight]}>
      <Text style={styles.priceLabel}>{label}</Text>
      <Text style={styles.priceValue}>{value}</Text>
    </View>
  );
}

function BottomNavigation({
  activeTab,
  onTabPress,
  onAddPress,
  bottomInset,
}: {
  activeTab: ActiveTab;
  onTabPress: (tab: ActiveTab) => void;
  onAddPress: () => void;
  bottomInset: number;
}) {
  return (
    <View style={[styles.bottomNavSurface, { paddingBottom: bottomInset }]}>
      <Pressable style={styles.navAddButton} onPress={onAddPress}>
        <Ionicons name="add" size={34} color="#FFFFFF" />
        <Text style={styles.navAddText}>Add</Text>
      </Pressable>
      <View style={styles.bottomNav}>
        <NavButton label="Overall" icon="analytics-outline" active={activeTab === 'overall'} onPress={() => onTabPress('overall')} />
        <NavButton label="Products" icon="list-outline" active={activeTab === 'products'} onPress={() => onTabPress('products')} />
        <View style={styles.navCenterSpacer} />
        <NavButton label="Shops" icon="storefront-outline" active={activeTab === 'shops'} onPress={() => onTabPress('shops')} />
        <NavButton label="Settings" icon="settings-outline" active={activeTab === 'settings'} onPress={() => onTabPress('settings')} />
      </View>
    </View>
  );
}

function NavButton({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: IoniconName;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.navButton} onPress={onPress}>
      <Ionicons name={icon} size={24} color={active ? '#0F766E' : '#64717B'} />
      <Text style={[styles.navLabel, active && styles.navActive]}>{label}</Text>
    </Pressable>
  );
}

function AddMenu({
  visible,
  onClose,
  shops,
  trips,
  selectedTrip,
  onOpenTripSelector,
  selectedShopId,
  onSelectShop,
  onPickGallery,
  onCapture,
  isAnalyzing,
}: {
  visible: boolean;
  onClose: () => void;
  shops: JapanShop[];
  trips: Trip[];
  selectedTrip: Trip;
  onOpenTripSelector: () => void;
  selectedShopId: string;
  onSelectShop: (id: string) => void;
  onPickGallery: () => void;
  onCapture: () => void;
  isAnalyzing: boolean;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.addSheet}>
          <Text style={styles.sectionTitle}>Add product photo</Text>
          <Text style={styles.bodyCopy}>Choose the trip and shop branch first, then add a product image.</Text>
          <TripDropdown
            selectedTrip={selectedTrip}
            onPress={onOpenTripSelector}
            compact
          />
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.shopPickerRail}>
              {shops.map((shop) => (
                <Pressable
                  key={shop.id}
                  style={[styles.shopPickerChip, shop.id === selectedShopId && styles.shopPickerChipSelected]}
                  onPress={() => onSelectShop(shop.id)}
                >
                  <Text style={styles.shopPickerChain}>{shop.chain}</Text>
                  <Text style={styles.shopPickerBranch}>{shop.branch}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
          <Pressable style={[styles.sheetButton, isAnalyzing && styles.sheetButtonDisabled]} onPress={onCapture} disabled={isAnalyzing}>
            <Ionicons name="camera-outline" size={26} color="#0F766E" style={styles.sheetButtonIcon} />
            <View>
              <Text style={styles.sheetButtonTitle}>Capture new photo</Text>
              <Text style={styles.sheetButtonSub}>Use the camera in a drugstore aisle</Text>
            </View>
          </Pressable>
          <Pressable style={[styles.sheetButton, isAnalyzing && styles.sheetButtonDisabled]} onPress={onPickGallery} disabled={isAnalyzing}>
            <Ionicons name="images-outline" size={26} color="#0F766E" style={styles.sheetButtonIcon} />
            <View>
              <Text style={styles.sheetButtonTitle}>Select from gallery</Text>
              <Text style={styles.sheetButtonSub}>Analyze an existing shelf photo</Text>
            </View>
          </Pressable>
          {isAnalyzing && (
            <View style={styles.analyzingRow}>
              <ActivityIndicator color="#0D9488" />
              <Text style={styles.analyzingText}>Analyzing product photo...</Text>
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F6F3EE',
  },
  appShell: {
    flex: 1,
  },
  screen: {
    gap: 18,
    padding: 20,
  },
  headerBlock: {
    gap: 12,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'flex-start',
  },
  kicker: {
    color: '#657078',
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  title: {
    color: '#17202A',
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 0,
  },
  captureButton: {
    alignItems: 'center',
    backgroundColor: '#0D9488',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 8,
    minHeight: 46,
    paddingHorizontal: 16,
  },
  captureIcon: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
  },
  captureText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  dropdownButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#D8E0E7',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 64,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  dropdownButtonCompact: {
    backgroundColor: '#F8FAFC',
  },
  dropdownCopy: {
    flex: 1,
  },
  dropdownLabel: {
    color: '#657078',
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  dropdownValue: {
    color: '#17202A',
    fontSize: 16,
    fontWeight: '900',
    marginTop: 3,
  },
  dropdownMeta: {
    color: '#657078',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metricCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E5DDD1',
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: '47%',
    flexGrow: 1,
    minHeight: 86,
    padding: 14,
  },
  metricLabel: {
    color: '#68737D',
    fontSize: 12,
    fontWeight: '700',
  },
  metricValue: {
    color: '#17202A',
    fontSize: 21,
    fontWeight: '800',
    marginTop: 10,
  },
  panel: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E5DDD1',
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
  },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  sectionTitle: {
    color: '#17202A',
    fontSize: 18,
    fontWeight: '800',
  },
  sectionMeta: {
    color: '#6E7982',
    flexShrink: 1,
    fontSize: 12,
    textAlign: 'right',
  },
  bodyCopy: {
    color: '#657078',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
  },
  sourceMeta: {
    color: '#0F766E',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 10,
  },
  fxSourceBox: {
    backgroundColor: '#F8FAFC',
    borderColor: '#DDE4EA',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 12,
    padding: 12,
  },
  fxSourceLabel: {
    color: '#68737D',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  fxSourceValue: {
    color: '#17202A',
    fontSize: 14,
    fontWeight: '900',
    marginTop: 5,
  },
  fxSourceMeta: {
    color: '#657078',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
  },
  imagePreviewBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.94)',
    flex: 1,
    justifyContent: 'center',
    padding: 16,
  },
  imagePreviewClose: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: 'rgba(15, 23, 42, 0.12)',
    borderRadius: 999,
    borderWidth: 1,
    elevation: 6,
    height: 44,
    justifyContent: 'center',
    position: 'absolute',
    right: 20,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 12,
    top: 52,
    width: 44,
    zIndex: 2,
  },
  imagePreviewGestureLayer: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    width: '100%',
  },
  imagePreviewFrame: {
    alignItems: 'center',
    borderColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 8,
    borderWidth: 1,
    height: '100%',
    justifyContent: 'center',
    overflow: 'hidden',
    width: '100%',
  },
  imagePreview: {
    height: '88%',
    width: '100%',
  },
  backgroundBanner: {
    alignItems: 'center',
    backgroundColor: '#E6F7F4',
    borderColor: '#99D7CF',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  backgroundBannerError: {
    backgroundColor: '#FFF1F0',
    borderColor: '#FDA29B',
  },
  backgroundBannerText: {
    color: '#0F766E',
    flex: 1,
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 20,
  },
  backgroundBannerErrorText: {
    color: '#B42318',
  },
  backgroundBannerClose: {
    alignItems: 'center',
    borderColor: 'rgba(15, 23, 42, 0.14)',
    borderRadius: 8,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  emptyState: {
    alignItems: 'center',
    borderColor: '#E3E8EE',
    borderRadius: 8,
    borderStyle: 'dashed',
    borderWidth: 1,
    gap: 8,
    marginTop: 14,
    padding: 18,
  },
  emptyTitle: {
    color: '#17202A',
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
  },
  emptyBody: {
    color: '#657078',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  editSheet: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    maxHeight: '88%',
    padding: 18,
  },
  editHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  iconButton: {
    alignItems: 'center',
    borderColor: '#D8E0E7',
    borderRadius: 8,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  editField: {
    marginTop: 12,
  },
  editToggleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 14,
  },
  editActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
  },
  segmented: {
    backgroundColor: '#EEF2F4',
    borderRadius: 8,
    flexDirection: 'row',
    padding: 3,
  },
  segmentButton: {
    borderRadius: 6,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  segmentActive: {
    backgroundColor: '#0D9488',
  },
  segmentText: {
    color: '#657078',
    fontSize: 12,
    fontWeight: '900',
  },
  segmentTextActive: {
    color: '#FFFFFF',
  },
  settingsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 14,
  },
  apiUsageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 14,
  },
  logActions: {
    flexDirection: 'row',
    gap: 8,
  },
  logBox: {
    backgroundColor: '#0F172A',
    borderRadius: 8,
    marginTop: 12,
    maxHeight: 240,
  },
  logBoxContent: {
    gap: 5,
    padding: 12,
  },
  logLine: {
    color: '#DDE7F0',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
  },
  logEmpty: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '700',
  },
  providerSegmented: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  providerButton: {
    backgroundColor: '#F8FAFC',
    borderColor: '#D8E0E7',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    minHeight: 72,
    padding: 12,
  },
  providerButtonActive: {
    backgroundColor: '#E0F2F1',
    borderColor: '#0D9488',
    borderWidth: 2,
  },
  providerButtonDisabled: {
    opacity: 0.45,
  },
  providerButtonText: {
    color: '#17202A',
    fontSize: 15,
    fontWeight: '900',
  },
  providerButtonTextActive: {
    color: '#0F766E',
  },
  providerButtonTextDisabled: {
    color: '#64717B',
  },
  providerModelText: {
    color: '#64717B',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 8,
  },
  modelManager: {
    gap: 14,
    marginTop: 16,
  },
  modelProviderBlock: {
    gap: 8,
  },
  modelProviderTitle: {
    color: '#17202A',
    fontSize: 13,
    fontWeight: '900',
  },
  modelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  modelSelectButton: {
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderColor: '#D8E0E7',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    minHeight: 42,
    paddingHorizontal: 10,
  },
  modelSelectButtonActive: {
    backgroundColor: '#ECFDF5',
    borderColor: '#0D9488',
  },
  modelName: {
    color: '#334155',
    flex: 1,
    fontSize: 12,
    fontWeight: '800',
  },
  modelNameActive: {
    color: '#0F766E',
  },
  modelDeleteButton: {
    alignItems: 'center',
    borderColor: '#F4C7C3',
    borderRadius: 8,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  modelDeleteButtonDisabled: {
    borderColor: '#E2E8F0',
    opacity: 0.55,
  },
  modelAddRow: {
    flexDirection: 'row',
    gap: 8,
  },
  modelInput: {
    backgroundColor: '#FFFFFF',
    borderColor: '#D8E0E7',
    borderRadius: 8,
    borderWidth: 1,
    color: '#17202A',
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    minHeight: 42,
    paddingHorizontal: 10,
  },
  modelAddButton: {
    alignItems: 'center',
    backgroundColor: '#0D9488',
    borderRadius: 8,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  settingInput: {
    flex: 1,
    minWidth: 130,
  },
  inputLabel: {
    color: '#68737D',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#F8FAFC',
    borderColor: '#CDD6DD',
    borderRadius: 8,
    borderWidth: 1,
    color: '#17202A',
    fontSize: 16,
    fontWeight: '700',
    minHeight: 42,
    paddingHorizontal: 10,
  },
  inputDisabled: {
    backgroundColor: '#EEF2F4',
    color: '#64717B',
  },
  toggleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    marginTop: 14,
  },
  toggle: {
    borderColor: '#B9C3CB',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  toggleActive: {
    backgroundColor: '#E0F2F1',
    borderColor: '#0D9488',
  },
  toggleText: {
    color: '#46515A',
    fontWeight: '800',
  },
  toggleTextActive: {
    color: '#0F766E',
  },
  settingsHint: {
    color: '#6E7982',
    flex: 1,
    fontSize: 12,
    marginTop: 10,
  },
  productRail: {
    flexDirection: 'row',
    gap: 12,
    paddingTop: 14,
  },
  productChip: {
    backgroundColor: '#F8FAFC',
    borderColor: '#D8E0E7',
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 162,
    padding: 10,
    position: 'relative',
    width: 138,
  },
  chipDeleteButton: {
    alignItems: 'center',
    backgroundColor: '#FFF5F4',
    borderColor: '#F3B7B2',
    borderRadius: 8,
    borderWidth: 1,
    height: 30,
    justifyContent: 'center',
    position: 'absolute',
    right: 6,
    top: 6,
    width: 30,
    zIndex: 2,
  },
  productChipSelected: {
    borderColor: '#0D9488',
    borderWidth: 2,
  },
  photoPlaceholder: {
    alignItems: 'center',
    aspectRatio: 1.35,
    backgroundColor: '#DDE7E4',
    borderRadius: 6,
    justifyContent: 'center',
    marginBottom: 10,
    overflow: 'hidden',
  },
  photoImage: {
    height: '100%',
    width: '100%',
  },
  photoText: {
    color: '#0F766E',
    fontSize: 22,
    fontWeight: '900',
  },
  chipName: {
    color: '#17202A',
    flexGrow: 1,
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 17,
  },
  verified: {
    color: '#15803D',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 8,
  },
  needsReview: {
    color: '#B45309',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 8,
  },
  goodDeal: {
    color: '#15803D',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 8,
  },
  detailPanel: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DDE4EA',
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
  },
  detailTop: {
    flexDirection: 'row',
    gap: 14,
  },
  largePhoto: {
    alignItems: 'center',
    aspectRatio: 0.82,
    backgroundColor: '#F1E7D6',
    borderRadius: 8,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 108,
  },
  largePhotoImage: {
    height: '100%',
    width: '100%',
  },
  largePhotoText: {
    color: '#8A5A24',
    fontSize: 17,
    fontWeight: '900',
    paddingHorizontal: 8,
    textAlign: 'center',
  },
  detailCopy: {
    flex: 1,
  },
  productName: {
    color: '#17202A',
    fontSize: 20,
    fontWeight: '900',
    lineHeight: 24,
  },
  productMeta: {
    color: '#60707C',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 6,
  },
  confidence: {
    color: '#0F766E',
    fontSize: 13,
    fontWeight: '800',
    marginTop: 10,
  },
  priceGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 18,
  },
  priceBlock: {
    backgroundColor: '#F8FAFC',
    borderColor: '#E2E8F0',
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: '47%',
    flexGrow: 1,
    padding: 12,
  },
  priceBlockHighlight: {
    backgroundColor: '#ECFDF5',
    borderColor: '#34D399',
  },
  priceLabel: {
    color: '#657078',
    fontSize: 12,
    fontWeight: '700',
  },
  priceValue: {
    color: '#17202A',
    fontSize: 19,
    fontWeight: '900',
    marginTop: 8,
  },
  sourceList: {
    gap: 10,
    marginTop: 18,
  },
  sourceHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  smallActionButton: {
    alignItems: 'center',
    backgroundColor: '#E0F2F1',
    borderColor: '#99D7CF',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    minHeight: 34,
    paddingHorizontal: 10,
  },
  smallActionButtonText: {
    color: '#0F766E',
    fontSize: 12,
    fontWeight: '900',
  },
  sourceRow: {
    alignItems: 'center',
    borderColor: '#E2E8F0',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 12,
  },
  sourceRowLinked: {
    borderColor: '#99D7CF',
    backgroundColor: '#F0FDFA',
  },
  sourceCopy: {
    flex: 1,
    paddingRight: 10,
  },
  sourceName: {
    color: '#17202A',
    fontSize: 15,
    fontWeight: '800',
  },
  sourceAvailability: {
    color: '#657078',
    fontSize: 12,
    marginTop: 3,
  },
  sourcePrice: {
    color: '#17202A',
    fontSize: 16,
    fontWeight: '900',
  },
  sourcePriceBlock: {
    alignItems: 'flex-end',
    gap: 4,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  verifyButton: {
    alignItems: 'center',
    backgroundColor: '#0D9488',
    borderRadius: 8,
    flex: 1,
    justifyContent: 'center',
    minHeight: 48,
  },
  verifyButtonDone: {
    backgroundColor: '#15803D',
  },
  verifyButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
  },
  secondaryButton: {
    alignItems: 'center',
    borderColor: '#B9C3CB',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 48,
  },
  secondaryButtonText: {
    color: '#334155',
    fontSize: 15,
    fontWeight: '900',
  },
  tableHeader: {
    borderBottomColor: '#E2E8F0',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
    paddingBottom: 8,
  },
  tableHeading: {
    color: '#64717B',
    flex: 1,
    fontSize: 12,
    fontWeight: '900',
  },
  tableRow: {
    borderBottomColor: '#E2E8F0',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 12,
  },
  tableProduct: {
    flex: 1.6,
  },
  tableCell: {
    flex: 1,
  },
  tableDeleteButton: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: '#FFF5F4',
    borderColor: '#F3B7B2',
    borderRadius: 8,
    borderWidth: 1,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  tableName: {
    color: '#17202A',
    fontSize: 14,
    fontWeight: '900',
    lineHeight: 18,
  },
  tableMeta: {
    color: '#657078',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
  tablePrice: {
    color: '#17202A',
    fontSize: 13,
    fontWeight: '900',
  },
  sourceBadgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  sourceBadge: {
    backgroundColor: '#EEF2F4',
    borderColor: '#D8E0E7',
    borderRadius: 8,
    borderWidth: 1,
    color: '#334155',
    fontSize: 13,
    fontWeight: '800',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  shopList: {
    gap: 12,
    marginTop: 14,
  },
  shopProductGroup: {
    marginTop: 16,
  },
  shopGroupHeader: {
    alignItems: 'center',
    borderBottomColor: '#CBD5E1',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    paddingBottom: 8,
  },
  shopGroupCopy: {
    flex: 1,
  },
  shopGroupTitle: {
    color: '#17202A',
    fontSize: 15,
    fontWeight: '900',
  },
  shopGroupMeta: {
    color: '#657078',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 3,
  },
  shopGroupDiscount: {
    color: '#8A5A24',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 6,
  },
  shopGroupTotals: {
    alignItems: 'flex-end',
    minWidth: 96,
  },
  shopGroupTotalValue: {
    color: '#17202A',
    fontSize: 14,
    fontWeight: '900',
    textAlign: 'right',
  },
  shopGroupTotalMeta: {
    color: '#0F766E',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 3,
  },
  shopCard: {
    backgroundColor: '#F8FAFC',
    borderColor: '#D8E0E7',
    borderRadius: 8,
    borderWidth: 1,
    padding: 14,
  },
  shopCardSelected: {
    backgroundColor: '#FFF7ED',
    borderColor: '#F59E0B',
    borderWidth: 2,
  },
  shopCardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  shopChain: {
    color: '#17202A',
    fontSize: 17,
    fontWeight: '900',
  },
  shopBranch: {
    color: '#0F766E',
    fontSize: 14,
    fontWeight: '800',
    marginTop: 3,
  },
  shopDiscount: {
    color: '#8A5A24',
    fontSize: 13,
    fontWeight: '800',
    marginTop: 10,
  },
  selectedShopBadge: {
    alignItems: 'center',
    backgroundColor: '#F59E0B',
    borderRadius: 8,
    justifyContent: 'center',
    minWidth: 88,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  selectedShopBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
    textAlign: 'center',
  },
  bottomNavSurface: {
    backgroundColor: '#FFFFFF',
    borderTopColor: '#DCE4EA',
    borderTopWidth: 1,
    bottom: 0,
    left: 0,
    paddingHorizontal: 12,
    paddingTop: 6,
    position: 'absolute',
    right: 0,
  },
  bottomNav: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    minHeight: 58,
  },
  navButton: {
    alignItems: 'center',
    flex: 1,
    gap: 4,
    justifyContent: 'center',
    minHeight: 52,
  },
  navSymbol: {
    color: '#64717B',
    fontSize: 17,
    fontWeight: '900',
  },
  navLabel: {
    color: '#64717B',
    fontSize: 11,
    fontWeight: '800',
  },
  navActive: {
    color: '#0F766E',
  },
  navAddButton: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: '#0D9488',
    borderRadius: 8,
    height: 72,
    justifyContent: 'center',
    position: 'absolute',
    top: -36,
    width: 78,
    zIndex: 2,
  },
  navAddText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  navCenterSpacer: {
    width: 78,
  },
  modalBackdrop: {
    backgroundColor: 'rgba(15, 23, 42, 0.38)',
    flex: 1,
    justifyContent: 'flex-end',
    padding: 16,
  },
  addSheet: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    gap: 12,
    padding: 18,
  },
  selectorSheet: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    gap: 12,
    padding: 18,
  },
  selectorList: {
    gap: 10,
  },
  selectorRow: {
    alignItems: 'center',
    borderColor: '#D8E0E7',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 14,
  },
  selectorRowSelected: {
    backgroundColor: '#E0F2F1',
    borderColor: '#0D9488',
  },
  selectorTitle: {
    color: '#17202A',
    fontSize: 16,
    fontWeight: '900',
  },
  selectorMeta: {
    color: '#657078',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 4,
  },
  shopPickerRail: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 4,
  },
  shopPickerChip: {
    backgroundColor: '#F8FAFC',
    borderColor: '#D8E0E7',
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
    width: 178,
  },
  shopPickerChipSelected: {
    backgroundColor: '#E0F2F1',
    borderColor: '#0D9488',
    borderWidth: 2,
  },
  shopPickerChain: {
    color: '#17202A',
    fontSize: 14,
    fontWeight: '900',
  },
  shopPickerBranch: {
    color: '#657078',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
  },
  sheetButton: {
    alignItems: 'center',
    borderColor: '#D8E0E7',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 14,
    padding: 14,
  },
  sheetButtonDisabled: {
    opacity: 0.55,
  },
  sheetButtonIcon: {
    alignItems: 'center',
    backgroundColor: '#E0F2F1',
    borderRadius: 8,
    color: '#0F766E',
    fontSize: 18,
    fontWeight: '900',
    overflow: 'hidden',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sheetButtonTitle: {
    color: '#17202A',
    fontSize: 16,
    fontWeight: '900',
  },
  sheetButtonSub: {
    color: '#657078',
    fontSize: 13,
    marginTop: 4,
  },
  analyzingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    paddingVertical: 8,
  },
  analyzingText: {
    color: '#0F766E',
    fontSize: 13,
    fontWeight: '800',
  },
});
