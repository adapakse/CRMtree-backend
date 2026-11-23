'use strict';

// The batch runner: queue, progress counters, stop request, the cross-replica
// lock and the per-company time limit. These tests try to break it — they drive
// runBatchForIds with a fake `enrichCompany`, so no website is crawled, but the
// database (stop requests, advisory lock) is the real one.

const db = require('../config/database');
const svc = require('../services/prospectEnrichmentService');

const TENANT_SLUGS = ['zz-prospect-batch-a', 'zz-prospect-batch-b'];
let tenantA, tenantB;

async function ensureTenant(slug) {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [`Prospect Batch Test ${slug}`, slug],
  );
  return tenant.id;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function batchLockKey(tenantId) {
  return `prospect-enrichment-batch:${tenantId}`;
}

beforeAll(async () => {
  tenantA = await ensureTenant(TENANT_SLUGS[0]);
  tenantB = await ensureTenant(TENANT_SLUGS[1]);
});

beforeEach(async () => {
  await db.query('DELETE FROM prospect_enrichment_stop_requests WHERE tenant_id = ANY($1)', [[tenantA, tenantB]]);
});

afterAll(async () => {
  await db.query('DELETE FROM prospect_enrichment_stop_requests WHERE tenant_id = ANY($1)', [[tenantA, tenantB]]);
});

describe('runBatchForIds — queue and counters', () => {
  test('processes every id exactly once and never an undefined one', async () => {
    const ids = Array.from({ length: 23 }, (_, i) => 1000 + i);
    const seen = [];
    const progress = await svc.runBatchForIds(tenantA, ids, {
      enrichCompany: async (id) => { seen.push(id); await sleep(Math.random() * 5); return { status: 'done' }; },
    });
    expect(seen).not.toContain(undefined);
    expect([...seen].sort((a, b) => a - b)).toEqual(ids);
    expect(progress).toMatchObject({ total: 23, done: 23, errors: 0, needs_review: 0, no_website: 0, running: false, stopped: false });
  });

  test('runs at most BATCH_CONCURRENCY companies at once', async () => {
    let active = 0;
    let peak = 0;
    await svc.runBatchForIds(tenantA, Array.from({ length: 30 }, (_, i) => i + 1), {
      enrichCompany: async () => { active++; peak = Math.max(peak, active); await sleep(5); active--; return { status: 'done' }; },
    });
    expect(peak).toBeLessThanOrEqual(svc.BATCH_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  test('counts needs_review and no_website as results, and only failures as errors', async () => {
    const outcomes = ['done', 'needs_review', 'no_website', 'error', 'needs_review', 'done', 'throw', undefined];
    const progress = await svc.runBatchForIds(tenantA, outcomes.map((_, i) => i), {
      enrichCompany: async (id) => {
        if (outcomes[id] === 'throw') throw new Error('boom');
        return outcomes[id] === undefined ? undefined : { status: outcomes[id] };
      },
    });
    expect(progress).toMatchObject({ total: 8, done: 8, needs_review: 2, no_website: 1, errors: 3 });
  });

  test('an empty list finishes immediately and leaves the tenant free for the next batch', async () => {
    expect(await svc.runBatchForIds(tenantA, [], { enrichCompany: async () => ({ status: 'done' }) }))
      .toMatchObject({ total: 0, done: 0, running: false });
    expect(await svc.runBatchForIds(tenantA, [1], { enrichCompany: async () => ({ status: 'done' }) }))
      .toMatchObject({ total: 1, done: 1 });
  });

  test('a batch that failed on every company still releases the tenant', async () => {
    const failed = await svc.runBatchForIds(tenantA, [1, 2, 3], { enrichCompany: async () => { throw new Error('boom'); } });
    expect(failed).toMatchObject({ done: 3, errors: 3, running: false });
    expect(svc.getBatchProgress(tenantA).running).toBe(false);
    expect(await svc.isBatchRunningOnAnotherReplica(tenantA)).toBe(false);
  });
});

describe('runBatchForIds — one batch per tenant', () => {
  test('a second batch for the same tenant in the same process is refused', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = svc.runBatchForIds(tenantA, [1, 2], { enrichCompany: async () => { await gate; return { status: 'done' }; } });
    await sleep(100);
    const secondCalls = [];
    const second = await svc.runBatchForIds(tenantA, [3], { enrichCompany: async (id) => { secondCalls.push(id); return { status: 'done' }; } });
    expect(second).toEqual({ alreadyRunning: true });
    expect(secondCalls).toEqual([]);
    release();
    expect(await first).toMatchObject({ total: 2, done: 2 });
  });

  test('a batch is refused while another replica holds the tenant lock, and processes nothing', async () => {
    const otherReplica = await db.getClient();
    try {
      await otherReplica.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [batchLockKey(tenantA)]);
      expect(await svc.isBatchRunningOnAnotherReplica(tenantA)).toBe(true);

      const calls = [];
      const refused = await svc.runBatchForIds(tenantA, [1, 2, 3], { enrichCompany: async (id) => { calls.push(id); return { status: 'done' }; } });
      expect(refused).toEqual({ alreadyRunning: true });
      expect(calls).toEqual([]);
      // The refused attempt must not leave this replica believing it runs a batch.
      expect(svc.getBatchProgress(tenantA).running).toBe(false);
    } finally {
      await otherReplica.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [batchLockKey(tenantA)]);
      otherReplica.release();
    }
    expect(await svc.isBatchRunningOnAnotherReplica(tenantA)).toBe(false);
    expect(await svc.runBatchForIds(tenantA, [1], { enrichCompany: async () => ({ status: 'done' }) })).toMatchObject({ done: 1 });
  });

  test('asking "is it running elsewhere" does not itself block a batch', async () => {
    await Promise.all(Array.from({ length: 8 }, () => svc.isBatchRunningOnAnotherReplica(tenantA)));
    expect(await svc.runBatchForIds(tenantA, [1], { enrichCompany: async () => ({ status: 'done' }) })).toMatchObject({ done: 1 });
  });

  test('batches of two tenants run side by side', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const batchA = svc.runBatchForIds(tenantA, [1], { enrichCompany: async () => { await gate; return { status: 'done' }; } });
    await sleep(100);
    const batchB = await svc.runBatchForIds(tenantB, [1, 2], { enrichCompany: async () => ({ status: 'done' }) });
    expect(batchB).toMatchObject({ total: 2, done: 2 });
    release();
    expect(await batchA).toMatchObject({ done: 1 });
  });
});

