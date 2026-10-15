# Monitoring and alerting for the Hetzner deployment

**Purpose:** what is watched on the single-server deployment (ADR-0026), how a problem reaches a
person, and which parts exist and are tested versus designed only. It closes the design half of
R-6 in [the readiness report](../reports/hetzner-test-deployment-readiness.md).
**Audience:** operators.

**Status:**
- **Built and tested locally:**
  - the signals the product and the template emit (health checks, backup status, scanner
    staleness, the audit and MFA signals);
  - `infra/hetzner/ops/host-check.sh`, which turns them into a pass or a list of findings.
- **Not built:**
  - delivery (the timer, the dead-man's switch, the external uptime check, the notification
    channel). Each needs an account with an outside service, so each is a hosted step, and none
    has been exercised.

## 1. Principles

- **One outside witness.** A server cannot report its own death. Two signals come from outside:
  - an external uptime check of the public `/login`;
  - a dead-man's switch that expects a ping from the server every 5 minutes.

  A missed ping is the alert. So a dead server, a stopped timer, a full disk that stops the timer
  and a failed check all page the same way.
- **Nothing private is exposed to watch it:**
  - The health routes stay behind the proxy (`Caddyfile` refuses every `/api/…` except previews
    and verified downloads).
  - Since R-11 they name no tenant: databases appear as `database:1`, `database:2` in catalogue
    order, and a failing one's slug goes to the private API log.
  - `/api/metrics` needs `METRICS_SCRAPE_TOKEN`.
  - `host-check.sh` reads everything from inside the server, and its output holds counts, ages and
    service names only.
- **Fail closed, then alert.** Where a dependency fails, the product refuses the operation rather
  than degrade silently:
  - uploads are refused while the scanner is down or past its signature limit;
  - a download is refused while the store is unreachable;
  - an MFA code is refused when its key is not held.

  Monitoring makes each refusal visible; it never relaxes one.

## 2. Signals

| # | Signal | Source (exists) | Finding when | Severity | Verified |
| --- | --- | --- | --- | --- | --- |
| M1 | Public availability | `GET https://<host>/login` from an outside uptime service | non-200 twice in a row | page | **No** (hosted) |
| M2 | Server alive and checks passing | `host-check.sh` exit 0 → ping the dead-man's switch | no ping for 15 min | page | Script: **locally**. Timer and switch: **no** |
| M3 | Disk space (root, backup volume) | `host-check.sh` (`df`) | > 85 % (`DISK_MAX_PERCENT`) | page | **Locally** (stack test, including a forced finding) |
| M4 | Backup volume free space | `munaxa_backup_volume_free_bytes` in `status/backup.prom` | trend; covered by M3 | info | Locally |
| M5 | Memory | `host-check.sh` (`/proc/meminfo`) and each container's `OOMKilled` | < 10 % available, or any OOM kill | page | Locally (no OOM produced) |
| M6 | Database availability | `/api/health/ready` from inside (every tenant database by position, Redis, scanner); the `postgres` container's health | not 200, or `database:N` DOWN | page | Locally |
| M7 | Backup age | `munaxa_backup_last_success_timestamp_seconds`; `db-backup` health (`munaxa-backup health`) | > 26 h since the last success | page | **Locally** (script tests, stack test) |
| M8 | Backup failure | `munaxa_backup_last_run_success = 0`; `db-backup` unhealthy | any failed run | page | **Locally** (a failed run is visible: script tests) |
| M9 | WAL archiving failing | `pg_stat_archiver`: `last_failed_time > last_archived_time` | true | page | Locally (healthy case; a failing archive was tested in the script suite, not through `host-check`) |
| M10 | Object storage failing | API log `Object storage is unavailable`, 503 answers on `/api/v1/downloads`; integrity sweep `INTEGRITY_MISMATCH` audit events and `storage.integrity-mismatch` outbox events | any mismatch; sustained 503s | page (mismatch), warn (503) | Behaviour locally (Phase A/B, R-9 tests); alerting **no** |
| M11 | Malware scanner | `antivirus` container health = a real scan **and** `munaxa-scanner-watch check` (signatures younger than 72 h); `/api/health` reports `antivirus` DEGRADED | unhealthy | page | **Locally** (`infra/antivirus/test-scanner-watch.sh`) |
| M12 | Scanner refusing (signatures > 168 h) | scanner log `stopping the engine; scans are refused`; uploads refused | any | page | Locally |
| M13 | MFA sealing key not held | `MFA_FAILED` audit events with reason `SEALING_KEY_NOT_HELD` (key-rotation.md) | any | page | Behaviour locally; alerting **no** |
| M14 | Audit chain broken | log `The audit chain failed verification`; metric `audit.chain.verified{intact="false"}` | any | page | Behaviour in existing suites; alerting **no** |
| M15 | TLS certificate expiry | depends on the TLS decision ([hetzner-tls-decision.md](../reports/hetzner-tls-decision.md)) | < 14 days | warn | **No** |
| M16 | Off-server backup copy age | the copy job's own success marker (README.md §7) | > 26 h | page | **No** (the copy job is a hosted step) |

