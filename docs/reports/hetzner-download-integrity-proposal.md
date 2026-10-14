# Proposal — verified, server-mediated downloads

- **Status:** **Proposal for review. Not implemented, not approved.** No code, configuration or
  infrastructure has been changed for it.
- **Date:** 2026-10-14
- **Context:** [ADR-0026](../architecture/adr/0026-hetzner-hosting-evaluation.md) §10, Phase A
- **Owner's stated preference:** downloads that pass through the API and are verified while
  streaming, rather than a five-minute signed store URL issued after a one-time check.

## 1. The problem

**How a download works today** (`9496c9a`):
1. The API checks permission, the confidentiality level, the scan verdict and the integrity
   status.
2. It makes one `HEAD` request to the store, comparing size, checksum or age with the record.
3. It signs a store URL that is valid for `STORAGE_SIGNED_URL_TTL_SECONDS` (default 300 s), and
   writes the `FILE_DOWNLOAD_ISSUED` audit event.
4. The browser fetches the bytes **straight from the store**. The API never sees them.

**What that leaves open:**
- **The 300-second window.** An object replaced after the HEAD is still served for the rest of the
  link's lifetime.
- **A HEAD is not a re-hash.** When the store reports a checksum, we trust its arithmetic. When it
  reports none (streamed exports, objects restored by a plain write, possibly every upload on R2
  if its copy drops the checksum — a Phase C question), only the size and the last-modified time
  are checked.
- **The verifier is not a stopgap.** The nightly integrity verifier finds tampering hours later,
  after the bytes may already have been served.

**A requirement that shapes the whole design:** computing a checksum *while* sending bytes does not,
by itself, stop a user from receiving corrupted bytes. The mismatch is only known after the last
byte has been read. By then every byte has already gone to the browser, and the most the server can
do is cut the connection. A browser usually marks such a download failed (the `Content-Length` is
not met), but the bytes are on the user's machine, and some clients (download managers, `curl`
without `--fail`, scripts) keep them. So **no byte may leave the server before the whole object has
been verified**, or before the part being sent has been verified.

## 2. Options

| | Design | Unverified bytes can reach the browser? | Cost | Change size |
| --- | --- | --- | --- | --- |
| **A** | **Verify, then serve, from a local staging copy.** The API streams the object into an encrypted temporary file while hashing it. Only when the digest matches does it send that file | **No.** The bytes sent are exactly the bytes hashed | Disk equal to the object's size, held only for the download; time to first byte equals the time to read the whole object | Medium: new endpoint, staging, Caddy route |
| B | Verify, then serve with a second, conditional read. A first streamed read hashes and discards; a second read with `If-Match: <ETag of the first>` is streamed to the browser, hashed again, and the connection is cut on mismatch | Only if the store ignores `If-Match` or an ETag collides — the guarantee is the store's, not ours | Twice the store traffic; same first-byte delay; no local disk | Medium |
| C | Per-chunk digests. Record a digest for every fixed-size chunk at upload, and stream each chunk only after it is verified | **No**, chunk by chunk. A mismatch stops the download partway, with only verified bytes sent | Low latency, constant memory, no staging | **Large:** schema migration, upload change, re-hashing every existing file |
| D | Hash while streaming, cut the connection on mismatch | **Yes** — the case §1 rules out | Cheapest | Small |
| E | Today's link with a shorter lifetime (e.g. 30 s) | **Yes**, within the window | None | Configuration only |

**Recommendation: A.** It is the only option that meets the requirement without trusting the store
or changing the schema. B is a fallback if the staging disk turns out to be a problem. C is the
long-term design if large files or first-byte delay matter later. D and E do not meet the
requirement.

## 3. Design A in detail

### 3.1 Flow

1. **Issue — the same request as today, different answer.**
   - `POST /api/v1/documents/:id/content` (and the revision route) keeps every check it has:
     `document:download`, the scope check, the confidentiality level's `allowDownload`, the scan
     verdict, the integrity status, and the HEAD check, which stays as a cheap early refusal.
   - It writes `FILE_DOWNLOAD_ISSUED` as today.
   - Instead of a store URL, it returns an **API URL**: `/api/v1/files/download?token=…`.
   - The token is signed (HMAC-SHA256, the same construction as the preview-stream token, with its
     own purpose string). It carries the file id, tenant id, user id, disposition, filename, the
     recorded size and digest, and an expiry (60 s is proposed).
   - The token is short-lived but can be used more than once until it expires, so a browser retry
     works. Each use is verified again from scratch.
