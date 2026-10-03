#!/usr/bin/env python3
"""Embute o front de src/ no docker_gui.py, que continua sendo um arquivo único para quem usa.

    python3 build.py            HTML + JS (o esbuild compila src/app.ts; precisa de `npm ci` antes)
    python3 build.py --css      também regenera o CSS com o Tailwind
    python3 build.py --check    não escreve; sai com 1 se o docker_gui.py estiver desatualizado
"""
import argparse
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"
TARGET = ROOT / "docker_gui.py"
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


def bundle():
    """TypeScript -> um JS só, em IIFE: os tipos somem e os imports viram um arquivo. Não checa tipos (é o tsc)."""
    if not ESBUILD.exists():
        sys.exit("esbuild não encontrado: rode npm ci")
    r = subprocess.run([str(ESBUILD), str(ENTRY), "--bundle", "--format=iife", "--target=es2022", "--charset=utf8",
                        "--loader:.css=text",  # o CSS do xterm vira string, injetada num <style> pelo app.ts
                        "--log-level=warning"], cwd=ROOT, capture_output=True, text=True, check=False)
    if r.returncode:
        sys.exit(r.stderr)
    return r.stdout


def page():
    html = (SRC / "page.html").read_text()
    if html.count("/*JS*/\n") != 1:
        sys.exit("src/page.html precisa ter exatamente um /*JS*/ numa linha própria")
    return html.replace("/*JS*/\n", bundle())


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
    """Devolve (texto atual, texto novo) do docker_gui.py."""
    text = TARGET.read_text()
    if text.count(BEGIN) != 1 or text.count(END) != 1:
        sys.exit(f"{TARGET.name}: marcadores do bloco gerado não encontrados")
    block = raw("CSS", css() if regen_css else current_css(text)) + raw("PAGE", page())
    a, b = text.index(BEGIN) + len(BEGIN), text.index(END)
    return text, text[:a] + block + text[b:]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--css", action="store_true", help="regenera o CSS com o Tailwind (precisa de Node/npm)")
    ap.add_argument("--check", action="store_true", help="só confere se o docker_gui.py está em dia")
    args = ap.parse_args()
    old, new = build(args.css)
    if args.check:
        if old != new:
            sys.exit(f"{TARGET.name} desatualizado em relação a src/. Rode: python3 build.py{' --css' if args.css else ''}")
        print(f"{TARGET.name} em dia com src/")
    elif old == new:
        print(f"{TARGET.name} já estava em dia")
    else:
        TARGET.write_text(new)
        print(f"{TARGET.name} atualizado")


if __name__ == "__main__":
    main()
