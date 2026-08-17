#!/usr/bin/env bash
set -euo pipefail

SCRIPT_FILE="${BASH_SOURCE[0]}"
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$SCRIPT_FILE")/.." && pwd)"
DEFAULT_SESSION="agent-html-report-001"
DEFAULT_ADDR="127.0.0.1:18080"

usage() {
  cat <<'EOF'
html-report test helper

Usage:
  scripts/html-report-test.sh agent-e2e [session-id] [addr]
      Start an auto UI watcher, then enter pisub. After html-report creates
      server-meta.json, the UI proxy starts and the browser opens automatically.

  scripts/html-report-test.sh agent-full-e2e [session-id] [addr]
      Start a full dynamic html-report E2E run: user question, recommendations,
      UI confirmation, Writer, Editor, Research, Review, and Designer stages.

  scripts/html-report-test.sh ui [session-id] [addr]
      Start UI proxy for an existing html-report session and open browser.

  scripts/html-report-test.sh smoke [session-id] [addr]
      Start a local html-report server + UI proxy without Agent, then open browser.

  scripts/html-report-test.sh status [session-id]
      Show session files and result schema status.

  scripts/html-report-test.sh stop [session-id]
      Stop helper-started UI/server processes for a session.

Examples:
  scripts/html-report-test.sh agent-e2e
  scripts/html-report-test.sh smoke manual-ui-smoke
  scripts/html-report-test.sh status agent-html-report-001
EOF
}

load_env() {
  # shellcheck source=/dev/null
  source "$ROOT_DIR/scripts/agent-env.sh" >/dev/null
}

session_dir() {
  printf '%s/.harness/state/html-report/%s\n' "$ROOT_DIR" "$1"
}

helper_dir() {
  printf '%s/.harness/helper-html-report/%s\n' "$ROOT_DIR" "$1"
}

read_meta_url() {
  local meta="$1/server-meta.json"
  [[ -f "$meta" ]] || return 1
  node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(p.url || '')" "$meta"
}

wait_for_meta_url() {
  local sid="$1"
  local wait_seconds="${2:-${HTML_REPORT_META_WAIT_SECONDS:-300}}"
  local dir
  dir="$(session_dir "$sid")"
  local deadline=0
  if (( wait_seconds > 0 )); then
    deadline=$((SECONDS + wait_seconds))
  fi
  local last_notice=$SECONDS
  while true; do
    local url=""
    url="$(read_meta_url "$dir" 2>/dev/null || true)"
    if [[ -n "$url" ]]; then
      printf '%s\n' "$url"
      return 0
    fi
    if (( deadline > 0 && SECONDS >= deadline )); then
      echo "Timed out waiting for $dir/server-meta.json after ${wait_seconds}s" >&2
      return 1
    fi
    if (( deadline == 0 && SECONDS - last_notice >= 60 )); then
      echo "Still waiting for $dir/server-meta.json ..." >&2
      last_notice=$SECONDS
    fi
    sleep 1
  done
}

pid_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

write_pid() {
  local sid="$1" name="$2" pid="$3"
  mkdir -p "$(session_dir "$sid")"
  printf '%s\n' "$pid" > "$(session_dir "$sid")/$name.pid"
}

write_ui_addr() {
  local sid="$1" addr="$2"
  mkdir -p "$(session_dir "$sid")"
  printf '%s\n' "$addr" > "$(session_dir "$sid")/ui-proxy.addr"
}

write_helper_pid() {
  local sid="$1" name="$2" pid="$3"
  mkdir -p "$(helper_dir "$sid")"
  printf '%s\n' "$pid" > "$(helper_dir "$sid")/$name.pid"
}

config_session_id() {
  local base_url="$1"
  local body=""
  body="$(curl -fsS --max-time "${HTML_REPORT_CONFIG_CURL_SECONDS:-3}" "${base_url%/}/harness/config" 2>/dev/null || true)"
  [[ -n "$body" ]] || return 1
  BODY="$body" node -e 'try { const p = JSON.parse(process.env.BODY || "{}"); if (p.session_id) console.log(p.session_id); } catch {}'
}

session_config_ready() {
  local base_url="$1" sid="$2"
  [[ "$(config_session_id "$base_url" 2>/dev/null || true)" == "$sid" ]]
}

