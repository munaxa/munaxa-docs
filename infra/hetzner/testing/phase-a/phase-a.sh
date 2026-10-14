# shellcheck shell=bash
# shellcheck disable=SC2154 # here, run_prefix and the *_pw values are run-stack-test.sh's own
# Phase A of the Hetzner hosting evaluation (ADR-0026 §10): local upload and download checks against
# the test MinIO. SOURCED by run-stack-test.sh (EXTRA_CHECKS), after its standard checks, so it uses
# that script's stack, configuration and helpers (compose, step, tenant_sql, $config, $run_prefix).
#
#   EXTRA_CHECKS=infra/hetzner/testing/phase-a/phase-a.sh DOCS_API_IMAGE=… DOCS_WEB_IMAGE=… \
#     DOCS_ANTIVIRUS_IMAGE=… infra/hetzner/testing/run-stack-test.sh
#
# Local only: it refuses to run against EXTERNAL_STORAGE_ENV. Each check is judged from the database
# and the object store as well as from HTTP answers. Lines read:
#   PASS     an expectation held
#   FAIL     an expectation did not hold — the run fails at the end of the phase
#   FINDING  an observed behaviour recorded as evidence, not judged here (ADR-0026 §10 records them)
#   MEASURE  a number (time, memory)
# Nothing in it changes a product setting. The one test-only setting is a second API container,
# `phase-a-api-ttl`, whose links last 30 s (STORAGE_SIGNED_URL_TTL_SECONDS=30) for step 3 and the
# expired-link case of step 6; the stack's own API keeps the product default.

if [ -n "${EXTERNAL_STORAGE_ENV:-}" ]; then
  echo "FAIL  Phase A runs against the local test MinIO only; unset EXTERNAL_STORAGE_ENV"
  exit 1
fi

pa_here="$here/phase-a"
pa_dir="$(mktemp -d)"
chmod 777 "$pa_dir"
pa_out="$pa_dir/out.log"
: > "$pa_out"
pa_failures=0
pa_bucket="t/munaxa-docs-test"
pa_tenant_prefix="$run_prefix/tenants/acme"
MiB=1048576

pa_pass() { echo "PASS  $*"; }
pa_fail() {
  echo "FAIL  $*"
  pa_failures=$((pa_failures + 1))
}
pa_finding() { echo "FINDING  $*"; }
pa_measure() { echo "MEASURE  $*"; }

extra_cleanup() {
  docker rm -f phase-a-api-ttl >/dev/null 2>&1 || true
  if [ -n "${pa_sampler:-}" ]; then kill "$pa_sampler" 2>/dev/null || true; fi
  rm -rf "$pa_dir"
}

# The client, in the smoke runner's container: the API as the web server calls it, the store as a
# browser reaches it. Its output is kept for the checks below and shown as it runs.
pa_client() {
  compose --profile test run --rm --no-deps -T \
    -v "$pa_here/client.mjs:/pa-client/client.mjs:ro" -v "$pa_dir:/pa" \
    --entrypoint node smoke /pa-client/client.mjs "$@" 2>&1 | tee -a "$pa_out"
  return "${PIPESTATUS[0]}"
}

# One value from the client's RESULT lines: a JavaScript expression over R (the parsed lines).
pa_q() {
  node -e '
    const R = require("fs").readFileSync(process.argv[1], "utf8").split("\n")
      .filter((l) => l.startsWith("RESULT ")).map((l) => JSON.parse(l.slice(7)));
    const v = ('"$1"');
    console.log(typeof v === "string" ? v : JSON.stringify(v));
  ' "$pa_out"
}

# The test MinIO, asked directly (its own root credentials, inside its own container).
# shellcheck disable=SC2016 # the variables are the storage container's own
pa_mc() {
  compose exec -T storage sh -c \
    'export MC_HOST_t="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@127.0.0.1:9000"; mc "$@"' sh "$@"
}
pa_exists() { pa_mc stat "$pa_bucket/$1" >/dev/null 2>&1; }

pa_sql() { tenant_sql; }

