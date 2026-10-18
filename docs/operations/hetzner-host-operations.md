# Operating the Hetzner host: access, secrets, releases, rollback and rebuild

**Purpose:** what the server around the Compose template needs: firewall, SSH, OS updates, secrets,
image digests, releases, rollback and rebuilding a lost host. ADR-0026 §8–§9 set the direction;
this is the procedure.
**Status:** **written, not performed.** No Hetzner server has been created. Steps marked
*(template-tested)* are exercised by `infra/hetzner/testing/run-stack-test.sh` locally; everything
else needs a TEST server.
**Audience:** whoever is given access to the server.

## 1. Firewall

Docker writes its own iptables rules, and **a port Docker publishes bypasses a host firewall such as
`ufw`**. So the boundary is the **Hetzner Cloud Firewall**, which filters before traffic reaches the
server, plus the template's own discipline: the only published port is Caddy's, bound to `127.0.0.1`
until the TLS decision changes it (compose.yaml).

| Inbound rule | TLS option A (Tunnel) | B (Cloudflare proxy) | C (Caddy ACME) | D (load balancer) |
| --- | --- | --- | --- | --- |
| TCP 22 from the administrators' named addresses (or a VPN) | yes | yes | yes | yes |
| TCP 443 | — | Cloudflare's published ranges only | any | from the load balancer only |
| TCP 80 | — | — | any (certificate challenge and redirect) | — |
| ICMP | optional | optional | optional | optional |
| Everything else | denied | denied | denied | denied |

**Outbound:** keep it open, because the server pulls images and reaches the object store, mail,
ClamAV mirrors and the off-server backup target. The containers' own egress is already constrained
by the template's internal networks.

**To verify on TEST** (not done): from an outside host, a port scan of the public address answers
only the intended ports.

## 2. SSH

- Keys only:
  - `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin no`;
  - one named account per administrator, in `sudo`;
  - Ed25519 keys, one per person and device.
- Access is granted by adding a key and revoked by removing it, with the date and the person
  recorded. A departing administrator's key is removed the same day, and any secret they could read
  is rotated (key-rotation.md for the three long-lived keys; the rest are independent).
- Hetzner's rescue console is the break-glass path. Its use is recorded.
- **Optional:** restrict SSH to a VPN or a bastion instead of named addresses, and add fail2ban.
  With a firewall allow-list, fail2ban adds little.

## 3. Operating-system updates

- Debian or Ubuntu LTS with `unattended-upgrades` limited to security updates.
- A monthly maintenance window to reboot when `/var/run/reboot-required` exists:
  1. the release's pre-deployment backup (§5);
  2. reboot;
  3. the host check (monitoring.md).
- Docker Engine from Docker's own repository, upgraded in the same window, one minor version at a
  time.

## 4. Secrets

| Secret | Lives in | Mode | Backed up to |
| --- | --- | --- | --- |
| `api.env`, `postgres.env`, `redis.env`, `operator.env`, `backup.env`, the catalogues | `DOCS_CONFIG_DIR` (`/etc/munaxa-docs`, 0700 root) | 0600 root (catalogues 0400 uid 1000) | The password manager and the offline escrow (key-rotation.md §5). **Not** in the database backups |
| The three long-lived keys and their previous values | `api.env` | as above | escrow, with key ids and dates (key-rotation.md) |
| `age` **identities** for the backups | **never on the server** | — | two holders, offline |
| The heartbeat and alert URLs, and who is paged | `/etc/munaxa-docs/monitoring.env` (config/monitoring.env.example) | 0600 root | password manager |
| The off-server copy's no-delete credential | `/etc/munaxa-docs/offsite.env` (config/offsite.env.example) | 0600 root | password manager |
| Caddy's ACME account key and certificates (direct TLS) | the `caddy-data` volume | Docker volume | not backed up: re-issued if lost (mind the CA's rate limits) |
| GHCR pull credential (if the images are private) | `/root/.docker/config.json` | 0600 | password manager; a read-only token |

**Rules:**

- Secrets never go on a command line (process lists), in shell history, in this repository or in a
  log. The template passes every one through files; `db-admin` passes passwords to `psql` as
  variables.
- The stack test checks that no generated credential, the backup identity included, appears in any
  container log *(template-tested)*.
- Generate with `openssl rand -hex 32`.

## 5. Releases by digest, and rollback

**A release is a set of digests, never tags.** `deploy.env` names:

- the `api`, `web` and `antivirus` images published by `publish-images.yml`, by `@sha256:` digest;
- the third-party images (Caddy, Redis), pinned by digest too.

**The PostgreSQL image** (`munaxa-docs-postgres`) is now a fourth leg of `publish-images.yml`: built
from `infra/hetzner/postgres`, accepted by `postgres/verify-image.sh` (PostgreSQL 16.10, age 1.2.1,
the backup tools, the refusal of a private key, a real start, no credential in its history), pushed,
pulled back by digest and accepted again. **Nothing has been published**: the workflow runs only
for an `image/<sha>` tag, which the owner pushes for the commit chosen for TEST. Until then every
digest in `deploy.test.env.example` is a placeholder. The third-party images (Caddy, Redis, and
rclone for the off-server copy, already pinned in compose.yaml) are pinned by digest in `deploy.env`;
`ops/check-deploy-env.sh` refuses a tag.

**Release** (from the release checkout, `C="docker compose --env-file deploy.env -f infra/hetzner/compose.yaml"`):

