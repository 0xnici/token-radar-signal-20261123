// signal-2: a pre-token value model driven only by the snapshot's own numbers.
//
// The model never reads a protocol name to assign a value. It learns one multiple from the
// protocols whose tokens already trade (market cap / TVL), winsorises that ratio at the 90th
// percentile, shrinks thin categories toward the global median, then applies three priors that
// the snapshot cannot fit: a size penalty, a seven-day momentum tilt and a tenure ramp. The
// honest range is a category peer-ratio interquartile band, not a promise about a launch price.
//
// No clock or entropy is consulted. A seeded mulberry32 generator supplies the bootstrap so two
// runs on the same snapshot write byte-identical files.

/** One of the ten fields the sealed snapshot carries per protocol. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Every knob of signal-2, published verbatim in the dashboard's Method view. */
export interface Constants {
  winsor_q: number;
  shrink_phantom_peers: number;
  size_exponent: number;
  size_min: number;
  size_max: number;
  momentum_weight: number;
  momentum_floor: number;
  momentum_cap: number;
  tenure_min: number;
  tenure_max: number;
  tenure_days: number;
  farm_threshold: number;
  watch_threshold: number;
  range_width_farm_max: number;
}

export const CONSTANTS: Constants = {
  winsor_q: 0.90,
  shrink_phantom_peers: 4,
  size_exponent: -0.30,
  size_min: 0.5,
  size_max: 2.0,
  momentum_weight: 0.35,
  momentum_floor: -60,
  momentum_cap: 150,
  tenure_min: 0.75,
  tenure_max: 1.20,
  tenure_days: 1460,
  farm_threshold: 60_000_000,
  watch_threshold: 20_000_000,
  range_width_farm_max: 30,
};

export const MODEL_VERSION = 'signal-2';
/** The watchlist floor plus this many early finds gives a 197-row board on this snapshot. */
export const EARLY_ROWS = 157;
export const LIVE_ROWS = 12;
export const BOOTSTRAP_REFITS = 256;
export const PRNG_SEED = 0x51f2a1c3;
export const HARD_VALUE_CAP = 100_000_000_000_000;

export type Verdict = 'FARM' | 'WATCH' | 'SKIP';

/** A priced protocol: point value, peer-ratio interval and the three verdict inputs. */
export interface Priced {
  implied: number;
  low: number;
  high: number;
  width: number;
  category_multiple: number;
  size: number;
  momentum: number;
  tenure: number;
  iqr_low: number;
  iqr_high: number;
  age_days: number | null;
  verdict: Verdict;
  reason: string;
  trigger_tvl: number;
  watch_trigger: string;
}

/** One board row, also the source of the dashboard's compact row. */
export interface BoardRow extends Priced {
  implied_value_usd: number;
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  watchlist: boolean;
  farm_steps: string[];
}

/** A fitted snapshot of the traded-peer market. */
interface Fit {
  global_multiple: number;
  ref_tvl: number;
  cap: number;
  category_multiple: Map<string, number>;
  category_count: Map<string, number>;
  category_iqr: Map<string, [number, number]>;
  global_iqr: [number, number];
}

interface Peer {
  p: SnapshotProtocol;
  ratio: number;
  capped: number;
}

/** Everything the dashboard renders, computed once from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  constants: Constants;
  counts: Record<string, number>;
  tops: Array<{ rank: number; slug: string; name: string; implied_value: number; verdict: Verdict }>;
  rows: BoardRow[];
  calibration: Calibration;
  accounting: Accounting;
  yardsticks: Yardstick[];
  live: LiveRow[];
}

export interface Calibration {
  summary: {
    traded_peers: number;
    median_factor_error: number;
    within_2x: number;
    within_3x: number;
    interval_coverage: number;
    bootstrap_5th: number;
    bootstrap_50th: number;
    bootstrap_95th: number;
    refits: number;
  };
  worst: Array<{ name: string; slug: string; category: string | null; predicted: number; actual: number; factor: number }>;
  bootstrap: number[];
  note: string;
}

export interface Accounting {
  total: number;
  board: number;
  already_tokened: number;
  screened_out: number;
  below_radar_cut: number;
  reason_counts: Record<string, number>;
  records_no_token: number;
  sum: number;
}

export interface Yardstick {
  category: string;
  multiple: number;
  peer_count: number;
  iqr_low: number;
  iqr_high: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  token_status: 'already trades';
}

/** Refused input, with a precise reason. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const UNKNOWN_AGE_DAYS = 730;
const WATCH_CHANGE_TRIGGER = 15;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Type-7 quantile of an already sorted numeric array. */
function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const position = (n - 1) * clamp(q, 0, 1);
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (position - lo);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

