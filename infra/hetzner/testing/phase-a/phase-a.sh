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
# `phase-a-api-ttl`, whose links last 30 s (STORAGE_SIGNED_URL_TTL_SECONDS=30 for uploads,
# DOWNLOAD_LINK_TTL_SECONDS=30 for downloads) for step 3 and the expired-link case of step 6; the
# stack's own API keeps the product defaults. Step 6v stops and restarts the test MinIO once, to
# stand in for a store outage.

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
  docker rm -f phase-a-api-ttl phase-a-sweeper >/dev/null 2>&1 || true
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

# Whether a JavaScript condition over one RESULT line holds: pa_holds '<find>' '<condition on f>'.
pa_holds() { [ "$(pa_q "((f) => Boolean($2))($1 ?? {})")" = "true" ]; }

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
# The container's anonymous memory — the process's own heap and buffers, without the page cache of
# files it wrote (which the kernel reclaims, and which `usage` counts).
pa_anon() {
  local dir="$1"
  if [ -f "$dir/memory.stat" ] && grep -q '^anon ' "$dir/memory.stat"; then
    awk '$1 == "anon" {print $2}' "$dir/memory.stat"
  else
    awk '$1 == "total_rss" || $1 == "rss" {print $2; exit}' "$dir/memory.stat"
  fi
}
# Samples the API's memory every half second into a file; prints the peak when stopped. The peak of
# the anonymous part is kept beside it (pa_anon_peak), because a download writes its staging file
# through the page cache and `usage` then counts those cached pages too.
pa_sample_start() {
  local dir
  dir="$(pa_cgroup "$(pa_api_id)")" || { echo "no cgroup for the API container"; return 1; }
  : > "$pa_dir/mem.samples"
  : > "$pa_dir/anon.samples"
  (while :; do
    pa_usage "$dir" >> "$pa_dir/mem.samples" 2>/dev/null
    pa_anon "$dir" >> "$pa_dir/anon.samples" 2>/dev/null
    sleep 0.5
  done) &
  pa_sampler=$!
}
pa_sample_stop() {
  [ -n "${pa_sampler:-}" ] || { echo 0; return 0; }
  kill "$pa_sampler" 2>/dev/null || true
  wait "$pa_sampler" 2>/dev/null || true
  pa_sampler=''
  sort -n "$pa_dir/mem.samples" | tail -1
}
# The anonymous peak of the last sampling (read after pa_sample_stop, which runs in a subshell).
pa_anon_peak() { sort -n "$pa_dir/anon.samples" 2>/dev/null | tail -1; }
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
if [ "$pa_create" = "415" ] && [ "$pa_sessions" = "0" ] \
  && pa_holds "R.find((r) => r.label === '$pa_over')" "/too large.*128 MB/.test(f.problem?.detail ?? '')"; then
  pa_pass "$pa_over: refused at creation (HTTP $pa_create, $(pa_q "R.find((r) => r.label === '$pa_over')?.problem")); no upload session row; no target issued"
else
  pa_fail "$pa_over: creation answered $pa_create; upload sessions recorded for that size: $pa_sessions"
fi
pa_text="text-32MiB-plus-1"
if pa_holds "R.find((r) => r.label === '$pa_text')" "f.create === 415 && /too large.*32 MB/.test(f.problem?.detail ?? '')"; then
  pa_pass "$pa_text: refused as too large, naming the text limit — $(pa_q "R.find((r) => r.label === '$pa_text')?.problem")"
else
  pa_fail "$pa_text: expected 415 naming the 32 MB text limit — got $(pa_q "R.find((r) => r.label === '$pa_text') ?? null")"
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
if [ "$pa_nd_files" = "0" ] && [ "$pa_nd_state" = "ABORTED" ] && [ "$pa_nd_object" = "absent" ] \
  && pa_holds "R.find((r) => r.step === 'no-digest')" "f.complete === 415 && /fingerprint could not be confirmed/.test(f.problem?.detail ?? '')"; then
  pa_pass "no-digest: refused 415 naming the unconfirmed fingerprint; session ABORTED; staged bytes removed; no file recorded"
