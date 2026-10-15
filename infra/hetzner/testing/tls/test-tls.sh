#!/usr/bin/env bash
# Tests direct TLS on the host (compose.tls.yaml, Caddyfile.tls; readiness report §5.2) without a
# real certificate, DNS or the internet:
#
#   1. the configuration: Caddyfile.tls and Caddyfile validate; automatic HTTPS is on for the one
#      host name; the shared routes are in both; a missing host name is refused;
#   2. the rendered Compose configuration: only the proxy publishes, only ports 80 and 443, Caddy's
#      /data is a volume; PostgreSQL, Redis and the scanner publish nothing and sit on internal
#      networks only (the scanner's signature egress aside);
#   3. a working HTTPS proxy with Caddy's LOCAL certificate authority in place of the ACME directory
#      (the only line changed): routing, the HTTP→HTTPS redirect, HSTS, the certificate's name, the
#      token kept out of the access log, and the certificate surviving a restart because /data
#      persists — and not surviving one without the volume.
#
#   infra/hetzner/testing/tls/test-tls.sh
#
# Nothing is published on the host: everything runs on an internal Docker network, and no request
# leaves the machine.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$(cd "$here/../.." && pwd)"
caddy_image="${DOCS_PROXY_IMAGE:-caddy:2.10.2-alpine}"
curl_image="${CURL_IMAGE:-curlimages/curl:8.16.0}"
host="docs-test.munaxa-fixture.eu"
run_id="tls-$(openssl rand -hex 4)"
net="$run_id-net"
work="$(mktemp -d)"
failures=0

cleanup() {
  docker rm -f "$run_id-proxy" "$run_id-web" "$run_id-api" >/dev/null 2>&1 || true
  docker volume rm "$run_id-data" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

pass() { echo "PASS  $*"; }
fail() {
  echo "FAIL  $*"
  failures=$((failures + 1))
}

caddy_run() {
  docker run --rm --network none -v "$template/caddy/routes.caddy:/etc/caddy/routes.caddy:ro" "$@"
}

echo "=== 1. the Caddy configuration"
tls_env=(-e "DOCS_PUBLIC_HOSTNAME=$host" -e DOCS_ACME_EMAIL=operator@munaxa-fixture.eu
  -e DOCS_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory)
out="$(caddy_run "${tls_env[@]}" -v "$template/Caddyfile.tls:/etc/caddy/Caddyfile:ro" "$caddy_image" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"
[ $? -eq 0 ] && pass "Caddyfile.tls validates" || fail "Caddyfile.tls: $(printf '%s' "$out" | tail -n 3)"
out="$(caddy_run -v "$template/Caddyfile:/etc/caddy/Caddyfile:ro" "$caddy_image" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"
[ $? -eq 0 ] && pass "the plain Caddyfile still validates with the shared routes" || fail "Caddyfile: $(printf '%s' "$out" | tail -n 3)"

caddy_run "${tls_env[@]}" -v "$template/Caddyfile.tls:/etc/caddy/Caddyfile:ro" "$caddy_image" \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >"$work/tls.json" 2>/dev/null
caddy_run -v "$template/Caddyfile:/etc/caddy/Caddyfile:ro" "$caddy_image" \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >"$work/plain.json" 2>/dev/null
python3 - "$work/tls.json" "$work/plain.json" "$host" <<'EOF' && pass "automatic HTTPS for exactly the one host name, HSTS, h1/h2 only, ACME CA and contact set, admin off" || fail "the adapted TLS configuration is not as expected"
import json, sys
tls, plain, host = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), sys.argv[3]
assert tls["admin"]["disabled"] is True
servers = tls["apps"]["http"]["servers"]
public = [s for s in servers.values() if ":443" in s["listen"]]
assert len(public) == 1, servers
srv = public[0]
assert not srv.get("automatic_https", {}).get("disable"), srv.get("automatic_https")
assert srv.get("protocols") == ["h1", "h2"], srv.get("protocols")
hosts = [h for r in srv["routes"] for m in r.get("match", []) for h in m.get("host", [])]
assert hosts == [host], hosts
text = json.dumps(srv)
assert "Strict-Transport-Security" in text
policies = tls["apps"]["tls"]["automation"]["policies"]
issuers = [i for p in policies for i in p.get("issuers", [])]
assert any(i.get("ca") == "https://acme-staging-v02.api.letsencrypt.org/directory" and i.get("email") == "operator@munaxa-fixture.eu" for i in issuers), issuers
# The routes come from one file: the plain site's four routes are, exactly, the TLS site's routes
# after its HSTS header.
plain_srv = [s for s in plain["apps"]["http"]["servers"].values() if ":8080" in s["listen"]][0]
tls_site = [h for r in srv["routes"] for h in r["handle"] if h["handler"] == "subroute"][0]["routes"]
assert [h["handler"] for h in tls_site[0]["handle"]] == ["headers"], tls_site[0]
assert json.dumps(tls_site[1:], sort_keys=True) == json.dumps(plain_srv["routes"], sort_keys=True), "routes differ"
EOF
grep -q '"disable":true' "$work/plain.json" && pass "the plain Caddyfile still has automatic HTTPS off" || fail "the plain Caddyfile would try to obtain certificates"

