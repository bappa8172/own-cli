export function normalizeUsage(usage = {}) {
  usage ||= {};
  const known = (item) => Number.isSafeInteger(item) && item >= 0;
  const value = (item) => known(item) ? item : 0;
  const input = value(usage.input_tokens ?? usage.prompt_tokens) + value(usage.cache_read_input_tokens) + value(usage.cache_creation_input_tokens);
  const output = value(usage.output_tokens ?? usage.completion_tokens);
  const cached = value(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens);
  const reportedCost = usage.currency === 'USD' ? usage.cost ?? usage.total_cost : null;
  const inputKnown = known(usage.input_tokens ?? usage.prompt_tokens);
  const outputKnown = known(usage.output_tokens ?? usage.completion_tokens);
  return { input, output, cached, total: value(usage.total_tokens) || input + output,
    reportedCost: typeof reportedCost === 'number' && Number.isFinite(reportedCost) && reportedCost >= 0 ? reportedCost : null,
    available: known(usage.total_tokens) || inputKnown && outputKnown, breakdownComplete: inputKnown && outputKnown };
}
export class UsageLedger {
  constructor({ maxTokens, maxCost, prices = {} } = {}) {
    this.maxTokens = maxTokens; this.maxCost = maxCost; this.prices = prices;
    this.input = 0; this.output = 0; this.cached = 0; this.total = 0; this.computedCost = 0;
    this.reportedCost = 0; this.allCostsReported = true; this.allUsageReported = true; this.allBreakdownsReported = true; this.allRequestsPriced = true; this.requests = 0;
  }
  before(model, messages, tools, outputLimit) {
    if ((this.maxTokens || this.maxCost !== undefined) && !this.allUsageReported) throw new Error('Provider omitted token usage; budget enforcement cannot continue.');
    if (this.maxTokens && this.total >= this.maxTokens) throw new Error('Token budget exhausted.');
    if (this.maxCost !== undefined) {
      const price = this.prices[model];
      if (!price || !['input', 'output'].every((key) => typeof price[key] === 'number' && Number.isFinite(price[key]) && price[key] >= 0)) {
        throw new Error(`Dollar budget requires explicit input/output prices per million tokens for ${model}. Use --prices.`);
      }
      // UTF-8 byte counts are a deliberately conservative prompt-size allowance, not a tokenizer estimate.
      const inputAllowance = Buffer.byteLength(JSON.stringify({ messages, tools }));
      const reserve = (inputAllowance * price.input + outputLimit * price.output) / 1000000;
      if (Math.max(this.computedCost, this.reportedCost) + reserve > this.maxCost) throw new Error('Request would exceed the configured dollar budget reserve.');
    }
    return this.maxTokens ? Math.max(1, Math.min(outputLimit, this.maxTokens - this.total)) : outputLimit;
  }
  add(model, rawUsage) {
    const usage = normalizeUsage(rawUsage);
    this.requests += 1; this.input += usage.input; this.output += usage.output; this.cached += usage.cached; this.total += usage.total;
    this.allUsageReported &&= usage.available;
    this.allBreakdownsReported &&= usage.breakdownComplete;
    this.allCostsReported &&= usage.reportedCost !== null;
    this.reportedCost += usage.reportedCost ?? 0;
    const price = this.prices[model];
    this.allRequestsPriced &&= Boolean(price) && usage.breakdownComplete;
    if (price) this.computedCost += (Math.max(0, usage.input - usage.cached) * (price.input || 0)
      + usage.cached * (price.cached ?? price.input ?? 0) + usage.output * (price.output || 0)) / 1000000;
    return this.summary();
  }
  after() {
    if ((this.maxTokens || this.maxCost !== undefined) && !this.allUsageReported) throw new Error('Provider omitted token usage; budget enforcement cannot continue.');
    if (this.maxTokens && this.total > this.maxTokens) throw new Error('Provider-reported token usage exceeded the turn budget. No further actions will run.');
    if (this.maxCost !== undefined && !this.allRequestsPriced && !this.allCostsReported) throw new Error('Provider returned an unpriced model or incomplete usage; dollar budget cannot be verified.');
    if (this.maxCost !== undefined && Math.max(this.computedCost, this.reportedCost) > this.maxCost) throw new Error('Provider-reported/computed cost exceeded the turn budget. No further actions will run.');
  }
  summary() { return { inputTokens: this.input, outputTokens: this.output, cachedTokens: this.cached, totalTokens: this.total,
    requests: this.requests, usageComplete: this.allUsageReported, breakdownComplete: this.allBreakdownsReported,
    reportedCost: this.allCostsReported && this.requests ? this.reportedCost : null,
    computedCost: Object.keys(this.prices).length && this.allRequestsPriced ? this.computedCost : null, currency: 'USD' }; }
}
