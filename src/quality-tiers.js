export const QUALITY_TIER_SCHEMA_VERSION = 1;

export const QUALITY_TIERS = Object.freeze({
  draft: Object.freeze({
    id: 'draft',
    label: 'Draft',
    description: 'Fast preview settings for iteration.',
    settings: Object.freeze({resolution: '720p', fps: 24, steps: 20}),
    costMultiplier: 0.5,
  }),
  final: Object.freeze({
    id: 'final',
    label: 'Final',
    description: 'Higher quality settings for delivery.',
    settings: Object.freeze({resolution: '1080p', fps: 30, steps: 50}),
    costMultiplier: 1,
  }),
});

const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const normalizeQualityTier = (value) => value === 'final' ? 'final' : 'draft';

export const qualitySettingsFor = (tier, overrides = {}) => {
  const normalizedTier = normalizeQualityTier(tier);
  return {
    ...clone(QUALITY_TIERS[normalizedTier].settings),
    ...(isRecord(overrides) ? clone(overrides) : {}),
    tier: normalizedTier,
  };
};

export const estimateGenerationCost = ({unitPrice, unit = 'generation', quantity = 1, qualityTier = 'draft'} = {}) => {
  if (!Number.isFinite(unitPrice) || unitPrice < 0) return null;
  const tier = normalizeQualityTier(qualityTier);
  const safeQuantity = Number.isFinite(quantity) && quantity >= 0 ? quantity : 1;
  const estimatedUsd = unitPrice * safeQuantity * QUALITY_TIERS[tier].costMultiplier;
  return {
    estimatedUsd,
    credits: estimatedUsd * 100,
    unit,
    quantity: safeQuantity,
    qualityTier: tier,
  };
};

export const createGenerationUsageEntry = ({job, output, now = () => new Date().toISOString()} = {}) => {
  const input = job?.input || job || {};
  const cost = output?.cost ?? input.cost ?? null;
  const reportedUsd = Number.isFinite(cost)
    ? cost
    : Number.isFinite(cost?.estimatedUsd) ? cost.estimatedUsd
      : Number.isFinite(cost?.cost) ? cost.cost
        : Number.isFinite(cost?.total_cost) ? cost.total_cost
          : null;
  const estimate = reportedUsd !== null
    ? {
      estimatedUsd: Math.max(0, reportedUsd),
      credits: Number.isFinite(cost?.credits) ? Math.max(0, cost.credits) : Math.max(0, reportedUsd * 100),
      unit: typeof cost.unit === 'string' && cost.unit.trim() ? cost.unit.trim() : 'generation',
      quantity: Number.isFinite(cost.quantity) ? Math.max(0, cost.quantity) : 1,
      qualityTier: normalizeQualityTier(cost.qualityTier || input.qualityTier),
    }
    : estimateGenerationCost({
      unitPrice: cost?.unitPrice ?? input.unitPrice,
      unit: cost?.unit,
      quantity: cost?.quantity ?? input.costQuantity,
      qualityTier: input.qualityTier,
    });
  if (!estimate) return null;
  const modelId = typeof output?.modelId === 'string' && output.modelId.trim()
    ? output.modelId.trim()
    : typeof input.modelId === 'string' ? input.modelId.trim() : '';
  if (!modelId) return null;
  return {
    id: `usage-${job?.jobId || job?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
    generationJobId: job?.jobId || job?.id || null,
    modelId,
    qualityTier: estimate.qualityTier,
    estimatedUsd: estimate.estimatedUsd,
    credits: estimate.credits,
    unit: estimate.unit,
    quantity: estimate.quantity,
    currency: typeof cost?.currency === 'string' && cost.currency.trim() ? cost.currency.trim() : 'USD',
    costBasis: typeof cost?.basis === 'string' && cost.basis.trim()
      ? cost.basis.trim()
      : reportedUsd !== null ? 'reported' : 'catalog-estimate',
    createdAt: now(),
  };
};

export const formatUsd = (value) => Number.isFinite(value) ? `$${value.toFixed(value >= 1 ? 2 : 3)}` : '—';
export const formatCredits = (value) => Number.isFinite(value) ? `${value.toFixed(value >= 10 ? 0 : 1)} credits` : '—';