out="$(caddy_run -e DOCS_PUBLIC_HOSTNAME= -e DOCS_ACME_EMAIL=operator@munaxa-fixture.eu \
  -e DOCS_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory \
  -v "$template/Caddyfile.tls:/etc/caddy/Caddyfile:ro" "$caddy_image" \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null)"
if printf '%s' "$out" | python3 -c 'import json,sys; c=json.load(sys.stdin); h=[x for s in c["apps"]["http"]["servers"].values() for r in s["routes"] for m in r.get("match",[]) for x in m.get("host",[])]; sys.exit(0 if h else 1)' 2>/dev/null; then
  fail "Caddy alone would serve a site without a host name"
else
  pass "without a host name Caddy names no site (and Compose refuses to start, below)"
fi

echo
echo "=== 2. the rendered Compose configuration"
config="$work/config"
mkdir -p "$config"
for f in api.env postgres.env redis.env operator.env backup.env offsite.env provision.env; do : >"$config/$f"; done
echo '{}' >"$config/tenants.json"
echo '{}' >"$config/operator-tenants.json"
compose_env=(DOCS_CONFIG_DIR="$config" DOCS_API_IMAGE=api@sha256:0 DOCS_WEB_IMAGE=web@sha256:0
  DOCS_ANTIVIRUS_IMAGE=av@sha256:0 DOCS_BACKUP_DIR=/mnt/backup
  DOCS_BACKUP_AGE_RECIPIENTS=age1placeholder DOCS_PUBLIC_HOSTNAME="$host"
  DOCS_ACME_EMAIL=operator@munaxa-fixture.eu)
render() { env "${compose_env[@]}" docker compose -f "$template/compose.yaml" -f "$template/compose.tls.yaml" config --format json 2>&1; }
render >"$work/rendered.json"
python3 - "$work/rendered.json" <<'EOF' && pass "only the proxy publishes, only 80 and 443; /data is a volume; database, cache and scanner are private" || fail "the rendered configuration is not as expected"
import json, sys
c = json.load(open(sys.argv[1]))
services, networks = c["services"], c["networks"]
published = {name: s.get("ports", []) for name, s in services.items() if s.get("ports")}
assert list(published) == ["proxy"], published
ports = sorted((p["published"], p["target"], p.get("host_ip", "")) for p in published["proxy"])
assert ports == [("443", 443, "0.0.0.0"), ("80", 80, "0.0.0.0")], ports
proxy = services["proxy"]
assert any(v["type"] == "volume" and v["target"] == "/data" for v in proxy["volumes"]), proxy["volumes"]
assert [t for t in proxy.get("tmpfs", [])] == ["/config"], proxy.get("tmpfs")
assert proxy["environment"]["DOCS_PUBLIC_HOSTNAME"] == "docs-test.munaxa-fixture.eu"
assert proxy.get("read_only") is True and proxy.get("cap_drop") == ["ALL"], proxy
def internal(n):
    return networks[n].get("internal") is True