wait_for_session_config() {
  local base_url="$1" sid="$2" wait_seconds="${3:-${HTML_REPORT_UPSTREAM_READY_SECONDS:-120}}"
  local deadline=$((SECONDS + wait_seconds))
  while (( SECONDS < deadline )); do
    if session_config_ready "$base_url" "$sid"; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for upstream session config: ${base_url%/}/harness/config" >&2
  return 1
}

start_ui_proxy() {
  local sid="$1" addr="$2" upstream="$3"
  local dir log
  dir="$(session_dir "$sid")"
  mkdir -p "$dir"
  log="$dir/ui-proxy.log"

  if [[ -f "$dir/ui-proxy.pid" ]] && pid_alive "$(cat "$dir/ui-proxy.pid")"; then
    local running_addr="$addr"
    [[ -f "$dir/ui-proxy.addr" ]] && running_addr="$(cat "$dir/ui-proxy.addr")"
    if session_config_ready "http://$running_addr" "$sid"; then
      echo "UI proxy already running: pid $(cat "$dir/ui-proxy.pid"), http://$running_addr"
      open "http://$running_addr" >/dev/null 2>&1 || true
      return 0
    fi
    echo "Ignoring stale UI proxy pid $(cat "$dir/ui-proxy.pid"): http://$running_addr is not session $sid" >&2
  fi

  wait_for_session_config "$upstream" "$sid" "${HTML_REPORT_UPSTREAM_READY_SECONDS:-120}"

  local host port candidate pid
  host="${addr%:*}"
  port="${addr##*:}"
  for offset in $(seq 0 20); do
    candidate="$host:$((port + offset))"
    echo "Starting UI proxy: http://$candidate -> $upstream"
    "$QDM_METRIC_CLI" ui \
      --session-upstream "$upstream" \
      --addr "$candidate" \
      --timeout "${HTML_REPORT_UI_TIMEOUT:-0}" \
      --no-open \
      >"$log" 2>&1 &
    pid=$!
    write_pid "$sid" "ui-proxy" "$pid"
    write_ui_addr "$sid" "$candidate"

    local ready_deadline=$((SECONDS + ${HTML_REPORT_UI_READY_SECONDS:-90}))
    while (( SECONDS < ready_deadline )); do
      if session_config_ready "http://$candidate" "$sid"; then
        echo "UI ready: http://$candidate"
        open "http://$candidate" >/dev/null 2>&1 || true
        return 0
      fi
      if ! pid_alive "$pid"; then
        break
      fi
      sleep 0.5
    done
    echo "UI proxy did not start on http://$candidate; trying next port. Log: $log" >&2
  done

  echo "UI proxy did not become ready. Log: $log" >&2
  return 1
}

cmd_agent_e2e() {
  local sid="${1:-$DEFAULT_SESSION}" addr="${2:-$DEFAULT_ADDR}"
  load_env
  echo "Session: $sid"
  echo "A watcher will open UI at http://$addr after html-report server starts."
  mkdir -p "$(helper_dir "$sid")"
  (
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$ROOT_DIR/scripts/agent-env.sh" >/dev/null
    upstream="$(wait_for_meta_url "$sid" "${HTML_REPORT_AUTO_UI_META_WAIT_SECONDS:-0}")"
    start_ui_proxy "$sid" "$addr" "$upstream"
  ) >"$(helper_dir "$sid")/auto-ui.log" 2>&1 &
  write_helper_pid "$sid" "auto-ui" "$!"
  echo "Auto UI watcher pid: $!"
  echo "In Agent, run: /skill:html-report 生成门店101001在2026-07-26的销售额日报，按日期维度展示"
  if command -v pisub >/dev/null 2>&1; then
    exec pisub --session-id "$sid"
  fi
  local pi_bin=""
  pi_bin="$(command -v pi || true)"
  if [[ -z "$pi_bin" && -x "$HOME/.npm-global/bin/pi" ]]; then
    pi_bin="$HOME/.npm-global/bin/pi"
  fi
  if [[ -z "$pi_bin" ]]; then
    echo "Neither pisub nor pi was found. Install Pi or add it to PATH." >&2
    exit 127
  fi
  exec "$pi_bin" --session-id "$sid"
}