1. Write the new digests into a **new** `deploy.env`; keep the previous file as
   `deploy.env.<previous release>`. Run `infra/hetzner/ops/check-deploy-env.sh deploy.env --on-host`
   until it reports nothing wrong *(script tested; never run on a server)*.
2. `$C pull`, then confirm each pulled image's digest is the one written: `docker image inspect --format '{{index .RepoDigests 0}}' <image>`.
3. **Pre-deployment backup:** `$C exec db-backup munaxa-backup once`. Write down the base backup's
   name and the time.
4. `$C --profile ops run --rm migrate` *(template-tested)*.
5. `$C up -d` *(template-tested)*.
6. Run `infra/hetzner/ops/host-check.sh`, and from outside sign in and download a document.

**Rollback:**

- **Code only.** The previous release's `deploy.env`, then `$C up -d`. This is safe because
  migrations are expand-only (go-live-runbook.md §20).
- **A migration must be undone.** It is never reversed in place. Recover the cluster to the time
  in step 3 by backup-and-restore.md §5.2 into a new volume, verify it (§3 there), then switch
  `postgres-data` to it during a maintenance window. Writes made after step 3 are lost unless they
  are replayed, so prefer fixing forward.
- **Rehearsal:** a rollback has never been executed (gate G-8). Rehearse one on TEST before
  production.

## 6. Rebuilding a lost host

**When:** the server is gone or untrustworthy (disk failure, compromise, account problem). Target:
hours, not minutes (ADR-0026 §9). **Never rehearsed (open).**

1. **Decide where:**
   - a new server in a new Hetzner project if the old account or project is suspect;
   - the same project otherwise.
2. **Provision:**
   - the server (same size class), firewall (§1), SSH (§2), Docker Engine;
   - a new backup volume, mounted as in infra/hetzner/README.md §7.
3. **Code and configuration:**
   - check out the release recorded in the last `deploy.env`;
   - restore `DOCS_CONFIG_DIR` from the password manager or escrow;
   - after a compromise, rotate every secret except the three long-lived keys, which are moved to
     their previous lists (key-rotation.md §3).
4. **Data:**
   - `offsite fetch` the newest complete recovery point (base backup, every verified WAL file after
     it, the newest dump set) from the off-server copy onto the new backup volume, every byte
     checked (backup-and-restore.md §5.5) *(tested against MinIO, and the drill recovers from it)*;
   - recover by backup-and-restore.md §5.2 to the end of the archive, or to a time before a
     compromise, into the `postgres-data` volume;
   - verify by §3 (chain, RLS, tenant isolation; the drill's checks).
5. **Start:**
   - `$C up -d`, then the host check;
   - the TLS path (tunnel, DNS or load balancer target) is moved to the new server last.
6. **Object storage** is not on the server and normally survives. If it does not, the provider's
   version history and the second-provider copy decide what can be recovered (D-3).
7. **Record:**
   - what was lost: the window between the last WAL that left the server and the failure;
   - how long each step took. That is the first real RTO measurement.

**The weak link today:** step 4 needs the off-server copy running at a real provider. The job is
built and tested against a stand-in; until a bucket exists and G-1/G-2 pass on it, losing the
server loses the backups with it.

## 7. Direct TLS on the host (TLS option C)

Recommended for TEST (readiness report §5.2), **not yet chosen** (D-2). With it, Caddy terminates TLS
on this server and nobody else decrypts traffic.

**Prerequisites, in this order:**

1. The TEST host name (D-8) chosen; its A record points at the server's primary IPv4, DNS only
   (not proxied). No AAAA: the overlay publishes on `0.0.0.0`, IPv4 only, and Let's Encrypt
   prefers IPv6 when an AAAA record exists. Let's Encrypt checks it from several places on the
   internet.
2. The Hetzner Cloud Firewall admits TCP 80 and 443 from anywhere (§1, column C). Port 80 must stay
   open: it answers the HTTP-01 challenge and redirects everything else.
3. `deploy.env` names `DOCS_PUBLIC_HOSTNAME` and `DOCS_ACME_EMAIL`, and for the first start
   `DOCS_ACME_CA` = Let's Encrypt **staging** (no rate limits, an untrusted certificate).
   `check-deploy-env.sh` refuses an address, `localhost` or an example name.
4. `$C up -d` with `-f infra/hetzner/compose.tls.yaml`. Caddy obtains the certificate within a
   minute; `docker compose logs proxy` says so. Then remove `DOCS_ACME_CA`, delete the staging
   state (`docker volume rm <project>_caddy-data` with the proxy stopped) and start again for the
   real certificate.

**Renewal** is automatic (about 30 days before expiry) and needs the same two ports and DNS.
`host-check.sh` reports a certificate with fewer than 14 days left (M15). The certificates and the
ACME account live in the `caddy-data` volume; on tmpfs every restart would request a new
certificate and soon hit Let's Encrypt's rate limits — the TLS test shows the difference.

**Client addresses.** Browsers reach Caddy directly and Docker keeps the source address of
published ports, so no forwarded header is trusted. **To verify on TEST:** the sign-in rate limit
and audit records see distinct client addresses (G-5).

**Tested locally** (`testing/tls/test-tls.sh`, Caddy's local CA in place of Let's Encrypt):
configuration, rendered ports and networks, routing, the redirect, HSTS, the certificate's name,
the token kept out of the access log, persistence across a restart. **Not tested:** a real
issuance, renewal, DNS, the firewall.