/** Whole days between the snapshot date and the day DefiLlama began tracking it. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A protocol records no token only when all three of DefiLlama's token markers are absent. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A traded peer has a real market cap and real TVL: the market's own yardsticks. */
export function isTradedPeer(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
}

const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const SCREEN_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX',
]);
const WRAPPED_WORD = /\b(?:wrapped|staked|staking)\b/i;
const VERSION_MARK = /\s(?:V\d+(?:\.\d+)?|v\d+(?:\.\d+)?|\d+\.\d+)$/;

/** The first reason a pre-token protocol is withheld from the ranking, or null when rankable. */
export function screenReason(p: SnapshotProtocol): string | null {
  if (EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix))) return 'exchange in-house product';
  if (p.category !== null && SCREEN_CATEGORIES.has(p.category)) return 'wrapped or exchange category';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped or staked product';
  if (VERSION_MARK.test(p.name)) return 'versioned pool';
  return null;
}

/** Fit every traded peer. Each category shrinks toward the global median by four phantom peers. */
export function fitPeers(peers: Peer[], C: Constants = CONSTANTS): Fit {
  const ratios = peers.map((peer) => peer.ratio).sort((a, b) => a - b);
  const cap = quantile(ratios, C.winsor_q);
  const capped = peers.map((peer) => Math.min(peer.ratio, cap)).sort((a, b) => a - b);
  const globalMultiple = quantile(capped.length > 0 ? capped : ratios, 0.5);
  const refTvl = median(peers.map((peer) => peer.p.tvl_usd));

  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  const byCategory = new Map<string, number[]>();
  for (const peer of peers) {
    const key = peer.p.category ?? 'Uncategorised';
    const value = Math.min(peer.ratio, cap);
    sums.set(key, (sums.get(key) ?? 0) + value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(value);
    else byCategory.set(key, [value]);
  }
  const categoryMultiple = new Map<string, number>();
  const categoryIqr = new Map<string, [number, number]>();
  for (const [key, count] of counts) {
    categoryMultiple.set(key, ((sums.get(key) ?? 0) + C.shrink_phantom_peers * globalMultiple) / (count + C.shrink_phantom_peers));
  }
  const globalIqr: [number, number] = [quantile(capped, 0.25), quantile(capped, 0.75)];
  for (const [key, bucket] of byCategory) {
    const sorted = bucket.sort((a, b) => a - b);
    if (sorted.length < 4) categoryIqr.set(key, globalIqr);
    else categoryIqr.set(key, [quantile(sorted, 0.25), quantile(sorted, 0.75)]);
  }
  return {
    global_multiple: globalMultiple,
    ref_tvl: refTvl > 0 ? refTvl : 1,
    cap,
    category_multiple: categoryMultiple,
    category_count: counts,
    category_iqr: categoryIqr,
    global_iqr: globalIqr,
  };
}

function tradedPeers(protocols: SnapshotProtocol[]): Peer[] {
  return protocols.filter(isTradedPeer).map((p) => ({
    p,
    ratio: (p.mcap_usd ?? 0) / p.tvl_usd,
    capped: 0,
  }));
}

function multipleFor(fit: Fit, category: string | null): number {
  return fit.category_multiple.get(category ?? 'Uncategorised') ?? fit.global_multiple;
}

function iqrFor(fit: Fit, category: string | null): [number, number] {
  return fit.category_iqr.get(category ?? 'Uncategorised') ?? fit.global_iqr;
}

/** dollars in a fixed, locale-independent shorthand used in reasons and farm steps. */
export function money(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v}`;
}

/** The three priors, the point estimate and the interval for one protocol under a fitted market. */
export function price(p: SnapshotProtocol, fit: Fit, asOf: string, C: Constants = CONSTANTS): Priced {
  const age = ageDays(asOf, p.listed_at);
  const ageForPrior = clamp(age ?? UNKNOWN_AGE_DAYS, 0, C.tenure_days);
  const category_multiple = multipleFor(fit, p.category);
  const size = clamp(Math.pow(p.tvl_usd / fit.ref_tvl, C.size_exponent), C.size_min, C.size_max);
  const growth = clamp(finite(p.change_7d, 0), C.momentum_floor, C.momentum_cap);
  const momentum = 1 + (C.momentum_weight * growth) / 100;
  const tenure = C.tenure_min + (ageForPrior / C.tenure_days) * (C.tenure_max - C.tenure_min);
  const scale = p.tvl_usd * size * momentum * tenure;
  const implied = clamp(Math.max(1, Math.round(scale * category_multiple)), 1, HARD_VALUE_CAP);
  const [iqr_low, iqr_high] = iqrFor(fit, p.category);
  const low = clamp(Math.round(scale * Math.max(iqr_low, 1e-9)), 1, HARD_VALUE_CAP);
  const high = clamp(Math.round(scale * Math.max(iqr_high, 1e-9)), low, HARD_VALUE_CAP);
  const width = high / Math.max(low, 1);
  const triggerBase = Math.max(1e-9, category_multiple * size * momentum * tenure);
  const trigger_tvl = Math.round(C.watch_threshold / triggerBase);

  let verdict: Verdict;
  let reason: string;
  if (implied >= C.farm_threshold && momentum >= 0.95 && width <= C.range_width_farm_max) {
    verdict = 'FARM';
    reason = `FARM: ${money(implied)} clears the ${money(C.farm_threshold)} bar, momentum ${momentum.toFixed(2)}x is positive and the peer range is ${width.toFixed(1)}x, inside ${C.range_width_farm_max}x.`;
  } else if (implied >= C.watch_threshold && width <= 60) {
    const missing = implied < C.farm_threshold
      ? `it sits below the ${money(C.farm_threshold)} farm bar`
      : `momentum ${momentum.toFixed(2)}x misses 0.95x`;
    verdict = 'WATCH';
    reason = `WATCH: ${money(implied)} is above ${money(C.watch_threshold)} and the range is ${width.toFixed(1)}x, but ${missing}.`;
  } else {
    verdict = 'SKIP';
    reason = `SKIP: ${money(implied)} and a ${width.toFixed(1)}x peer range miss both bars; flip on 7-day TVL change above +${WATCH_CHANGE_TRIGGER}% or TVL crossing ${money(trigger_tvl)}.`;
  }
  const watch_trigger = `7-day TVL change above +${WATCH_CHANGE_TRIGGER}% or TVL crossing ${money(trigger_tvl)}`;
  return {
    implied, low, high, width, category_multiple, size, momentum, tenure, iqr_low, iqr_high,
    age_days: age, verdict, reason, trigger_tvl, watch_trigger,
  };
}

/** Gas cost band by chain, quoted as a range because a scenario is not a fee quote. */
function gasBand(chains: string[]): { chain: string; text: string } {
  const chain = chains.length > 0 ? chains[0]! : 'its main chain';
  const key = chain.toLowerCase();
  if (key === 'ethereum') return { chain, text: '$6-$18' };
  if (key === 'base') return { chain, text: '$0.05-$0.40' };
  if (key === 'solana') return { chain, text: '$0.02-$0.10' };
  if (key === 'bsc' || key === 'binance') return { chain, text: '$0.10-$0.60' };
  if (key === 'arbitrum' || key === 'optimism' || key === 'polygon' || key === 'avalanche') return { chain, text: '$0.20-$1.20' };
  return { chain, text: '$1-$5' };
}

function scenarioSize(tvl: number): number {
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 100_000_000) return 100;
  return 50;
}

function holdDays(age: number | null): number {
  if (age === null || age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The qualifying action that matches this protocol's own category. */
function qualifyingAction(p: SnapshotProtocol, scenario: number): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `supply ${money(scenario)} of USDC and keep the borrow below half of that`;
  if (c.includes('perp') || c.includes('derivative')) return `open one small hedged ${money(scenario)} position and close it after the snapshot`;
  if (c.includes('dex') || c.includes('amm') || c.includes('yield') || c.includes('farm')) return `add ${money(scenario)} of single-sided liquidity to the main pool`;
  if (c.includes('restak') || c.includes('staking')) return `stake ${money(scenario)} of the native asset and keep the receipt token`;
  if (c.includes('bridge')) return `bridge ${money(scenario)} of USDC and use it once in the destination app`;
  if (c.includes('vault') || c.includes('curator') || c.includes('allocator')) return `deposit ${money(scenario)} into a public vault and hold the shares`;
  if (c.includes('predict') || c.includes('gaming')) return `place one ${money(scenario)} position and record its transaction hash`;
  if (c.includes('rwa') || c.includes('stable')) return `mint or redeem ${money(scenario)} of the protocol's own asset`;
  return `deposit ${money(scenario)} of USDC into the app and leave it untouched`;
}