## 3. The host check

`infra/hetzner/ops/host-check.sh` runs on the server and reads; it changes nothing. It checks M3,
M5, the health of every container (which carries M7, M8 and M11), M7–M9 directly, and M6. It
prints one line per check and exits with the number of findings.

```bash
# /etc/systemd/system/munaxa-host-check.service  (sketch — not yet run on a server)
[Service]
Type=oneshot
WorkingDirectory=/opt/munaxa-docs            # the release checkout
EnvironmentFile=/etc/munaxa-docs/monitoring.env   # HEARTBEAT_URL=… (secret; 0600)
ExecStart=/bin/sh -c 'infra/hetzner/ops/host-check.sh >/var/log/munaxa-host-check.log 2>&1 && curl -fsS -m 10 --retry 2 "$HEARTBEAT_URL" >/dev/null'

# /etc/systemd/system/munaxa-host-check.timer
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
```

- The heartbeat URL is a credential (anyone holding it can silence the alert): it lives in
  `/etc/munaxa-docs/monitoring.env` (0600), never in the repository, a log or a command line.
- The check's own output goes to a local log only.
- **Tested:** the stack test runs it against the live test stack (all well), then with
  `DISK_MAX_PERCENT=0` (a finding, a non-zero exit, the disk named).
- **Not tested:** the systemd units, `curl` to a real switch, log rotation of the output.

## 4. Delivery: what a TEST environment needs

| Need | Proposal | Cost (estimate) | Validated |
| --- | --- | --- | --- |
| Dead-man's switch (M2) | Any heartbeat-monitoring service with a free tier; one check, 5-minute period, 10-minute grace | free tier | No |
| External uptime check (M1) | The same service's HTTP check, or a separate one, every 1–5 minutes | free tier | No |
| Notification channel | Email to the owner, plus a phone push for "page" | free tier | No |
| Metrics history (optional) | `METRICS_DRIVER=PROMETHEUS` scraped privately with `METRICS_SCRAPE_TOKEN`, plus node_exporter's textfile collector reading `status/backup.prom` — only if trends are wanted; not needed for TEST | the server's own resources | No |
| Log retention | Container logs rotate at 10 MB × 5 per service (compose.yaml); journald for the host check. Longer retention needs a log shipper — not proposed for TEST | — | Rotation: yes; retention: no |

**The order matters:** the dead-man's switch and the external uptime check come before the first
data that matters (ADR-0026 §9). Without them, every signal in §2 is a line in a file nobody reads.

## 5. Runbook links

| Finding | First action |
| --- | --- |
| disk | `docker system df`; the backup volume's `munaxa-backup list` and prune settings; never delete `wal/` by hand |
| memory / OOM | Which container (`docker inspect`), its `mem_limit` in compose.yaml, ADR-0026 §10 measurements |
| backup age / failure | `docker compose logs db-backup`; `munaxa-backup validate` inside the container |
| WAL archiving failing | `docker compose logs postgres` (archive command message); free space on the backup volume. **pg_wal grows until archiving works — this becomes a disk finding** |
| scanner unhealthy / refusing | `docker compose logs antivirus`; mirror reachability (`scanner-egress` network); uploads are refused meanwhile, by design |
| `SEALING_KEY_NOT_HELD` | key-rotation.md §3 "A failed rotation" |
| audit chain broken | backup-and-restore.md §3; treat as an incident |
