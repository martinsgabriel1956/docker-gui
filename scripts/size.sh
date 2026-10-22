#!/usr/bin/env bash
# Teto de tamanho do PRD: cada instalador gerado pelo tauri build (.deb, .rpm, .msi, .exe do NSIS) com até 20 MB.
# Uso: scripts/size.sh [pasta dos bundles]   (padrão: src-tauri/target/release/bundle)
set -euo pipefail
export LC_ALL=C
dir=${1:-"$(dirname "$0")/../src-tauri/target/release/bundle"}
max=$((20 * 1000 * 1000))
found=0 over=0
while IFS= read -r -d '' f; do
  found=1
  size=$(wc -c < "$f")
  awk -v s="$size" -v f="${f#"$dir"/}" 'BEGIN { printf "%6.1f MB  %s\n", s / 1000000, f }'
  [ "$size" -le "$max" ] || over=1
done < <(find "$dir" -maxdepth 2 -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.msi' -o -name '*-setup.exe' \) -print0)
[ "$found" = 1 ] || { echo "nenhum instalador em $dir: rode npx tauri build" >&2; exit 1; }
[ "$over" = 0 ] || { echo "acima do teto de 20 MB do PRD" >&2; exit 1; }
echo "todos dentro do teto de 20 MB"