function step(action: string, cost: string, time: string): string {
  const text = `${action} Cost: ${cost}. Time: ${time}.`.trim();
  return text.length > 600 ? `${text.slice(0, 596)}...` : text;
}

/** Six costed, timed steps, generated from this row's own category, chains, TVL, age and verdict. */
export function farmSteps(p: SnapshotProtocol, priced: Priced, C: Constants = CONSTANTS): string[] {
  const gas = gasBand(p.chains);
  const scenario = scenarioSize(p.tvl_usd);
  const hold = holdDays(priced.age_days);
  const qualifying = qualifyingAction(p, scenario);
  const first = priced.verdict === 'SKIP'
    ? step(
        `Watch trigger: ${priced.watch_trigger}. Spend $0 on ${p.name} until that trigger fires; this is a watch plan, not a farm plan. Budget ${gas.text} of gas on ${gas.chain} only if it fires.`,
        '$0 while watching',
        '5 minutes a week',
      )
    : step(
        `Open one dedicated wallet holding only the funds for ${p.name}; keep its seed phrase offline. Budget ${gas.text} of gas on ${gas.chain} for the first transaction.`,
        `${gas.text} of gas on ${gas.chain}`,
        '5 minutes',
      );
  return [
    first,
    step(
      `In this worked scenario, size the position at ${money(scenario)} (a scenario, not a recommendation): ${qualifying} on ${gas.chain}.`,
      `${money(scenario)} scenario capital plus ${gas.text} gas`,
      '20 minutes to set up',
    ),
    step(
      `Each week make exactly one qualifying action, such as ${qualifying}, and save the transaction hash in a log.`,
      'about $2 of gas a week on average',
      '10 minutes a week',
    ),
    step(
      `Hold the position for at least ${hold} days so the activity shows up in more than one eligibility snapshot.`,
      `${money(scenario)} scenario capital stays deployed`,
      `${hold} days`,
    ),
    step(
      `Claim only from ${p.name}'s own published page: open the link it publishes, check the amount, and never pay to claim or hand over a seed phrase.`,
      '$0 to check; never pay to claim',
      '10 minutes',
    ),
    step(
      `Log the wallet, dates, amounts and transaction hashes; unwind the same steps in reverse if the verdict trigger flips or the range widens past ${C.range_width_farm_max * 2}x.`,
      'nothing but the log',
      '15 minutes',
    ),
  ];
}