else
  pa_fail "no-digest: expected 415 (fingerprint), ABORTED, staged bytes removed, no file — got session ${pa_nd_state:-<none>}, staged $pa_nd_object, files $pa_nd_files"
fi

# =================================================================================================
step "Phase A 3 — uploads slower than their link (test-only API with a 30 s link lifetime)"
compose run -d --no-deps --name phase-a-api-ttl -e STORAGE_SIGNED_URL_TTL_SECONDS=30 \
  -e DOWNLOAD_LINK_TTL_SECONDS=30 api >/dev/null \
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
pa_slow_state() {
  printf "SELECT state FROM upload_session WHERE id = '%s';\n" \
    "$(pa_q "R.find((r) => r.variant === '$1')?.sessionId ?? ''")" | pa_sql
}
if pa_holds "R.find((r) => r.variant === 'expired-before-put')" "f.put === 403 && f.complete === 422 && /link expired/.test(f.problem?.detail ?? '')" \
  && [ "$(pa_slow_state expired-before-put)" = "EXPIRED" ]; then
  pa_pass "expired-before-put: the store refused the late PUT (403); completion 422 naming the expired link; session EXPIRED"
else
  pa_fail "expired-before-put: expected PUT 403, completion 422 (link expired), session EXPIRED — got session $(pa_slow_state expired-before-put)"
fi
if pa_holds "R.find((r) => r.variant === 'slow-before-sweep')" "f.complete === 201 && f.scanStatus === 'CLEAN'"; then
  pa_pass "slow-before-sweep: a transfer that started in time and ended after the link expired completed 201 CLEAN (the store checks the link when the transfer starts)"
else
  pa_fail "slow-before-sweep: expected 201 CLEAN"
fi
pa_sdp_session="$(pa_q "R.find((r) => r.variant === 'sweep-during-put')?.sessionId ?? ''")"
if pa_holds "R.find((r) => r.variant === 'sweep-during-put')" "f.complete === 422 && /already been finished/.test(f.problem?.detail ?? '')"; then
  pa_pass "sweep-during-put: completion after the sweep is refused 422 (already finished); no file recorded"
else
  pa_fail "sweep-during-put: expected completion 422 (already finished)"
fi
if pa_exists "$pa_tenant_prefix/staging/$pa_sdp_session"; then
  pa_finding "sweep-during-put: its staged object is still there (session $(pa_slow_state sweep-during-put)); step 7's orphan sweep is expected to remove it"
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
  pa_measure "API peak memory, $n concurrent uploads: $(pa_mib "$peak") MiB of 1536 MiB (anonymous $(pa_mib "$(pa_anon_peak)") MiB); wall time $(pa_q "R.find((r) => r.step === 'load$n-total')?.wallSeconds") s"
  local ok
  ok="$(pa_q "R.filter((r) => r.step === 'load$n').every((r) => r.complete === 201 && r.scanStatus === 'CLEAN')")"
  local finished
  finished="$(pa_q "R.filter((r) => r.step === 'load$n').length")"
  if [ "$ok" = "true" ] && [ "$finished" = "$n" ] && [ "$(pa_api_state)" = "$pa_api_baseline_state" ]; then
    pa_pass "$n concurrent uploads: all $n completed 201 CLEAN; API not restarted or OOM-killed ($(pa_api_state)); completions refused as busy and completed again: $(pa_q "R.filter((r) => r.step === 'load$n').reduce((sum, r) => sum + (r.busyRefusals ?? 0), 0)")"
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
  if pa_holds "R.find((r) => r.step === 'dl-pre' && r.case === '$pa_c')" "f.issue === 409 && f.get === undefined && /integrity check/.test(f.problem?.detail ?? '')"; then
    pa_pass "before the verifier, the $pa_c object is refused 409 (integrity check) and no link is issued"
  else
    pa_fail "before the verifier, the $pa_c object: expected 409 with no link — got $(pa_q "R.find((r) => r.step === 'dl-pre' && r.case === '$pa_c') ?? null")"
  fi
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
expect open '[200, 201].includes(f.issue) && f.viaApi === true && f.get === 200 && f.sameBytes === true && /^attachment/.test(f.disposition ?? "")' \
  "verified link issued, served by the API as an attachment, the same bytes"
