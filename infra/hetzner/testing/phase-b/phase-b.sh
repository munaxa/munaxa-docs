# shellcheck shell=bash
# shellcheck disable=SC2154 # here, run_prefix, files and the helpers are run-stack-test.sh's own
# Phase B of the Hetzner hosting evaluation (ADR-0026 §10, docs/reports/hetzner-phase-b-browser-test-plan.md):
# downloads and uploads through the real web interface, in Chromium, against the local test MinIO.
# SOURCED by run-stack-test.sh (EXTRA_CHECKS), after its standard checks, like phase-a.sh:
#
#   EXTRA_CHECKS=infra/hetzner/testing/phase-b/phase-b.sh PHASE_B_OUT=/some/empty/dir \
#     DOCS_API_IMAGE=… DOCS_WEB_IMAGE=… DOCS_ANTIVIRUS_IMAGE=… infra/hetzner/testing/run-stack-test.sh
#
# Local only: it refuses to run against EXTERNAL_STORAGE_ENV. Test-only settings, none a product
# default: the stack's API is recreated with DOWNLOAD_LINK_TTL_SECONDS=30 (compose.phase-b.yaml) for
# the expiry cases, and the test MinIO is stopped and started once for the outage case.
#
# The browser writes RESULT lines; each expectation is judged here from them and from the database and
# the store. Lines read PASS, FAIL, FINDING (recorded, not judged) and MEASURE, as in Phase A.

if [ -n "${EXTERNAL_STORAGE_ENV:-}" ]; then
  echo "FAIL  Phase B runs against the local test MinIO only; unset EXTERNAL_STORAGE_ENV"
  exit 1
fi
: "${PHASE_B_OUT:?set PHASE_B_OUT to an empty directory for screenshots and downloaded files}"
export PHASE_B_OUT

pb_failures=0
pb_out="$PHASE_B_OUT/results.log"
: > "$pb_out"
pb_bucket="t/munaxa-docs-test"
pb_tenant_prefix="$run_prefix/tenants/acme"
files+=(-f "$here/phase-b/compose.phase-b.yaml")

pb_pass() { echo "PASS  $*"; }
pb_fail() {
  echo "FAIL  $*"
  pb_failures=$((pb_failures + 1))
}
pb_finding() { echo "FINDING  $*"; }
pb_measure() { echo "MEASURE  $*"; }

extra_cleanup() {
  compose --profile test rm -fsv browser api-small-staging api-tiny-disk api-disk-fills >/dev/null 2>&1 || true
  if [ -n "${pb_mem_sampler:-}" ]; then kill "$pb_mem_sampler" 2>/dev/null || true; fi
}

# One browser case (or a set of them): browser.mjs in the `browser` service.
pb_browser() {
  compose --profile test run --rm --no-deps -T browser node browser.mjs "$@" 2>&1 | tee -a "$pb_out"
  return "${PIPESTATUS[0]}"
}

# A JavaScript expression over the RESULT lines, as phase-a.sh's pa_q.
pb_q() {
  node -e '
    const R = require("fs").readFileSync(process.argv[1], "utf8").split("\n")
      .filter((l) => l.startsWith("RESULT ")).map((l) => JSON.parse(l.slice(7)));
    const v = ('"$1"');
    console.log(typeof v === "string" ? v : JSON.stringify(v));
  ' "$pb_out"
}
pb_case() { pb_q "R.filter((r) => r.case === '$1').pop() ?? null"; }
# expect <case> <JS condition over its facts f> <description>
pb_expect() {
  if [ "$(pb_q "((f) => Boolean($2))(R.filter((r) => r.case === '$1').pop() ?? {})")" = "true" ]; then
    pb_pass "$1: $3 — $(pb_case "$1")"
  else
    pb_fail "$1: expected $3 — got $(pb_case "$1")"
  fi
}