for name in ("postgres", "redis"):
    assert all(internal(n) for n in services[name]["networks"]), (name, services[name]["networks"])
av = services["antivirus"]["networks"]
assert set(av) == {"scan", "scanner-egress"} and internal("scan"), av
assert "edge" not in av
EOF
out="$(env "${compose_env[@]}" DOCS_PUBLIC_HOSTNAME= docker compose -f "$template/compose.yaml" -f "$template/compose.tls.yaml" config -q 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -q 'set DOCS_PUBLIC_HOSTNAME' && pass "Compose refuses to start the TLS overlay without DOCS_PUBLIC_HOSTNAME" ||
  fail "no refusal without a host name: $out"
out="$(env "${compose_env[@]}" DOCS_ACME_EMAIL= docker compose -f "$template/compose.yaml" -f "$template/compose.tls.yaml" config -q 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -q 'set DOCS_ACME_EMAIL' && pass "and without DOCS_ACME_EMAIL" || fail "no refusal without a contact: $out"
env "${compose_env[@]}" docker compose -f "$template/compose.yaml" config --format json >"$work/base.json" 2>&1
python3 - "$work/base.json" <<'EOF' && pass "without the overlay the template still publishes only 127.0.0.1:8080" || fail "the base template's publishing changed"
import json, sys
c = json.load(open(sys.argv[1]))
published = {n: s["ports"] for n, s in c["services"].items() if s.get("ports")}
assert list(published) == ["proxy"], published
assert [(p["host_ip"], p["published"]) for p in published["proxy"]] == [("127.0.0.1", "8080")], published
EOF

echo
echo "=== 3. a working HTTPS proxy, with Caddy's local CA in place of the ACME directory"
# The one change: the ACME directory line becomes `local_certs`. Everything else is Caddyfile.tls.
grep -q '^	acme_ca {\$DOCS_ACME_CA}$' "$template/Caddyfile.tls" || fail "Caddyfile.tls no longer has the line this test replaces"
sed 's/^	acme_ca {\$DOCS_ACME_CA}$/	local_certs/' "$template/Caddyfile.tls" >"$work/Caddyfile.local"
docker network create --internal "$net" >/dev/null
# Stand-ins for the web and the API that say who answered.
for stub in web:3000 api:3001; do
  docker run -d --name "$run_id-${stub%%:*}" --network "$net" --network-alias "${stub%%:*}" "$caddy_image" \
    caddy respond --listen ":${stub##*:}" --body "${stub%%:*}-answered" >/dev/null