# Fires a declared schedule now, through the product's own operator script (scripts/run-schedule.mjs)
# on the API's network and configuration: only the clock is substituted.
pa_schedule() {
  compose run --rm --no-deps -T --entrypoint node api /app/scripts/run-schedule.mjs "$1"
}

# --- API memory -----------------------------------------------------------------------------------
pa_api_id() { docker inspect -f '{{.Id}}' "$(compose ps -q api)"; }
pa_api_state() { docker inspect -f '{{.RestartCount}} {{.State.OOMKilled}} {{.State.StartedAt}}' "$(compose ps -q api)"; }
pa_cgroup() {
  local id="$1" dir
  for dir in "/sys/fs/cgroup/memory/docker/$id" "/sys/fs/cgroup/system.slice/docker-$id.scope" \
    "/sys/fs/cgroup/docker/$id"; do
    [ -d "$dir" ] && { echo "$dir"; return 0; }
  done
  return 1
}
pa_usage() {
  local dir="$1"
  if [ -f "$dir/memory.usage_in_bytes" ]; then cat "$dir/memory.usage_in_bytes"; else cat "$dir/memory.current"; fi
}
# Samples the API's memory every half second into a file; prints the peak when stopped.
pa_sample_start() {
  local dir
  dir="$(pa_cgroup "$(pa_api_id)")" || { echo "no cgroup for the API container"; return 1; }
  : > "$pa_dir/mem.samples"
  (while :; do pa_usage "$dir" >> "$pa_dir/mem.samples" 2>/dev/null; sleep 0.5; done) &
  pa_sampler=$!
}
pa_sample_stop() {
  [ -n "${pa_sampler:-}" ] || { echo 0; return 0; }
  kill "$pa_sampler" 2>/dev/null || true
  wait "$pa_sampler" 2>/dev/null || true
  pa_sampler=''
  sort -n "$pa_dir/mem.samples" | tail -1
}
# Counts lines of a store listing; a prefix with nothing under it is 0, not an error.
pa_count() { { pa_mc ls --recursive "$@" 2>/dev/null || true; } | wc -l; }
pa_mib() { echo $(( $1 / MiB )); }

# Waits for the API's liveness probe (inside its container); prints the seconds it took.
pa_wait_api() {
  local waited=0
  until docker exec "$(compose ps -q api)" node -e \
    "fetch('http://127.0.0.1:3001/api/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
    >/dev/null 2>&1; do
    [ "$waited" -ge 240 ] && { echo "$waited"; return 1; }
    sleep 2
    waited=$((waited + 2))
  done
  echo "$waited"
}

# The kernel's own record of a memory-cgroup kill in the API container, where the host lets us read it.
pa_oom_record() {
  { dmesg 2>/dev/null || true; } | grep -A1 -F "task_memcg=/docker/$(pa_api_id)" \
    | grep -o "Memory cgroup out of memory: Killed process.*" | tail -1 | cut -c1-160
}

# =================================================================================================
step "Phase A — baseline"
pa_measure "host: $(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo) MiB memory available, $(df -Pm / | awk 'NR==2 {print $4}') MiB disk free"
pa_measure "API container: restarts, OOM-killed, started = $(pa_api_state)"
pa_api_baseline_state="$(pa_api_state)"

# =================================================================================================
step "Phase A 1 — upload size boundaries (ceiling 128 MiB = AV_ICAP_MAX_BYTES)"
pa_sample_start || pa_fail "could not sample the API's memory"
pa_client sizes || pa_fail "the sizes step did not complete"
pa_measure "API peak memory during step 1: $(pa_mib "$(pa_sample_stop)") MiB (limit 1536 MiB)"

