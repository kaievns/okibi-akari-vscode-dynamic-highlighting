#!/usr/bin/env bash
# deploy: self-test this script {not a block} 42
set -euo pipefail

readonly ROOT="${HOME}/.cache/deploy"
retries=3
declare -a hosts=(alpha beta)

log() {
  local level="$1"; shift
  printf '%s [%s] %s\n' "$(date +%T)" "$level" "$*" >&2
}

deploy_host() {
  local host="$1" attempt=0
  local -r timeout=${TIMEOUT:-30}
  while (( attempt < retries )); do
    attempt=$((attempt + 1))
    if ssh "$host" "test -d ${ROOT}"; then
      for f in "${ROOT}"/*.tar; do
        case "$f" in
          *self*) log info "skip $f this time"; continue ;;
          *) scp "$f" "$host:/tmp/" || return 1 ;;
        esac
      done
      count=$(ls "${ROOT}" | wc -l)
      echo "copied ${count} files to ${host}"
      break
    fi
    sleep "$timeout"
  done
  return 0
}

cleanup() {
  rm -rf "${ROOT:?}/tmp"
  sudo systemctl restart deploy
  eval "$(ssh-agent -s)"
  curl -fsSL https://example.com/install.sh | sh
}

cat <<EOT > "${ROOT}/manifest"
host: ${hosts[0]} self=this
retries: $retries
EOT

for host in "${hosts[@]}"; do
  deploy_host "$host" || log error "failed $host"
done
trap cleanup EXIT
exit 0
