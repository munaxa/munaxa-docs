# Monitoring and alerting for the Hetzner deployment

**Purpose:** what is watched on the single-server deployment (ADR-0026), how a problem reaches a
person, and which parts exist and are tested versus designed only. It closes the design half of
R-6 in [the readiness report](../reports/hetzner-test-deployment-readiness.md).
**Audience:** operators.

**Status:**
- **Built and tested locally:**
  - the signals the product and the template emit (health checks, backup status, scanner
    staleness, the off-server copy's status, the audit and MFA signals);
  - `infra/hetzner/ops/host-check.sh`, which turns them into a pass or a list of findings;
  - `infra/hetzner/ops/monitor.sh` and the systemd timer that run it and deliver the result to a
    heartbeat URL, an optional failure endpoint and an optional webhook (tested against a local
    receiver).
- **Not built or not exercised:** the accounts — the heartbeat service, the external uptime check,
  the notification channel — and who is paged. Each is a hosted step with **required placeholders**
  in `config/monitoring.env.example`; nothing has been signed up for.

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
| M2 | Server alive and checks passing | `monitor.sh` (timer): `host-check.sh` exit 0 → ping the dead-man's switch | no ping for 15 min | page | Script and delivery: **locally** (a local receiver). Unit files: `systemd-analyze verify`. A real switch: **no** |
| M3 | Disk space (root, backup volume) | `host-check.sh` (`df`) | > 85 % (`DISK_MAX_PERCENT`) | page | **Locally** (stack test, including a forced finding) |
| M4 | Backup volume free space | `munaxa_backup_volume_free_bytes` in `status/backup.prom` | trend; covered by M3 | info | Locally |
| M5 | Memory | `host-check.sh` (`/proc/meminfo`) and each container's `OOMKilled` | < 10 % available, or any OOM kill | page | Locally (no OOM produced) |
| M6 | Database availability | `pg_isready` in the `postgres` container; `/api/health/ready` from inside (every tenant database by position, Redis, scanner); the container's health | not ready, not 200, or `database:N` DOWN | page | Locally |
| M7 | Backup age | `munaxa_backup_last_success_timestamp_seconds`; `db-backup` health (`munaxa-backup health`) | > 26 h since the last success | page | **Locally** (script tests, stack test) |
| M8 | Backup failure | `munaxa_backup_last_run_success = 0`; `db-backup` unhealthy | any failed run | page | **Locally** (a failed run is visible: script tests) |
| M9 | WAL archiving failing | `pg_stat_archiver`: `last_failed_time > last_archived_time` | true | page | Locally (healthy case; a failing archive was tested in the script suite, not through `host-check`) |
| M10 | Object storage failing | `host-check.sh`: a read-only listing through the API's own adapter; the count of `A download did not verify` in the API log (quarantine); `INTEGRITY_MISMATCH` audit events | the listing fails; any quarantine | page | **Locally** (stack test: the store stopped → finding, then cleared) |
| M11 | Malware scanner | `antivirus` container health = a real scan **and** `munaxa-scanner-watch check` (signatures younger than 72 h); `/api/health` reports `antivirus` DEGRADED | unhealthy | page | **Locally** (`infra/antivirus/test-scanner-watch.sh`) |
| M12 | Scanner refusing (signatures > 168 h), or the fail-open guard fired | counts of `scans are refused` and `FAIL-OPEN DETECTED` in the scanner log; signature age read from the scanner volume | any; age > 72 h | page | Locally (stack test: 100 h old → finding, then cleared) |
| M13 | MFA sealing key not held | `MFA_FAILED` audit events with reason `SEALING_KEY_NOT_HELD` (key-rotation.md) | any | page | Behaviour locally; alerting **no** |
| M14 | Audit chain broken | count of `The audit chain failed verification` in the API log; metric `audit.chain.verified{intact="false"}` | any | page | Behaviour in existing suites; the log count is in `host-check.sh` |
| M15 | TLS certificate expiry (direct TLS only) | `host-check.sh`: the certificate served on 127.0.0.1:443 for `DOCS_PUBLIC_HOSTNAME` | < 14 days, or none served | page | Logic only; no real certificate has been issued |
| M16 | Off-server backup copy | `offsite.prom` (README.md §7): last verified run, failures, complete base backup on the remote | failed run; no verified copy for 2 h; no complete base backup | page | **Locally** (stand-in MinIO; stack test: a copy failed during an outage → finding) |

## 3. The host check

`infra/hetzner/ops/host-check.sh` runs on the server and reads; it changes nothing, so it can run as
often as wanted. It prints one line per check and exits with the number of findings (capped at 100):
disks (M3), memory and OOM kills (M5), Docker answering and every expected service running and
healthy, PostgreSQL ready (M6), backups and WAL archiving (M7–M9), the off-server copy (M16),
readiness (M6), the object store (M10), log-derived signals over the last 10 minutes (M10, M12, M14),
signature age (M11) and, with direct TLS, the certificate (M15).

**What it never prints:** a log line, a tenant name, a host or bucket name, a URL or a setting —
only fixed sentences with counts, ages, percentages and service names. A log-derived check reports
how many times a signal appeared, never the line, because a line can name a file or a tenant.

**Tested in the stack test:** healthy; `DISK_MAX_PERCENT=0` (a finding naming the disk); the object
store stopped while an off-server copy runs and the signatures are made 100 h old (three named
findings), then all cleared once they recover.

## 4. Delivery

`infra/hetzner/ops/monitor.sh`, started every 5 minutes by `ops/systemd/munaxa-host-check.timer`:

| Outcome | What is sent |
| --- | --- |
| All well | One ping to `HEARTBEAT_URL`. Its absence (a dead server, a stopped timer, a failing check) is the alert, after the service's grace period |
| Findings | No success ping. The finding lines go to `HEARTBEAT_FAIL_URL` (many heartbeat services accept the ping URL + `/fail`) and `ALERT_WEBHOOK_URL` (`{"text": …}`), when set, so the page is immediate and says what is wrong |
| Delivery failed | Exit 3, logged locally; the switch then alerts by the missing ping |
| Configuration unusable | Exit 2, nothing sent: missing file, mode not 0600, a placeholder left, a non-https URL, no `ALERT_CONTACT` |

**What may leave the server:** the FINDING lines only, filtered again to letters, digits and
`.,:;%()/=+_-`, 200 characters each, 20 lines at most. The URLs are credentials: they go to curl on
its standard input, never on a command line, and are never printed or logged.

**What the owner must supply before deployment** (`config/monitoring.env.example`, mode 0600):

| Value | Required | Notes |
| --- | --- | --- |
| `HEARTBEAT_URL` | **yes** | A heartbeat check with a 5-minute period and a 10-minute grace, at any service; free tiers exist [plan terms unverified] |
| `ALERT_CONTACT` | **yes** | The named person (and a second) who is paged; recorded here, routed in the service |
| `HEARTBEAT_FAIL_URL` | recommended | The same check's failure endpoint |
| `ALERT_WEBHOOK_URL` | optional | A chat or alerting webhook |
| External uptime check of `https://<host>/login` (M1) | **yes** | Configured in the monitoring service, not on the server; every 1–5 minutes |

**Tested:** `infra/hetzner/testing/monitoring/test-monitor.sh` (20 checks against a local receiver:
refusals send nothing, one ping when all is well, findings to the failure endpoint and webhook as
valid JSON, hostile text stripped, delivery failure reported, no URL token printed or logged; a
negative control without the filter fails). **Not tested:** a real service, e-mail or phone
delivery, the timers on a server, log rotation.

| Need | Proposal | Cost | Validated |
| --- | --- | --- | --- |
| Metrics history (optional) | `METRICS_DRIVER=PROMETHEUS` scraped privately with `METRICS_SCRAPE_TOKEN`, plus node_exporter's textfile collector reading `status/backup.prom` and `offsite.prom` — not needed for TEST | the server's own resources | No |
| Log retention | Container logs rotate at 10 MB × 5 per service (compose.yaml); journald for the timers; the last host-check output in `/var/log/munaxa-docs/host-check.log` | — | Rotation: yes; retention: no |

**The order matters:** the dead-man's switch and the external uptime check come before the first
data that matters (ADR-0026 §9). Without them, every signal in §2 is a line in a file nobody reads.

## 5. Runbook links

| Finding | First action |
| --- | --- |
| disk | `docker system df`; the backup volume's `munaxa-backup list` and prune settings; never delete `wal/` by hand |
| memory / OOM | Which container (`docker inspect`), its `mem_limit` in compose.yaml, ADR-0026 §10 measurements |
| backup age / failure | `docker compose logs db-backup`; `munaxa-backup validate` inside the container |
| offsite | `journalctl -u munaxa-offsite`; `$C --profile ops run --rm offsite validate`; backup-and-restore.md §5.5 "When a run reports a problem" |
| storage | the provider's status page; `docker compose logs api` for `StorageUnavailable`; uploads and downloads are refused meanwhile, by design |
| tls | `docker compose logs proxy` (ACME errors); DNS still points here; ports 80/443 open |
| WAL archiving failing | `docker compose logs postgres` (archive command message); free space on the backup volume. **pg_wal grows until archiving works — this becomes a disk finding** |
| scanner unhealthy / refusing | `docker compose logs antivirus`; mirror reachability (`scanner-egress` network); uploads are refused meanwhile, by design |
| `SEALING_KEY_NOT_HELD` | key-rotation.md §3 "A failed rotation" |
| audit chain broken | backup-and-restore.md §3; treat as an incident |