/** Leave-one-out calibration over every traded peer, plus a seeded bootstrap of the global multiple. */
export function calibrate(snapshot: Snapshot, C: Constants = CONSTANTS): Calibration {
  const peers = tradedPeers(snapshot.protocols);
  const errors: number[] = [];
  const logErrors: Array<{ log: number; entry: Calibration['worst'][number] }> = [];
  let within2 = 0;
  let within3 = 0;
  let inside = 0;

  for (let i = 0; i < peers.length; i++) {
    const held = peers[i]!;
    const rest = peers.filter((_, j) => j !== i);
    const fit = fitPeers(rest, C);
    const priced = price(held.p, fit, snapshot.as_of, C);
    const actual = held.p.mcap_usd!;
    const factor = priced.implied / actual;
    errors.push(factor);
    if (factor >= 0.5 && factor <= 2) within2++;
    if (factor >= 1 / 3 && factor <= 3) within3++;
    const [lowRatio, highRatio] = iqrFor(fit, held.p.category);
    if (held.ratio >= lowRatio && held.ratio <= highRatio) inside++;
    logErrors.push({
      log: Math.abs(Math.log(Math.max(factor, 1e-12))),
      entry: {
        name: held.p.name,
        slug: held.p.slug,
        category: held.p.category,
        predicted: priced.implied,
        actual,
        factor: Math.round(factor * 1000) / 1000,
      },
    });
  }

  const rng = mulberry32(PRNG_SEED);
  const bootstrap: number[] = [];
  for (let b = 0; b < BOOTSTRAP_REFITS; b++) {
    const sample: Peer[] = [];
    for (let k = 0; k < peers.length; k++) sample.push(peers[Math.floor(rng() * peers.length)]!);
    bootstrap.push(fitPeers(sample, C).global_multiple);
  }
  const sortedBootstrap = [...bootstrap].sort((a, b) => a - b);
  const worst = logErrors
    .sort((a, b) => b.log - a.log || (a.entry.slug < b.entry.slug ? -1 : 1))
    .slice(0, 10)
    .map((item) => item.entry);

  return {
    summary: {
      traded_peers: peers.length,
      median_factor_error: Math.round(quantile([...errors].sort((a, b) => a - b), 0.5) * 1000) / 1000,
      within_2x: within2,
      within_3x: within3,
      interval_coverage: peers.length === 0 ? 0 : Math.round((inside / peers.length) * 1000) / 1000,
      bootstrap_5th: Math.round(quantile(sortedBootstrap, 0.05) * 10000) / 10000,
      bootstrap_50th: Math.round(quantile(sortedBootstrap, 0.5) * 10000) / 10000,
      bootstrap_95th: Math.round(quantile(sortedBootstrap, 0.95) * 10000) / 10000,
      refits: BOOTSTRAP_REFITS,
    },
    worst,
    bootstrap,
    note: 'Momentum and tenure are stated priors, not fitted parameters: this snapshot has no launch dates for pre-token protocols, so it cannot calibrate them. The range is a category peer-ratio IQR, not a promise.',
  };
}