for pa_label in size-1MiB size-127MiB size-128MiB; do
  pa_facts="$(pa_q "R.find((r) => r.label === '$pa_label') ?? null")"
  pa_digest="$(pa_q "R.find((r) => r.label === '$pa_label')?.digest ?? ''")"
  pa_row="$(printf "SELECT scan_status, scanner LIKE 'ICAP %%', size_bytes FROM file_object WHERE checksum_sha256 = '%s';\n" "$pa_digest" | pa_sql)"
  if [ "$(pa_q "R.find((r) => r.label === '$pa_label')?.complete ?? null")" = "201" ] \
    && [ "$(pa_q "R.find((r) => r.label === '$pa_label')?.scanStatus ?? null")" = "CLEAN" ] \
    && [ "$pa_row" = "CLEAN | t | $(pa_q "R.find((r) => r.label === '$pa_label')?.sizeBytes")" ]; then
    pa_pass "$pa_label: completed 201 CLEAN in $(pa_q "R.find((r) => r.label === '$pa_label')?.ms")ms; database: $pa_row (scan_status | ICAP scanner | size)"
  else
    pa_fail "$pa_label: client $pa_facts; database: ${pa_row:-no row}"
  fi
done

pa_over="size-128MiB-plus-1"
pa_create="$(pa_q "R.find((r) => r.label === '$pa_over')?.create ?? null")"
pa_sessions="$(printf 'SELECT count(*) FROM upload_session WHERE declared_size_bytes = %s;\n' $((128 * MiB + 1)) | pa_sql)"
if [ "$pa_create" -ge 400 ] 2>/dev/null && [ "$pa_sessions" = "0" ]; then
  pa_pass "$pa_over: refused at creation (HTTP $pa_create, $(pa_q "R.find((r) => r.label === '$pa_over')?.problem")); no upload session row; no target issued"
else
  pa_fail "$pa_over: creation answered $pa_create; upload sessions recorded for that size: $pa_sessions"
fi
pa_text="text-32MiB-plus-1"
pa_finding "$pa_text (text family cap 32 MiB): creation answered $(pa_q "R.find((r) => r.label === '$pa_text')?.create ?? null") $(pa_q "R.find((r) => r.label === '$pa_text')?.problem ?? null")"
if [ "$(pa_q "R.find((r) => r.label === '$pa_text')?.create ?? 0")" -lt 400 ]; then
  pa_fail "$pa_text: a text file over its family's 32 MiB cap was accepted"
fi
pa_staged=0
for pa_session in $(pa_q "R.filter((r) => r.step === 'sizes' && r.sessionId).map((r) => r.sessionId).join(' ')"); do
  if pa_exists "$pa_tenant_prefix/staging/$pa_session"; then pa_staged=$((pa_staged + 1)); fi
done
if [ "$pa_staged" = "0" ]; then
  pa_pass "no staged object left behind by step 1's uploads (completed ones are promoted, refused ones never staged)"
else
  pa_fail "$pa_staged staged object(s) left behind by step 1's uploads"
fi

# =================================================================================================
step "Phase A 2 — an upload created without a SHA-256"
pa_client no-digest || pa_fail "the no-digest step did not complete"
pa_nd_session="$(pa_q "R.find((r) => r.step === 'no-digest')?.sessionId ?? ''")"
pa_nd_digest="$(pa_q "R.find((r) => r.step === 'no-digest')?.digest ?? ''")"
pa_finding "no-digest: create $(pa_q "R.find((r) => r.step === 'no-digest')?.create") (checksum signed into the link: $(pa_q "R.find((r) => r.step === 'no-digest')?.signedChecksum")), PUT $(pa_q "R.find((r) => r.step === 'no-digest')?.put"), completion $(pa_q "R.find((r) => r.step === 'no-digest')?.complete") $(pa_q "R.find((r) => r.step === 'no-digest')?.problem")"
pa_nd_state="$(printf "SELECT state FROM upload_session WHERE id = '%s';\n" "$pa_nd_session" | pa_sql)"
pa_nd_files="$(printf "SELECT count(*) FROM file_object WHERE checksum_sha256 = '%s';\n" "$pa_nd_digest" | pa_sql)"
if pa_exists "$pa_tenant_prefix/staging/$pa_nd_session"; then pa_nd_object=present; else pa_nd_object=absent; fi
pa_finding "no-digest: database session state ${pa_nd_state:-<none>}; file_object rows for its bytes: $pa_nd_files; staged object: $pa_nd_object"
if [ "$pa_nd_files" = "0" ]; then
  pa_pass "no-digest: nothing recorded as a file for bytes whose digest was never confirmed"
