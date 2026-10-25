function price(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function pricingStatus(model, id) {
  const pricing = model.pricing;
  const pairs = [
    [pricing?.prompt, pricing?.completion],
    [pricing?.input, pricing?.output],
    [model.input_price, model.output_price],
  ];
  const explicit = typeof model.is_free === 'boolean' ? model.is_free
    : typeof model.free === 'boolean' ? model.free : null;
  // Explicit charges take precedence over a name that happens to contain "free".
  const amounts = [...pairs.flat(), pricing?.request].map(price).filter((value) => value !== null);
  if (explicit === false || amounts.some((value) => value > 0)) return 'paid';
  if (explicit === true || pairs.some(([input, output]) => price(input) === 0 && price(output) === 0)) return 'free';
  if (/^free\//i.test(id) || /:free$/i.test(id)) return 'free';
  return 'unknown';
}

export function normalizeModels(entries) {
  const models = new Map();
  for (const entry of entries) {
    const model = typeof entry === 'string' ? { id: entry } : entry;
    if (!model || typeof model.id !== 'string' || !model.id.trim() || /[\s\x00-\x1F\x7F]/.test(model.id)) {
      throw new Error('The model catalog contains an invalid model ID.');
    }
    const item = { id: model.id, pricing: pricingStatus(model, model.id) };
    const previous = models.get(item.id);
    // Conflicting entries must never turn an explicit paid price into a free label.
    if (!previous || item.pricing === 'paid' || previous.pricing === 'unknown') models.set(item.id, item);
  }
  return [...models.values()].sort((a, b) => (a.pricing !== 'free') - (b.pricing !== 'free') || a.id.localeCompare(b.id));
}

export function formatModels(models, { currentModel, freeOnly = false } = {}) {
  const free = models.filter((model) => model.pricing === 'free');
  const selected = freeOnly ? free : models;
  const lines = [
    `Current model: ${currentModel}`,
    `Provider catalog: ${models.length} models; ${free.length} marked free.`,
  ];
  if (!selected.length) lines.push(freeOnly ? 'No free models were identified in the provider catalog.' : 'The provider returned no models.');
  for (const model of selected) {
    const label = model.pricing === 'free' ? 'FREE' : model.pricing === 'paid' ? 'PAID' : 'PRICE UNKNOWN';
    lines.push(`${model.id === currentModel ? '*' : ' '} [${label}] ${model.id}`);
  }
  lines.push(
    'Free labels use provider metadata or free model IDs; account quotas or subscriptions may apply.',
    'Use /model free to filter, /model to refresh all, or /model <id> to switch for this session.',
  );
  return lines.join('\n');
}