# shellcheck disable=SC2016 # the variables are the storage container's own
pb_mc() {
  compose exec -T storage sh -c \
    'export MC_HOST_t="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@127.0.0.1:9000"; mc "$@"' sh "$@"
}
pb_sql() { tenant_sql; }
pb_key() { printf "SELECT storage_key FROM file_object WHERE id = '%s';\n" "$1" | pb_sql; }
pb_integrity() { printf "SELECT integrity_status FROM file_object WHERE id = '%s';\n" "$1" | pb_sql; }
pb_audits() { printf "SELECT count(*) FROM audit_event WHERE action = '%s' AND subject_id = '%s';\n" "$1" "$2" | pb_sql; }
pb_staging_left() {
  docker exec "$(compose ps -q api)" sh -c '
    n=0; for fd in /proc/[0-9]*/fd/*; do
      case "$(readlink "$fd" 2>/dev/null)" in /var/lib/munaxa-docs/download-staging/*) n=$((n+1)) ;; esac
    done
    echo "$(ls -A /var/lib/munaxa-docs/download-staging | wc -l) $n"'
}

# =================================================================================================
step "Phase B — the stack's API with a 30 s download link lifetime (test only)"
compose up -d --no-deps api >/dev/null || pb_fail "could not recreate the API with the Phase B overlay"
for _ in $(seq 1 90); do
  docker exec "$(compose ps -q api)" node -e \
    "fetch('http://127.0.0.1:3001/api/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
    >/dev/null 2>&1 && break
  sleep 2
done
if [ "$(docker exec "$(compose ps -q api)" printenv DOWNLOAD_LINK_TTL_SECONDS)" = 30 ]; then
  pb_pass "the stack's API now issues 30 s download links (compose.phase-b.yaml; no product default changed)"
else
  pb_fail "the API did not take DOWNLOAD_LINK_TTL_SECONDS=30"
fi

# =================================================================================================
step "Phase B 1 — set-up through the API: a library, levels, a viewer without download, documents"
pb_browser setup || pb_fail "the set-up did not complete"

step "Phase B 2 — upload through the interface, then download it (B-8, B-1, B-2)"
pb_browser upload-and-download || pb_fail "the upload-and-download cases did not complete"
# Judged on its own and never normalised: at the default 1280×720 window the dialog's submit button
# lies below the window, in a dialog nothing can scroll (a product finding, not a harness limit).
pb_expect ui-upload-720 'f.submitInViewport === true' \
  "the Add documents dialog's submit button is reachable in a 1280×720 window"
pb_expect ui-upload 'f.filed === true && f.scanStatus === "CLEAN" && f.recordedDigest === f.chosenDigest' \
  "filed through the upload dialog (1920×1080 window), scanned CLEAN, the recorded digest is the browser's own"
for pb_c in download-text download-pdf download-binary download-large download-ui-upload; do
  pb_expect "$pb_c" 'f.downloadEvent === true && f.sameBytes === true && f.navigatedAway === false' \
    "a download event, and the saved file is byte for byte the document"
done
pb_expect download-library-row 'f.downloadEvent === true && f.sameBytes === true' "the library row action downloads the same bytes"
pb_expect download-revision 'f.downloadEvent === true && f.sameBytes === true' "the revision panel downloads that revision's bytes"

step "Phase B 3 — Arabic and accented file names (B-3)"
pb_browser filenames || pb_fail "the file-name cases did not complete"
for pb_c in name-arabic name-accented name-mixed name-quotes; do
  pb_expect "$pb_c" 'f.sameBytes === true && f.suggestedFilename === f.expectedFilename' \
    "Chromium saves it under its own name"
done

step "Phase B 4 — attachment and inline (B-4)"
pb_browser disposition || pb_fail "the disposition cases did not complete"
pb_expect attachment 'f.downloadEvent === true && /^attachment/.test(f.disposition ?? "")' "an attachment is saved, not rendered"
pb_expect inline-text 'f.downloadEvent === false && f.rendered === true && /^inline/.test(f.disposition ?? "")' "plain text renders in place"
pb_expect preview-pdf 'f.canvasPainted === true && f.downloadEvent === false' "a PDF preview renders in the viewer"
pb_expect inline-html 'f.scriptRan === false' "an HTML file never runs as a page"

step "Phase B 5 — expired and edited links (B-5, B-6f)"
pb_browser links || pb_fail "the link cases did not complete"
pb_expect expired-link 'f.beforeExpiry === "download" && f.afterExpiryStatus === 404 && f.afterExpiryDownload === false && /expired/.test(f.afterExpiryText ?? "")' \
  "served within 30 s, an expired-link page after, no file"
pb_expect edited-link 'f.status === 404 && f.downloadEvent === false' "an edited token is refused, no file"
pb_expect followed-without-session 'f.status !== undefined' "recorded"
pb_finding "a link followed in a fresh browser context with no session: $(pb_q "(R.filter((r) => r.case === 'followed-without-session').pop() ?? {}).outcome ?? null") (a link is a bearer link for its lifetime, re-checked against its person)"

step "Phase B 6 — who may download (B-6)"
pb_browser access || pb_fail "the access cases did not complete"
pb_expect viewer-without-download 'f.downloadEvent === false && (f.buttonAbsent === true || /permission/.test(f.message ?? ""))' "no download for a viewer without document:download"
pb_expect confidential 'f.downloadEvent === false && /permission/.test(f.message ?? "")' "no download where the confidentiality level forbids it"
pb_expect other-tenant 'f.downloadEvent === false && f.notFound === true' \
  "a document id this tenant does not have is not found (tenants are separate databases; a real second-tenant document was not created)"
pb_expect signed-out 'f.downloadEvent === false && f.atSignIn === true' "signed out: back at sign-in, no file"

step "Phase B 7 — tampered, missing, quarantined, unavailable: no file bytes (B-7)"
pb_browser integrity-setup || pb_fail "the integrity set-up did not complete"
pb_doc() { pb_q "(R.filter((r) => r.case === 'integrity-setup').pop() ?? {}).documents?.$1 ?? ''"; }
# Changed in the store after each link is issued, through the browser's own download action, and
# followed by the same signed-in browser once the change is made (the links live 30 s).
rm -f "$PHASE_B_OUT/issued.flag" "$PHASE_B_OUT/tampered.flag"
pb_browser integrity-issue &
pb_issue_pid=$!
for _ in $(seq 1 6000); do [ -f "$PHASE_B_OUT/issued.flag" ] && break; sleep 0.1; done
[ -f "$PHASE_B_OUT/issued.flag" ] || pb_fail "the integrity links were not issued"
{ printf 'phase-b: these bytes replaced the stored ones\n'; head -c 4096 /dev/zero | tr '\0' 'x'; } \
  | head -c 4096 | pb_mc pipe "$pb_bucket/$pb_tenant_prefix/$(pb_key "$(pb_doc swapped)")" >/dev/null \
  || pb_fail "could not swap the object's bytes"
pb_mc rm "$pb_bucket/$pb_tenant_prefix/$(pb_key "$(pb_doc vanished)")" >/dev/null \
  || pb_fail "could not delete the vanished object"
printf "UPDATE file_object SET integrity_status = 'MISMATCH' WHERE id = '%s';\n" "$(pb_doc quarantined)" | pb_sql >/dev/null
touch "$PHASE_B_OUT/tampered.flag"
wait "$pb_issue_pid" || pb_fail "the integrity cases did not complete"
compose stop storage >/dev/null 2>&1 || pb_fail "could not stop the test MinIO"
pb_browser integrity-follow unavailable || pb_fail "the unavailable case did not complete"
compose start storage >/dev/null 2>&1 || pb_fail "could not start the test MinIO again"
for _ in $(seq 1 60); do compose exec -T storage mc ready local >/dev/null 2>&1 && break; sleep 2; done
for pb_c in swapped vanished quarantined; do
  pb_expect "integrity-$pb_c" 'f.tamperedFirst === true && f.linkAgeMs < 30000' \
    "followed after the store was changed, inside the link's 30 s lifetime"
  pb_expect "integrity-$pb_c" 'f.downloadEvent === false && f.savedBytes === 0 && /integrity check/.test(f.message ?? "")' \
    "the integrity message, and no file saved"
done
pb_expect integrity-unavailable 'f.downloadEvent === false && f.savedBytes === 0' "store down: no file saved"
pb_expect integrity-unavailable '/temporarily|busy|try again/i.test(f.message ?? "")' \
  "store down: the person is told to try again (the API's sentence reaches the interface)"
pb_is() { # actual expected pass-message fail-message
  if [ "$1" = "$2" ]; then pb_pass "$3"; else pb_fail "$4 (got $1)"; fi
}
pb_is "$(pb_integrity "$(pb_doc swapped)")" MISMATCH "the swapped file is quarantined MISMATCH" "the swapped file is not MISMATCH"
pb_is "$(pb_integrity "$(pb_doc vanished)")" UNREADABLE "the vanished file is quarantined UNREADABLE" "the vanished file is not UNREADABLE"
pb_is "$(pb_integrity "$(pb_doc unavailable)")" UNVERIFIED "the file behind the outage is not quarantined" "the file behind the outage changed status"
pb_browser integrity-follow unavailable-again || pb_fail "the retry after the outage did not complete"
pb_expect integrity-unavailable-again 'f.downloadEvent === true && f.sameBytes === true' "with the store back, the same action saves the exact file"

step "Phase B 8 — the Arabic interface (B-9) and the exports (B-10)"
pb_browser arabic exports || pb_fail "the Arabic and export cases did not complete"
pb_expect arabic-download 'f.downloadEvent === true && f.sameBytes === true && f.dir === "rtl"' "an Arabic, right-to-left interface downloads the same bytes"
pb_expect arabic-integrity 'f.downloadEvent === false && f.savedBytes === 0' "a quarantined file, in Arabic: no file saved"
pb_expect arabic-integrity '/سلامة/.test(f.warnedBeforeClick ?? "")' \
  "a quarantined file, in Arabic: the page says it failed its integrity check before anyone clicks"
pb_expect arabic-integrity 'f.downloadButtonEnabled === false' \
  "a quarantined file, in Arabic: no enabled Download button"
pb_expect arabic-integrity 'f.clicked === false || /سلامة/.test(f.message ?? "")' \
  "a quarantined file, in Arabic: a refusal, if one is reached, names the integrity check"
pb_expect report-export 'f.downloadEvent === true && f.matchesStore === true && /^\/api\/v1\/downloads/.test(f.link ?? "") && f.tabOpened !== true' \
  "a report export saves the verified file through /api/v1/downloads, with no popup (export design §3.2)"
pb_expect audit-export 'f.downloadEvent === true && f.matchesStore === true && /^\/api\/v1\/downloads/.test(f.link ?? "") && f.tabOpened !== true' \
  "an audit artefact saves the verified file through /api/v1/downloads, one click per artefact, with no popup (export design §3.3)"

# =================================================================================================
step "Phase B 9 — verified downloads at and past their resource limits (no limit raised)"
pb_limits() {
  compose --profile test run --rm --no-deps -T browser node limits.mjs "$@" 2>&1 | tee -a "$pb_out"
  return "${PIPESTATUS[0]}"
}
pb_cid() { compose ps -q "$1"; }
pb_cgroup() {
  local id dir
  id="$(docker inspect -f '{{.Id}}' "$1")"
  for dir in "/sys/fs/cgroup/memory/docker/$id" "/sys/fs/cgroup/system.slice/docker-$id.scope" \
    "/sys/fs/cgroup/docker/$id"; do
    [ -d "$dir" ] && { echo "$dir"; return 0; }
  done
  return 1
}
# Samples one API container every half second: cgroup usage, its anonymous memory, and the bytes of
# staging files it holds open (read inside it; the loop ends itself on a marker in its /tmp).
pb_sample_start() { # container
  local dir container="$1"
  dir="$(pb_cgroup "$container")" || { echo "no cgroup for $container"; return 1; }
  : > "$PHASE_B_OUT/mem.samples"
  : > "$PHASE_B_OUT/staged.samples"
  (while :; do
    if [ -f "$dir/memory.usage_in_bytes" ]; then u="$(cat "$dir/memory.usage_in_bytes")"; else u="$(cat "$dir/memory.current")"; fi
    a="$(awk '$1 == "anon" || $1 == "rss" {print $2; exit}' "$dir/memory.stat")"
    echo "$u ${a:-0}" >> "$PHASE_B_OUT/mem.samples"
    sleep 0.5
  done) &
  pb_mem_sampler=$!
  docker exec "$container" rm -f /tmp/pb-staged-stop
  docker exec "$container" sh -c '
    while [ ! -e /tmp/pb-staged-stop ]; do
      s=0
      for fd in /proc/[0-9]*/fd/*; do
        case "$(readlink "$fd" 2>/dev/null)" in
          /var/lib/munaxa-docs/download-staging/*) s=$((s + $(stat -L -c %s "$fd" 2>/dev/null || echo 0))) ;;
        esac
      done
      echo "$s"; sleep 0.5
    done' >> "$PHASE_B_OUT/staged.samples" 2>/dev/null &
  pb_staged_sampler=$!
  pb_sampled="$container"
}
pb_sample_stop() { # prints: peak-usage-MiB peak-anonymous-MiB peak-staged-MiB
  kill "$pb_mem_sampler" 2>/dev/null || true
  wait "$pb_mem_sampler" 2>/dev/null || true
  docker exec "$pb_sampled" touch /tmp/pb-staged-stop 2>/dev/null || true
  wait "$pb_staged_sampler" 2>/dev/null || true
  echo "$(sort -n -k1 "$PHASE_B_OUT/mem.samples" | tail -1 | awk '{print int($1/1048576)}') \
$(sort -n -k2 "$PHASE_B_OUT/mem.samples" | tail -1 | awk '{print int($2/1048576)}') \
$(sort -n "$PHASE_B_OUT/staged.samples" | tail -1 | awk '{print int($1/1048576)}')"
}
pb_restarts() { docker inspect -f '{{.RestartCount}} {{.State.OOMKilled}} {{.State.Running}} {{.State.StartedAt}}' "$1"; }
pb_left_in() { # container: files in the staging directory, staging files held open, tmpfs bytes used
  docker exec "$1" sh -c '
    n=0; for fd in /proc/[0-9]*/fd/*; do
      case "$(readlink "$fd" 2>/dev/null)" in /var/lib/munaxa-docs/download-staging/*) n=$((n+1)) ;; esac
    done
    echo "$(ls -A /var/lib/munaxa-docs/download-staging | wc -l) $n $(df -P /var/lib/munaxa-docs/download-staging | awk "NR==2 {print \$3}")"'
}
pb_limit_case() { pb_q "R.filter((r) => r.case === '$1').pop() ?? null"; }
pb_wait_live() {
  for _ in $(seq 1 90); do
    docker exec "$(pb_cid "$1")" node -e \
      "fetch('http://127.0.0.1:3001/api/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
      >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

pb_limits setup || pb_fail "the 128 MiB and 48 MiB limits documents could not be set up"
pb_limits_file="$(pb_q "(R.filter((r) => r.case === 'limits-setup').pop() ?? {}).fileObjectId ?? ''")"
pb_small_file="$(pb_q "(R.filter((r) => r.case === 'limits-setup').pop() ?? {}).smallFileObjectId ?? ''")"
pb_api="$(pb_cid api)"
pb_api_state="$(pb_restarts "$pb_api")"
pb_served_before="$(pb_audits FILE_DOWNLOAD_SERVED "$pb_limits_file")"

# 9a. Within the limits: 8 at once (DOWNLOAD_MAX_CONCURRENT=8, 1 GiB of the 2 GiB staging budget).
pb_sample_start "$pb_api"
pb_limits overflow api 8 within-limits >/dev/null || pb_fail "the within-limits downloads did not complete"
read -r pb_u pb_a pb_s <<< "$(pb_sample_stop)"
pb_measure "within limits (8 × 128 MiB at once): $(pb_limit_case within-limits) | API cgroup peak ${pb_u} MiB, anonymous ${pb_a} MiB, staged ${pb_s} MiB"
pb_expect within-limits 'f.served === 8 && f.corrupt === 0' "all 8 served byte for byte"

# 9b. Past the concurrency limit: 40 at once. Each must be the exact file or a 503 with Retry-After.
pb_sample_start "$pb_api"
pb_limits overflow api 40 over-concurrency >/dev/null || pb_fail "the over-concurrency downloads did not complete"
read -r pb_u pb_a pb_s <<< "$(pb_sample_stop)"
pb_measure "past the concurrency limit (40 × 128 MiB at once): $(pb_limit_case over-concurrency) | API cgroup peak ${pb_u} MiB, anonymous ${pb_a} MiB, staged ${pb_s} MiB"
pb_expect over-concurrency 'f.corrupt === 0 && f.other.length === 0 && f.served + f.busy === 40' \
  "every answer is the exact file or a retryable 503 (Retry-After: 30); none partial, none other"
if [ "${pb_s:-0}" -le 1024 ]; then
  pb_pass "never more than 8 × 128 MiB staged at once (peak ${pb_s} MiB)"
else
  pb_fail "staged ${pb_s} MiB at once, more than DOWNLOAD_MAX_CONCURRENT allows"
fi

# 9c. Past the staging budget: a test-only API whose budget is 256 MiB (two 128 MiB files).
compose --profile test up -d --no-deps api-small-staging >/dev/null 2>&1 || pb_fail "could not start api-small-staging"
pb_wait_live api-small-staging || pb_fail "api-small-staging did not become live"
pb_small="$(pb_cid api-small-staging)"
pb_sample_start "$pb_small"
pb_limits overflow api-small-staging 24 over-staging >/dev/null || pb_fail "the over-staging downloads did not complete"
read -r pb_u pb_a pb_s <<< "$(pb_sample_stop)"
pb_measure "past the staging budget (24 × 128 MiB, budget 256 MiB): $(pb_limit_case over-staging) | cgroup peak ${pb_u} MiB, anonymous ${pb_a} MiB, staged ${pb_s} MiB"
pb_expect over-staging 'f.corrupt === 0 && f.other.length === 0 && f.served + f.busy === 24' \
  "every answer is the exact file or a retryable 503"
if [ "${pb_s:-0}" -le 256 ]; then
  pb_pass "never more than the 256 MiB staging budget staged (peak ${pb_s} MiB)"
else
  pb_fail "staged ${pb_s} MiB, more than the 256 MiB budget"
fi

# 9d. Too little staging disk, with the product's free-space reserve: refused before a byte is staged.
compose --profile test up -d --no-deps api-tiny-disk >/dev/null 2>&1 || pb_fail "could not start api-tiny-disk"
pb_wait_live api-tiny-disk || pb_fail "api-tiny-disk did not become live"
pb_limits overflow api-tiny-disk 1 disk-reserve >/dev/null || pb_fail "the disk-reserve download did not complete"
pb_expect disk-reserve 'f.busy === 1 && f.served === 0' "refused 503 with Retry-After, no file bytes"
pb_measure "api-tiny-disk staging after: files, open, KiB used = $(pb_left_in "$(pb_cid api-tiny-disk)")"

# 9e. The disk fills part-way: reserve 0, and two 48 MiB downloads at once on the 64 MiB disk. Each
# passes the free-space check alone; together they cannot both be staged — what staging failure
# (ENOSPC) answers.
compose --profile test up -d --no-deps api-disk-fills >/dev/null 2>&1 || pb_fail "could not start api-disk-fills"
pb_wait_live api-disk-fills || pb_fail "api-disk-fills did not become live"
pb_fills="$(pb_cid api-disk-fills)"
pb_fills_state="$(pb_restarts "$pb_fills")"
pb_limits overflow api-disk-fills 2 disk-fills small >/dev/null || pb_fail "the disk-fills downloads did not complete"
pb_measure "disk fills part-way: $(pb_limit_case disk-fills); staging after: files, open, KiB used = $(pb_left_in "$pb_fills"); container $(pb_restarts "$pb_fills") (before: $pb_fills_state)"
pb_expect disk-fills 'f.corrupt === 0 && f.statuses.every((s) => s === 200 || typeof s === "number")' \
  "the disk filling part-way delivers no partial or unverified file"
pb_expect disk-fills 'f.other.length === 0 && f.served + f.busy === 2' \
  "every answer is the exact file or a retryable 503 (Retry-After) — not an error page"
if [ "$(pb_restarts "$pb_fills")" = "$pb_fills_state" ] && [ "$(pb_left_in "$pb_fills" | awk '{print $1, $2, $3}')" = "0 0 0" ]; then
  pb_pass "disk fills part-way: the API kept running and freed the staging disk"
else
  pb_fail "disk fills part-way: container $(pb_restarts "$pb_fills"), staging $(pb_left_in "$pb_fills")"
fi

# 9f. Downloads left part-way: nothing stays staged, and nothing is recorded as served.
pb_limits interrupt staging >/dev/null || pb_fail "the interrupted-while-verifying case did not complete"
sleep 3
pb_measure "left while verifying: $(pb_limit_case interrupt-staging); staging after: files, open = $(pb_staging_left)"
pb_limits interrupt sending >/dev/null || pb_fail "the interrupted-while-sending case did not complete"
sleep 3
pb_measure "left while sending: $(pb_limit_case interrupt-sending); staging after: files, open = $(pb_staging_left)"
if [ "$(pb_staging_left)" = "0 0" ]; then
  pb_pass "downloads left part-way leave no staging file behind"
else
  pb_fail "downloads left part-way left staging: $(pb_staging_left)"
fi

# 9g. The store killed while a download is being verified: retryable, nothing quarantined.
rm -f "$PHASE_B_OUT/following.flag"
pb_limits follow-one api store-killed >/dev/null &
pb_follow_pid=$!
for _ in $(seq 1 200); do [ -f "$PHASE_B_OUT/following.flag" ] && break; sleep 0.1; done
sleep 0.4
compose kill storage >/dev/null 2>&1 || pb_fail "could not kill the test MinIO"
wait "$pb_follow_pid" || pb_fail "the store-killed download did not complete"
compose start storage >/dev/null 2>&1 || pb_fail "could not start the test MinIO again"
for _ in $(seq 1 60); do compose exec -T storage mc ready local >/dev/null 2>&1 && break; sleep 2; done
pb_expect store-killed 'f.status === 503 && f.retryAfter === "30" && f.disposition === null' "a store lost mid-verification answers a retryable 503, with no file bytes"

# 9h. After all of it: the stack's API was never restarted, the limits file never quarantined, every
# partial attempt unrecorded as served, and staging empty.
if [ "$(pb_restarts "$pb_api")" = "$pb_api_state" ]; then
  pb_pass "the stack's API was not restarted or OOM-killed by any resource-limit case ($(pb_restarts "$pb_api"))"
else
  pb_fail "the stack's API restarted: $(pb_restarts "$pb_api") (before: $pb_api_state)"
fi
case "$(pb_integrity "$pb_limits_file")" in
  UNVERIFIED | VERIFIED) pb_pass "the limits file was never quarantined ($(pb_integrity "$pb_limits_file"); INTEGRITY_MISMATCH rows: $(pb_audits INTEGRITY_MISMATCH "$pb_limits_file"))" ;;
  *) pb_fail "the limits file was quarantined: $(pb_integrity "$pb_limits_file")" ;;
esac
case "$(pb_integrity "$pb_small_file")" in
  UNVERIFIED | VERIFIED) pb_pass "the 48 MiB file was never quarantined by the disk filling ($(pb_integrity "$pb_small_file"))" ;;
  *) pb_fail "the 48 MiB file was quarantined: $(pb_integrity "$pb_small_file")" ;;
esac
pb_served_after="$(pb_audits FILE_DOWNLOAD_SERVED "$pb_limits_file")"
pb_served_expected=$((pb_served_before + $(pb_q "['within-limits','over-concurrency','over-staging'].map((c) => (R.filter((r) => r.case === c).pop() ?? {}).served ?? 0).reduce((a, b) => a + b, 0)")))
pb_measure "FILE_DOWNLOAD_SERVED for the limits file: $pb_served_after (served in full by 9a–9c: $((pb_served_expected - pb_served_before)))"
if [ "$pb_served_after" = "$pb_served_expected" ]; then
  pb_pass "FILE_DOWNLOAD_SERVED counts exactly the downloads served in full — none for a refused, interrupted or failed one"
else
  pb_fail "FILE_DOWNLOAD_SERVED $pb_served_after, expected $pb_served_expected"
fi
if [ "$(pb_staging_left)" = "0 0" ]; then
  pb_pass "the stack's API staging is empty after the resource-limit cases"
else
  pb_fail "the stack's API staging after the resource-limit cases: $(pb_staging_left)"
fi
compose --profile test rm -fsv api-small-staging api-tiny-disk api-disk-fills >/dev/null 2>&1 || true

# =================================================================================================
step "Phase B — the trail and what is left"
pb_measure "FILE_DOWNLOAD_SERVED rows: $(printf "SELECT count(*) FROM audit_event WHERE action = 'FILE_DOWNLOAD_SERVED';\n" | pb_sql); FILE_DOWNLOAD_ISSUED rows: $(printf "SELECT count(*) FROM audit_event WHERE action = 'FILE_DOWNLOAD_ISSUED';\n" | pb_sql)"
for pb_c in swapped vanished quarantined; do
  pb_is "$(pb_audits FILE_DOWNLOAD_SERVED "$(pb_doc "$pb_c")")" 0 \
    "no FILE_DOWNLOAD_SERVED for the $pb_c file" "FILE_DOWNLOAD_SERVED recorded for the $pb_c file"
done
if [ "$(pb_staging_left)" = "0 0" ]; then
  pb_pass "download staging is empty: no file in the directory, none held open"
else
  pb_fail "download staging after Phase B: files, open = $(pb_staging_left)"
fi
pb_browser console || true
pb_finding "browser console errors and CSP violations: $(pb_q "(R.filter((r) => r.case === 'console').pop() ?? {}).errors ?? null")"

# Fails the whole run at its end, after the standard checks that follow still run.
# shellcheck disable=SC2034 # read by run-stack-test.sh
extra_failures=$pb_failures