cmd_agent_full_e2e() {
  export HTML_REPORT_A_CONFIG_MODE=dynamic
  export HTML_REPORT_GATE_MODE=step
  cmd_agent_e2e "$@"
}

cmd_ui() {
  local sid="${1:-$DEFAULT_SESSION}" addr="${2:-$DEFAULT_ADDR}"
  load_env
  local upstream
    upstream="$(wait_for_meta_url "$sid")"
  start_ui_proxy "$sid" "$addr" "$upstream"
  echo "Logs: $(session_dir "$sid")/ui-proxy.log"
}

cmd_smoke() {
  local sid="${1:-manual-ui-smoke}" addr="${2:-$DEFAULT_ADDR}"
  load_env
  local dir upstream server_log
  dir="$(session_dir "$sid")"
  mkdir -p "$dir"
  server_log="$dir/local-server.log"

  if [[ -f "$dir/local-server.pid" ]] && pid_alive "$(cat "$dir/local-server.pid")"; then
    echo "Local server already running: pid $(cat "$dir/local-server.pid")"
  else
    "$ROOT_DIR/scripts/start-local-html-report-server.sh" "$sid" >"$server_log" 2>&1 &
    write_pid "$sid" "local-server" "$!"
    echo "Local server pid: $!"
  fi
  upstream="$(wait_for_meta_url "$sid")"
  start_ui_proxy "$sid" "$addr" "$upstream"
  echo "Open: http://$addr"
  echo "Result path: $dir/result.json"
}

cmd_status() {
  local sid="${1:-$DEFAULT_SESSION}"
  local dir hdir
  dir="$(session_dir "$sid")"
  hdir="$(helper_dir "$sid")"
  echo "Session dir: $dir"
  for name in server-meta.json recommendations.json result.json auto-ui.log ui-proxy.log ui-proxy.addr local-server.log; do
    [[ -e "$dir/$name" ]] && echo "- $name"
  done
  if [[ -d "$hdir" ]]; then
    echo "Helper dir: $hdir"
    for name in auto-ui.log; do
      [[ -e "$hdir/$name" ]] && echo "- helper/$name"
    done
  fi
  for name in auto-ui ui-proxy local-server; do
    local pid_file=""
    if [[ -f "$dir/$name.pid" ]]; then
      pid_file="$dir/$name.pid"
    elif [[ -f "$hdir/$name.pid" ]]; then
      pid_file="$hdir/$name.pid"
    fi
    if [[ -n "$pid_file" ]]; then
      local pid
      pid="$(cat "$pid_file")"
      if pid_alive "$pid"; then
        echo "- $name pid: $pid running"
      else
        echo "- $name pid: $pid stopped"
      fi
    fi
  done
  if [[ -f "$dir/server-meta.json" ]]; then
    echo "Upstream: $(read_meta_url "$dir" || true)"
  fi
  if [[ -f "$dir/result.json" ]]; then
    jq '{status, session_id, cardKeys:(.cards[0]|keys)}' "$dir/result.json"
  fi
}

cmd_stop() {
  local sid="${1:-$DEFAULT_SESSION}"
  local dir hdir
  dir="$(session_dir "$sid")"
  hdir="$(helper_dir "$sid")"
  for name in auto-ui ui-proxy local-server; do
    for pid_file in "$dir/$name.pid" "$hdir/$name.pid"; do
      [[ -f "$pid_file" ]] || continue
      local pid
      pid="$(cat "$pid_file")"
      if pid_alive "$pid"; then
        kill "$pid" 2>/dev/null || true
        echo "Stopped $name pid $pid"
      fi
    done
  done
}

cmd="${1:-}"
shift || true
case "$cmd" in
  agent-e2e) cmd_agent_e2e "$@" ;;
  agent-full-e2e) cmd_agent_full_e2e "$@" ;;
  ui) cmd_ui "$@" ;;
  smoke) cmd_smoke "$@" ;;
  status) cmd_status "$@" ;;
  stop) cmd_stop "$@" ;;
  -h|--help|help|"") usage ;;
  *) echo "unknown command: $cmd" >&2; usage >&2; exit 2 ;;
esac