expect nodl 'f.issue === 403' "refused by the confidentiality level (403)"
expect tampered 'f.issue >= 400 && f.get === undefined' "refused after the verifier quarantined it, no link"
expect missing 'f.issue >= 400 && f.get === undefined' "refused after the verifier quarantined it, no link"
expect reader-without-download-permission 'f.issue === 403' "refused for a user without document:download (403)"
expect expired-link 'f.beforeExpiry === 200 && f.beforeExpirySameBytes === true && f.afterExpiry === 404 && /expired/.test(f.afterExpiryPage ?? "")' \
  "served before expiry, refused after with the expired-link page"
expect edited-signature 'f.status === 404 && f.disposition === null' "refused by the API, no file"
expect edited-payload 'f.status === 404 && f.disposition === null' "refused by the API, no file"
expect unicode 'f.get === 200 && f.sameBytes === true && decodeURIComponent((/filename\*=UTF-8\x27\x27([^;]+)/.exec(f.disposition ?? "") ?? [])[1] ?? "") === "Résumé تقرير.txt" && /filename="[ -~]+"/.test(f.disposition ?? "")' \
  "the name arrives intact in filename*, with an ASCII fallback"
pa_finding "a verified link followed with no session at all answered $(d followed-without-a-session status): a link is a bearer link for its lifetime (60 s), re-checked against its person when followed"

# =================================================================================================
step "Phase A 6v — verified delivery: no file byte is sent before the whole file matches its record"
for pa_c in swapped vanished outage; do
  pa_client dl-issue "$pa_c" >/dev/null || pa_fail "could not issue the $pa_c link"
done
f() { pa_q "R.filter((r) => r.step === 'dl-follow' && r.case === '$1' && r.round === '${2:-1}').pop() ?? null"; }
fo() { pa_q "(R.filter((r) => r.step === 'dl-follow' && r.case === '$1' && r.round === '${2:-1}').pop() ?? {}).$3 ?? null"; }
audits() { printf "SELECT count(*) FROM audit_event WHERE action = '%s' AND subject_id = '%s';\n" "$1" "$2" | pa_sql; }

# Swapped after the link was issued: the same size, other bytes — what a HEAD at issue cannot see.
pa_swapped_key="$pa_tenant_prefix/$(key_of "$(dq swapped fileObjectId)")"
{ printf 'phase-a: these bytes replaced the stored ones\n'; head -c 4096 /dev/zero | tr '\0' 'x'; } \
  | head -c 4096 | pa_mc pipe "$pa_bucket/$pa_swapped_key" >/dev/null \
  || pa_fail "could not swap the object's bytes"
pa_client dl-follow swapped >/dev/null || pa_fail "could not follow the swapped link"
if pa_holds "$(printf "R.filter((r) => r.step === 'dl-follow' && r.case === 'swapped').pop()")" \
  "f.status === 409 && /^text\/html/.test(f.contentType ?? '') && f.disposition === null && !f.containsOriginal && !f.containsReplacement && f.bodyBytes < 2048 && /integrity check/.test(f.page ?? '')"; then
  pa_pass "swapped after issue (same size): 409 integrity page, 0 bytes of the file, original or replacement — $(f swapped)"
else
  pa_fail "swapped after issue: expected 409 and no file bytes — got $(f swapped)"
fi
pa_s_id="$(dq swapped fileObjectId)"
if [ "$(integrity "$pa_s_id")" = MISMATCH ] && [ "$(audits INTEGRITY_MISMATCH "$pa_s_id")" -ge 1 ] && [ "$(audits FILE_DOWNLOAD_SERVED "$pa_s_id")" = 0 ]; then
  pa_pass "the swapped file is quarantined MISMATCH with INTEGRITY_MISMATCH in the trail, and no FILE_DOWNLOAD_SERVED"
