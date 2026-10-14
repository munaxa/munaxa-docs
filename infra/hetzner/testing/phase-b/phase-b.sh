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
  compose --profile test rm -fsv browser >/dev/null 2>&1 || true
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
pb_expect ui-upload 'f.filed === true && f.scanStatus === "CLEAN" && f.recordedDigest === f.chosenDigest' \
  "filed through the upload dialog, scanned CLEAN, the recorded digest is the browser's own"
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
pb_expect other-tenant 'f.downloadEvent === false && f.notFound === true' "another tenant's document is not found"
pb_expect signed-out 'f.downloadEvent === false && f.atSignIn === true' "signed out: back at sign-in, no file"

step "Phase B 7 — tampered, missing, quarantined, unavailable: no file bytes (B-7)"
pb_browser integrity-setup || pb_fail "the integrity set-up did not complete"
pb_doc() { pb_q "(R.filter((r) => r.case === 'integrity-setup').pop() ?? {}).documents?.$1 ?? ''"; }
# Changed in the store after each link is issued, through the browser's own download action.
pb_browser integrity-issue || pb_fail "the integrity links could not be issued"
{ printf 'phase-b: these bytes replaced the stored ones\n'; head -c 4096 /dev/zero | tr '\0' 'x'; } \
  | head -c 4096 | pb_mc pipe "$pb_bucket/$pb_tenant_prefix/$(pb_key "$(pb_doc swapped)")" >/dev/null \
  || pb_fail "could not swap the object's bytes"
pb_mc rm "$pb_bucket/$pb_tenant_prefix/$(pb_key "$(pb_doc vanished)")" >/dev/null \
  || pb_fail "could not delete the vanished object"
printf "UPDATE file_object SET integrity_status = 'MISMATCH' WHERE id = '%s';\n" "$(pb_doc quarantined)" | pb_sql >/dev/null
pb_browser integrity-follow swapped vanished quarantined || pb_fail "the integrity cases did not complete"
compose stop storage >/dev/null 2>&1 || pb_fail "could not stop the test MinIO"
pb_browser integrity-follow unavailable || pb_fail "the unavailable case did not complete"
compose start storage >/dev/null 2>&1 || pb_fail "could not start the test MinIO again"
for _ in $(seq 1 60); do compose exec -T storage mc ready local >/dev/null 2>&1 && break; sleep 2; done
for pb_c in swapped vanished quarantined; do
  pb_expect "integrity-$pb_c" 'f.downloadEvent === false && f.savedBytes === 0 && /integrity check/.test(f.message ?? "")' \
    "the integrity message, and no file saved"
done
pb_expect integrity-unavailable 'f.downloadEvent === false && f.savedBytes === 0 && /temporarily|busy|try again/i.test(f.message ?? "")' \
  "a try-again message, and no file saved"
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
pb_expect arabic-integrity 'f.downloadEvent === false && f.message !== null' "the integrity refusal, in Arabic (wording for native review)"
pb_finding "Arabic integrity message as shown: $(pb_q "(R.filter((r) => r.case === 'arabic-integrity').pop() ?? {}).message ?? null")"
pb_expect report-export 'f.downloadEvent === true && f.matchesStore === true' "a report export's tab saves exactly what the store serves (a signed store URL: exports are not on the verified path)"
pb_expect audit-export 'f.downloadEvent === true && f.matchesStore === true' "an audit export's tab saves exactly what the store serves (a signed store URL: exports are not on the verified path)"

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
