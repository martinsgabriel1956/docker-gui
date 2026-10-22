#!/usr/bin/env python3
"""Embute o front de src/ no docker_gui.py, que continua sendo um arquivo único para quem usa.

    python3 build.py            HTML + JS (o esbuild compila src/app.ts; precisa de `npm ci` antes)
    python3 build.py --css      também regenera o CSS com o Tailwind
    python3 build.py --check    não escreve; sai com 1 se o docker_gui.py (ou a página do desktop) estiver desatualizado

A mesma página vai para o app desktop em src-tauri/dist/index.html, com o transporte do Tauri (a condição "desktop" do
esbuild troca o '#transport' do package.json): o --check confere os dois.
"""
import argparse
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"
TARGET = ROOT / "docker_gui.py"
DESKTOP = ROOT / "src-tauri" / "dist" / "index.html"
ENTRY = SRC / "app.ts"  # o esbuild segue os imports a partir daqui e gera um único <script>
ESBUILD = ROOT / "node_modules" / ".bin" / "esbuild"  # versão fixa no package-lock.json: saída reproduzível
TAILWIND = "4.3.3"  # versão fixa: outra versão gera CSS diferente e o --check acusaria sem mudança real
BEGIN = "# >>> gerado por build.py a partir de src/: não edite à mão, mude src/ e rode python3 build.py\n"
END = "# <<< fim do gerado\n"


def raw(name, text):
    # o conteúdo vai num r"""...""": não pode ter aspas triplas nem terminar em barra
    if '"""' in text or text.endswith("\\"):
        sys.exit(f"{name}: conteúdo não cabe numa string r\"\"\"...\"\"\"")
    return f'{name} = r"""{text}"""\n'


def bundle(desktop=False):
    """TypeScript -> um JS só, em IIFE: os tipos somem e os imports viram um arquivo. Não checa tipos (é o tsc)."""
    if not ESBUILD.exists():
        sys.exit("esbuild não encontrado: rode npm ci")
    r = subprocess.run([str(ESBUILD), str(ENTRY), "--bundle", "--format=iife", "--target=es2022", "--charset=utf8",
                        "--loader:.css=text",  # o CSS do xterm vira string, injetada num <style> pelo app.ts
                        *(["--conditions=desktop"] if desktop else []),  # '#transport' -> transport-desktop.ts
                        "--log-level=warning"], cwd=ROOT, capture_output=True, text=True, check=False)
    if r.returncode:
        sys.exit(r.stderr)
    # o xterm.js tem caracteres de controle crus em strings ("\x16"...): no .py eles viram armadilha (o ruff
    # acusa, editores escondem). Escapados como \xNN, que no JS vale o mesmo dentro de string e regex
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", lambda m: f"\\x{ord(m[0]):02x}", r.stdout)


def page(desktop=False):
    html = (SRC / "page.html").read_text()
    if html.count("/*JS*/\n") != 1:
        sys.exit("src/page.html precisa ter exatamente um /*JS*/ numa linha própria")
    return html.replace("/*JS*/\n", bundle(desktop))


def css():
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(["npm", "install", "--silent", "--no-save", f"tailwindcss@{TAILWIND}",
                        f"@tailwindcss/cli@{TAILWIND}"], cwd=d, check=True)
        # copia src/ para junto do node_modules: o @import "tailwindcss" resolve a partir da pasta do CSS,
        # e o Tailwind só enxerga os arquivos de src/ (os @source do theme.css)
        for f in SRC.iterdir():
            pathlib.Path(d, f.name).write_text(f.read_text())
        subprocess.run(["npx", "tailwindcss", "-i", "theme.css", "-o", "out.css", "--minify"], cwd=d, check=True)
        return pathlib.Path(d, "out.css").read_text()


def current_css(text):
    a = text.index('CSS = r"""', text.index(BEGIN)) + len('CSS = r"""')
    return text[a:text.index('"""', a)]


def build(regen_css=False):
    """Devolve [(arquivo, texto atual, texto novo)]: o docker_gui.py e a página do desktop."""
    text = TARGET.read_text()
    if text.count(BEGIN) != 1 or text.count(END) != 1:
        sys.exit(f"{TARGET.name}: marcadores do bloco gerado não encontrados")
    style = css() if regen_css else current_css(text)
    block = raw("CSS", style) + raw("PAGE", page())
    a, b = text.index(BEGIN) + len(BEGIN), text.index(END)
    desktop = page(desktop=True).replace("/*CSS*/", style)
    return [(TARGET, text, text[:a] + block + text[b:]),
            (DESKTOP, DESKTOP.read_text() if DESKTOP.exists() else "", desktop)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--css", action="store_true", help="regenera o CSS com o Tailwind (precisa de Node/npm)")
    ap.add_argument("--check", action="store_true", help="só confere se o docker_gui.py está em dia")
    args = ap.parse_args()
    for path, old, new in build(args.css):
        name = path.relative_to(ROOT)
        if args.check:
            if old != new:
                sys.exit(f"{name} desatualizado em relação a src/. Rode: python3 build.py{' --css' if args.css else ''}")
            print(f"{name} em dia com src/")
        elif old == new:
            print(f"{name} já estava em dia")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(new)
            print(f"{name} atualizado")


if __name__ == "__main__":
    main()