/** Deterministic uniform generator: same seed, same 256 refits, same bytes. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The eight best-represented categories and the multiples the market gave them. */
export function yardsticks(fit: Fit): Yardstick[] {
  return [...fit.category_count.entries()]
    .map(([category, peer_count]) => {
      const [iqr_low, iqr_high] = iqrFor(fit, category);
      return {
        category,
        multiple: Math.round((fit.category_multiple.get(category) ?? fit.global_multiple) * 10000) / 10000,
        peer_count,
        iqr_low: Math.round(iqr_low * 10000) / 10000,
        iqr_high: Math.round(iqr_high * 10000) / 10000,
      };
    })
    .sort((a, b) => b.peer_count - a.peer_count || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0))
    .slice(0, 8);
}

/** Market caps of live tokens: yardsticks, never board rows. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      token_status: 'already trades' as const,
    }));
}

/** A disjoint, exhaustive split of all snapshot protocols for the accounting view. */
export function accounting(snapshot: Snapshot, boardSlugs: Set<string>, C: Constants = CONSTANTS): Accounting {
  const reason_counts: Record<string, number> = {
    'exchange in-house product': 0,
    'wrapped or exchange category': 0,
    'wrapped or staked product': 0,
    'versioned pool': 0,
  };
  let tokened = 0;
  let screened = 0;
  let below = 0;
  let onBoard = 0;
  let noToken = 0;
  for (const p of snapshot.protocols) {
    if (!recordsNoToken(p)) {
      tokened++;
      continue;
    }
    noToken++;
    const reason = screenReason(p);
    if (reason !== null) {
      screened++;
      reason_counts[reason] = (reason_counts[reason] ?? 0) + 1;
    } else if (boardSlugs.has(p.slug)) {
      onBoard++;
    } else {
      below++;
    }
  }
  return {
    total: snapshot.protocols.length,
    board: onBoard,
    already_tokened: tokened,
    screened_out: screened,
    below_radar_cut: below,
    reason_counts,
    records_no_token: noToken,
    sum: onBoard + tokened + screened + below,
  };
}

