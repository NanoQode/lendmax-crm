#!/usr/bin/env bash
# Start the dev server detached, replacing any instance this script started.
#
# A pidfile, not a pkill pattern and not a port lookup:
#   · a pkill pattern that names the script also matches the shell running it
#   · `ss -ltnp` returns no pid in some containers, so "no process found" is
#     indistinguishable from "not permitted to see it" — and the old process
#     keeps serving while you believe you restarted it, which costs an hour
#     of debugging the wrong thing.
set -u
cd "$(dirname "$0")/.."
PORT="${PORT:-3400}"
PIDFILE="${PIDFILE:-/tmp/lendmax-crm.pid}"
LOGFILE="${LOGFILE:-/tmp/crm.log}"

if [ -f "$PIDFILE" ]; then
  OLD=$(cat "$PIDFILE")
  if kill -0 "$OLD" 2>/dev/null; then
    kill "$OLD" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$OLD" 2>/dev/null || break
      sleep 0.3
    done
    kill -9 "$OLD" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

nohup node --env-file-if-exists=.env --experimental-strip-types src/server.ts > "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"

for _ in $(seq 1 20); do
  if curl -sf "localhost:${PORT}/crm/api/health" > /dev/null 2>&1; then
    curl -s "localhost:${PORT}/crm/api/health"; echo
    exit 0
  fi
  sleep 0.5
done
echo "server did not come up; last log lines:"
tail -20 "$LOGFILE"
exit 1