else
  pa_fail "swapped: integrity $(integrity "$pa_s_id"), INTEGRITY_MISMATCH $(audits INTEGRITY_MISMATCH "$pa_s_id"), served $(audits FILE_DOWNLOAD_SERVED "$pa_s_id")"
fi

# Deleted after the link was issued.
pa_mc rm "$pa_bucket/$pa_tenant_prefix/$(key_of "$(dq vanished fileObjectId)")" >/dev/null \
  || pa_fail "could not delete the vanished object"
pa_client dl-follow vanished >/dev/null || pa_fail "could not follow the vanished link"
pa_v_id="$(dq vanished fileObjectId)"
if pa_holds "R.filter((r) => r.step === 'dl-follow' && r.case === 'vanished').pop()" \
  "f.status === 409 && f.disposition === null && !f.containsOriginal && f.bodyBytes < 2048" \
  && [ "$(integrity "$pa_v_id")" = UNREADABLE ]; then
  pa_pass "deleted after issue: 409, no file bytes, quarantined UNREADABLE after a confirming HEAD"
else
  pa_fail "deleted after issue: got $(f vanished), integrity $(integrity "$pa_v_id")"
fi

# The store down when the link is followed: retryable, nothing quarantined, and served once it is back.
compose stop storage >/dev/null 2>&1 || pa_fail "could not stop the test MinIO"
pa_client dl-follow outage 1 >/dev/null || pa_fail "could not follow the outage link"
compose start storage >/dev/null 2>&1 || pa_fail "could not start the test MinIO again"
for _ in $(seq 1 60); do
  compose exec -T storage mc ready local >/dev/null 2>&1 && break
  sleep 2
done
pa_o_id="$(dq outage fileObjectId)"
if pa_holds "R.filter((r) => r.step === 'dl-follow' && r.case === 'outage' && r.round === '1').pop()" \
  "f.status === 503 && f.retryAfter === '30' && f.disposition === null && !f.containsOriginal" \
  && case "$(integrity "$pa_o_id")" in UNVERIFIED | VERIFIED) true ;; *) false ;; esac \
  && [ "$(audits INTEGRITY_MISMATCH "$pa_o_id")" = 0 ]; then
  pa_pass "store down: 503 with Retry-After, no file bytes, nothing quarantined — $(f outage 1)"
else
  pa_fail "store down: expected 503 and no quarantine — got $(f outage 1), integrity $(integrity "$pa_o_id")"
fi
pa_client dl-issue outage >/dev/null || pa_fail "could not issue the outage link again"
pa_client dl-follow outage 2 >/dev/null || pa_fail "could not follow the outage link again"
if pa_holds "R.filter((r) => r.step === 'dl-follow' && r.case === 'outage' && r.round === '2').pop()" \
  "f.status === 200 && f.sameBytes === true" && [ "$(audits FILE_DOWNLOAD_SERVED "$pa_o_id")" -ge 1 ]; then
  pa_pass "store back: the same file is served, byte for byte, and FILE_DOWNLOAD_SERVED is recorded"
else
  pa_fail "store back: got $(f outage 2), served audits $(audits FILE_DOWNLOAD_SERVED "$pa_o_id")"
fi

pa_open_id="$(dq open fileObjectId)"
pa_measure "trail for the open document: FILE_DOWNLOAD_ISSUED $(audits FILE_DOWNLOAD_ISSUED "$pa_open_id"), FILE_DOWNLOAD_SERVED $(audits FILE_DOWNLOAD_SERVED "$pa_open_id")"
[ "$(audits FILE_DOWNLOAD_SERVED "$pa_open_id")" -ge 1 ] \
  || pa_fail "no FILE_DOWNLOAD_SERVED for the open document's successful downloads"