else
  pa_fail "no-digest: a file_object was recorded for unconfirmed bytes"
fi

# =================================================================================================
step "Phase A 3 — uploads slower than their link (test-only API with a 30 s link lifetime)"
compose run -d --no-deps --name phase-a-api-ttl -e STORAGE_SIGNED_URL_TTL_SECONDS=30 api >/dev/null \
  || pa_fail "could not start the 30 s-link API"
for _ in $(seq 1 60); do
  if docker exec phase-a-api-ttl node -e "fetch('http://127.0.0.1:3001/api/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 2
done
docker exec phase-a-api-ttl node -e "fetch('http://127.0.0.1:3001/api/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
  || { pa_fail "the 30 s-link API did not become healthy"; }

# The product sweeps abandoned sessions at */15 (UTC). The two timed variants must not straddle a
# scheduled sweep unless this script fires it, so they wait out a boundary that is too close.
pa_clear_of_sweep() {
  local seconds=$(( (15 - $(date -u +%-M) % 15) * 60 - $(date -u +%-S) ))
  if [ "$seconds" -lt "$1" ]; then
    echo "waiting $((seconds + 20)) s for the scheduled sweep at the quarter-hour to pass"
    sleep $((seconds + 20))
  fi
}

pa_client slow expired-before-put || pa_fail "the expired-before-put variant did not complete"
pa_clear_of_sweep 150
pa_client slow slow-before-sweep || pa_fail "the slow-before-sweep variant did not complete"
pa_clear_of_sweep 200
pa_client slow sweep-during-put &
pa_slow_pid=$!
sleep 45
echo "firing storage.sweep-upload-sessions while the third upload is still transferring"
pa_schedule storage.sweep-upload-sessions || pa_fail "the upload sweep could not be fired"
wait "$pa_slow_pid" || pa_fail "the sweep-during-put variant did not complete"

for pa_variant in expired-before-put slow-before-sweep sweep-during-put; do
  q() { pa_q "R.find((r) => r.step === 'slow' && r.variant === '$pa_variant')?.$1 ?? null"; }
  pa_session="$(q sessionId)"
  pa_state="$(printf "SELECT state FROM upload_session WHERE id = '%s';\n" "$pa_session" | pa_sql)"
  pa_files="$(printf "SELECT coalesce(string_agg(scan_status::text, ','), 'none') FROM file_object WHERE checksum_sha256 = '%s';\n" "$(q digest)" | pa_sql)"
  if pa_exists "$pa_tenant_prefix/staging/$pa_session"; then pa_object=present; else pa_object=absent; fi
  pa_finding "$pa_variant: link ~$(q ttlSeconds) s; PUT started at $(q putStartedAfterS) s, ended at $(q putEndedAfterS) s, answered $(q put) $(q putCode); completion $(q complete) $(q scanStatus) $(q problem); session $pa_state; file_object: $pa_files; staged object: $pa_object"
  # Integrity, whatever the timing: a file is recorded only CLEAN, and only with a completion that said so.
  if [ "$pa_files" != "none" ] && { [ "$(q complete)" != "201" ] || [ "$pa_files" != "CLEAN" ]; }; then
    pa_fail "$pa_variant: a file_object ($pa_files) exists without a 201 CLEAN completion"
  fi
done
pa_sdp_session="$(pa_q "R.find((r) => r.variant === 'sweep-during-put')?.sessionId ?? ''")"
if pa_exists "$pa_tenant_prefix/staging/$pa_sdp_session"; then
  pa_finding "sweep-during-put: the staged object exists with its session $(printf "SELECT state FROM upload_session WHERE id = '%s';\n" "$pa_sdp_session" | pa_sql) — no OPEN session refers to it, so no later sweep will delete it (an untracked object; only a bucket lifecycle rule would)"
fi

