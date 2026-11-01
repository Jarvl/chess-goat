#!/usr/bin/env bash
# Start or stop a throwaway PostgreSQL 18 for development and the integration tests.
#   scripts/local-postgres.sh start   -> prints the DATABASE_URL to export for development
#   scripts/local-postgres.sh stop
#   scripts/local-postgres.sh prune [--drop]
#                                     -> lists (with --drop, drops) test databases whose worktree is gone
# Tests need no export: each worktree creates its own databases here (docs/testing.md).
set -euo pipefail

PORT="${PGPORT_LOCAL:-54329}"
DIR="${PGDIR_LOCAL:-/tmp/chess-goat-pg}"
BIN="${PGBIN:-$(ls -d /usr/lib/postgresql/18/bin 2>/dev/null || dirname "$(command -v pg_ctl)")}"
DBS="chess_goat"

run_as_pg() {
  if [ "$(id -u)" = "0" ]; then su postgres -s /bin/bash -c "$1"; else bash -c "$1"; fi
}

case "${1:-}" in
  start)
    if [ ! -d "$DIR/data" ]; then
      mkdir -p "$DIR"
      [ "$(id -u)" = "0" ] && chown postgres "$DIR"
      run_as_pg "'$BIN/initdb' -D '$DIR/data' -A trust -U postgres >'$DIR/initdb.log' 2>&1"
    fi
    run_as_pg "'$BIN/pg_ctl' -D '$DIR/data' -o '-p $PORT -k $DIR -c listen_addresses=127.0.0.1' -l '$DIR/pg.log' start >/dev/null"
    for _ in $(seq 1 30); do
      "$BIN/pg_isready" -h 127.0.0.1 -p "$PORT" -U postgres >/dev/null 2>&1 && break
      sleep 0.5
    done
    for DB in $DBS; do
      "$BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -tAc "select 1 from pg_database where datname='$DB'" | grep -q 1 \
        || "$BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -qc "create database $DB"
    done
    echo "export DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/chess_goat"
    echo "# Tests need no export; TEST_DATABASE_URL, if set, only picks another server."
    ;;
  stop)
    run_as_pg "'$BIN/pg_ctl' -D '$DIR/data' stop >/dev/null" || true
    ;;
  prune)
    ROOT="$(cd "$(dirname "$0")/.." && pwd)"
    # Without the worktree list every database would look stale, so a failed read stops here.
    WORKTREES="$(git -C "$ROOT" worktree list --porcelain | sed -n 's/^worktree //p')" || {
      echo "prune: cannot list this repository's worktrees; nothing done" >&2
      exit 1
    }
    KEYS=""
    while read -r WORKTREE; do
      [ -n "$WORKTREE" ] && [ -d "$WORKTREE" ] && KEYS="$KEYS $(node "$ROOT/scripts/test-database-name.mjs" key "$WORKTREE")"
    done <<<"$WORKTREES"
    case " $KEYS " in
      *" $(node "$ROOT/scripts/test-database-name.mjs" key "$ROOT") "*) ;;
      *)
        echo "prune: this checkout is missing from its own worktree list; nothing done" >&2
        exit 1
        ;;
    esac
    PSQL=("$BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -tA)
    for DB in $("${PSQL[@]}" -c "select datname from pg_database where datname like 'chess_goat\_test\_%' or datname like 'chess_goat\_scratch\_%'"); do
      LIVE=""
      for KEY in $KEYS; do
        case "$DB" in *"_${KEY}"*) LIVE=1 ;; esac
      done
      [ -n "$LIVE" ] && continue
      if [ "${2:-}" = "--drop" ]; then
        "${PSQL[@]}" -qc "drop database \"$DB\" with (force)"
        echo "dropped $DB"
      else
        echo "stale $DB"
      fi
    done
    [ "${2:-}" = "--drop" ] || echo "(dry run: rerun with --drop to drop the databases listed)"
    ;;
  *)
    echo "usage: $0 start|stop|prune [--drop]" >&2
    exit 2
    ;;
esac
