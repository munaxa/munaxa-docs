#!/usr/bin/env bash
# TEST session helper for .github/workflows/test-session.yml. TEST only: the account, prefix and
# deployer are fixed below and cannot be pointed at Production.
#
#   test-session.sh prepare-db fresh|existing   write the session secrets, run the database
#                                                 administration task, migrate through the tunnel,
#                                                 and (fresh only) provision the TEST tenant
#   test-session.sh describe                     print "<ExpiresAt> <ReleaseCommit>" of the running
#                                                 session ("None" for a missing tag), or "none"
#                                                 when no session resource exists at all
#   test-session.sh cleanup-leftovers            delete a provisioning secret left by a failed run
#
# Credentials: the job's own credentials are the Testing CI role, which can do nothing but assume
# the TEST deployer. This script opens one deployer session (source identity github-actions,
# session gha-run-…) and keeps it in this process only. Generated passwords exist only in this
# process and in Secrets Manager; they are masked in the log and never written to a file outside a
# private temporary directory that is removed on exit. The deployer can write secret values but can
# never read them back (its guardrails deny it), which is why an existing session rotates only the
# migration owner's password and leaves every other value as it is.
#
# Required environment: GITHUB_RUN_ID, AWS_REGION, and for prepare-db the session outputs
# (DB_ADDRESS, TENANT_ID, TENANT_SLUG, TENANT_DATABASE, DOCS_BUCKET, OPS_SUBNETS, OPS_SECURITY_GROUPS,
# SECRET_APP_ARN, SECRET_OPERATOR_ARN, SECRET_GHCR_ARN) plus TEST_PULL_USER, TEST_PULL_TOKEN,
# TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD (GitHub `testing` environment secrets).
set -euo pipefail

ACCOUNT=657878534449
PREFIX=munaxa-docs-eu-test
DEPLOYER_ROLE_ARN="arn:aws:iam::$ACCOUNT:role/munaxa-docs/bootstrap/$PREFIX-deployer"
: "${GITHUB_RUN_ID:?}" "${AWS_REGION:?}"
[ "$AWS_REGION" = eu-central-1 ] || { echo "TEST is eu-central-1 only" >&2; exit 2; }

PRIVATE=$(mktemp -d)
chmod 700 "$PRIVATE"
TUNNEL_PID=""
TUNNEL_TASK=""
cleanup() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "$TUNNEL_TASK" ] && aws ecs stop-task --cluster "$PREFIX" --task "$TUNNEL_TASK" --reason "tunnel no longer needed" >/dev/null 2>&1 || true
  rm -rf "$PRIVATE"
}
trap cleanup EXIT