done
docker volume create "$run_id-data" >/dev/null
# The proxy as compose.yaml + compose.tls.yaml run it (section 2 checked those settings).
start_proxy() {
  docker run -d --name "$run_id-proxy" --network "$net" --read-only --tmpfs /config \
    --security-opt no-new-privileges:true --cap-drop ALL --cap-add NET_BIND_SERVICE \
    -e "DOCS_PUBLIC_HOSTNAME=$host" -e DOCS_ACME_EMAIL=operator@munaxa-fixture.eu \
    -v "$work/Caddyfile.local:/etc/caddy/Caddyfile:ro" -v "$template/caddy/routes.caddy:/etc/caddy/routes.caddy:ro" \
    "$@" "$caddy_image" >/dev/null
  for _ in $(seq 1 30); do
    docker exec "$run_id-proxy" wget -q -O /dev/null http://127.0.0.1:8081/ 2>/dev/null && break
    sleep 1
  done
  proxy_ip="$(docker inspect --format "{{(index .NetworkSettings.Networks \"$net\").IPAddress}}" "$run_id-proxy")"
}
start_proxy -v "$run_id-data:/data"
# The local root, as a client that trusts this deployment's CA would hold it.
for _ in $(seq 1 30); do
  docker exec "$run_id-proxy" cat /data/caddy/pki/authorities/local/root.crt >"$work/root.crt" 2>/dev/null && [ -s "$work/root.crt" ] && break
  sleep 1
done
client() {
  docker run --rm --network "$net" -v "$work/root.crt:/root.crt:ro" "$curl_image" --silent --show-error \
    --max-time 15 --cacert /root.crt --resolve "$host:443:$proxy_ip" --resolve "$host:80:$proxy_ip" "$@"
}
fingerprint() {
  client --head --output /dev/null --write-out '%{certs}' "https://$host/" 2>/dev/null |
    sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' | head -n 40 | sha256sum | cut -d' ' -f1
}
sleep 2
[ "$(client "https://$host/" 2>&1)" = "web-answered" ] && pass "https://$host/ is served by the web, over a verified certificate" ||
  fail "the web did not answer over TLS: $(client "https://$host/" 2>&1 | tail -n 1)"
[ "$(client "https://$host/api/v1/downloads/abc" 2>&1)" = "api-answered" ] && pass "a verified download goes to the API" || fail "downloads not routed"
[ "$(client --output /dev/null --write-out '%{http_code}' "https://$host/api/health")" = "404" ] && pass "/api/health is 404 from outside" || fail "/api/health is reachable"
[ "$(client --output /dev/null --write-out '%{http_code}' "https://$host/api/metrics")" = "404" ] && pass "/api/metrics is 404 from outside" || fail "/api/metrics is reachable"
redirect="$(client --output /dev/null --write-out '%{http_code} %{redirect_url}' "http://$host/login")"
case "$redirect" in "308 https://$host/login") pass "plain HTTP redirects to HTTPS ($redirect)" ;; *) fail "no redirect: $redirect" ;; esac
client --include --output - "https://$host/" 2>/dev/null | grep -qi '^strict-transport-security: max-age=15552000' &&
  pass "HSTS is sent" || fail "no HSTS header"
# curl verifies the name itself (no -k); its verbose output says which name matched.
names="$(client --verbose --head --output /dev/null "https://$host/" 2>&1 | grep -i 'subjectAltName' | head -n 1)"
printf '%s' "$names" | grep -q "host \"$host\" matched" && pass "the certificate names $host (curl: ${names#* })" ||
  fail "certificate name check: $names"
client --output /dev/null "https://$host/api/v1/downloads/abc?token=TLS-TEST-CAPABILITY-$run_id" >/dev/null 2>&1
sleep 1
docker logs "$run_id-proxy" 2>&1 | grep -q "TLS-TEST-CAPABILITY-$run_id" && fail "a download token reached the access log" ||
  pass "the download token is kept out of the access log"
before="$(fingerprint)"
docker rm -f "$run_id-proxy" >/dev/null
start_proxy -v "$run_id-data:/data"
sleep 2
after="$(fingerprint)"
[ -n "$before" ] && [ "$before" = "$after" ] && pass "after a restart the same certificate is served: /data persists (no new issuance)" ||
  fail "the certificate changed across a restart with the volume"
docker rm -f "$run_id-proxy" >/dev/null
# The control: the base template's tmpfs /data. A restart loses the certificate (with a real CA,
# every restart would be a new issuance, and the rate limits would follow).
start_proxy --tmpfs /data
sleep 2
docker exec "$run_id-proxy" cat /data/caddy/pki/authorities/local/root.crt >"$work/root.crt" 2>/dev/null
first="$(fingerprint)"
docker restart "$run_id-proxy" >/dev/null
sleep 3
docker exec "$run_id-proxy" cat /data/caddy/pki/authorities/local/root.crt >"$work/root.crt" 2>/dev/null
second="$(fingerprint)"
[ -n "$first" ] && [ -n "$second" ] && [ "$first" != "$second" ] &&
  pass "control: on tmpfs /data a restart produces a new certificate — the reason for the volume" ||
  fail "control did not behave as expected (first ${first:0:12}, second ${second:0:12})"

echo
if [ "$failures" -eq 0 ]; then
  echo "All TLS checks passed"
else
  echo "$failures TLS check(s) FAILED"
fi
exit "$failures"
