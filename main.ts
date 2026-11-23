// token-radar-01, signal-2 entrypoint. Node 22+, standard library only, no network.
//
// Reads the sealed snapshot (locally: --input <snapshot.json>), refuses a board the gate would
// reject, writes board.json and data.js, copies the dashboard and screenshots, then writes
// dossier.json last from the final contents of /output.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read --name value, --name=value, or a fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const joined = process.argv.find((item) => item.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy regular files whose names do not start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

/** Refuse a dashboard that names a network address where the scorer forbids one. */
function assertDashboardOffline(dir: string): void {
  const address = /https?:\/\//i;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const text = readFileSync(path, 'utf8');
    if (name.endsWith('.css') && address.test(text)) {
      process.stderr.write(`token radar: dashboard/${name} names a network address in CSS\n`);
      process.exit(1);
    }
    if (name.endsWith('.html')) {
      const attributes = /[A-Za-z-]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let found: RegExpExecArray | null;
      while ((found = attributes.exec(text)) !== null) {
        if (address.test(found[1] ?? found[2] ?? '')) {
          process.stderr.write(`token radar: dashboard/${name} names a network address in an HTML attribute\n`);
          process.exit(1);
        }
      }
    }
    if (name.endsWith('.js')) {
      for (const found of text.matchAll(/https?:\/\//gi)) {
        const at = found.index ?? 0;
        const around = text.slice(Math.max(0, at - 90), Math.min(text.length, at + 90));
        if (/\b(?:import|export|require|from)\b/.test(around)) {
          process.stderr.write(`token radar: dashboard/${name} names a network address in a module specifier\n`);
          process.exit(1);
        }
      }
    }
  }
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
assertDashboardOffline(join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > 4) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: hand in 3 or 4 whole-page captures\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name} is not a plain file name\n`);
    process.exit(1);
  }
}

writeFileSync(join(out, 'dossier.json'), buildDossier(out, {
  text_max_bytes: TEXT_MAX_BYTES,
  screenshots: SCREENSHOT_CAPS,
  dashboard: DASHBOARD_CAPS,
}));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watchlist, ${board.length} ranked rows\n` +
  `token radar: leave-one-out over ${radar.calibration.summary.traded_peers} traded peers: median factor ${radar.calibration.summary.median_factor_error.toFixed(2)}x, ` +
  `${Math.round(radar.calibration.summary.interval_coverage * 100)}% interval coverage, ${radar.calibration.summary.within_2x} within 2x\n` +
  `token radar: wrote board.json, data.js, dashboard (offline preflight passed), ${shots.length} screenshots and dossier.json to ${out}\n`,
);
