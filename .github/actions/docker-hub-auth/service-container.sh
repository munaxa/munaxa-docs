#!/usr/bin/env bash
# Starts CI's database and cache containers as steps, after the optional Docker Hub login
# (.github/actions/docker-hub-auth), instead of as `services:`.
#
# Why not `services:`: the runner pulls service images before the first step, so only the
# service's own `credentials:` can authenticate that pull, and GitHub rejects a workflow whose
# `credentials` username or password is empty ("Unexpected value ''"). Optional secrets, forks and
# Dependabot (which get no secrets) would then invalidate the whole job. A step-started container
# pulls with the Docker CLI's login when there is one, and anonymously when there is none.
#
#   service-container.sh start <name> <image> [docker run options...]
#       pulls <image> (three attempts, like the runner's service pull) and runs it detached as <name>
#   service-container.sh wait <name>...
#       waits until every named container's health check reports healthy (at most 120 s); on failure
#       prints the container's state and last log lines
set -euo pipefail

cmd="${1:?usage: service-container.sh start <name> <image> [options...] | wait <name>...}"
shift

case "$cmd" in
  start)
    name="${1:?name}"
    image="${2:?image}"
    shift 2
    for attempt in 1 2 3; do
      if docker pull --quiet "$image"; then
        break
      fi
      if [ "$attempt" = 3 ]; then
        echo "::error title=Docker pull::Could not pull $image after 3 attempts. If the error above is 'toomanyrequests', set the DOCKERHUB_USERNAME and DOCKERHUB_TOKEN repository secrets."
        exit 1
      fi
      echo "::warning::docker pull $image failed (attempt $attempt of 3); retrying in $((attempt * 5)) s"
      sleep $((attempt * 5))
    done
    docker run --detach --name "$name" "$@" "$image" >/dev/null
    echo "started $name ($image)"
    ;;
  wait)
    deadline=$((SECONDS + 120))
    for name in "$@"; do
      while :; do
        status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$name")
        case "$status" in
          healthy) echo "$name is healthy"; break ;;
          starting) ;;
          *)
            echo "::error title=Service container::$name is $status"
            docker logs --tail 40 "$name" || true
            exit 1
            ;;
        esac
        if [ "$SECONDS" -ge "$deadline" ]; then
          echo "::error title=Service container::$name was not healthy within 120 s"
          docker logs --tail 40 "$name" || true
          exit 1
        fi
        sleep 2
      done
    done
    ;;
  *)
    echo "unknown command $cmd" >&2
    exit 2
    ;;
esac