# =================================================================================================
step "Phase A 4 — the server-side multipart writer (S3StorageAdapter.put) against MinIO"
compose run --rm --no-deps -T -e "RUN_PREFIX=$run_prefix/" \
  -v "$pa_here/multipart.cjs:/pa-client/multipart.cjs:ro" --entrypoint node api \
  /pa-client/multipart.cjs 2>&1 | tee -a "$pa_out" || pa_fail "the multipart step did not complete"
mq() { pa_q "R.find((r) => r.step === 'multipart' && r.case === '$1')?.$2 ?? null"; }
pa_measure "multipart parts (bytes): $(mq uneven partSizes)"
if [ "$(mq uneven readBackIdentical)" = "true" ] && [ "$(mq uneven readBackDigestMatches)" = "true" ] \
  && [ "$(mq uneven reportedDigestMatches)" = "true" ] && [ "$(mq uneven headSize)" = "$(mq uneven sizeBytes)" ] \
  && [ "$(mq uneven pendingUploadsAfter)" = "0" ]; then
  pa_pass "multipart: $(mq uneven sizeBytes) bytes in uneven parts read back byte for byte; SHA-256 matches what put() reported; no unfinished upload left"
else
  pa_fail "multipart uneven: $(pa_q "R.find((r) => r.step === 'multipart' && r.case === 'uneven')")"
fi
pa_finding "multipart: non-trailing parts all the same size: $(mq uneven nonTrailingPartsEqual) (MinIO accepts unequal parts; whether Cloudflare R2 does is a Phase C question)"
if [ "$(mq failing-source refused)" = "StorageUnavailableError" ] && [ "$(mq failing-source objectAfter)" = "false" ] \
  && [ "$(mq failing-source pendingUploadsAfter)" = "0" ]; then
  pa_pass "multipart: a source failing after $(mq failing-source partsSentBeforeFailure) part(s) is refused, aborted, and leaves no object and no unfinished upload"
else
  pa_fail "multipart failing source: $(pa_q "R.find((r) => r.step === 'multipart' && r.case === 'failing-source')")"
fi

# =================================================================================================
step "Phase A 5 — memory under concurrent ~120 MiB uploads (API limit 1536 MiB)"
pa_load() {
  local n="$1" peak
  pa_sample_start || pa_fail "could not sample the API's memory"
  pa_client load "$n" || pa_fail "the $n-upload load step did not complete"
  peak="$(pa_sample_stop)"
  pa_measure "API peak memory, $n concurrent uploads: $(pa_mib "$peak") MiB of 1536 MiB; wall time $(pa_q "R.find((r) => r.step === 'load$n-total')?.wallSeconds") s"
  local ok
  ok="$(pa_q "R.filter((r) => r.step === 'load$n').every((r) => r.complete === 201 && r.scanStatus === 'CLEAN')")"
  local finished
  finished="$(pa_q "R.filter((r) => r.step === 'load$n').length")"
  if [ "$ok" = "true" ] && [ "$finished" = "$n" ] && [ "$(pa_api_state)" = "$pa_api_baseline_state" ]; then
    pa_pass "$n concurrent uploads: all $n completed 201 CLEAN; API not restarted or OOM-killed ($(pa_api_state))"
    return 0
  fi
  pa_fail "$n concurrent uploads: outcomes $(pa_q "R.filter((r) => r.step === 'load$n').map((r) => [r.complete ?? null, r.scanStatus ?? null, r.error ?? r.problem ?? null])"); API state $(pa_api_state) (baseline $pa_api_baseline_state)"
  local recovered
  if recovered="$(pa_wait_api)"; then
    pa_measure "API live again $recovered s after the load step ended"
  else
    pa_fail "the API was not live again within 240 s"
  fi
  local record
  record="$(pa_oom_record)"
  [ -n "$record" ] && pa_finding "kernel record for the API container: $record"
  # What each interrupted upload left: its session, its staged object, its content-key object, its row.
  local session digest
  for session in $(pa_q "R.filter((r) => r.step === 'load$n' && r.sessionId).map((r) => r.sessionId).join(' ')"); do
    digest="$(pa_q "R.find((r) => r.sessionId === '$session').digest")"
    local staged=absent blob=absent
    pa_exists "$pa_tenant_prefix/staging/$session" && staged=present
    pa_exists "$pa_tenant_prefix/blobs/${digest:0:2}/${digest:2:2}/$digest" && blob=present
    pa_finding "load$n upload $session: session $(printf "SELECT state FROM upload_session WHERE id = '%s';\n" "$session" | pa_sql); staged object $staged; content-key object $blob; file_object $(printf "SELECT coalesce(string_agg(scan_status::text, ','), 'none') FROM file_object WHERE checksum_sha256 = '%s';\n" "$digest" | pa_sql); client: $(pa_q "R.find((r) => r.sessionId === '$session').error ?? R.find((r) => r.sessionId === '$session').complete ?? null")"
  done
  pa_api_baseline_state="$(pa_api_state)"
  return 1
}
if pa_load 4; then
  pa_avail="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"
  pa_disk="$(df -Pm / | awk 'NR==2 {print $4}')"
  if [ "$pa_avail" -ge 6144 ] && [ "$pa_disk" -ge 4096 ]; then
    pa_load 8 || true
  else
    pa_finding "8 concurrent uploads skipped: host has $pa_avail MiB memory available and $pa_disk MiB disk free (needs 6144 and 4096)"
  fi
