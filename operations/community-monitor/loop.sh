#!/usr/bin/env bash
# One fresh Claude process per monitor cycle. systemd waits 30 minutes after
# this process exits before starting the next one.
set -euo pipefail
cd /home/ubuntu/monitor

# Load box secrets into shell variables WITHOUT exporting them.
# Only DISCORD_TOKEN is exported (the mcp-discord server config requires it
# from the process environment). POLLI_TOKEN and TB_TOKEN never enter the
# agent's environment: probe.mjs and the leaderboard builders load .env
# themselves via `node --env-file`, and tb-query.sh reads .env directly.
# shellcheck disable=SC1091
source /home/ubuntu/monitor/.env
export DISCORD_TOKEN
unset POLLI_TOKEN TB_TOKEN

LOG=/home/ubuntu/monitor/loop.log

# Cycle output, transcripts and MCP logs can quote Discord messages, which we
# don't store. Keep only the cycle times and exit status.
echo "=== cycle start $(date -u +%FT%TZ) ===" | tee -a "$LOG"
status=0
claude -p "$(cat CYCLE.md)" \
    --model claude-opus-5-5 --effort medium \
    --no-session-persistence \
    --permission-mode dontAsk \
    --allowedTools "mcp__discord__discord_read_messages,mcp__discord__discord_send,Read(/home/ubuntu/monitor/state.json),Read(/home/ubuntu/monitor/probe-results.json),Read(/home/ubuntu/monitor/people_mapping.json),Write(/home/ubuntu/monitor/state.json),Write(/home/ubuntu/monitor/people_mapping.json),Write(/home/ubuntu/monitor/probe-candidates.json),Bash(node --env-file=/home/ubuntu/monitor/.env probe.mjs:*),Bash(bash /home/ubuntu/monitor/tb-query.sh:*),Bash(cd /home/ubuntu/monitor/leaderboard),Bash(cd /home/ubuntu/monitor/leaderboard:*),Bash(node --env-file=/home/ubuntu/monitor/.env build-leaderboard.mjs:*),Bash(node --env-file=/home/ubuntu/monitor/.env build-image-leaderboard.mjs:*),Bash(curl -s https://gen.pollinations.ai/models:*)" \
    >/dev/null 2>&1 || status=$?
rm -rf /home/ubuntu/.cache/claude-cli-nodejs/-home-ubuntu-monitor/mcp-logs-discord
echo "=== cycle end $(date -u +%FT%TZ) exit=$status ===" | tee -a "$LOG"
exit "$status"
