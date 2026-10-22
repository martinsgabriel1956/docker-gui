#!/usr/bin/env bash
# Memória do Stivo: a soma do processo e de todos os descendentes (o app, o WebKitWebProcess e o WebKitNetworkProcess,
# ou o msedgewebview2 no Windows). Duas somas: o RSS conta as bibliotecas compartilhadas uma vez por processo e exagera
# em app de vários processos; o PSS divide as páginas compartilhadas entre quem usa, e é o número justo (o do PRD).
#
#   scripts/memory.sh <pid>            mede um Stivo que já está rodando
#   scripts/memory.sh --idle [binário] abre o Stivo num X próprio com o docker falso, fecha a janela (o app fica na
#                                      bandeja, vigiando), espera WAIT segundos (padrão 120) e confere o teto de 150 MB
set -euo pipefail
export LC_ALL=C
ROOT=$(cd "$(dirname "$0")/.." && pwd)

measure() {
  local root=$1
  [ -d "/proc/$root" ] || { echo "sem o processo $root" >&2; exit 1; }
  local pids=("$root") i=0 rss_total=0 pss_total=0
  while [ "$i" -lt "${#pids[@]}" ]; do  # o processo e cada descendente, em largura
    for child in $(cat /proc/"${pids[$i]}"/task/*/children 2>/dev/null); do
      # o docker (e o docker falso dos testes) é ferramenta do usuário, não do Stivo: fica de fora da conta
      case "$(cat "/proc/$child/comm" 2>/dev/null)" in docker|podman|python3|sh) ;; *) pids+=("$child") ;; esac
    done
    i=$((i + 1))
  done
  printf '%10s %10s  %-8s %s\n' "RSS kB" "PSS kB" "pid" "processo"
  for pid in "${pids[@]}"; do
    rss=$(awk '/^VmRSS:/ { print $2 }' "/proc/$pid/status" 2>/dev/null || echo 0)
    pss=$(awk '/^Pss:/ { print $2 }' "/proc/$pid/smaps_rollup" 2>/dev/null || echo 0)
    printf '%10d %10d  %-8s %s\n' "${rss:-0}" "${pss:-0}" "$pid" "$(cat "/proc/$pid/comm" 2>/dev/null || echo "?")"
    rss_total=$((rss_total + ${rss:-0})); pss_total=$((pss_total + ${pss:-0}))
  done
  PSS_MB=$(echo "$pss_total / 1024" | bc -l)
  printf 'RSS total: %.1f MB, PSS total: %.1f MB, em %d processos\n' "$(echo "$rss_total / 1024" | bc -l)" "$PSS_MB" "${#pids[@]}"
}

if [ "${1:-}" != "--idle" ]; then
  measure "${1:?uso: $0 <pid> | --idle [binário]}"
  exit 0
fi

bin=$(realpath "${2:-$ROOT/src-tauri/target/release/stivo}")
[ -x "$bin" ] || { echo "sem binário em $bin: rode npx tauri build" >&2; exit 1; }
work=$(mktemp -d)
procs=()
trap 'for p in "${procs[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$work"' EXIT
display=":$((80 + RANDOM % 9))"
Xvfb "$display" -screen 0 1400x900x24 >/dev/null 2>&1 & procs+=($!)
python3 - "$work/state.json" <<'PY'
import json, sys
names = ["api", "web", "worker", "db", "cache", "proxy"]
# com stats: o stats roda em segundo plano (alerta de memória) e entra na conta; o api perto do limite de 512 MiB
stats = lambda n: {"CPUPerc": "1.20%", "MemUsage": "480MiB / 512MiB" if n == "api" else "120MiB / 15.6GiB",
                   "MemPerc": "93.75%" if n == "api" else "0.75%", "NetIO": "1.2kB / 648B", "BlockIO": "0B / 4.1kB"}
json.dump({"containers": [{"ID": f"{i:012x}", "Names": n, "Image": f"{n}:latest", "State": "running",
                           "Status": "Up 5 minutes", "Ports": "", "Labels": "com.docker.compose.project=loja",
                           "stats": stats(n)}
                          for i, n in enumerate(names, 1)]}, open(sys.argv[1], "w"))
PY
sleep 1
env -u WAYLAND_DISPLAY DISPLAY="$display" GDK_BACKEND=x11 XDG_CONFIG_HOME="$work/config" XDG_DATA_HOME="$work/data" \
  PATH="$ROOT/tests/e2e/fake-docker:$PATH" FAKE_DOCKER_STATE="$work/state.json" "$bin" >"$work/app.log" 2>&1 &
app=$!; procs+=($app)
for _ in $(seq 60); do
  win=$(DISPLAY=$display xdotool search --onlyvisible --name '^Stivo( ·|$)' 2>/dev/null | head -1) && [ -n "$win" ] && break
  sleep 0.5
done
[ -n "${win:-}" ] || { echo "a janela não abriu" >&2; exit 1; }
sleep 5
DISPLAY=$display python3 "$ROOT/e2e/x11-close.py" "$win"
echo "janela fechada; esperando ${WAIT:-120} s com o Stivo na bandeja..."
sleep "${WAIT:-120}"
measure "$app"
if [ "$(echo "$PSS_MB > 150" | bc)" = 1 ]; then echo "acima do teto de 150 MB do PRD" >&2; exit 1; fi
echo "dentro do teto de 150 MB"