else
  pa_finding "8 concurrent uploads skipped: the 4-upload run was not clean"
fi

# =================================================================================================
step "Phase A 6 — downloads: authorization, confidentiality, integrity, links"
pa_wait_api >/dev/null || pa_fail "the API is not live before step 6"
pa_client dl-setup || pa_fail "the download set-up did not complete"
dq() { pa_q "R.find((r) => r.step === 'dl-setup')?.documents?.$1?.$2 ?? ''"; }
key_of() { printf "SELECT storage_key FROM file_object WHERE id = '%s';\n" "$1" | pa_sql; }
pa_tampered_key="$pa_tenant_prefix/$(key_of "$(dq tampered fileObjectId)")"
pa_missing_key="$pa_tenant_prefix/$(key_of "$(dq missing fileObjectId)")"
# The store-side faults the integrity verifier exists for: the tampered object's bytes replaced with
# other bytes, the missing one deleted. Done in the store, as a fault would be; nothing in the
# database is touched.
printf 'phase-a: these bytes replaced the stored ones %s\n' "$(openssl rand -hex 16)" \
  | pa_mc pipe "$pa_bucket/$pa_tampered_key" >/dev/null || pa_fail "could not replace the tampered object's bytes"
pa_mc rm "$pa_bucket/$pa_missing_key" >/dev/null || pa_fail "could not delete the missing object"
if ! pa_exists "$pa_tampered_key" || pa_exists "$pa_missing_key"; then
  pa_fail "the store faults were not in place (tampered present, missing absent)"
fi
pa_client dl-pre || pa_fail "the pre-verifier download checks did not complete"
for pa_c in tampered missing; do
  pa_finding "before the verifier, $pa_c object: link issued $(pa_q "R.find((r) => r.step === 'dl-pre' && r.case === '$pa_c')?.issue"), store answered $(pa_q "R.find((r) => r.step === 'dl-pre' && r.case === '$pa_c')?.get"), bytes match the recorded digest: $(pa_q "R.find((r) => r.step === 'dl-pre' && r.case === '$pa_c')?.sameBytes")"
done

echo "firing storage.verify-integrity (the rolling verifier) and waiting for its findings"
integrity() { printf "SELECT integrity_status FROM file_object WHERE id = '%s';\n" "$1" | pa_sql; }
for _ in 1 2 3; do
  pa_schedule storage.verify-integrity >/dev/null || true
  for _ in $(seq 1 30); do
    pa_t="$(integrity "$(dq tampered fileObjectId)")" pa_m="$(integrity "$(dq missing fileObjectId)")"
    case "$pa_t/$pa_m" in MISMATCH/UNREADABLE) break 2 ;; esac
    sleep 4
  done