2. **Serve: `GET /api/v1/files/download?token=…`.**
   - Caddy routes it to the API, as it already does `/api/v1/preview/stream*`.
   1. Verify the token: signature, expiry, tenant. Any failure is an empty 404, as for previews.
   2. **Check again in the database:** the scan verdict and integrity status may have changed
      since issue, and the user may have lost the permission or been deactivated. If any of that is
      true, refuse 404.
   3. Wait for staging capacity: a byte budget, the same `ByteBudget` as scans, with its own limit.
      A wait past its bound answers **503 with `Retry-After`** and sends no bytes.
   4. `GET` the object from the store and stream it in chunks (64 KiB–1 MiB) into:
      - a SHA-256 hash;
      - a byte counter that aborts as soon as it passes the recorded size;
      - an **encrypted staging file**: AES-256-GCM (or CTR) with a random key held only in this
        request's memory. The file is created in a private directory (mode 0700), opened, and
        unlinked straight away, so nothing named remains on disk and a crash leaves only
        unreadable bytes.
   5. Compare the size and digest with the record.
      - **Match:** send headers, then stream the staging file back through the decryption to the
        response. The headers are:
        - `Content-Type` from the record;
        - `Content-Length`;
        - `Content-Disposition` in RFC 6266 form, with an ASCII `filename=` and
          `filename*=UTF-8''…` (this also fixes the non-ASCII name Phase A recorded);
        - `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`;
        - `Content-Security-Policy: sandbox` for inline answers.
      - **Mismatch, short or long:** **send no body.** Answer 409 with the existing
        integrity-failure message, and quarantine (§3.3).
   6. Release the staging budget and close the file descriptor, which frees the disk, on every
      path, including errors and client disconnects.
3. **The web app.** The download still goes through `window.location.assign(url)`, now to a
   same-origin API URL. The store no longer needs a CORS rule for `GET`; it keeps the one for
   `PUT`, for uploads.
4. **Previews.** The preview stream already verifies before it sends, but in memory. It would use
   the same staging path, which removes its whole-object buffer.

### 3.2 Failures, disconnects and retries

| Event | Behaviour | Quarantine? |
| --- | --- | --- |
| Digest or size mismatch | 409, no body; quarantined as MISMATCH | **Yes** |
| Store answers 404 for an object the record says exists | 409, no body. Quarantined as UNREADABLE **only after a second read confirms it** | Yes, on a confirmed absence |
| Store 5xx, timeout, connection reset, `ByteBudget` timeout | 503 with `Retry-After`, no body | **No.** A flaky store must not quarantine a library |
| Client disconnects while the server reads from the store | Stop reading, discard the staging file, release the budget | No |
| Client disconnects while the server sends verified bytes | Stop sending, discard, release | No |
| Browser retries within the token's lifetime | A fresh verified read | — |
| API process killed | Unlinked staging files vanish with their descriptors; on start-up the API empties its staging directory | — |

The table follows one rule: **only a definite, repeatable finding quarantines; anything that may be
transient answers 503.** The current integrity verifier does not follow that rule (§6).

### 3.3 Audit and quarantine

- `FILE_DOWNLOAD_ISSUED` stays, unchanged, at issue.
- A new audit action `FILE_DOWNLOAD_SERVED` is proposed, written when the last byte has been
  handed to the socket, with the file, the user, the digest and the size. Audit actions are strings
  (`audit_event.action`), so this needs **no migration**. A disconnect writes nothing; it is logged.
- A mismatch or a confirmed absence uses the existing `quarantine()` path. In one transaction it
  records the integrity status, writes the `INTEGRITY_MISMATCH` audit event (outcome FAILED,
  expected and actual digest) and publishes the `storage.integrity-mismatch` outbox event. From
  then on, every issue and serve is refused by the existing gate until an administrator restores
  the object.
- Logs carry ids, sizes and timings, never the token, a signed URL or a credential.

### 3.4 Files without a store checksum

Every file record has a non-null recorded SHA-256 (`file_object.checksum_sha256`, `CHAR(64)`).
Design A hashes the bytes itself and compares them with that record, so **whether the store keeps
a checksum no longer matters**:
- streamed exports are verified like uploads;
- restored objects are verified like uploads;
- if R2's copy drops the checksum, uploads still verify.

The `HEAD` check's last-modified rule becomes only an early refusal, not the protection.

Any future object without a recorded digest must not be served by this path. It must be refused
until an administrator records one, never served unverified.

### 3.5 Costs and trade-offs

