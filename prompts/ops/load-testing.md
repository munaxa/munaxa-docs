# Load Testing

Baseline load/smoke testing for the API with [k6](https://k6.io). The script lives at
`infra/loadtest/k6-smoke.js`.

## Running

```bash
# Against local (API on :4000, seeded tenant)
k6 run infra/loadtest/k6-smoke.js

# Against staging
BASE_URL=https://api.staging.munaxa.app \
TENANT_SLUG=demo EMAIL=admin@demo.example PASSWORD='…' \
k6 run infra/loadtest/k6-smoke.js
```

## What it does

- `setup()` logs in once and shares the bearer token with all virtual users.
- Each VU iteration hits the public liveness probe and an authenticated read (`/auth/me`).
- Profile: ramp 0→20 VUs (30s), hold 20 VUs (1m), ramp down (20s).

## Thresholds (the run fails if breached)

| Metric | Budget |
|--------|--------|
| `http_req_duration` p95 | < 500 ms |
| `http_req_duration` p99 | < 800 ms |
| `http_req_failed` | < 1% |
| `business_errors` (non-200 on checked calls) | < 1% |

These mirror the latency SLOs in `monitoring.md`.

## Interpreting results & next steps

- **Latency climbs with VUs** → check DB pool saturation and event-loop lag; scale API pods or the
  DB, or add PgBouncer.
- **Errors at higher VUs** → likely the global throttle (`THROTTLE_LIMIT`) or connection limits;
  distinguish 429 (rate limit) from 5xx (capacity).
- **For capacity planning**, raise the sustained stage VUs/duration and add scenarios for the heavy
  read paths (reporting aggregations, `/me/dashboard`) and write paths (attendance bulk, finance).
- Run a baseline before each major release and compare p95/p99 against the previous run; treat a
  regression as a release blocker.

> This is a smoke/baseline harness, not a stress or soak test. For production capacity sign-off, run
> a longer soak (≥30 min) at expected peak concurrency in staging with production-like data volumes.
