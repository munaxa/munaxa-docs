#!/usr/bin/env node
/**
 * The load harness `19-performance-and-scalability.md` §8 has named since Phase 0 — Phase 18.
 *
 * ## Why it is Node and not k6
 *
 * k6, Artillery and Gatling are all better at this than three hundred lines of Node, and any of
 * them would have been the answer if the lockfile could gain a dependency. It cannot — the Phase
 * 18 report shows the command that establishes it — so the choice was between a harness with no
 * dependencies and no harness at all. What that costs is real and worth stating: no distributed
 * load generation, no built-in HTML report, and a generator that shares an event loop with its own
 * timing. The last of those is why every latency below is measured with `performance.now()` around
 * a single `fetch` and why the concurrency is a fixed pool rather than an arrival rate — a
 * generator that queues internally reports its own queueing as the server's latency.
 *
 * **Run it from a machine that is not the deployment**, for the same reason.
 *
 * ## Usage
 *
 *   node infra/loadtest/run.mjs \
 *     --base-url https://staging.docs.munaxa.com \
 *     --tokens-file tokens.txt \
 *     --folder-id … --document-id … --search-term policy
 *
 * `--tokens-file` holds one access token per line, one per test user (`--token` is one user). Each
 * virtual user takes its own identity, round-robin, and is paced to its scenario's
 * `perUserIntervalMs` — the API's per-identity rate limits, which a real person keeps to. With
 * fewer identities than virtual users, the users sharing one identity share its allowance, so a
 * run cannot quietly turn into a measurement of the rate limiter: every 429 is counted in its own
 * column (STG-7). Provide at least as many identities as the largest scenario's concurrency (100)
 * for the scenarios to run at full rate.
 *
 * It exits non-zero when a scenario misses its threshold, so a release step can gate on it.
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { argv, exit, stdout } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { NOT_IMPLEMENTED, SCENARIOS } from './scenarios.mjs';

function options() {
  const parsed = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== undefined && flag.startsWith('--')) {
      parsed.set(flag.slice(2), argv[index + 1] ?? '');
      index += 1;
    }
  }
  return parsed;
}

function required(parsed, name) {
  const value = parsed.get(name);
  if (value === undefined || value === '') {
    stdout.write(`Missing --${name}. See the header of this file for usage.\n`);
    exit(2);
  }
  return value;
}

/** One access token per test user: `--tokens-file` (one per line), or a single `--token`. */
function identities(parsed) {
  const file = parsed.get('tokens-file');
  const tokens =
    file !== undefined && file !== ''
      ? readFileSync(file, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
      : [required(parsed, 'token')];
  if (tokens.length === 0) {
    stdout.write('--tokens-file holds no tokens.\n');
    exit(2);
  }
  return tokens;
}

/**
 * The percentile of a sorted sample, by nearest rank.
 *
 * Nearest rank rather than interpolation, because the numbers are compared against 19 §1's
 * targets, and a p99 that is an average of the two slowest requests is not the p99 anybody means
 * when they write an SLO.
 */
function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

async function runScenario(scenario, context) {
  const deadline = performance.now() + scenario.durationSeconds * 1_000;
  const latencies = [];
  let failures = 0;
  let rateLimited = 0;
  // Users sharing an identity share its allowance: pace each so the identity stays inside it.
  const usersPerIdentity = Math.ceil(scenario.concurrency / context.tokens.length);
  const intervalMs = (scenario.perUserIntervalMs ?? 0) * usersPerIdentity;

  const worker = async (index) => {
    const token = context.tokens[index % context.tokens.length];
    while (performance.now() < deadline) {
      const spec = scenario.request(context);
      const startedAt = performance.now();
      try {
        const response = await fetch(`${context.baseUrl}${spec.path}`, {
          method: spec.method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(spec.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        });
        // Drained, always: an undrained body holds the connection and the next request in this
        // worker pays for it, which shows up as latency the server never spent.
        await response.arrayBuffer();
        const elapsed = performance.now() - startedAt;
        if (response.ok) {
          latencies.push(elapsed);
        } else if (response.status === 429) {
          // Counted apart: a run whose users exceed their allowance measures the limiter.
          rateLimited += 1;
        } else {
          // A refusal is not a measurement. Counted, never timed: mixing 403s into the sample is
          // how a load test reports an excellent p95 for a scenario that authorised nothing.
          failures += 1;
        }
      } catch {
        failures += 1;
      }
      // Paced from the start of the request, so a slow answer does not also slow the next ask.
      const wait = intervalMs - (performance.now() - startedAt);
      if (wait > 0 && performance.now() + wait < deadline) {
        await sleep(wait);
      }
    }
  };

  await Promise.all(Array.from({ length: scenario.concurrency }, (_, index) => worker(index)));

  const sorted = [...latencies].sort((left, right) => left - right);
  return {
    name: scenario.name,
    title: scenario.title,
    requests: latencies.length,
    failures,
    rateLimited,
    concurrency: scenario.concurrency,
    identities: Math.min(context.tokens.length, scenario.concurrency),
    intervalMs,
    durationSeconds: scenario.durationSeconds,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    thresholds: scenario.thresholds,
  };
}

function report(results) {
  stdout.write(
    '\n| Scenario | Users | Identities | Pace | Duration | Requests | Failures | 429 | p50 | p95 | target | p99 | target | |\n',
  );
  stdout.write(
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n',
  );
  let missed = 0;
  for (const result of results) {
    // A scenario that authorised nothing, or was mostly refused, has not met anything.
    const ok =
      result.requests > 0 &&
      result.failures + result.rateLimited <= result.requests * 0.01 &&
      result.p95 <= result.thresholds.p95 &&
      result.p99 <= result.thresholds.p99;
    if (!ok) {
      missed += 1;
    }
    const ms = (value) => (Number.isNaN(value) ? '—' : `${Math.round(value)} ms`);
    stdout.write(
      `| ${result.title} | ${result.concurrency} | ${result.identities} | ${result.intervalMs} ms | ` +
        `${result.durationSeconds} s | ${result.requests} | ${result.failures} | ${result.rateLimited} | ${ms(result.p50)} | ` +
        `${ms(result.p95)} | ${result.thresholds.p95} ms | ${ms(result.p99)} | ` +
        `${result.thresholds.p99} ms | ${ok ? 'met' : '**missed**'} |\n`,
    );
  }

  stdout.write('\nNot measured by this harness, and why:\n');
  for (const absence of NOT_IMPLEMENTED) {
    stdout.write(`  - ${absence.scenario}: ${absence.why}\n`);
  }
  return missed;
}

const parsed = options();
const context = {
  baseUrl: required(parsed, 'base-url').replace(/\/+$/, ''),
  tokens: identities(parsed),
  folderId: required(parsed, 'folder-id'),
  documentId: required(parsed, 'document-id'),
  searchTerm: parsed.get('search-term') ?? 'policy',
};

const only = parsed.get('only');
const selected = only ? SCENARIOS.filter((scenario) => scenario.name === only) : SCENARIOS;
if (selected.length === 0) {
  stdout.write(`No scenario named ${String(only)}.\n`);
  exit(2);
}

const results = [];
for (const scenario of selected) {
  stdout.write(`Running ${scenario.title} …\n`);
  results.push(await runScenario(scenario, context));
}

// Non-zero when anything missed, so a release step can gate on it rather than on somebody reading
// the table. 19 §8 requires a regression to block a release; this is the half of that a script can
// enforce, and the other half — comparing against the previous phase — needs a stored baseline
// that no phase has produced yet.
exit(report(results) === 0 ? 0 : 1);
