/**
 * The load scenarios `19-performance-and-scalability.md` §8 has named since Phase 0.
 *
 * §8 says: *"Scenarios, thresholds and the harness live in `edms/infra/loadtest/`: folder listing
 * at 1M documents, search under concurrency, 100 parallel uploads, 500 approvals per minute, and a
 * full-tenant index rebuild. Every phase records its measured numbers against the table in §1, and
 * a regression against the previous phase blocks the release."*
 *
 * **None of that existed until Phase 18, and no phase has ever recorded a number.** The phase
 * report says so plainly rather than quietly creating the directory and moving on — the sentence
 * above was false for seventeen phases, the same way 19 §5's fairness claim was false until Phase
 * 16 and said so.
 *
 * What is here is the harness and the scenarios as *data*. What is not here is a set of measured
 * numbers, and the reason is not laziness: **a load test needs a target, and this environment has
 * no deployment.** Numbers produced against a laptop with one PostgreSQL container and no object
 * store would not be measurements of anything a customer runs, and writing them into §1's table
 * would be worse than the empty column — a comparison the next phase would be held to against a
 * baseline that means nothing.
 *
 * So the deliverable is a harness an operator points at a staging deployment, with the thresholds
 * from §1 encoded beside each scenario so that a run either meets them or names which one it
 * missed. Running it is a step in the release procedure (`docs/operations/deployment.md`), not a
 * step in CI: a shared runner's timings would fail the thresholds for reasons that have nothing to
 * do with the release.
 */

/** Every threshold below is `19-performance-and-scalability.md` §1's own table, in milliseconds. */
export const SCENARIOS = Object.freeze([
  {
    name: 'folder-listing',
    title: 'Folder listing, 100 items',
    /** 19 §1: p95 200 ms, p99 500 ms. */
    thresholds: { p95: 200, p99: 500 },
    /** Concurrent virtual users. 19 §1's "500 concurrent" divided across the read scenarios. */
    concurrency: 50,
    durationSeconds: 60,
    request: (context) => ({
      method: 'GET',
      path: `/api/v1/folders/${context.folderId}/documents?limit=100`,
    }),
  },
  {
    name: 'document-detail',
    title: 'Document detail',
    thresholds: { p95: 300, p99: 700 },
    concurrency: 50,
    durationSeconds: 60,
    request: (context) => ({ method: 'GET', path: `/api/v1/documents/${context.documentId}` }),
  },
  {
    name: 'search',
    title: 'Search, filtered, under concurrency',
    thresholds: { p95: 800, p99: 1_500 },
    concurrency: 100,
    durationSeconds: 120,
    request: (context) => ({
      method: 'GET',
      path: `/api/v1/search?q=${encodeURIComponent(context.searchTerm)}&limit=20`,
    }),
  },
  {
    name: 'presign-download',
    title: 'Presign a download',
    thresholds: { p95: 150, p99: 400 },
    concurrency: 25,
    durationSeconds: 60,
    request: (context) => ({
      method: 'POST',
      path: `/api/v1/files/${context.fileObjectId}/download-url`,
      body: { filename: 'procedure.pdf' },
    }),
  },
  {
    name: 'dashboard',
    title: 'The dashboard, which is the most-loaded route in the product',
    /**
     * No threshold in §1, because §1 predates the dashboard. It is here anyway: Phase 13's own
     * claim is that the screen costs a number of queries bounded by widgets and independent of
     * rows, and that is a claim a load test can falsify and a unit test cannot.
     */
    thresholds: { p95: 500, p99: 1_200 },
    concurrency: 100,
    durationSeconds: 60,
    request: () => ({ method: 'GET', path: '/api/v1/dashboard' }),
  },
]);

/**
 * The scenarios that are **not** here, and why each is a deliberate absence rather than an
 * oversight — because §8 names five and this file offers a different five.
 *
 * A load harness that quietly dropped three of the named scenarios and added two of its own would
 * be the kind of half-measure this product's reports exist to prevent.
 */
export const NOT_IMPLEMENTED = Object.freeze([
  {
    scenario: '100 parallel uploads',
    why: 'Bytes never pass through the API (19 §2), so what this measures is the object store’s ingest rate and the presign path — and the presign path is measured above. A harness that uploaded through this process would be measuring a path production does not have.',
    closes: 'A driver that writes to the presigned URL directly, which is a storage benchmark rather than an application one.',
  },
  {
    scenario: '500 approvals per minute',
    why: 'A write scenario needs a seeded corpus with documents in the right state and an approver per request, and it leaves the tenant permanently changed. That is a fixture generator, not a request loop, and it is the larger half of the work.',
    closes: 'A seeding step in the same directory, which the deployment runbook’s staging refresh would run first.',
  },
  {
    scenario: 'A full-tenant index rebuild',
    why: 'Phase 8 built it as a resumable shadow-table rebuild that never empties a live index, and its cost is a function of corpus size rather than of concurrency. It is a capacity measurement taken once per release against a known corpus, not a load scenario.',
    closes: 'The same seeding step, plus a timer around the existing rebuild route.',
  },
]);