mask() { [ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$1"; return 0; }

open_session() {
  local creds
  creds=$(aws sts assume-role \
    --role-arn "$DEPLOYER_ROLE_ARN" \
    --role-session-name "gha-run-${GITHUB_RUN_ID}-$1" \
    --source-identity github-actions \
    --duration-seconds 3600 \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
  read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN <<<"$creds"
  unset creds
  mask "$AWS_SECRET_ACCESS_KEY"; mask "$AWS_SESSION_TOKEN"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
}

new_secret() { # <hex|b64>
  local v
  if [ "$1" = hex ]; then v=$(openssl rand -hex 32); else v=$(openssl rand -base64 48 | tr -d '\n'); fi
  mask "$v"; printf '%s' "$v"
}

put_secret() { # <arn> <json-file>
  aws secretsmanager put-secret-value --secret-id "$1" --secret-string "file://$2" >/dev/null
}

network() {
  printf 'awsvpcConfiguration={subnets=[%s],securityGroups=[%s],assignPublicIp=ENABLED}' "$OPS_SUBNETS" "$OPS_SECURITY_GROUPS"
}

run_ops_task() { # <family suffix> → waits, fails unless every essential container exits 0
  local family="$PREFIX-$1" arn
  arn=$(aws ecs run-task --cluster "$PREFIX" --launch-type FARGATE --task-definition "$family" \
    --network-configuration "$(network)" --query 'tasks[0].taskArn' --output text)
  echo "started $family: ${arn##*/}"
  aws ecs wait tasks-stopped --cluster "$PREFIX" --tasks "$arn"
  local codes
  codes=$(aws ecs describe-tasks --cluster "$PREFIX" --tasks "$arn" \
    --query 'tasks[0].containers[?name!=`redis`].exitCode' --output text)
  echo "$family exit codes: $codes"
  for c in $codes; do [ "$c" = 0 ] || { echo "::error::$family failed (exit $c); see /munaxa-docs/eu-test/ops logs"; return 1; }; done
}

open_tunnel() { # → local port 15432 forwards to the session database
  TUNNEL_TASK=$(aws ecs run-task --cluster "$PREFIX" --launch-type FARGATE --enable-execute-command \
    --task-definition "$PREFIX-ops-tunnel" --network-configuration "$(network)" \
    --query 'tasks[0].taskArn' --output text)
  aws ecs wait tasks-running --cluster "$PREFIX" --tasks "$TUNNEL_TASK"
  local runtime="" agent=""
  for _ in $(seq 1 30); do
    runtime=$(aws ecs describe-tasks --cluster "$PREFIX" --tasks "$TUNNEL_TASK" --query 'tasks[0].containers[?name==`tunnel`].runtimeId | [0]' --output text)
    agent=$(aws ecs describe-tasks --cluster "$PREFIX" --tasks "$TUNNEL_TASK" --query 'tasks[0].containers[?name==`tunnel`].managedAgents[0].lastStatus | [0]' --output text)
    [ "$agent" = RUNNING ] && break
    sleep 5
  done
  [ "$agent" = RUNNING ] || { echo "::error::ECS Exec agent did not start on the tunnel task"; return 1; }
  aws ssm start-session \
    --target "ecs:${PREFIX}_${TUNNEL_TASK##*/}_${runtime}" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "{\"host\":[\"$DB_ADDRESS\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"15432\"]}" \
    > "$PRIVATE/tunnel.log" 2>&1 &
  TUNNEL_PID=$!
  for _ in $(seq 1 30); do
    (exec 3<>/dev/tcp/127.0.0.1/15432) 2>/dev/null && { echo "tunnel open"; return 0; }
    sleep 2
  done
  echo "::error::the migration tunnel did not open"; return 1
}

prepare_db() { # fresh|existing
  local mode="$1"
  : "${DB_ADDRESS:?}" "${TENANT_ID:?}" "${TENANT_SLUG:?}" "${TENANT_DATABASE:?}" "${DOCS_BUCKET:?}"
  : "${OPS_SUBNETS:?}" "${OPS_SECURITY_GROUPS:?}" "${SECRET_APP_ARN:?}" "${SECRET_OPERATOR_ARN:?}" "${SECRET_GHCR_ARN:?}"
  umask 077
  open_session db

  local owner_pw app_pw backup_pw
  owner_pw=$(new_secret hex)
  if [ "$mode" = fresh ]; then
    : "${TEST_PULL_USER:?}" "${TEST_PULL_TOKEN:?}" "${TEST_ADMIN_EMAIL:?}" "${TEST_ADMIN_PASSWORD:?}"
    app_pw=$(new_secret hex); backup_pw=$(new_secret hex)

    jq -n --arg u "$TEST_PULL_USER" --arg p "$TEST_PULL_TOKEN" '{username:$u,password:$p}' > "$PRIVATE/ghcr.json"
    put_secret "$SECRET_GHCR_ARN" "$PRIVATE/ghcr.json"

    local db_url redis_pw
    db_url="postgresql://edms_app:${app_pw}@${DB_ADDRESS}:5432/${TENANT_DATABASE}?sslmode=require"
    redis_pw=$(new_secret hex)
    jq -n \
      --arg db "$db_url" --arg id "$TENANT_ID" --arg slug "$TENANT_SLUG" --arg bucket "$DOCS_BUCKET" \
      --arg redis_pw "$redis_pw" \
      --arg jwt "$(new_secret b64)" --arg witness "$(new_secret b64)" --arg audit "$(new_secret b64)" \
      --arg mfa "$(new_secret b64)" --arg metrics "$(new_secret hex)" \
      '{
        DATABASE_URL: $db,
        TENANT_CATALOGUE: ({
          defaults: {storage: {driver: "S3", container: $bucket, region: "eu-central-1", prefixTemplate: "{slug}"},
                     search: {indexTemplate: "{slug}"}},
          tenants: [{id: $id, slug: $slug, name: "Munaxa Internal (TEST)", database: {url: $db}}]
        } | tojson),
        REDIS_PASSWORD: $redis_pw,
        REDIS_URL: ("redis://:" + $redis_pw + "@127.0.0.1:6379"),
        JWT_ACCESS_SECRET: $jwt,
        SIGNATURE_WITNESS_SECRET: $witness,
        AUDIT_CHECKPOINT_SECRET: $audit,
        MFA_TOTP_SEALING_KEY: $mfa,
        METRICS_SCRAPE_TOKEN: $metrics
      }' > "$PRIVATE/app.json"
    put_secret "$SECRET_APP_ARN" "$PRIVATE/app.json"
  else
    # The deployer cannot read the current values, and the application's secrets must outlive a
    # release within one session (signatures, MFA, the audit chain). Only the owner rotates.
    app_pw=KEEP; backup_pw=KEEP
  fi

  jq -n --arg o "$owner_pw" --arg a "$app_pw" --arg b "$backup_pw" \
    '{EDMS_OWNER_PASSWORD:$o, EDMS_APP_PASSWORD:$a, EDMS_BACKUP_PASSWORD:$b}' > "$PRIVATE/operator.json"
  put_secret "$SECRET_OPERATOR_ARN" "$PRIVATE/operator.json"
  rm -f "$PRIVATE"/*.json

  echo "== cluster roles and the tenant database"
  run_ops_task ops-dbadmin

  echo "== migrations (twice: the second run must find nothing pending)"
  open_tunnel
  local url="postgresql://edms_owner:${owner_pw}@127.0.0.1:15432/${TENANT_DATABASE}?sslmode=require"
  (cd "$GITHUB_WORKSPACE" && DATABASE_MIGRATION_URL="$url" TENANT_SLUG="$TENANT_SLUG" node scripts/migrate-tenants.mjs)
  (cd "$GITHUB_WORKSPACE" && DATABASE_MIGRATION_URL="$url" TENANT_SLUG="$TENANT_SLUG" node scripts/migrate-tenants.mjs)
  kill "$TUNNEL_PID" 2>/dev/null || true; TUNNEL_PID=""

  if [ "$mode" = fresh ]; then
    echo "== the TEST tenant's first administrator"
    local name="$PREFIX/provision/$TENANT_SLUG"
    jq -n --arg id "$TENANT_ID" --arg e "$TEST_ADMIN_EMAIL" --arg p "$TEST_ADMIN_PASSWORD" \
      '{TENANT_ID:$id, ADMIN_EMAIL:$e, ADMIN_NAME:"TEST administrator", ADMIN_PASSWORD:$p}' > "$PRIVATE/provision.json"
    aws secretsmanager create-secret --name "$name" --kms-key-id "alias/$PREFIX" \
      --description "Temporary: one TEST provisioning run" --secret-string "file://$PRIVATE/provision.json" \
      --tags Key=Environment,Value=Testing Key=Lifecycle,Value=ephemeral Key=Owner,Value=munaxa-docs-ci >/dev/null
    rm -f "$PRIVATE/provision.json"
    local rc=0
    run_ops_task ops-provision || rc=$?
    aws secretsmanager delete-secret --secret-id "$name" --force-delete-without-recovery >/dev/null
    [ "$rc" = 0 ] || return "$rc"
  fi
  echo "database ready ($mode)"
}

case "${1:-}" in
  prepare-db)
    case "${2:-}" in fresh|existing) prepare_db "$2" ;; *) echo "usage: prepare-db fresh|existing" >&2; exit 2 ;; esac
    ;;
  describe)
    # The load balancer and the database are the session's two hourly costs; either one alone
    # still counts as a session, so a half-destroyed session is found and destroyed too.
    open_session describe
    alb=$(aws elbv2 describe-load-balancers --names "$PREFIX-alb" --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)
    db=$(aws rds describe-db-instances --db-instance-identifier "$PREFIX-pg" --query 'DBInstances[0].DBInstanceArn' --output text 2>/dev/null || true)
    [ "$alb" = None ] && alb=""
    [ "$db" = None ] && db=""
    if [ -z "$alb" ] && [ -z "$db" ]; then echo none; exit 0; fi
    expires=None; commit=None
    if [ -n "$alb" ]; then
      expires=$(aws elbv2 describe-tags --resource-arns "$alb" --query 'TagDescriptions[0].Tags[?Key==`ExpiresAt`].Value | [0]' --output text)
      commit=$(aws elbv2 describe-tags --resource-arns "$alb" --query 'TagDescriptions[0].Tags[?Key==`ReleaseCommit`].Value | [0]' --output text)
    else
      expires=$(aws rds list-tags-for-resource --resource-name "$db" --query 'TagList[?Key==`ExpiresAt`].Value | [0]' --output text)
    fi
    printf '%s %s\n' "${expires:-None}" "${commit:-None}"
    ;;
  cleanup-leftovers)
    open_session cleanup
    for name in $(aws secretsmanager list-secrets --filters Key=name,Values="$PREFIX/provision/" --query 'SecretList[].Name' --output text); do
      aws secretsmanager delete-secret --secret-id "$name" --force-delete-without-recovery >/dev/null && echo "deleted leftover $name"
    done
    ;;
  *)
    echo "usage: $0 prepare-db fresh|existing | describe | cleanup-leftovers" >&2
    exit 2
    ;;
esac