describe('runBatchForIds — stop request', () => {
  test('stops after the companies in flight and leaves the rest untouched', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    const started = [];
    const batch = svc.runBatchForIds(tenantA, ids, {
      enrichCompany: async (id) => { started.push(id); await sleep(40); return { status: 'done' }; },
    });
    await sleep(120);
    await svc.requestBatchStop(tenantA, null);
    const progress = await batch;

    expect(progress.stopped).toBe(true);
    expect(progress.running).toBe(false);
    expect(progress.done).toBe(started.length);
    expect(started.length).toBeLessThan(ids.length);
    expect(started.length).toBeGreaterThan(0);
    // Every company that was started was also finished and counted — none dropped mid-flight.
    expect(new Set(started).size).toBe(started.length);
  });

  test('a stop request left over from an earlier batch does not stop a new one', async () => {
    await svc.requestBatchStop(tenantA, null);
    await sleep(50);
    const progress = await svc.runBatchForIds(tenantA, [1, 2, 3, 4, 5, 6], { enrichCompany: async () => ({ status: 'done' }) });
    expect(progress).toMatchObject({ total: 6, done: 6, stopped: false });
  });

  test('a stop request for one tenant does not stop another tenant', async () => {
    const batchB = svc.runBatchForIds(tenantB, Array.from({ length: 12 }, (_, i) => i), {
      enrichCompany: async () => { await sleep(20); return { status: 'done' }; },
    });
    await sleep(30);
    await svc.requestBatchStop(tenantA, null);
    expect(await batchB).toMatchObject({ total: 12, done: 12, stopped: false });
  });

  test('stopping twice is harmless', async () => {
    const batch = svc.runBatchForIds(tenantA, Array.from({ length: 40 }, (_, i) => i), {
      enrichCompany: async () => { await sleep(30); return { status: 'done' }; },
    });
    await sleep(60);
    await svc.requestBatchStop(tenantA, null);
    await svc.requestBatchStop(tenantA, null);
    expect((await batch).stopped).toBe(true);
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM prospect_enrichment_stop_requests WHERE tenant_id = $1', [tenantA]);
    expect(rows[0].n).toBe(1);
  });
});

describe('runBatchForIds — time limit per company', () => {
  test('a company that never finishes is recorded as an error and the batch goes on', async () => {
    const finished = [];
    const progress = await svc.runBatchForIds(tenantA, [1, 2, 3, 4], {
      companyTimeLimitMs: 150,
      enrichCompany: (id) => (id === 2 ? new Promise(() => {}) : Promise.resolve().then(() => { finished.push(id); return { status: 'done' }; })),
    });
    expect(finished.sort()).toEqual([1, 3, 4]);
    expect(progress).toMatchObject({ total: 4, done: 4, errors: 1, running: false });
  });

  test('a company that fails after it was abandoned does not crash the process', async () => {
    const progress = await svc.runBatchForIds(tenantA, [1], {
      companyTimeLimitMs: 50,
      enrichCompany: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 150)),
    });
    expect(progress).toMatchObject({ done: 1, errors: 1 });
    await sleep(250); // the late rejection happens here; an unhandled one would fail the run
  });
});
