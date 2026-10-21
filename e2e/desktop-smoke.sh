#!/usr/bin/env bash
# Smoke test do app desktop (o que o harness HTTP dos specs não cobre): num X próprio (Xvfb) e num D-Bus de sessão
# próprio, com o docker falso dos testes de UI, confere que
#   1. o app abre, lista os containers e manda a contagem para a bandeja;
#   2. fechar a janela só a esconde: o processo continua;
#   3. com a janela fechada, um container que cai gera notificação do sistema em até 5 s (PRD);
#   4. abrir o Stivo de novo traz a janela de volta (instância única), sem segundo processo.
# O mesmo método do Paddock: o tauri-driver precisaria do WebKitWebDriver, que a distribuição não empacota.
#
# Precisa de Xvfb, xdotool, dbus-run-session e python3 com gi (Gio). Uso: e2e/desktop-smoke.sh [binário]
# (padrão: src-tauri/target/debug/stivo; o de release em src-tauri/target/release/stivo)
set -euo pipefail
export LC_ALL=C

ROOT=$(cd "$(dirname "$0")/.." && pwd)
bin=$(realpath "${1:-$ROOT/src-tauri/target/debug/stivo}")
[ -x "$bin" ] || { echo "sem binário em $bin: rode cargo build -p stivo (em src-tauri)" >&2; exit 1; }
for tool in Xvfb xdotool dbus-run-session python3; do
  command -v "$tool" >/dev/null || { echo "falta: $tool" >&2; exit 1; }
done
if [ -z "${STIVO_SMOKE_INNER:-}" ]; then  # reentra num D-Bus de sessão só deste teste
  exec env STIVO_SMOKE_INNER=1 dbus-run-session -- "$0" "$bin"
fi

work=$(mktemp -d)
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "FALHOU: $*" >&2; echo "--- log do app:" >&2; tail -30 "$work/app.log" >&2 || true; exit 1; }
wait_for() {  # wait_for <segundos> <comando...>
  local until=$(( $(date +%s) + $1 )); shift
  until "$@" >/dev/null 2>&1; do [ "$(date +%s)" -lt "$until" ] || return 1; sleep 0.2; done
}

display=":$((90 + RANDOM % 9))"
Xvfb "$display" -screen 0 1400x900x24 >/dev/null 2>&1 & pids+=($!)
python3 "$ROOT/e2e/notify-server.py" "$work/notifications" & pids+=($!)
cat > "$work/state.json" <<'EOF'
{"containers": [
 {"ID": "0123456789ab", "Names": "web", "Image": "nginx:1.27", "State": "running", "Status": "Up 5 minutes",
  "Ports": "", "Labels": ""}
]}
EOF
run() {
  env -u WAYLAND_DISPLAY DISPLAY="$display" GDK_BACKEND=x11 XDG_CONFIG_HOME="$work/config" XDG_DATA_HOME="$work/data" \
    PATH="$ROOT/tests/e2e/fake-docker:$PATH" FAKE_DOCKER_STATE="$work/state.json" DOCKER_GUI_LANG=pt "$bin" "$@"
}
sleep 1
run >"$work/app.log" 2>&1 & app=$!; pids+=($app)

visible() { DISPLAY=$display xdotool search --onlyvisible --name '^Stivo$'; }
wait_for 30 visible || fail "a janela não abriu"
wait_for 15 grep -q "bandeja: -" "$work/app.log" || fail "a página não mandou a contagem para a bandeja"
echo "ok: o app abriu e a bandeja recebeu a contagem"

win=$(visible | head -1)
DISPLAY=$display python3 "$ROOT/e2e/x11-close.py" "$win"
wait_for 10 sh -c "! DISPLAY=$display xdotool search --onlyvisible --name '^Stivo\$'" || fail "fechar não escondeu a janela"
kill -0 "$app" 2>/dev/null || fail "fechar a janela encerrou o app"
grep -q "continua na bandeja" "$work/notifications" || fail "sem o aviso da primeira vez que a janela fecha"
echo "ok: fechar escondeu a janela e o app continua"

: > "$work/notifications"
before=$(date +%s.%N)
python3 - "$work/state.json" <<'EOF'
import json, os, sys
p = sys.argv[1]; d = json.load(open(p))
d["containers"][0].update(State="exited", Status="Exited (1) 1 second ago")
json.dump(d, open(p + ".tmp", "w")); os.replace(p + ".tmp", p)
EOF
wait_for 5 grep -q "web precisa de atenção" "$work/notifications" || fail "nenhuma notificação em 5 s com a janela fechada"
after=$(cut -f1 "$work/notifications" | head -1)
printf 'ok: notificação %.1f s depois da queda\n' "$(echo "$after - $before" | bc)"
wait_for 5 grep -q "bandeja: 1" "$work/app.log" || fail "a contagem da bandeja não mudou para 1"
echo "ok: a bandeja mostra 1"

run >>"$work/app.log" 2>&1 || true  # a segunda instância avisa a primeira e sai
wait_for 10 visible || fail "abrir de novo não trouxe a janela de volta"
[ "$(pgrep -fc "^$bin")" -eq 1 ] || fail "ficou mais de um processo do Stivo"
echo "ok: abrir de novo trouxe a janela, sem segundo processo"
echo "smoke do desktop: tudo certo"
