#!/usr/bin/env bash
# Tinybird query wrapper for the community-monitor agent.
# Reads TB_TOKEN from the monitor .env itself so the token never has to live
# in the agent's environment, and never prints it.
#
# Usage:
#   tb-query.sh pipe '/v0/pipes/<name>.json?<params>'   (token sent as query param)
#   tb-query.sh sql 'SELECT ...'                        (token sent as Bearer header)
set -euo pipefail

ENV_FILE="${MONITOR_ENV_FILE:-/home/ubuntu/monitor/.env}"
[ -r "$ENV_FILE" ] || { echo "tb-query.sh: cannot read $ENV_FILE" >&2; exit 1; }

TB_TOKEN=""
while IFS='=' read -r key value; do
    case "$key" in
        TB_TOKEN) TB_TOKEN="$value" ;;
    esac
done < "$ENV_FILE"
[ -n "$TB_TOKEN" ] || { echo "tb-query.sh: TB_TOKEN not set in $ENV_FILE" >&2; exit 1; }

HOST="https://api.europe-west2.gcp.tinybird.co"
case "${1:-}" in
    pipe)
        [ $# -ge 2 ] || { echo "usage: tb-query.sh pipe '/v0/pipes/<name>.json?<params>'" >&2; exit 2; }
        exec curl -sS --max-time 20 "$HOST$2&token=$TB_TOKEN"
        ;;
    sql)
        [ $# -ge 2 ] || { echo "usage: tb-query.sh sql 'SELECT ...'" >&2; exit 2; }
        exec curl -sS --max-time 20 "$HOST/v0/sql" -H "Authorization: Bearer $TB_TOKEN" --data-urlencode "q=$2"
        ;;
    *)
        echo "usage: tb-query.sh pipe|sql <query>" >&2
        exit 2
        ;;
esac