| | Estimate (to be measured in a later phase) |
| --- | --- |
| **Memory** | Constant per download: a few chunk buffers (≤ 2 MiB). Concurrency is bounded by the staging budget. It does not grow with file size, unlike today's preview stream |
| **Disk** | Staging budget, e.g. 2 GiB (16 concurrent 128 MiB downloads), on the server's local disk. Encrypted with throwaway keys and unlinked, so it holds nothing readable |
| **CPU** | SHA-256 plus AES on every byte, twice through the process: roughly 0.1–0.4 s of one core per 128 MiB on a current x86 server [estimate]. Small files are negligible |
| **Bandwidth** | Every download crosses the server twice (store → server, server → browser), where today it crosses neither. Hetzner Cloud includes a monthly traffic allowance [verify]; R2 charges no egress [verify]; Hetzner Object Storage includes an egress quota [verify] |
| **Latency** | Time to first byte grows from the store's latency to the time needed to read the whole object. For 1 MiB that is not noticeable. For 128 MiB it is about 1–2 s at 1 Gbit/s from a nearby store, and longer from an R2 bucket outside the EU [estimate]. The browser shows the download as pending until then |
| **Operations** | A staging directory and its size limit; an API process that serves bulk bytes (it should get its own budget, so a burst of downloads cannot starve uploads); new metrics (served, refused, quarantined, busy); a Caddy route |

**What it does not change:** authorization, confidentiality levels, the scan gate, the upload path,
the 128 MiB and 32 MiB limits, and the database schema.

**What it needs approved** (each is outside the earlier approvals):
- the new public route in the Caddyfile;
- a staging volume on the server;
- the new audit action;
- removing `GET` from the store's CORS rule afterwards.

Range requests (resumable downloads) are left out at first. Browsers fall back to a full download.
They can later be served from the verified staging file.

## 4. Tests that must pass before it is used

Integration tests against MinIO and PostgreSQL, with the staging path and the real S3 adapter:

1. A tampered object (same size, other bytes) gives 409 with **0 body bytes**, a MISMATCH record,
   one `INTEGRITY_MISMATCH` audit event and one outbox event.
2. A tampered object of a different size gives 409 with 0 body bytes, and the read stops once the
   recorded size is passed.
3. A missing object gives 409 with 0 body bytes, UNREADABLE only after the confirming read, and
   no quarantine on a single transient 404 followed by success.
4. An already quarantined file (MISMATCH or UNREADABLE), or one PENDING, INFECTED or FAILED, is
   refused **before any store read**, at issue and at serve.
5. An object swapped while being staged (a test store that changes the bytes mid-read) gives 409
   and 0 body bytes.
6. Store 5xx, a timeout and a reset each give 503 with no body and **no quarantine**.
7. The happy path serves bytes identical to the upload. The headers carry `Content-Length`,
   `nosniff`, `no-store` and RFC 6266 names, ASCII and non-ASCII. `FILE_DOWNLOAD_SERVED` is
   written once.
8. A client disconnect at three points (while staging, at the first byte, mid-send) removes the
   staging file, releases the budget, and writes no "served" event.
9. The token: expired, edited, another tenant's, or used after the user lost `document:download`
   or was deactivated gives 404. A confidentiality level without download refuses at issue.
10. The budget: with the budget full, a request gives 503 `Retry-After` with no body, and a later
    retry succeeds.
11. Memory and disk: 8 concurrent 128 MiB downloads under the Phase A harness, with peak API
    memory and staging disk measured against stated bounds.
12. A crash: a killed API leaves no readable staging bytes, and start-up empties the directory.
13. Unit tests for the token, the hashing and encrypting stager, and the size guard.
14. Browser tests (Phase B harness): a verified download saves the identical file; a tampered one
    shows the error and saves no file.

## 5. Not decided here

- The token lifetime, the staging budget and whether staging sits on its own volume.
- Whether reports and audit exports, which open in a new tab, move to the same path at once. They
  should, because exports are exactly the objects that lack a store checksum.
- Whether to keep a feature switch back to signed store URLs during roll-out.

## 6. Defect found while preparing this proposal (not fixed)

The integrity verifier (`StorageService.verifyIntegrity`, present since `06ab302`) quarantines in
two situations where its own comments say it should not:
- **Oversized files.** `rehash()` returns `null` for a file larger than
  `STORAGE_INTEGRITY_MAX_BYTES` (128 MiB), and `integrityFrom()` turns `null` into **UNREADABLE**.
  So an object over 128 MiB is quarantined on the verifier's first pass and can no longer be
  downloaded. The comment says such files are recorded UNVERIFIED and never quarantined. Uploads
  are capped at 128 MiB under the ICAP scanner, but internal objects written by streaming (for
  example evidence exports) can be larger.
- **One failed read.** A single failed read, for example a brief store outage, also returns `null`
  and quarantines at once. The comment says one pass is not an incident.

Both need a small application fix with tests, which this documentation task does not include.
Design A's streaming verification would also let the verifier hash objects of any size without
holding them in memory.