# Nothing staged is left: no file in the directory, and no staging file still open in the API.
pa_staging_left() {
  docker exec "$(compose ps -q api)" sh -c '
    n=0; for fd in /proc/[0-9]*/fd/*; do
      case "$(readlink "$fd" 2>/dev/null)" in /var/lib/munaxa-docs/download-staging/*) n=$((n+1)) ;; esac
    done
    echo "$(ls -A /var/lib/munaxa-docs/download-staging | wc -l) $n"'
}
if [ "$(pa_staging_left)" = "0 0" ]; then
  pa_pass "download staging is empty: no file in the directory, none held open"
else
  pa_fail "download staging after step 6v: files, open = $(pa_staging_left)"
fi

# =================================================================================================
step "Phase A 6m — verified downloads measured: time to first byte, memory, staging disk"
# Bytes of staging files the API holds open, sampled inside its container every half second.
pa_staged_start() {
  : > "$pa_dir/staged.samples"
  docker exec "$(compose ps -q api)" rm -f /tmp/pa-staged-stop
  # Ends itself when the stop marker appears: killing `docker exec` would leave it running inside.
  docker exec "$(compose ps -q api)" sh -c '
    while [ ! -e /tmp/pa-staged-stop ]; do
      s=0
      for fd in /proc/[0-9]*/fd/*; do
        case "$(readlink "$fd" 2>/dev/null)" in
          /var/lib/munaxa-docs/download-staging/*) s=$((s + $(stat -L -c %s "$fd" 2>/dev/null || echo 0))) ;;
        esac
      done
      echo "$s"; sleep 0.5
    done' >> "$pa_dir/staged.samples" 2>/dev/null &
  pa_stager=$!
}
pa_staged_stop() {
  docker exec "$(compose ps -q api)" touch /tmp/pa-staged-stop || true
  wait "$pa_stager" 2>/dev/null || true
  sort -n "$pa_dir/staged.samples" | tail -1
}
pa_client dl-measure-setup || pa_fail "the measurement documents could not be set up"
pa_dl_measure() { # name concurrency label
  local peak staged
  pa_sample_start || pa_fail "could not sample the API's memory"
  pa_staged_start
  pa_client dl-measure "$1" "$2" >/dev/null || pa_fail "the $3 download measurement did not complete"
  peak="$(pa_sample_stop)"
  staged="$(pa_staged_stop)"
  local m="R.filter((r) => r.step === 'dl-measure' && r.case === '$1' && r.concurrency === $2).pop()"
  pa_measure "$3: $(pa_q "(($m).outcomes).map((o) => o.status).join(',')") | TTFB ms $(pa_q "(($m).outcomes).map((o) => o.ttfbMs).join(',')") | total ms $(pa_q "(($m).outcomes).map((o) => o.totalMs).join(',')") | wall $(pa_q "($m).wallMs") ms | API peak memory $(pa_mib "$peak") MiB (of which anonymous, i.e. not page cache: $(pa_mib "$(pa_anon_peak)") MiB) | peak staged $(pa_mib "${staged:-0}") MiB"
  if pa_holds "$m" "f.outcomes.every((o) => o.status === 200 && o.sameBytes === true)"; then
    pa_pass "$3: every download served the document's exact bytes"
  else
    pa_finding "$3: not every download was served — $(pa_q "(($m).outcomes).map((o) => [o.status, o.retryAfter, o.sameBytes])")"
  fi
}
pa_dl_measure m1 1 "1 MiB, one download"
pa_dl_measure m32 1 "32 MiB, one download"
pa_dl_measure m128 1 "128 MiB, one download"
pa_dl_measure m128 8 "128 MiB, 8 at once (DOWNLOAD_MAX_CONCURRENT=8)"
pa_dl_measure m128 12 "128 MiB, 12 at once (4 must wait for a slot)"
if [ "$(pa_api_state)" = "$pa_api_baseline_state" ]; then
  pa_pass "the API was not restarted or OOM-killed by the download measurements ($(pa_api_state))"
else
  pa_fail "the API restarted during the download measurements: $(pa_api_state) (baseline $pa_api_baseline_state)"
fi
if [ "$(pa_staging_left)" = "0 0" ]; then
  pa_pass "download staging is empty after the measurements"
else
  pa_fail "download staging after the measurements: files, open = $(pa_staging_left)"
fi

# =================================================================================================
step "Phase A 7 — completions interrupted by a killed API, a retry, and the orphan sweep"
# The orphan sweep runs only on a process that consumes the retention lane. For this step one test
# container does, with a grace of 240 s (the least configuration accepts at the default scan queue
# wait and timeout); the stack's own API and the 30 s-link API are stopped while it runs, so the
# sweep's settings are the ones under test. STORAGE_ORPHAN_SWEEP_DRY_RUN is tried first.
pa_client interrupt-prepare 4 || pa_fail "the interrupted uploads could not be prepared"
pa_client interrupt-complete &
pa_complete_pid=$!
# Kill the API while completions are under way: as soon as at least one has copied its bytes to the
# content key (each ~120 MiB scan then takes several seconds), so the kill interrupts real work.
pa_digests_list="$(pa_q "R.filter((r) => r.step === 'interrupt-prepare').map((r) => r.digest).join(' ')")"
for _ in $(seq 1 120); do
  pa_copied=0
  for pa_d in $pa_digests_list; do
    pa_exists "$pa_tenant_prefix/blobs/${pa_d:0:2}/${pa_d:2:2}/$pa_d" && pa_copied=$((pa_copied + 1))
  done
  [ "$pa_copied" -gt 0 ] && break
  sleep 0.5
done
pa_killed_at="$(date +%s)"
docker kill --signal KILL "$(compose ps -q api)" >/dev/null || pa_fail "could not kill the API"
wait "$pa_complete_pid" || true
# Docker may treat a kill it was asked for as a manual stop and not restart it; a supervisor would.
sleep 5
[ "$(docker inspect -f '{{.State.Running}}' "$(compose ps -aq api)")" = "true" ] || compose start api >/dev/null
pa_recovered="$(pa_wait_api)" || pa_fail "the API did not come back after being killed"
pa_measure "API live again ${pa_recovered:-?} s after being killed; $(pa_api_state)"

pa_interrupt_state() { # session → "state staged blob rows"
  local session="$1" digest
  digest="$(pa_q "R.find((r) => r.step === 'interrupt-prepare' && r.sessionId === '$session').digest")"
  local staged=absent blob=absent
  pa_exists "$pa_tenant_prefix/staging/$session" && staged=present
  pa_exists "$pa_tenant_prefix/blobs/${digest:0:2}/${digest:2:2}/$digest" && blob=present
  echo "$(printf "SELECT state FROM upload_session WHERE id = '%s';\n" "$session" | pa_sql) staged:$staged blob:$blob rows:$(printf "SELECT count(*) FROM file_object WHERE checksum_sha256 = '%s';\n" "$digest" | pa_sql)"
}
pa_sessions_7="$(pa_q "R.filter((r) => r.step === 'interrupt-prepare').map((r) => r.sessionId).join(' ')")"
pa_unfinished=0
for pa_session in $pa_sessions_7; do
  pa_st="$(pa_interrupt_state "$pa_session")"
  pa_finding "after the kill, upload $pa_session: $pa_st; client: $(pa_q "(() => { const r = R.find((x) => x.step === 'interrupt-complete' && x.sessionId === '$pa_session'); return r?.error ?? r?.status ?? null; })()")"
  case "$pa_st" in
    "OPEN staged:present"*) pa_unfinished=$((pa_unfinished + 1)) ;;
    "COMPLETED staged:absent"*) ;;
    *) pa_fail "upload $pa_session after the kill is neither OPEN with its staged bytes nor COMPLETED: $pa_st" ;;
  esac
done
pa_measure "$pa_unfinished of 4 completions were interrupted by the kill"

# The interrupted uploads that had not copied anything yet are completed again, as a person would:
# their staged bytes are still there. Those that had copied are left, as an abandoned upload is,
# so their content keys become the orphans the sweep must find.
pa_retry_ids=""
for pa_session in $pa_sessions_7; do
  case "$(pa_interrupt_state "$pa_session")" in
    "OPEN staged:present blob:absent"*) pa_retry_ids="$pa_retry_ids $pa_session" ;;
  esac
done
pa_measure "completing again: ${pa_retry_ids:- none}"
# shellcheck disable=SC2086 # one argument per session id
pa_client interrupt-retry $pa_retry_ids || pa_fail "the retries did not complete"
for pa_session in $(pa_q "R.filter((r) => r.step === 'interrupt-retry').map((r) => r.sessionId).join(' ')"); do
  pa_r="$(pa_q "R.filter((r) => r.step === 'interrupt-retry' && r.sessionId === '$pa_session').at(-1)")"
  case "$(pa_interrupt_state "$pa_session")" in
    "COMPLETED staged:absent blob:present rows:1")
      pa_pass "upload $pa_session completed after the kill (retry answered $(pa_q "R.filter((r) => r.step === 'interrupt-retry' && r.sessionId === '$pa_session').at(-1).status")): one row, its blob, no staged bytes" ;;
    *) pa_fail "upload $pa_session after its retry: $(pa_interrupt_state "$pa_session"); client $pa_r" ;;
  esac
done

# The other two are left, as an abandoned upload is: their links expire (300 s), the expiry sweep
# settles them, and whatever their interrupted completion copied has no row.
pa_wait_until=$((pa_killed_at + 310))
pa_now="$(date +%s)"
[ "$pa_now" -lt "$pa_wait_until" ] && { echo "waiting $((pa_wait_until - pa_now)) s for the abandoned uploads' links to expire"; sleep $((pa_wait_until - pa_now)); }
pa_schedule storage.sweep-upload-sessions >/dev/null || pa_fail "the upload sweep could not be fired"
sleep 10

# Only the sweeper consumes the retention lane from here.
docker rm -f phase-a-api-ttl >/dev/null 2>&1 || true
compose stop api >/dev/null
pa_sweeper() { # dry-run true|false
  docker rm -f phase-a-sweeper >/dev/null 2>&1 || true
  compose run -d --no-deps --name phase-a-sweeper -e STORAGE_ORPHAN_GRACE_SECONDS=240 \
    -e "STORAGE_ORPHAN_SWEEP_DRY_RUN=$1" api >/dev/null
  for _ in $(seq 1 60); do
    docker exec phase-a-sweeper node -e "fetch('http://127.0.0.1:3001/api/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
# One pass: fire the schedule, wait for the sweeper's log line for this tenant, print its JSON.
pa_sweep_lines() {
  { docker logs phase-a-sweeper 2>&1 || true; } | grep '"msg":"The orphan sweep' \
    | grep -F "\"tenantId\":\"$acme_id\"" || true
}
pa_sweep_pass() {
  local before
  before="$(pa_sweep_lines | wc -l)"
  pa_schedule storage.sweep-orphaned-objects >/dev/null || return 1
  for _ in $(seq 1 60); do
    if [ "$(pa_sweep_lines | wc -l)" -gt "$before" ]; then
      pa_sweep_lines | tail -1
      return 0
    fi
    sleep 2
  done
  return 1
}
pa_present_7() { # how many of the abandoned uploads' blobs, and all of step 7's staged bytes, are present
  local blobs=0 staged=0 session digest
  for session in $pa_sessions_7; do
    digest="$(pa_q "R.find((r) => r.step === 'interrupt-prepare' && r.sessionId === '$session').digest")"
    pa_exists "$pa_tenant_prefix/blobs/${digest:0:2}/${digest:2:2}/$digest" && blobs=$((blobs + 1))
    pa_exists "$pa_tenant_prefix/staging/$session" && staged=$((staged + 1))
  done
  echo "blobs:$blobs staged:$staged"
}
pa_digests_7="$(pa_q "R.filter((r) => r.step === 'interrupt-prepare').map((r) => \"'\" + r.digest + \"'\").join(',')")"
pa_before_sweep="$(pa_present_7)"
pa_measure "before the orphan sweep: step 7 objects $pa_before_sweep; file rows for step 7's bytes: $(printf "SELECT count(*) FROM file_object WHERE checksum_sha256 IN (%s);\n" "$pa_digests_7" | pa_sql)"
pa_sweeper true || pa_fail "the dry-run sweeper did not start"
pa_dry="$(pa_sweep_pass)" || pa_fail "the dry-run orphan sweep did not report"
pa_measure "dry run: $(printf '%s' "$pa_dry" | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify({dryRun:l.dryRun,graceSeconds:l.graceSeconds,staging:l.staging,blobs:l.blobs,orphanedKeys:l.orphanedKeys.length}))')"
pa_after_dry="$(pa_present_7)"
pa_sweeper false || pa_fail "the sweeper did not start"
pa_real="$(pa_sweep_pass)" || pa_fail "the orphan sweep did not report"
pa_measure "sweep: $(printf '%s' "$pa_real" | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify({dryRun:l.dryRun,staging:l.staging,blobs:l.blobs,orphanedKeys:l.orphanedKeys}))')"
pa_after_real="$(pa_present_7)"
pa_again="$(pa_sweep_pass)" || pa_fail "the second orphan sweep did not report"
pa_measure "second sweep: $(printf '%s' "$pa_again" | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify({staging:l.staging,blobs:l.blobs,orphaned:l.orphanedKeys.length}))')"
docker rm -f phase-a-sweeper >/dev/null 2>&1 || true
compose start api >/dev/null
pa_wait_api >/dev/null || pa_fail "the API did not come back after the sweep"

# Judged from the store and the database, not from the sweep's own report.
if printf '%s' "$pa_dry" | grep -q '"dryRun":true' && [ "$pa_after_dry" = "$pa_before_sweep" ]; then
  pa_pass "dry run: reported its findings and removed nothing (step 7 objects before and after: $pa_after_dry)"
else
  pa_fail "dry run: expected nothing removed — before $pa_before_sweep, after $pa_after_dry"
fi
pa_recorded_7="$(printf "SELECT count(DISTINCT checksum_sha256) FROM file_object WHERE checksum_sha256 IN (%s);\n" "$pa_digests_7" | pa_sql)"
pa_orphaned_7="$(printf '%s' "$pa_real" | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(l.orphanedKeys.filter((k) => k.startsWith("blobs/")).length)')"
if [ "$pa_after_real" = "blobs:$pa_recorded_7 staged:0" ] && [ "$pa_orphaned_7" -gt 0 ]; then
  pa_pass "orphan sweep: removed $pa_orphaned_7 orphaned content key(s); of step 7 only the $pa_recorded_7 uploads with a file row keep their blob, and no staged object is left"
else
  pa_fail "orphan sweep: expected blobs:$pa_recorded_7 staged:0 with at least one orphan removed — got $pa_after_real, $pa_orphaned_7 orphaned content keys"
fi
if printf '%s' "$pa_again" | grep -q '"orphanedKeys":\[\]'; then
  pa_pass "a second orphan sweep found nothing to remove"
else
  pa_fail "a second orphan sweep still found orphans: $pa_again"
fi
if ! pa_exists "$pa_tenant_prefix/staging/$pa_sdp_session"; then
  pa_pass "step 3's staged object left by the sweep-during-put transfer is gone"
else
  pa_fail "step 3's staged object left by the sweep-during-put transfer is still there"
fi
# Nothing legitimate was touched: every file row's object is still in the store.
pa_missing_rows=0
for pa_key in $(printf "SELECT storage_key FROM file_object WHERE deleted_at IS NULL;\n" | pa_sql); do
  pa_exists "$pa_tenant_prefix/$pa_key" || pa_missing_rows=$((pa_missing_rows + 1))
done
pa_quarantined="$(printf "SELECT count(*) FROM file_object WHERE deleted_at IS NULL AND integrity_status IN ('UNREADABLE');\n" | pa_sql)"
# Steps 6 and 6v deliberately deleted two objects (their rows are UNREADABLE); every other row's bytes
# must be there.
if [ "$pa_missing_rows" = "$pa_quarantined" ]; then
  pa_pass "every live file row's object is still in the store (bar the $pa_quarantined steps 6 and 6v deleted on purpose)"
else
  pa_fail "$pa_missing_rows live file rows have no object, $pa_quarantined of them deleted on purpose"
fi

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