done
if [ "$pa_t/$pa_m" = "MISMATCH/UNREADABLE" ]; then
  pa_pass "the integrity verifier marked the tampered blob MISMATCH and the missing one UNREADABLE"
else
  pa_fail "after the verifier: tampered $pa_t, missing $pa_m (expected MISMATCH, UNREADABLE)"
fi

pa_client dl-post || pa_fail "the download checks did not complete"
d() { pa_q "R.find((r) => r.step === 'dl-post' && r.case === '$1')?.$2 ?? null"; }
expect() { # name, condition (JS over the case's facts f), description
  if [ "$(pa_q "((f) => $2)(R.find((r) => r.step === 'dl-post' && r.case === '$1') ?? {})")" = "true" ]; then
    pa_pass "download $1: $3 — $(pa_q "R.find((r) => r.step === 'dl-post' && r.case === '$1')")"
  else
    pa_fail "download $1: expected $3 — got $(pa_q "R.find((r) => r.step === 'dl-post' && r.case === '$1') ?? null")"
  fi
}
expect open '[200, 201].includes(f.issue) && f.get === 200 && f.sameBytes === true && /^attachment/.test(f.disposition ?? "")' \
  "link issued, served as an attachment, the same bytes"
expect nodl 'f.issue === 403' "refused by the confidentiality level (403)"
expect tampered 'f.issue >= 400 && f.get === undefined' "refused after the verifier quarantined it, no link"
expect missing 'f.issue >= 400 && f.get === undefined' "refused after the verifier quarantined it, no link"
expect reader-without-download-permission 'f.issue === 403' "refused for a user without document:download (403)"
expect expired-link 'f.beforeExpiry === 200 && f.afterExpiry === 403' "served before expiry, refused after"
expect edited-signature 'f.status === 403' "refused by the store"
expect edited-path 'f.status === 403' "refused by the store"
pa_finding "non-ASCII file name 'Résumé تقرير.txt': link $(d unicode issue), store $(d unicode get), same bytes $(d unicode sameBytes); Content-Disposition as received: $(d unicode disposition)"

# =================================================================================================
step "Phase A — what is left, before the stack is removed"
pa_open_sessions="$(printf "SELECT count(*) FROM upload_session WHERE state = 'OPEN';\n" | pa_sql)"
pa_staged_left="$(pa_count "$pa_bucket/$pa_tenant_prefix/staging/")"
pa_incomplete="$(pa_count --incomplete "$pa_bucket/$run_prefix/")"
pa_current="$(pa_count "$pa_bucket/$run_prefix/")"
pa_versions="$(pa_count --versions "$pa_bucket/$run_prefix/")"
pa_measure "open upload sessions: $pa_open_sessions; staged objects: $pa_staged_left; unfinished multipart uploads: $pa_incomplete"
pa_measure "objects under the run prefix: $pa_current current, $pa_versions versions incl. delete markers (the test bucket is versioned)"
pa_measure "host after Phase A: $(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo) MiB memory available, $(df -Pm / | awk 'NR==2 {print $4}') MiB disk free; API $(pa_api_state)"

# The 30 s-link API's own log is not in `compose logs`; it gets the same check as every other.
for pa_value in "$owner_pw" "$app_pw" "$backup_pw" "$redis_pw" "$minio_pw" "$admin_pw"; do
  if docker logs phase-a-api-ttl 2>&1 | grep -qF "$pa_value"; then
    pa_fail "a generated credential appears in the 30 s-link API's log"
  fi
done

# Handed back rather than exited on, so the stack test's own remaining checks (production validation,
# credentials in logs) still run; it fails the run at its end.
# shellcheck disable=SC2034 # read by run-stack-test.sh
extra_failures=$pa_failures
if [ "$pa_failures" -ne 0 ]; then
  echo "Phase A: $pa_failures expectation(s) did not hold (FINDING lines are evidence, not passes)"
else
  echo "Phase A: every expectation held (FINDING lines are evidence for review, not passes)"
fi