/** The ranked board: watchlist floor first, then the strongest pre-token finds below it. */
export function buildBoard(snapshot: Snapshot, C: Constants = CONSTANTS): { board: BoardRow[]; fit: Fit } {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  const watch = new Set(snapshot.watchlist);
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: the strongest pre-token protocols the watchlist leaves out, by TVL. The
  // watchlist is a floor, not a ceiling: a protocol above it that the house rule missed is still a
  // fair early find, so TVL is a ranking key here, never an exclusion.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && !watch.has(p.slug) && recordsNoToken(p) && screenReason(p) === null)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const fit = fitPeers(tradedPeers(snapshot.protocols), C);
  const rows = [...chosen.values()].map((p) => {
    const priced = price(p, fit, snapshot.as_of, C);
    return { ...priced, implied_value_usd: priced.implied, rank: 0, slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d, watchlist: watch.has(p.slug), farm_steps: farmSteps(p, priced, C) };
  });
  rows.sort((a, b) => b.implied - a.implied || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  rows.forEach((row, i) => { row.rank = i + 1; });
  return { board: rows, fit };
}

/** Assemble the entire dashboard payload. */
export function buildRadar(snapshot: Snapshot, C: Constants = CONSTANTS): { board: BoardRow[]; radar: RadarData } {
  const { board, fit } = buildBoard(snapshot, C);
  const calibration = calibrate(snapshot, C);
  const acct = accounting(snapshot, new Set(board.map((r) => r.slug)), C);
  const counts: Record<string, number> = {
    protocols: snapshot.protocols.length,
    watchlist: snapshot.watchlist.length,
    board: board.length,
    early: board.filter((r) => !r.watchlist).length,
    records_no_token: acct.records_no_token,
    already_tokened: acct.already_tokened,
    screened_out: acct.screened_out,
    below_radar_cut: acct.below_radar_cut,
    traded_peers: calibration.summary.traded_peers,
  };
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    constants: C,
    counts,
    tops: board.slice(0, 8).map((r) => ({ rank: r.rank, slug: r.slug, name: r.name, implied_value: r.implied, verdict: r.verdict })),
    rows: board.map((row) => ({
      ...row,
      implied_value: row.implied_value_usd,
      range_low: row.low,
      range_high: row.high,
      range_width: row.width,
    })),
    calibration,
    accounting: acct,
    yardsticks: yardsticks(fit),
    live: liveRows(snapshot),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape signal-2 scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols: SnapshotProtocol[] = o.protocols.map((value, i) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = value as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, name or TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Refuse any board the seven gate rows would reject, before a byte is written. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows, outside 100..4000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  const missing = snapshot.watchlist.filter((slug) => !board.some((row) => row.slug === slug));
  if (missing.length > 0) return `board misses ${missing.length} watchlist slug(s): ${missing.slice(0, 5).join(', ')}`;
  for (const row of board) {
    if (!Number.isSafeInteger(row.rank) || row.rank < 1) return `${row.slug} has rank ${row.rank}`;
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > HARD_VALUE_CAP) return `${row.slug} has implied value ${row.implied_value_usd}`;
    if (typeof row.name !== 'string' || row.name.trim() === '') return `${row.slug} has no name`;
    if (!known.has(row.slug)) return `${row.slug} is not a snapshot protocol`;
    if (seen.has(row.slug)) return `${row.slug} appears twice`;
    seen.add(row.slug);
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const text of row.farm_steps) {
      const length = text.trim().length;
      if (length < 20 || length > 600) return `${row.slug} has a farm step of ${length} characters`;
    }
  }
  const sorted = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < sorted.length; i++) if (sorted[i]!.rank !== i + 1) return `rank ${i + 1} is ${sorted[i]!.rank}`;
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.implied_value_usd > sorted[i - 1]!.implied_value_usd) return `rank ${i + 1} outranks rank ${i} on value`;
  if (board.length >= 2 && sorted[0]!.implied_value_usd === sorted[sorted.length - 1]!.implied_value_usd) return 'every row shares one implied value: not a ranking';
  return null;
}

/** One line: window.RADAR=<json>; */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
