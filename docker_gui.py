#!/usr/bin/env python3
"""Gerenciador de containers Docker no navegador. Só stdlib + docker CLI."""
import argparse
import errno
import hmac
import json
import re
import secrets
import subprocess
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765  # padrão; se estiver ocupada, serve() tenta as próximas
# segredo por execução: sem ele a API não responde. Fecha a porta para o que roda na máquina
# sem ser o seu navegador (container com network_mode: host, outros usuários, outros processos).
TOKEN = secrets.token_urlsafe(24)
ACTIONS = {"start": ["start"], "stop": ["stop"], "restart": ["restart"], "pause": ["pause"],
           "unpause": ["unpause"], "remove": ["rm", "-f"]}
# leitura (ps, logs, inspect) é rápida; stop/restart esperam o stop_grace_period do container
READ_TIMEOUT, ACTION_TIMEOUT = 15, 120


def docker(*args, timeout=READ_TIMEOUT):
    # sem timeout, um daemon travado prende uma thread por poll (a cada 2s, por aba) para sempre
    try:
        return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, "", f"docker {args[0]} não respondeu em {timeout}s. O daemon está travado?")


class Handler(BaseHTTPRequestHandler):
    def send(self, code, body, ctype="application/json"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def host_ok(self):
        # bloqueia DNS rebinding: só aceita acesso via localhost
        port = self.server.server_address[1]
        return self.headers.get("Host") in (f"127.0.0.1:{port}", f"localhost:{port}")

    def token_ok(self):
        # vem num header (não em cookie: cookie não separa porta e vazaria para outros servidores em localhost).
        # Header custom também força preflight CORS, então outros sites não conseguem chamar a API.
        return hmac.compare_digest(self.headers.get("X-Docker-GUI-Token", ""), TOKEN)

    def do_GET(self):
        if not self.host_ok():
            return self.send(403, '"forbidden"')
        if self.path == "/":  # a página em si não tem dados; só a API exige o token
            return self.send(200, PAGE, "text/html")
        if not self.token_ok():
            return self.send(401, '"token ausente ou inválido"')
        if self.path == "/api/containers":
            r = docker("ps", "-a", "--format", "{{json .}}")
            if r.returncode:
                return self.send(500, json.dumps(r.stderr.strip()))
            return self.send(200, "[" + ",".join(r.stdout.splitlines()) + "]")
        m = re.fullmatch(r"/api/logs/([0-9a-f]{12,64})", self.path)
        if m:
            r = docker("logs", "--tail", "500", m[1])
            return self.send(500 if r.returncode else 200, json.dumps(r.stdout + r.stderr))
        m = re.fullmatch(r"/api/health/([0-9a-f]{12,64})", self.path)
        if m:  # saída dos probes do healthcheck (não aparece em docker logs)
            r = docker("inspect", "--format", "{{json .State.Health}}", m[1])
            return self.send(500, json.dumps(r.stderr.strip())) if r.returncode else self.send(200, r.stdout.strip())
        self.send(404, '"not found"')

    def do_POST(self):
        if not self.host_ok():
            return self.send(403, '"forbidden"')
        if not self.token_ok():
            return self.send(401, '"token ausente ou inválido"')
        m = re.fullmatch(r"/api/(\w+)/([0-9a-f]{12,64})", self.path)
        if not m or m[1] not in ACTIONS:
            return self.send(404, '"not found"')
        r = docker(*ACTIONS[m[1]], m[2], timeout=ACTION_TIMEOUT)
        self.send(500 if r.returncode else 200, json.dumps(r.stderr.strip()))

    def log_message(self, *args):
        pass


def serve(port):
    """Escuta na porta pedida; sem --port, cai para as próximas se a padrão estiver ocupada."""
    for p in [port] if port is not None else range(PORT, PORT + 10):
        try:
            return ThreadingHTTPServer(("127.0.0.1", p), Handler)
        except OSError as e:
            if e.errno != errno.EADDRINUSE:
                raise
    sys.exit(f"Porta {port} ocupada. Escolha outra com --port." if port is not None
             else f"Portas {PORT}-{PORT + 9} ocupadas. Escolha uma com --port.")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, help=f"porta local (padrão: {PORT}, ou a próxima livre)")
    args = ap.parse_args()
    server = serve(args.port)
    # o token vai no #fragmento: não é enviado ao servidor nem fica em log; a página guarda e o tira da URL
    url = f"http://localhost:{server.server_address[1]}/#t={TOKEN}"
    print(f"Docker GUI em {url}  (Ctrl+C para sair)")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


# Front (HTML, JS e o CSS do Tailwind) embutido: sem CDN, funciona offline e não pisca sem estilo.
# A fonte fica em src/; para mudar o visual ou o comportamento da página, veja o README.
# >>> gerado por build.py a partir de src/: não edite à mão, mude src/ e rode python3 build.py
CSS = r"""/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */
@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inline))) or ((-moz-orient:inline) and (not (color:rgb(from red r g b)))){*,:before,:after,::backdrop{--tw-space-y-reverse:0;--tw-border-style:solid;--tw-leading:initial;--tw-font-weight:initial;--tw-tracking:initial;--tw-shadow:0 0 #0000;--tw-shadow-color:initial;--tw-shadow-alpha:100%;--tw-inset-shadow:0 0 #0000;--tw-inset-shadow-color:initial;--tw-inset-shadow-alpha:100%;--tw-ring-color:initial;--tw-ring-shadow:0 0 #0000;--tw-inset-ring-color:initial;--tw-inset-ring-shadow:0 0 #0000;--tw-ring-inset:initial;--tw-ring-offset-width:0px;--tw-ring-offset-color:#fff;--tw-ring-offset-shadow:0 0 #0000;--tw-blur:initial;--tw-brightness:initial;--tw-contrast:initial;--tw-grayscale:initial;--tw-hue-rotate:initial;--tw-invert:initial;--tw-opacity:initial;--tw-saturate:initial;--tw-sepia:initial;--tw-drop-shadow:initial;--tw-drop-shadow-color:initial;--tw-drop-shadow-alpha:100%;--tw-drop-shadow-size:initial;--tw-outline-style:solid}}}@layer theme{:root,:host{--font-sans:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--font-mono:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;--color-black:#000;--color-white:#fff;--spacing:.25rem;--container-md:28rem;--container-7xl:80rem;--text-xs:.75rem;--text-xs--line-height:calc(1 / .75);--text-sm:.875rem;--text-sm--line-height:calc(1.25 / .875);--text-lg:1.125rem;--text-lg--line-height:calc(1.75 / 1.125);--text-2xl:1.5rem;--text-2xl--line-height:calc(2 / 1.5);--font-weight-normal:400;--font-weight-medium:500;--font-weight-semibold:600;--tracking-tight:-.025em;--tracking-normal:0em;--tracking-wider:.05em;--leading-relaxed:1.625;--radius-md:.375rem;--radius-lg:.5rem;--radius-xl:.75rem;--animate-pulse:pulse 2s cubic-bezier(.4, 0, .6, 1) infinite;--default-transition-duration:.15s;--default-transition-timing-function:cubic-bezier(.4, 0, .2, 1);--default-font-family:var(--font-sans);--default-mono-font-family:var(--font-mono);--color-canvas:oklch(14.1% .005 285.823);--color-raised:oklch(21% .006 285.885);--color-hover:oklch(27.4% .006 286.033);--color-line:oklch(27.4% .006 286.033);--color-line-strong:oklch(37% .013 285.805);--color-dim:oklch(55.2% .016 285.938);--color-muted:oklch(70.5% .015 286.067);--color-fg-soft:oklch(87.1% .006 286.286);--color-fg:oklch(92% .004 286.32);--color-fg-strong:oklch(96.7% .001 286.375);--color-ok:oklch(76.5% .177 163.223);--color-ok-fg:oklch(84.5% .143 164.978);--color-ok-soft:oklch(90.5% .093 164.15);--color-warn:oklch(82.8% .189 84.429);--color-warn-fg:oklch(87.9% .169 91.605);--color-warn-soft:oklch(92.4% .12 95.746);--color-warn-strong:oklch(96.2% .059 95.617);--color-bad:oklch(70.4% .191 22.216);--color-bad-fg:oklch(80.8% .114 19.571);--color-bad-soft:oklch(88.5% .062 18.334);--color-danger:oklch(50.5% .213 27.518);--color-danger-hover:oklch(44.4% .177 26.899);--color-pause:oklch(70.2% .183 293.541);--color-pause-fg:oklch(81.1% .111 293.571);--color-accent:oklch(74.6% .16 232.661);--color-accent-fg:oklch(82.8% .111 230.318);--color-accent-soft:oklch(90.1% .058 230.902)}}@layer base{*,:after,:before,::backdrop{box-sizing:border-box;border:0 solid;margin:0;padding:0}::file-selector-button{box-sizing:border-box;border:0 solid;margin:0;padding:0}html,:host{-webkit-text-size-adjust:100%;tab-size:4;line-height:1.5;font-family:var(--default-font-family,-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");font-feature-settings:var(--default-font-feature-settings,normal);font-variation-settings:var(--default-font-variation-settings,normal);-webkit-tap-highlight-color:transparent}hr{height:0;color:inherit;border-top-width:1px}abbr:where([title]){-webkit-text-decoration:underline dotted;text-decoration:underline dotted}h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}a{color:inherit;-webkit-text-decoration:inherit;-webkit-text-decoration:inherit;-webkit-text-decoration:inherit;text-decoration:inherit}b,strong{font-weight:bolder}code,kbd,samp,pre{font-family:var(--default-mono-font-family,ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);font-feature-settings:var(--default-mono-font-feature-settings,normal);font-variation-settings:var(--default-mono-font-variation-settings,normal);font-size:1em}small{font-size:80%}sub,sup{vertical-align:baseline;font-size:75%;line-height:0;position:relative}sub{bottom:-.25em}sup{top:-.5em}table{text-indent:0;border-color:inherit;border-collapse:collapse}:-moz-focusring:where(:not(iframe)){outline:auto}progress{vertical-align:baseline}summary{display:list-item}ol,ul,menu{list-style:none}img,svg,video,canvas,audio,iframe,embed,object{vertical-align:middle;display:block}img,video{max-width:100%;height:auto}button,input,select,optgroup,textarea{font:inherit;font-feature-settings:inherit;font-variation-settings:inherit;letter-spacing:inherit;color:inherit;opacity:1;background-color:#0000;border-radius:0}::file-selector-button{font:inherit;font-feature-settings:inherit;font-variation-settings:inherit;letter-spacing:inherit;color:inherit;opacity:1;background-color:#0000;border-radius:0}:where(select:is([multiple],[size])) optgroup{font-weight:bolder}:where(select:is([multiple],[size])) optgroup option{padding-inline-start:20px}::file-selector-button{margin-inline-end:4px}::placeholder{opacity:1}@supports (not ((-webkit-appearance:-apple-pay-button))) or (contain-intrinsic-size:1px){::placeholder{color:currentColor}@supports (color:color-mix(in lab, red, red)){::placeholder{color:color-mix(in oklab, currentcolor 50%, transparent)}}}textarea{resize:vertical}::-webkit-search-decoration{-webkit-appearance:none}::-webkit-date-and-time-value{min-height:1lh;text-align:inherit}::-webkit-datetime-edit{display:inline-flex}::-webkit-datetime-edit-fields-wrapper{padding:0}::-webkit-datetime-edit{padding-block:0}::-webkit-datetime-edit-year-field{padding-block:0}::-webkit-datetime-edit-month-field{padding-block:0}::-webkit-datetime-edit-day-field{padding-block:0}::-webkit-datetime-edit-hour-field{padding-block:0}::-webkit-datetime-edit-minute-field{padding-block:0}::-webkit-datetime-edit-second-field{padding-block:0}::-webkit-datetime-edit-millisecond-field{padding-block:0}::-webkit-datetime-edit-meridiem-field{padding-block:0}::-webkit-calendar-picker-indicator{line-height:1}:-moz-ui-invalid{box-shadow:none}button,input:where([type=button],[type=reset],[type=submit]){appearance:button}::file-selector-button{appearance:button}::-webkit-inner-spin-button{height:auto}::-webkit-outer-spin-button{height:auto}[hidden]:where(:not([hidden=until-found])){display:none!important}}@layer components;@layer utilities{.sr-only{clip-path:inset(50%);white-space:nowrap;border-width:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}.fixed{position:fixed}.right-4{right:calc(var(--spacing) * 4)}.bottom-4{bottom:calc(var(--spacing) * 4)}.z-30{z-index:30}.container{width:100%}@media (min-width:40rem){.container{max-width:40rem}}@media (min-width:48rem){.container{max-width:48rem}}@media (min-width:64rem){.container{max-width:64rem}}@media (min-width:80rem){.container{max-width:80rem}}@media (min-width:96rem){.container{max-width:96rem}}.m-auto{margin:auto}.mx-1{margin-inline:var(--spacing)}.mx-auto{margin-inline:auto}.-mt-0\.5{margin-top:calc(var(--spacing) * -.5)}.mt-0\.5{margin-top:calc(var(--spacing) * .5)}.mt-1{margin-top:var(--spacing)}.mt-1\.5{margin-top:calc(var(--spacing) * 1.5)}.mt-2{margin-top:calc(var(--spacing) * 2)}.mr-1\.5{margin-right:calc(var(--spacing) * 1.5)}.mr-auto{margin-right:auto}.mb-4{margin-bottom:calc(var(--spacing) * 4)}.mb-6{margin-bottom:calc(var(--spacing) * 6)}.ml-1{margin-left:var(--spacing)}.ml-auto{margin-left:auto}.block{display:block}.contents{display:contents}.flex{display:flex}.grid{display:grid}.hidden{display:none}.inline{display:inline}.table{display:table}.size-1\.5{width:calc(var(--spacing) * 1.5);height:calc(var(--spacing) * 1.5)}.size-2{width:calc(var(--spacing) * 2);height:calc(var(--spacing) * 2)}.size-3{width:calc(var(--spacing) * 3);height:calc(var(--spacing) * 3)}.size-4{width:calc(var(--spacing) * 4);height:calc(var(--spacing) * 4)}.size-6{width:calc(var(--spacing) * 6);height:calc(var(--spacing) * 6)}.size-8{width:calc(var(--spacing) * 8);height:calc(var(--spacing) * 8)}.h-5{height:calc(var(--spacing) * 5)}.h-\[65vh\]{height:65vh}.min-h-screen{min-height:100vh}.w-\[min\(1100px\,95vw\)\]{width:min(1100px,95vw)}.w-fit{width:fit-content}.w-full{width:100%}.w-px{width:1px}.max-w-7xl{max-width:var(--container-7xl)}.max-w-md{max-width:var(--container-md)}.min-w-0{min-width:0}.min-w-48{min-width:calc(var(--spacing) * 48)}.shrink-0{flex-shrink:0}.animate-pulse{animation:var(--animate-pulse)}.cursor-pointer{cursor:pointer}.resize{resize:both}.list-none{list-style-type:none}.flex-wrap{flex-wrap:wrap}.place-items-center{place-items:center}.items-center{align-items:center}.items-start{align-items:flex-start}.justify-between{justify-content:space-between}.justify-end{justify-content:flex-end}.gap-1{gap:var(--spacing)}.gap-1\.5{gap:calc(var(--spacing) * 1.5)}.gap-2{gap:calc(var(--spacing) * 2)}.gap-2\.5{gap:calc(var(--spacing) * 2.5)}.gap-3{gap:calc(var(--spacing) * 3)}.gap-4{gap:calc(var(--spacing) * 4)}:where(.space-y-3>:not(:last-child)){--tw-space-y-reverse:0;margin-block-start:calc(calc(var(--spacing) * 3) * var(--tw-space-y-reverse));margin-block-end:calc(calc(var(--spacing) * 3) * calc(1 - var(--tw-space-y-reverse)))}.gap-x-3{column-gap:calc(var(--spacing) * 3)}.gap-y-2{row-gap:calc(var(--spacing) * 2)}.truncate{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.overflow-auto{overflow:auto}.overflow-x-auto{overflow-x:auto}.rounded{border-radius:.25rem}.rounded-full{border-radius:3.40282e38px}.rounded-lg{border-radius:var(--radius-lg)}.rounded-md{border-radius:var(--radius-md)}.rounded-xl{border-radius:var(--radius-xl)}.border-t{border-top-style:var(--tw-border-style);border-top-width:1px}.border-b{border-bottom-style:var(--tw-border-style);border-bottom-width:1px}.border-line{border-color:var(--color-line)}.border-line\/70{border-color:#27272ab3}@supports (color:color-mix(in lab, red, red)){.border-line\/70{border-color:color-mix(in oklab, var(--color-line) 70%, transparent)}}.bg-accent{background-color:var(--color-accent)}.bg-accent\/10{background-color:#00bcfe1a}@supports (color:color-mix(in lab, red, red)){.bg-accent\/10{background-color:color-mix(in oklab, var(--color-accent) 10%, transparent)}}.bg-bad{background-color:var(--color-bad)}.bg-bad\/5{background-color:#ff65680d}@supports (color:color-mix(in lab, red, red)){.bg-bad\/5{background-color:color-mix(in oklab, var(--color-bad) 5%, transparent)}}.bg-bad\/10{background-color:#ff65681a}@supports (color:color-mix(in lab, red, red)){.bg-bad\/10{background-color:color-mix(in oklab, var(--color-bad) 10%, transparent)}}.bg-canvas{background-color:var(--color-canvas)}.bg-danger{background-color:var(--color-danger)}.bg-dim{background-color:var(--color-dim)}.bg-fg{background-color:var(--color-fg)}.bg-hover{background-color:var(--color-hover)}.bg-hover\/60{background-color:#27272a99}@supports (color:color-mix(in lab, red, red)){.bg-hover\/60{background-color:color-mix(in oklab, var(--color-hover) 60%, transparent)}}.bg-ok{background-color:var(--color-ok)}.bg-ok\/10{background-color:#00d2941a}@supports (color:color-mix(in lab, red, red)){.bg-ok\/10{background-color:color-mix(in oklab, var(--color-ok) 10%, transparent)}}.bg-ok\/40{background-color:#00d29466}@supports (color:color-mix(in lab, red, red)){.bg-ok\/40{background-color:color-mix(in oklab, var(--color-ok) 40%, transparent)}}.bg-pause{background-color:var(--color-pause)}.bg-raised{background-color:var(--color-raised)}.bg-raised\/40{background-color:#18181b66}@supports (color:color-mix(in lab, red, red)){.bg-raised\/40{background-color:color-mix(in oklab, var(--color-raised) 40%, transparent)}}.bg-warn{background-color:var(--color-warn)}.bg-warn\/10{background-color:#fcbb001a}@supports (color:color-mix(in lab, red, red)){.bg-warn\/10{background-color:color-mix(in oklab, var(--color-warn) 10%, transparent)}}.p-0{padding:0}.p-1{padding:var(--spacing)}.p-4{padding:calc(var(--spacing) * 4)}.px-1{padding-inline:var(--spacing)}.px-1\.5{padding-inline:calc(var(--spacing) * 1.5)}.px-2{padding-inline:calc(var(--spacing) * 2)}.px-2\.5{padding-inline:calc(var(--spacing) * 2.5)}.px-3{padding-inline:calc(var(--spacing) * 3)}.px-4{padding-inline:calc(var(--spacing) * 4)}.py-0\.5{padding-block:calc(var(--spacing) * .5)}.py-1{padding-block:var(--spacing)}.py-2{padding-block:calc(var(--spacing) * 2)}.py-3{padding-block:calc(var(--spacing) * 3)}.py-8{padding-block:calc(var(--spacing) * 8)}.py-16{padding-block:calc(var(--spacing) * 16)}.pt-4{padding-top:calc(var(--spacing) * 4)}.pt-5{padding-top:calc(var(--spacing) * 5)}.pr-4{padding-right:calc(var(--spacing) * 4)}.pr-6{padding-right:calc(var(--spacing) * 6)}.pb-2{padding-bottom:calc(var(--spacing) * 2)}.pl-4{padding-left:calc(var(--spacing) * 4)}.text-center{text-align:center}.text-left{text-align:left}.align-middle{vertical-align:middle}.font-mono{font-family:var(--font-mono)}.font-sans{font-family:var(--font-sans)}.text-2xl{font-size:var(--text-2xl);line-height:var(--tw-leading,var(--text-2xl--line-height))}.text-lg{font-size:var(--text-lg);line-height:var(--tw-leading,var(--text-lg--line-height))}.text-sm{font-size:var(--text-sm);line-height:var(--tw-leading,var(--text-sm--line-height))}.text-xs{font-size:var(--text-xs);line-height:var(--tw-leading,var(--text-xs--line-height))}.leading-relaxed{--tw-leading:var(--leading-relaxed);line-height:var(--leading-relaxed)}.font-medium{--tw-font-weight:var(--font-weight-medium);font-weight:var(--font-weight-medium)}.font-normal{--tw-font-weight:var(--font-weight-normal);font-weight:var(--font-weight-normal)}.font-semibold{--tw-font-weight:var(--font-weight-semibold);font-weight:var(--font-weight-semibold)}.tracking-normal{--tw-tracking:var(--tracking-normal);letter-spacing:var(--tracking-normal)}.tracking-tight{--tw-tracking:var(--tracking-tight);letter-spacing:var(--tracking-tight)}.tracking-wider{--tw-tracking:var(--tracking-wider);letter-spacing:var(--tracking-wider)}.\[overflow-wrap\:anywhere\]{overflow-wrap:anywhere}.whitespace-nowrap{white-space:nowrap}.whitespace-pre-wrap{white-space:pre-wrap}.text-accent{color:var(--color-accent)}.text-accent-fg{color:var(--color-accent-fg)}.text-bad-fg{color:var(--color-bad-fg)}.text-bad-soft{color:var(--color-bad-soft)}.text-fg{color:var(--color-fg)}.text-fg-soft{color:var(--color-fg-soft)}.text-fg-strong{color:var(--color-fg-strong)}.text-muted{color:var(--color-muted)}.text-ok-fg{color:var(--color-ok-fg)}.text-ok-soft{color:var(--color-ok-soft)}.text-pause-fg{color:var(--color-pause-fg)}.text-warn-fg{color:var(--color-warn-fg)}.text-warn-soft{color:var(--color-warn-soft)}.text-warn-strong{color:var(--color-warn-strong)}.text-white{color:var(--color-white)}.normal-case{text-transform:none}.uppercase{text-transform:uppercase}.underline{text-decoration-line:underline}.underline-offset-4{text-underline-offset:4px}.antialiased{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}.opacity-40{opacity:.4}.opacity-70{opacity:.7}.shadow-lg{--tw-shadow:0 10px 15px -3px var(--tw-shadow-color,#0000001a), 0 4px 6px -4px var(--tw-shadow-color,#0000001a);box-shadow:var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)}.ring-1{--tw-ring-shadow:var(--tw-ring-inset,) 0 0 0 calc(1px + var(--tw-ring-offset-width)) var(--tw-ring-color,currentcolor);box-shadow:var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)}.shadow-black\/40{--tw-shadow-color:#0006}@supports (color:color-mix(in lab, red, red)){.shadow-black\/40{--tw-shadow-color:color-mix(in oklab, color-mix(in oklab, var(--color-black) 40%, transparent) var(--tw-shadow-alpha), transparent)}}.ring-accent\/20{--tw-ring-color:#00bcfe33}@supports (color:color-mix(in lab, red, red)){.ring-accent\/20{--tw-ring-color:color-mix(in oklab, var(--color-accent) 20%, transparent)}}.ring-bad\/40{--tw-ring-color:#ff656866}@supports (color:color-mix(in lab, red, red)){.ring-bad\/40{--tw-ring-color:color-mix(in oklab, var(--color-bad) 40%, transparent)}}.ring-current{--tw-ring-color:currentcolor}.ring-danger{--tw-ring-color:var(--color-danger)}.ring-line{--tw-ring-color:var(--color-line)}.ring-line-strong{--tw-ring-color:var(--color-line-strong)}.ring-line-strong\/80{--tw-ring-color:#3f3f46cc}@supports (color:color-mix(in lab, red, red)){.ring-line-strong\/80{--tw-ring-color:color-mix(in oklab, var(--color-line-strong) 80%, transparent)}}.ring-ok\/40{--tw-ring-color:#00d29466}@supports (color:color-mix(in lab, red, red)){.ring-ok\/40{--tw-ring-color:color-mix(in oklab, var(--color-ok) 40%, transparent)}}.ring-warn\/30{--tw-ring-color:#fcbb004d}@supports (color:color-mix(in lab, red, red)){.ring-warn\/30{--tw-ring-color:color-mix(in oklab, var(--color-warn) 30%, transparent)}}.filter{filter:var(--tw-blur,) var(--tw-brightness,) var(--tw-contrast,) var(--tw-grayscale,) var(--tw-hue-rotate,) var(--tw-invert,) var(--tw-saturate,) var(--tw-sepia,) var(--tw-drop-shadow,)}.transition{transition-property:color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to,opacity,box-shadow,transform,translate,scale,rotate,filter,-webkit-backdrop-filter,backdrop-filter,display,content-visibility,overlay,pointer-events;transition-timing-function:var(--tw-ease,var(--default-transition-timing-function));transition-duration:var(--tw-duration,var(--default-transition-duration))}.transition-opacity{transition-property:opacity;transition-timing-function:var(--tw-ease,var(--default-transition-timing-function));transition-duration:var(--tw-duration,var(--default-transition-duration))}.group-aria-pressed\:inline-block:is(:where(.group)[aria-pressed=true] *){display:inline-block}.selection\:bg-accent\/30 ::selection{background-color:#00bcfe4d}@supports (color:color-mix(in lab, red, red)){.selection\:bg-accent\/30 ::selection{background-color:color-mix(in oklab, var(--color-accent) 30%, transparent)}}.selection\:bg-accent\/30::selection{background-color:#00bcfe4d}@supports (color:color-mix(in lab, red, red)){.selection\:bg-accent\/30::selection{background-color:color-mix(in oklab, var(--color-accent) 30%, transparent)}}.placeholder\:text-muted::placeholder{color:var(--color-muted)}.backdrop\:bg-black\/70::backdrop{background-color:#000000b3}@supports (color:color-mix(in lab, red, red)){.backdrop\:bg-black\/70::backdrop{background-color:color-mix(in oklab, var(--color-black) 70%, transparent)}}.empty\:hidden:empty{display:none}@media (hover:hover){.hover\:bg-accent\/20:hover{background-color:#00bcfe33}@supports (color:color-mix(in lab, red, red)){.hover\:bg-accent\/20:hover{background-color:color-mix(in oklab, var(--color-accent) 20%, transparent)}}.hover\:bg-danger-hover:hover{background-color:var(--color-danger-hover)}.hover\:bg-hover:hover{background-color:var(--color-hover)}.hover\:bg-ok\/10:hover{background-color:#00d2941a}@supports (color:color-mix(in lab, red, red)){.hover\:bg-ok\/10:hover{background-color:color-mix(in oklab, var(--color-ok) 10%, transparent)}}.hover\:bg-raised\/70:hover{background-color:#18181bb3}@supports (color:color-mix(in lab, red, red)){.hover\:bg-raised\/70:hover{background-color:color-mix(in oklab, var(--color-raised) 70%, transparent)}}.hover\:text-accent-soft:hover{color:var(--color-accent-soft)}.hover\:text-fg:hover{color:var(--color-fg)}.hover\:text-fg-strong:hover{color:var(--color-fg-strong)}}.focus\:not-sr-only:focus{clip-path:none;white-space:normal;width:auto;height:auto;margin:0;padding:0;position:static;overflow:visible}.focus\:fixed:focus{position:fixed}.focus\:top-3:focus{top:calc(var(--spacing) * 3)}.focus\:left-3:focus{left:calc(var(--spacing) * 3)}.focus\:z-50:focus{z-index:50}.focus\:rounded-md:focus{border-radius:var(--radius-md)}.focus\:bg-fg-strong:focus{background-color:var(--color-fg-strong)}.focus\:px-3:focus{padding-inline:calc(var(--spacing) * 3)}.focus\:py-2:focus{padding-block:calc(var(--spacing) * 2)}.focus\:text-sm:focus{font-size:var(--text-sm);line-height:var(--tw-leading,var(--text-sm--line-height))}.focus\:text-canvas:focus{color:var(--color-canvas)}.focus\:ring-accent:focus{--tw-ring-color:var(--color-accent)}.focus\:outline-none:focus{--tw-outline-style:none;outline-style:none}.focus-visible\:outline-2:focus-visible{outline-style:var(--tw-outline-style);outline-width:2px}.focus-visible\:-outline-offset-2:focus-visible{outline-offset:calc(2px * -1)}.focus-visible\:outline-offset-2:focus-visible{outline-offset:2px}.focus-visible\:outline-accent:focus-visible{outline-color:var(--color-accent)}.aria-disabled\:cursor-wait[aria-disabled=true]{cursor:wait}.aria-disabled\:opacity-40[aria-disabled=true]{opacity:.4}.aria-pressed\:bg-accent\/15[aria-pressed=true]{background-color:#00bcfe26}@supports (color:color-mix(in lab, red, red)){.aria-pressed\:bg-accent\/15[aria-pressed=true]{background-color:color-mix(in oklab, var(--color-accent) 15%, transparent)}}.aria-pressed\:bg-fg-strong[aria-pressed=true]{background-color:var(--color-fg-strong)}.aria-pressed\:text-accent-soft[aria-pressed=true]{color:var(--color-accent-soft)}.aria-pressed\:text-canvas[aria-pressed=true]{color:var(--color-canvas)}.aria-pressed\:ring-accent\/40[aria-pressed=true]{--tw-ring-color:#00bcfe66}@supports (color:color-mix(in lab, red, red)){.aria-pressed\:ring-accent\/40[aria-pressed=true]{--tw-ring-color:color-mix(in oklab, var(--color-accent) 40%, transparent)}}.aria-pressed\:ring-fg-strong[aria-pressed=true]{--tw-ring-color:var(--color-fg-strong)}@media (prefers-reduced-motion:reduce){.motion-reduce\:animate-none{animation:none}.motion-reduce\:transition-none{transition-property:none}}@media not all and (min-width:64rem){.max-lg\:block{display:block}.max-lg\:hidden{display:none}.max-lg\:size-11{width:calc(var(--spacing) * 11);height:calc(var(--spacing) * 11)}.max-lg\:min-h-11{min-height:calc(var(--spacing) * 11)}.max-lg\:w-11{width:calc(var(--spacing) * 11)}.max-lg\:justify-start{justify-content:flex-start}.max-lg\:gap-2{gap:calc(var(--spacing) * 2)}:where(.max-lg\:space-y-1\.5>:not(:last-child)){--tw-space-y-reverse:0;margin-block-start:calc(calc(var(--spacing) * 1.5) * var(--tw-space-y-reverse));margin-block-end:calc(calc(var(--spacing) * 1.5) * calc(1 - var(--tw-space-y-reverse)))}.max-lg\:p-0{padding:0}.max-lg\:px-3{padding-inline:calc(var(--spacing) * 3)}.max-lg\:px-4{padding-inline:calc(var(--spacing) * 4)}.max-lg\:py-3{padding-block:calc(var(--spacing) * 3)}.max-lg\:py-3\.5{padding-block:calc(var(--spacing) * 3.5)}.max-lg\:py-4{padding-block:calc(var(--spacing) * 4)}.max-lg\:pt-1{padding-top:var(--spacing)}.max-lg\:pt-2{padding-top:calc(var(--spacing) * 2)}.max-lg\:pl-5{padding-left:calc(var(--spacing) * 5)}.max-lg\:text-sm{font-size:var(--text-sm);line-height:var(--tw-leading,var(--text-sm--line-height))}.max-lg\:text-xs{font-size:var(--text-xs);line-height:var(--tw-leading,var(--text-xs--line-height))}.max-lg\:has-\[div\]\:block:has(:is(div)){display:block}}@media (min-width:40rem){.sm\:w-72{width:calc(var(--spacing) * 72)}}@media (min-width:64rem){.lg\:hidden{display:none}.lg\:w-9{width:calc(var(--spacing) * 9)}.lg\:w-20{width:calc(var(--spacing) * 20)}.lg\:max-w-\[24ch\]{max-width:24ch}.lg\:min-w-\[24ch\]{min-width:24ch}.lg\:truncate{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.lg\:text-left{text-align:left}.lg\:text-right{text-align:right}.lg\:\[direction\:rtl\]{direction:rtl}}.\[\&\:\:-webkit-details-marker\]\:hidden::-webkit-details-marker{display:none}}@media (prefers-color-scheme:light){:root{--color-canvas:oklch(98.5% 0 none);--color-raised:#fff;--color-hover:oklch(96.7% .001 286.375);--color-line:oklch(92% .004 286.32);--color-line-strong:oklch(87.1% .006 286.286);--color-dim:oklch(70.5% .015 286.067);--color-muted:oklch(44.2% .017 285.786);--color-fg-soft:oklch(37% .013 285.805);--color-fg:oklch(27.4% .006 286.033);--color-fg-strong:oklch(14.1% .005 285.823);--color-ok:oklch(69.6% .17 162.48);--color-ok-fg:oklch(50.8% .118 165.612);--color-ok-soft:oklch(43.2% .095 166.913);--color-warn:oklch(76.9% .188 70.08);--color-warn-fg:oklch(55.5% .163 48.998);--color-warn-soft:oklch(47.3% .137 46.201);--color-warn-strong:oklch(41.4% .112 45.904);--color-bad:oklch(63.7% .237 25.331);--color-bad-fg:oklch(50.5% .213 27.518);--color-bad-soft:oklch(44.4% .177 26.899);--color-danger:oklch(50.5% .213 27.518);--color-danger-hover:oklch(44.4% .177 26.899);--color-pause:oklch(60.6% .25 292.717);--color-pause-fg:oklch(49.1% .27 292.581);--color-accent:oklch(58.8% .158 241.966);--color-accent-fg:oklch(50% .134 242.749);--color-accent-soft:oklch(44.3% .11 240.79)}}@property --tw-space-y-reverse{syntax:"*";inherits:false;initial-value:0}@property --tw-border-style{syntax:"*";inherits:false;initial-value:solid}@property --tw-leading{syntax:"*";inherits:false}@property --tw-font-weight{syntax:"*";inherits:false}@property --tw-tracking{syntax:"*";inherits:false}@property --tw-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-shadow-color{syntax:"*";inherits:false}@property --tw-shadow-alpha{syntax:"<percentage>";inherits:false;initial-value:100%}@property --tw-inset-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-inset-shadow-color{syntax:"*";inherits:false}@property --tw-inset-shadow-alpha{syntax:"<percentage>";inherits:false;initial-value:100%}@property --tw-ring-color{syntax:"*";inherits:false}@property --tw-ring-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-inset-ring-color{syntax:"*";inherits:false}@property --tw-inset-ring-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-ring-inset{syntax:"*";inherits:false}@property --tw-ring-offset-width{syntax:"<length>";inherits:false;initial-value:0}@property --tw-ring-offset-color{syntax:"*";inherits:false;initial-value:#fff}@property --tw-ring-offset-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-blur{syntax:"*";inherits:false}@property --tw-brightness{syntax:"*";inherits:false}@property --tw-contrast{syntax:"*";inherits:false}@property --tw-grayscale{syntax:"*";inherits:false}@property --tw-hue-rotate{syntax:"*";inherits:false}@property --tw-invert{syntax:"*";inherits:false}@property --tw-opacity{syntax:"*";inherits:false}@property --tw-saturate{syntax:"*";inherits:false}@property --tw-sepia{syntax:"*";inherits:false}@property --tw-drop-shadow{syntax:"*";inherits:false}@property --tw-drop-shadow-color{syntax:"*";inherits:false}@property --tw-drop-shadow-alpha{syntax:"<percentage>";inherits:false;initial-value:100%}@property --tw-drop-shadow-size{syntax:"*";inherits:false}@property --tw-outline-style{syntax:"*";inherits:false;initial-value:solid}@keyframes pulse{50%{opacity:.5}}"""
PAGE = r"""<!doctype html>
<html lang="pt-BR" class="bg-canvas">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light">
<title>Docker GUI</title>
<style>/*CSS*/</style>
</head>
<body class="min-h-screen bg-canvas text-fg-soft antialiased selection:bg-accent/30">
<a href="#table" class="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-fg-strong focus:px-3 focus:py-2 focus:text-sm focus:text-canvas">Pular para a lista</a>
<main class="max-w-7xl mx-auto px-4 py-8">
  <header class="flex flex-wrap items-start justify-between gap-4 mb-6">
    <div>
      <h1 class="text-2xl font-semibold text-fg-strong tracking-tight flex items-center gap-2.5">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" class="size-6 text-accent"><path d="M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7z"/><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10"/></svg>
        Containers
      </h1>
      <div id="count" role="group" aria-label="Filtrar por estado" class="flex flex-wrap gap-1 mt-2 text-sm text-muted">Carregando…</div>
    </div>
    <div class="w-full sm:w-72">
      <label for="q" class="sr-only">Filtrar containers por nome, imagem ou projeto</label>
      <input id="q" type="search" placeholder="Filtrar por nome, imagem ou projeto…" aria-describedby="hint"
        class="w-full rounded-lg bg-raised ring-1 ring-line px-3 py-2 max-lg:py-3 text-sm text-fg-strong placeholder:text-muted focus:ring-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
      <p id="hint" class="mt-1.5 text-xs text-muted max-lg:hidden">Atalhos:
        <kbd class="font-mono text-xs px-1 rounded ring-1 ring-line-strong text-fg-soft">/</kbd> busca ·
        <kbd class="font-mono text-xs px-1 rounded ring-1 ring-line-strong text-fg-soft">↑</kbd>
        <kbd class="font-mono text-xs px-1 rounded ring-1 ring-line-strong text-fg-soft">↓</kbd> entre os botões Logs</p>
    </div>
  </header>
  <p id="shown" class="sr-only" aria-live="polite"></p>

  <div id="banner" role="alert" class="hidden mb-4 rounded-lg ring-1 ring-warn/30 bg-warn/10 px-4 py-3 text-sm"></div>

  <div id="table" tabindex="-1" class="rounded-xl ring-1 ring-line bg-raised/40 overflow-x-auto transition-opacity motion-reduce:transition-none focus:outline-none">
    <table role="table" aria-label="Containers" class="w-full text-left max-lg:block">
      <thead role="rowgroup" class="max-lg:hidden text-xs uppercase tracking-wider text-muted">
        <tr role="row"><th role="columnheader" scope="col" class="py-3 pl-4 font-medium">Nome</th><th role="columnheader" scope="col" class="font-medium">Imagem</th>
            <th role="columnheader" scope="col" class="font-medium">Status</th><th role="columnheader" scope="col" class="font-medium">Portas</th>
            <th role="columnheader" scope="col" class="pr-4 font-medium"><span class="sr-only">Ações</span></th></tr>
      </thead>
      <tbody id="rows" role="rowgroup" class="max-lg:block"></tbody>
    </table>
  </div>
</main>

<dialog id="dlg" aria-labelledby="dlg-title" class="m-auto w-[min(1100px,95vw)] rounded-xl bg-raised text-fg-soft ring-1 ring-line-strong backdrop:bg-black/70 p-0">
  <div class="px-4 py-3 border-b border-line space-y-3">
    <div class="flex items-start gap-3">
      <div class="mr-auto min-w-0">
        <h2 id="dlg-title" class="text-lg font-semibold text-fg-strong truncate">Logs · <span id="lt"></span></h2>
        <div id="dlg-status" class="text-sm mt-0.5"></div>
      </div>
      <button onclick="dlg.close(); afterClose()" aria-label="Fechar logs" class="shrink-0 grid place-items-center size-8 max-lg:size-11 rounded-md text-muted hover:text-fg-strong hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" class="size-4"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <span id="dlg-acts" class="contents"></span>
      <span aria-hidden="true" class="h-5 w-px bg-hover mx-1 max-lg:hidden"></span>
      <button id="refresh" onclick="refreshLogs()" class="px-2.5 py-1 max-lg:min-h-11 max-lg:px-4 max-lg:text-sm rounded-md text-xs font-medium ring-1 ring-line-strong/80 text-fg hover:bg-hover aria-disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Atualizar</button>
      <button id="follow" aria-pressed="false" onclick="toggleFollow()" class="group px-2.5 py-1 max-lg:min-h-11 max-lg:px-4 max-lg:text-sm rounded-md text-xs font-medium ring-1 ring-line-strong/80 text-fg hover:bg-hover aria-pressed:bg-accent/15 aria-pressed:text-accent-soft aria-pressed:ring-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"><span aria-hidden="true" class="hidden group-aria-pressed:inline-block size-1.5 mr-1.5 align-middle rounded-full bg-accent animate-pulse motion-reduce:animate-none"></span>Acompanhar ao vivo</button>
      <button onclick="copyLogs()" class="px-2.5 py-1 max-lg:min-h-11 max-lg:px-4 max-lg:text-sm rounded-md text-xs font-medium ring-1 ring-line-strong/80 text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Copiar</button>
      <span id="lmeta" class="ml-auto text-xs text-muted">Últimas 500 linhas</span>
    </div>
    <div id="dlg-msg" role="status" aria-live="polite" class="empty:hidden"></div>
  </div>
  <pre id="lb" tabindex="0" aria-label="Saída dos logs" class="focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent h-[65vh] overflow-auto p-4 text-xs leading-relaxed font-mono text-fg-soft whitespace-pre-wrap [overflow-wrap:anywhere]"></pre>
</dialog>

<div id="toast" role="status" aria-live="polite" class="fixed bottom-4 right-4 max-w-md"></div>

<script>
"use strict";
(() => {
  // src/format.ts
  var esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  var EXIT = {
    1: "erro da aplicação",
    125: "falha do próprio docker run",
    126: "comando sem permissão de execução",
    127: "comando não encontrado",
    137: "morto à força ou sem memória (OOM)",
    139: "falha de segmentação",
    143: "encerrado por SIGTERM"
  };
  var UNIT = { second: "s", minute: "min", hour: "h", day: "d", week: "sem", month: "mês", year: "ano" };
  var restartCode = (c) => +(c.Status.match(/^Restarting \((\d+)\)/)?.[1] ?? 0);
  function tone(c) {
    if (c.State === "running") return /\(unhealthy\)/.test(c.Status) ? "warn" : /health: starting/.test(c.Status) ? "check" : "ok";
    if (c.State === "paused") return "pause";
    if (c.State === "restarting") return restartCode(c) ? "bad" : "busy";
    if (c.State === "dead" || /^Exited \((?!0\))/.test(c.Status)) return "bad";
    return "off";
  }
  var BUCKET_OF_STATE = { running: "rodando", paused: "pausado", restarting: "reiniciando" };
  var bucket = (c) => ["bad", "warn"].includes(tone(c)) ? "problema" : BUCKET_OF_STATE[c.State] || "parado";
  var isProblem = (c) => bucket(c) === "problema";
  var project = (c) => (c.Labels || "").match(/(?:^|,)com\.docker\.compose\.project=([^,]*)/)?.[1] || "";
  function dur(s) {
    if (/less than a second/i.test(s)) return "<1 s";
    const m = s.match(/(about )?(an?|\d+) (second|minute|hour|day|week|month|year)/i);
    if (!m) return s;
    const n = /^an?$/i.test(m[2]) ? 1 : +m[2], u = UNIT[m[3].toLowerCase()];
    return `${m[1] ? "~" : ""}${n} ${n > 1 && u === "mês" ? "meses" : n > 1 && u === "ano" ? "anos" : u}`;
  }
  function status(c) {
    const s = c.Status, t = dur(s.replace(/^(Up|Exited \(\d+\)|Restarting \(\d+\))\s*/, "").replace(/ \(.*\)$/, "").replace(/ ago$/, ""));
    const h = /\(unhealthy\)/.test(s) ? " · healthcheck falhando" : /health: starting/.test(s) ? " · verificando saúde" : /\(healthy\)/.test(s) ? " · saudável" : "";
    if (c.State === "running") return [`Rodando há ${t}${h}`];
    if (c.State === "paused") return ["Pausado"];
    if (c.State === "restarting") return restartCode(c) ? [`Reiniciando em loop · saiu com código ${restartCode(c)}`, EXIT[restartCode(c)]] : ["Reiniciando…"];
    if (c.State === "created") return ["Criado, nunca iniciado"];
    if (c.State === "dead") return ["Morto · só dá para remover"];
    const code = +(s.match(/^Exited \((\d+)\)/)?.[1] ?? 0);
    return code ? [`Saiu com código ${code} há ${t}`, EXIT[code]] : [`Parado há ${t}`];
  }
  var MAX_EXPAND = 8;
  var ports = (p) => {
    const out = [];
    for (const [, h1, h2 = h1, c1, c2 = c1, proto] of p.matchAll(/:(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(\w+)/g)) {
      const n = +h2 - +h1;
      if (n === +c2 - +c1 && n < MAX_EXPAND) for (let i = 0; i <= n; i++) out.push([`${+h1 + i}`, `${+c1 + i}`, proto]);
      else out.push([h1 === h2 ? h1 : `${h1}-${h2}`, c1 === c2 ? c1 : `${c1}-${c2}`, proto]);
    }
    return [...new Set(out.map((x) => x.join(":")))].map((s) => s.split(":"));
  };
  var shortImage = (img) => img.replace(/^[^/]+[.:][^/]*\//, "");
  var hasHealth = (c) => /\((un)?healthy\)|health: starting/.test(c.Status);

  // src/app.ts
  var $ = (s) => document.querySelector(s);
  var TOKEN = (() => {
    const t = new URLSearchParams(location.hash.slice(1)).get("t");
    try {
      if (t) localStorage.setItem("docker-gui-token", t);
      return t || localStorage.getItem("docker-gui-token") || "";
    } catch {
      return t || "";
    }
  })();
  var api = (path, opts = {}) => fetch(path, { ...opts, headers: { ...opts.headers, "X-Docker-GUI-Token": TOKEN } });
  var LABEL = { start: "Iniciar", stop: "Parar", restart: "Reiniciar", pause: "Pausar", unpause: "Retomar", logs: "Logs", remove: "Remover" };
  var VERB = { start: "Iniciando…", stop: "Parando…", restart: "Reiniciando…", pause: "Pausando…", unpause: "Retomando…", remove: "Removendo…" };
  var DONE = { start: "iniciado", stop: "parado", restart: "reiniciado", pause: "pausado", unpause: "retomado", remove: "removido" };
  var PRIMARY = { running: "stop", restarting: "stop", paused: "unpause", exited: "start", created: "start" };
  var SECONDARY = { running: "restart", paused: "stop" };
  var STOPPABLE = ["running", "paused", "restarting"];
  var removable = (c) => !STOPPABLE.includes(c.State);
  var TONE = {
    ok: ["bg-ok", "text-ok-fg"],
    check: ["bg-ok/40", "text-ok-soft"],
    warn: ["bg-warn", "text-warn-fg"],
    busy: ["bg-fg animate-pulse motion-reduce:animate-none", "text-fg-strong"],
    bad: ["bg-bad", "text-bad-fg"],
    pause: ["bg-pause", "text-pause-fg"],
    off: ["bg-dim", "text-muted"]
  };
  var NOT_HTTP = /* @__PURE__ */ new Set([
    21,
    22,
    25,
    53,
    110,
    143,
    465,
    587,
    993,
    995,
    1025,
    1433,
    1521,
    2181,
    3306,
    4222,
    5432,
    5672,
    6379,
    9042,
    9092,
    11211,
    27017
  ]);
  var BUCKETS = [
    ["problema", "com problema", "com problema", "text-bad-fg"],
    ["rodando", "rodando bem", "rodando bem", "text-fg"],
    ["pausado", "pausado", "pausados", "text-fg"],
    ["reiniciando", "reiniciando", "reiniciando", "text-fg"],
    ["parado", "parado", "parados", "text-fg"]
  ];
  var TOUCH = matchMedia("(pointer: coarse)").matches;
  var PROBLEM_TXT = { docker: "Docker fora do ar", perm: "sem acesso ao Docker", server: "sem conexão", auth: "sem token" };
  var BTN = "px-2.5 py-1 max-lg:min-h-11 max-lg:px-4 max-lg:text-sm rounded-md text-xs font-medium ring-1 ring-line-strong/80 transition motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-disabled:opacity-40 aria-disabled:cursor-wait";
  var data = [];
  var busy = /* @__PURE__ */ new Map();
  var errors = /* @__PURE__ */ new Map();
  var lastOk = null;
  var problem = "";
  var problemKind = "";
  var only = "";
  var toastTimer;
  var logId = null;
  var follow = null;
  var arming = null;
  var lastSay = "";
  var dirty = false;
  var toastFn = null;
  function toast(msg, ok = false, action = null) {
    toastFn = action?.[1] || null;
    const html = `<div class="flex items-center gap-3 rounded-lg ring-1 text-sm px-4 py-3 ${ok ? "bg-ok/10 ring-ok/40 text-ok-soft" : "bg-bad/10 ring-bad/40 text-bad-soft"}"><span>${esc(msg)}</span>${action ? `<button onclick="runToastAction()"
      class="shrink-0 font-medium underline underline-offset-4 hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-accent rounded">${esc(action[0])}</button>
      <kbd class="shrink-0 font-mono text-xs px-1 rounded ring-1 ring-current opacity-70" title="Atalho">Z</kbd>` : ""}</div>`;
    ($("#dlg").open ? $("#dlg-msg") : $("#toast")).innerHTML = html;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      $("#toast").innerHTML = $("#dlg-msg").innerHTML = "";
      toastFn = null;
    }, action ? 1e4 : ok ? 4e3 : 8e3);
  }
  function runToastAction() {
    const f = toastFn;
    toastFn = null;
    $("#toast").innerHTML = "";
    f?.();
  }
  function showProblem(p) {
    if ((p?.[0] || "") === problem) return;
    problem = p?.[0] || "";
    problemKind = p?.[3] || "";
    $("#banner").classList.toggle("hidden", !p);
    $("#table").classList.toggle("opacity-40", !!p);
    $("#table").inert = !!p;
    if (p) $("#banner").innerHTML = `<p class="font-medium text-warn-strong">${p[0]}</p>
    <p class="mt-0.5 text-warn-soft">${p[1]}</p>
    <details class="mt-2 text-xs text-warn-soft"><summary class="cursor-pointer w-fit py-1 max-lg:py-3.5 rounded focus-visible:outline-2 focus-visible:outline-accent">Detalhes técnicos</summary>
    <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono">${esc(p[2])}</pre></details>`;
    renderCount();
    if (!lastOk) render();
  }
  async function load() {
    try {
      const r = await api("/api/containers"), j = await r.json();
      if (r.status === 401) return showProblem([
        "Esta aba não tem o token do Docker GUI.",
        'Abra o link com <code class="font-mono">#t=…</code> que aparece no terminal onde você rodou <code class="font-mono">python3 docker_gui.py</code>. O token muda a cada execução.',
        j,
        "auth"
      ]);
      if (!r.ok) return showProblem(/permission denied/i.test(String(j)) ? ["Seu usuário não tem acesso ao Docker.", 'Rode <code class="font-mono">sudo usermod -aG docker $USER</code> e entre de novo na sessão.', j, "perm"] : ["Não consegui falar com o Docker.", 'O daemon está rodando? Verifique com <code class="font-mono">systemctl status docker</code>.', j, "docker"]);
      const first = !lastOk;
      lastOk = /* @__PURE__ */ new Date();
      if (first || JSON.stringify(j) !== JSON.stringify(data)) {
        data = j;
        if (selectingRows()) dirty = true;
        else render();
      }
      showProblem(null);
    } catch (e) {
      showProblem([
        lastOk ? "O servidor do Docker GUI parou de responder." : "Não consegui conectar ao servidor do Docker GUI.",
        'Rode <code class="font-mono">python3 docker_gui.py</code> de novo; a página volta sozinha.',
        e.message,
        "server"
      ]);
    }
  }
  function renderCount() {
    const n = (k) => data.filter((c) => bucket(c) === k).length, running = data.filter((c) => c.State === "running").length;
    const problemTxt = problemKind ? PROBLEM_TXT[problemKind] : "";
    document.title = !lastOk && !problem ? "Docker GUI" : !problem ? `Docker GUI · ${running} rodando${n("problema") ? ` · ${n("problema")} com problema` : ""}` : `Docker GUI · ${problemTxt}`;
    if (problem) {
      const t = lastOk?.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      $("#count").textContent = lastOk ? `Desatualizado · dados de ${t}` : problemTxt[0].toUpperCase() + problemTxt.slice(1);
      return;
    }
    const pill = "rounded-md px-2 py-0.5 max-lg:py-3 focus-visible:outline-2 focus-visible:outline-accent";
    $("#count").innerHTML = (BUCKETS.filter(([k]) => n(k) || only === k).map(
      ([k, one, many, color]) => `<button data-id="count-${k}" data-a="filter" aria-pressed="${only === k}" onclick="filterBy('${k}')"
      class="${pill} ring-1 ring-line hover:bg-hover aria-pressed:bg-fg-strong aria-pressed:text-canvas aria-pressed:ring-fg-strong ${color}">${n(k)} ${n(k) === 1 ? one : many}</button>`
    ).join("") || "<span>0 containers</span>") + (only || $("#q").value.trim() ? `<button data-id="count-clear" data-a="filter" onclick="clearFilters()" class="${pill} text-accent-fg underline underline-offset-4 hover:text-accent-soft">Limpar filtros</button>` : "");
  }
  function filterBy(k) {
    only = only === k ? "" : k;
    render();
  }
  function clearFilters() {
    only = "";
    $("#q").value = "";
    render();
    $("#q").focus();
  }
  function saveHash() {
    const h = new URLSearchParams(), q = $("#q").value.trim();
    if (only) h.set("estado", only);
    if (q) h.set("q", q);
    history.replaceState(null, "", h.size ? "#" + h : location.pathname);
  }
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    only = BUCKETS.find(([k]) => k === h.get("estado"))?.[0] || "";
    $("#q").value = h.get("q") || "";
  }
  function copyAddr(h) {
    navigator.clipboard.writeText(`localhost:${h}`).then(() => toast(`Copiado: localhost:${h}`, true), () => toast("Não consegui copiar."));
  }
  function portChip(c, [h, p, proto]) {
    const label = `${h}→${p}${proto === "tcp" ? "" : "/" + proto}`, svg = 'aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="inline size-3 ml-1 -mt-0.5"';
    const base = "whitespace-nowrap font-mono text-xs px-1.5 py-0.5 max-lg:text-xs max-lg:px-3 max-lg:py-3.5 rounded ring-1 focus-visible:outline-2 focus-visible:outline-accent";
    if (h.includes("-")) return `<span title="Faixa de portas: ${h} do host → ${p} do container"
    class="${base} bg-hover/60 text-fg-soft ring-line-strong">${label}</span>`;
    return c.State === "running" && proto === "tcp" && !NOT_HTTP.has(+p) ? `<a href="http://localhost:${h}" target="_blank" rel="noopener" aria-label="Abrir localhost:${h} em nova aba (porta ${p} do container)"
        title="Abrir no navegador" class="${base} bg-accent/10 text-accent-fg ring-accent/20 hover:bg-accent/20">${label}<svg ${svg}><path d="M6 3h7v7M13 3 4 12"/></svg></a>` : `<button onclick="copyAddr('${h}')" aria-label="Copiar localhost:${h} (porta ${p}/${proto} do container)" title="Copiar localhost:${h}"
        class="${base} bg-hover/60 text-fg-soft ring-line-strong hover:bg-hover">${label}<svg ${svg}><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5"/><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5"/></svg></button>`;
  }
  function errHtml(c) {
    const e = errors.get(c.ID);
    if (!e) return "";
    if (e.state !== c.State) {
      errors.delete(c.ID);
      return "";
    }
    return `<details data-keep="err" class="mt-1 text-xs text-bad-fg"><summary class="cursor-pointer w-fit py-1 max-lg:py-3.5 rounded focus-visible:outline-2 focus-visible:outline-accent">Falhou ao ${e.what.toLowerCase()} · ver erro</summary>
    <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-bad-soft">${esc(e.msg)}</pre></details>`;
  }
  var health = {};
  async function loadHealth(id) {
    const c = data.find((c2) => c2.ID === id);
    if (!c || health[id + c.Status]) return;
    let txt;
    try {
      const r = await api("/api/health/" + id), h = await r.json(), last = r.ok ? h?.Log?.at(-1) : void 0;
      txt = !r.ok ? `Não consegui ler o healthcheck: ${h}` : last ? `código ${last.ExitCode} · ${last.Output.trim() || "(sem saída)"}` : "Nenhum probe rodou ainda.";
    } catch {
      txt = "Não consegui ler o healthcheck.";
    }
    health[id + c.Status] = txt;
    render();
  }
  var rowCache = /* @__PURE__ */ new Map();
  function row(c, withProject = false) {
    const sig = JSON.stringify([c, withProject, busy.get(c.ID), arming?.id === c.ID, errors.get(c.ID), health[c.ID + c.Status], TOUCH]);
    const hit = rowCache.get(c.ID);
    if (hit?.sig === sig) return hit.html;
    const html = rowHtml(c, withProject);
    rowCache.set(c.ID, { sig, html });
    return html;
  }
  function rowHtml(c, withProject) {
    const b = busy.get(c.ID), t = TONE[b ? "busy" : tone(c)], st = status(c), pp = ports(c.Ports), p = project(c);
    const armed = arming?.id === c.ID, prim = PRIMARY[c.State], sec = SECONDARY[c.State];
    const slot = (w = "lg:w-20") => `<span aria-hidden="true" class="${w} shrink-0 max-lg:hidden"></span>`;
    const btn = (a, cls = "text-fg hover:bg-hover", text = LABEL[a], aria = `${LABEL[a]} ${esc(c.Names)}`) => `<button data-id="${c.ID}" data-a="${a}" ${b && a !== "logs" ? 'aria-disabled="true"' : ""}
      aria-label="${aria}" aria-describedby="st-${c.ID}" onclick="act('${a}','${c.ID}')" class="lg:w-20 shrink-0 ${BTN} ${cls}">${text}</button>`;
    const more = [
      sec && [sec, LABEL[sec]],
      c.State === "running" && ["pause", "Pausar"],
      c.State === "running" && ["exec", "Copiar docker exec"],
      removable(c) && ["remove", "Remover…"]
    ].filter((x) => !!x);
    const item = "block w-full text-left px-3 py-2 max-lg:py-3 rounded-md text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent";
    const menu = !more.length ? slot("lg:w-9") : `<details data-keep="menu" class="shrink-0" ontoggle="placeMenu(this)">
      <summary data-id="${c.ID}" data-a="menu" aria-label="Mais ações para ${esc(c.Names)}" ${b ? 'aria-disabled="true"' : ""}
        class="list-none [&::-webkit-details-marker]:hidden cursor-pointer grid place-items-center lg:w-9 max-lg:w-11 ${BTN} text-fg hover:bg-hover">
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" class="size-4"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg></summary>
      <div class="fixed z-30 min-w-48 rounded-lg bg-raised ring-1 ring-line-strong p-1 shadow-lg shadow-black/40">
        ${more.map(([a, text]) => `<button data-id="${c.ID}" data-a="m-${a}" ${b ? 'aria-disabled="true"' : ""} onclick="menuPick(this); ${a === "exec" ? `copyExec('${c.ID}')` : `act('${a}','${c.ID}')`}"
          class="${item} ${a === "remove" ? "text-bad-fg" : "text-fg"}">${text}</button>`).join("")}
      </div></details>`;
    const healthBox = hasHealth(c) && !b ? `<details data-keep="health" class="mt-1 text-xs" ontoggle="this.open && loadHealth('${c.ID}')">
      <summary class="cursor-pointer w-fit py-1 max-lg:py-3.5 rounded focus-visible:outline-2 focus-visible:outline-accent text-muted hover:text-fg">Ver último healthcheck</summary>
      <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-fg-soft">${esc(health[c.ID + c.Status] || "Carregando…")}</pre></details>` : "";
    return `<tr data-row data-key="c:${c.ID}" role="row" class="border-t border-line/70 hover:bg-raised/70 transition motion-reduce:transition-none max-lg:block max-lg:px-4 max-lg:py-4 max-lg:space-y-1.5">
    <th role="rowheader" scope="row" class="py-3 pl-4 pr-6 max-lg:block max-lg:p-0 text-left font-normal"><div class="flex items-center gap-3">
      <span aria-hidden="true" class="size-2 shrink-0 rounded-full ${t[0]}"></span>
      <div class="min-w-0"><div class="font-medium text-fg-strong lg:truncate lg:max-w-[24ch]" title="${esc(c.Names)}">${esc(c.Names)}</div>
           <div class="text-xs font-mono text-muted">${c.ID.slice(0, 12)}${withProject && p ? `<span class="font-sans"> · ${esc(p)}</span>` : ""}</div></div></div></th>
    <td role="cell" class="font-mono text-xs text-muted pr-4 max-lg:block max-lg:p-0 max-lg:pl-5 [overflow-wrap:anywhere]">
      <span class="sr-only lg:hidden">Imagem: </span><div class="lg:truncate lg:max-w-[24ch] lg:[direction:rtl] lg:text-left" title="${esc(c.Image)}"><bdi dir="ltr">${esc(shortImage(c.Image))}</bdi></div></td>
    <td role="cell" class="text-sm pr-4 lg:min-w-[24ch] max-lg:block max-lg:p-0 max-lg:pl-5" title="${esc(c.Status)}">
      <span id="st-${c.ID}" class="${t[1]}">${b ? VERB[b] : esc(st[0])}${st[1] && !b ? `<span class="block text-xs text-muted">${st[1]}</span>` : ""}</span>${b ? "" : errHtml(c) + healthBox}</td>
    <td role="cell" class="pr-4 max-lg:hidden max-lg:has-[div]:block max-lg:p-0 max-lg:pl-5 max-lg:pt-1">${pp.length ? `<div class="flex flex-wrap gap-1 max-lg:gap-2">${pp.map((x) => portChip(c, x)).join("")}</div>` : ""}</td>
    <td role="cell" class="pr-4 max-lg:block max-lg:p-0 max-lg:pt-2"><div class="flex justify-end max-lg:justify-start items-center gap-1.5 max-lg:gap-2">
      ${prim ? btn(prim, prim === "start" ? "text-ok-fg hover:bg-ok/10" : void 0) : slot()}${btn("logs")}
      ${armed ? btn("remove", "bg-danger text-white ring-danger hover:bg-danger-hover", "Confirmar", `Confirmar remoção de ${esc(c.Names)}`) : menu}
    </div>${armed ? `<p aria-hidden="true" class="mt-1.5 text-xs text-bad-soft lg:text-right">Apagar de vez? Os volumes ficam. ${TOUCH ? "Cancela sozinho em 8 s." : "Esc cancela."}</p>` : ""}</td></tr>`;
  }
  function menuPick(el) {
    const sum = el.closest("details").querySelector("summary");
    closeMenus();
    sum.focus();
  }
  function placeMenu(d) {
    if (!d.open) return;
    const r = d.querySelector("summary").getBoundingClientRect(), m = d.querySelector("div");
    const left = Math.min(Math.max(8, r.right - m.offsetWidth), innerWidth - m.offsetWidth - 8);
    const top = r.bottom + 4 + m.offsetHeight > innerHeight ? r.top - 4 - m.offsetHeight : r.bottom + 4;
    Object.assign(m.style, { left: left + "px", top: top + "px" });
  }
  addEventListener("resize", () => closeMenus());
  addEventListener("scroll", () => closeMenus(), true);
  function closeMenus(except) {
    document.querySelectorAll('details[data-keep="menu"][open]').forEach((d) => d !== except && d.removeAttribute("open"));
  }
  document.addEventListener("click", (e) => closeMenus(e.target instanceof Element ? e.target.closest('details[data-keep="menu"]') : null));
  var bandHead = (text, cls) => `<tr data-key="h:attn" role="row" class="max-lg:block"><th role="columnheader" colspan="5" scope="colgroup"
  class="max-lg:block px-4 pt-4 pb-2 text-left text-xs font-medium uppercase tracking-wider border-t border-line/70 ${cls}">${text}</th></tr>`;
  function groupHead(k, label) {
    const all = data.filter((c) => project(c) === k), on = all.filter((c) => c.State === "running").length;
    const anyBusy = all.some((c) => busy.has(c.ID));
    const inBand = all.filter(isProblem).length;
    const sbtn = (a, n, text) => k && n ? `<button data-id="stack-${esc(k)}" data-a="${a}" data-p="${esc(k)}" ${anyBusy ? 'aria-disabled="true"' : ""}
      aria-label="${text} do projeto ${esc(k)} (${n})" title="${esc(stackList(a, k).map((c) => c.Names).join(", "))}" onclick="stackAct('${a}', this.dataset.p)" class="${BTN} text-fg hover:bg-hover normal-case tracking-normal">${text} (${n})</button>` : "";
    return `<tr data-key="g:${esc(k)}" role="row" class="max-lg:block"><th role="columnheader" colspan="5" scope="colgroup" class="max-lg:block px-4 pt-5 pb-2 text-left font-normal border-t border-line/70">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span class="text-xs font-medium uppercase tracking-wider text-fg">${label}</span>
      ${k ? `<span class="text-xs text-muted">compose · ${on} de ${all.length} rodando</span>` : ""}
      ${k && inBand ? `<span class="text-xs text-bad-fg">${inBand} na faixa de atenção ↑</span>` : ""}
      <span class="ml-auto flex flex-wrap gap-1.5">${STACK.map(([a, text]) => sbtn(a, stackList(a, k).length, text)).join("")}</span>
    </div></th></tr>`;
  }
  function render() {
    const q = $("#q").value.trim().toLowerCase();
    const rows = data.filter((c) => (!only || bucket(c) === only) && [c.Names, c.Image, project(c)].join(" ").toLowerCase().includes(q)).sort((a, b) => a.Names.localeCompare(b.Names));
    const attn = rows.filter(isProblem), groups = /* @__PURE__ */ new Map();
    for (const c of rows) if (!isProblem(c)) groups.set(project(c), [...groups.get(project(c)) || [], c]);
    for (const c of attn) if (project(c) && !groups.has(project(c))) groups.set(project(c), []);
    const keys = [...groups.keys()].sort((a, b) => Number(a === "") - Number(b === "") || a.localeCompare(b));
    const heads = attn.length || keys.length > 1 || keys[0];
    const label = only ? BUCKETS.find(([k]) => k === only)[1] + " " : "";
    const f = document.activeElement?.dataset;
    patchRows(rows.length ? [
      ...attn.length ? [bandHead(`Precisa de atenção · ${attn.length}`, "text-bad-fg bg-bad/5"), ...attn.map((c) => row(c, true))] : [],
      ...keys.flatMap((k) => [
        ...heads ? [groupHead(k, k ? esc(k) : keys.length > 1 ? "Sem projeto compose" : "Demais containers")] : [],
        ...groups.get(k).map((c) => row(c))
      ])
    ] : [`<tr data-key="empty" role="row" class="max-lg:block"><td role="cell" colspan="5" class="max-lg:block py-16 px-4 text-center text-muted">${!lastOk ? problem ? "Sem dados ainda." : "Carregando…" : !data.length ? 'Nenhum container ainda. Crie um com <code class="font-mono">docker run</code>.' : `Nenhum container ${label}${q ? `corresponde a “${esc(q)}”` : "agora"}.`}</td></tr>`]);
    dirty = false;
    renderCount();
    renderDlg();
    if (f?.id) refocus(f.id, f.a);
    saveHash();
    const say = arming ? `Clique em Confirmar para apagar ${arming.name} de vez. Os volumes não são afetados. ${TOUCH ? "Cancela sozinho em 8 segundos." : "Esc cancela."}` : q || only ? `${rows.length} de ${data.length} containers` : "";
    if (say !== lastSay) $("#shown").textContent = lastSay = say;
  }
  function refocus(id, a) {
    const q = (sel) => document.querySelector(sel);
    const groupLogs = () => {
      for (let tr = q(`[data-key="g:${id.slice(6)}"]`)?.nextElementSibling; tr?.dataset.row !== void 0; tr = tr.nextElementSibling) {
        const l = tr.querySelector('[data-a="logs"]');
        if (l) return l;
      }
    };
    (q(`[data-id="${id}"][data-a="${a}"]`) ?? (["m-remove", "menu"].includes(a ?? "") ? q(`[data-id="${id}"][data-a="remove"]`) : null) ?? q(`[data-id="${id}"][data-a="logs"]`) ?? (id === "dlg" ? $("#lb") : null) ?? (id.startsWith("stack-") ? groupLogs() : null) ?? q(`[data-id="${id}"]`))?.focus();
  }
  function patchRows(htmls) {
    const tb = $("#rows"), old = new Map([...tb.children].map((tr) => [tr.dataset.key, tr]));
    let prev = null;
    for (const html of htmls) {
      const key = html.match(/data-key="([^"]*)"/)[1];
      let tr = old.get(key);
      old.delete(key);
      if (tr?._html !== html) {
        const tpl = document.createElement("template");
        tpl.innerHTML = html.trim();
        const fresh = tpl.content.firstElementChild;
        fresh._html = html;
        if (tr) {
          const open = [...tr.querySelectorAll("details[open]")].map((d) => d.dataset.keep);
          fresh.querySelectorAll("details[data-keep]").forEach((d) => open.includes(d.dataset.keep) && d.setAttribute("open", ""));
          tr.replaceWith(fresh);
        }
        tr = fresh;
      }
      const want = prev ? prev.nextElementSibling : tb.firstElementChild;
      if (want !== tr) tb.insertBefore(tr, want);
      prev = tr;
    }
    old.forEach((tr) => tr.remove());
  }
  var selectingRows = () => {
    const s = getSelection();
    return !!s?.toString() && $("#rows").contains(s.anchorNode);
  };
  document.addEventListener("selectionchange", () => {
    if (dirty && !selectingRows()) render();
  });
  async function run(a, c) {
    errors.delete(c.ID);
    busy.set(c.ID, a);
    render();
    try {
      const r = await api(`/api/${a}/${c.ID}`, { method: "POST" });
      const msg = await r.json();
      if (!r.ok) errors.set(c.ID, { msg: msg || "erro sem mensagem", state: c.State, what: LABEL[a] });
      return r.ok;
    } catch {
      errors.set(c.ID, { msg: "Sem resposta do servidor do Docker GUI.", state: c.State, what: LABEL[a] });
      return false;
    } finally {
      busy.delete(c.ID);
      render();
    }
  }
  async function act(a, id) {
    if (a === "logs") return logs(id);
    const c = data.find((c2) => c2.ID === id);
    if (!c || busy.has(id)) return;
    if (a === "remove" && arming?.id !== id) {
      disarm(false);
      arming = { id, name: c.Names, at: Date.now(), timer: setTimeout(armTick, 8e3) };
      render();
      return;
    }
    if (a === "remove" && arming && Date.now() - arming.at < 600) return;
    if (a === "remove") disarm(false);
    const trs = [...document.querySelectorAll("#rows tr[data-row]")], i = trs.findIndex((tr) => tr.dataset.key === "c:" + id);
    const near = (trs[i + 1] || trs[i - 1])?.dataset.key?.slice(2);
    const done = run(a, c);
    $("#shown").textContent = `${VERB[a]} ${c.Names}`;
    if (!await done) {
      toast(`Não deu para ${LABEL[a].toLowerCase()} ${c.Names}. O erro ficou na linha.`);
      return load();
    }
    if (!UP.includes(a)) {
      toast(`${c.Names} ${DONE[a]}.`, true, a === "pause" ? ["Retomar", () => act("unpause", id)] : null);
      await load();
      if (a === "remove") (document.querySelector(`[data-id="${near}"][data-a="logs"]`) || $("#q")).focus();
      return;
    }
    toast(`${c.Names} ${DONE[a]}, conferindo se ficou de pé…`, true);
    confirmUp([c.ID]);
  }
  var UP = ["start", "restart", "unpause"];
  async function confirmUp(ids) {
    await new Promise((r) => setTimeout(r, 3e3));
    await load();
    const cs = ids.map((id) => data.find((c) => c.ID === id)).filter((c) => !!c);
    const fell = cs.filter((c) => c.State !== "running" || isProblem(c));
    if (!fell.length) return toast(cs.length === 1 ? `${cs[0].Names} está de pé.` : `Os ${cs.length} containers estão de pé.`, true);
    if (fell.length === 1) toast(`${fell[0].Names} subiu mas não ficou bem: ${status(fell[0])[0]}.`, false, ["Ver logs", () => logs(fell[0].ID)]);
    else toast(`${fell.length} containers subiram mas não ficaram bem. Veja a faixa de atenção.`);
  }
  var STACK = [["start", "Iniciar tudo"], ["restart", "Reiniciar tudo"], ["stop", "Parar tudo"]];
  var stackList = (a, p, ids) => data.filter((c) => project(c) === p && (ids ? ids.includes(c.ID) : a === "start" ? PRIMARY[c.State] === "start" : a === "restart" ? c.State === "running" : STOPPABLE.includes(c.State)));
  function copyExec(id) {
    const cmd = `docker exec -it ${data.find((c) => c.ID === id).Names} sh`;
    navigator.clipboard.writeText(cmd).then(() => toast(`Copiado: ${cmd}`, true), () => toast(`Não consegui copiar. O comando é: ${cmd}`));
  }
  async function stackAct(a, p, ids) {
    const list = stackList(a, p, ids);
    if (!list.length || list.some((c) => busy.has(c.ID))) return;
    const all = Promise.all(list.map((c) => run(a, c)));
    $("#shown").textContent = `${VERB[a]} ${list.length} containers de ${p}`;
    const res = await all, fails = res.filter((ok) => !ok).length, okIds = list.filter((c, i) => res[i] && c.State !== "paused").map((c) => c.ID);
    if (fails) toast(`${p}: ${fails} de ${list.length} ${fails === 1 ? "falhou" : "falharam"}. ${fails === 1 ? "O erro ficou na linha" : "Os erros ficaram nas linhas"}.`);
    else if (a === "stop") toast(`${p}: ${list.length} parados.`, true, okIds.length ? ["Iniciar de novo", () => stackAct("start", p, okIds)] : null);
    else toast(`${p}: ${list.length} ${a === "start" ? "iniciados" : "reiniciados"}, conferindo se ficaram de pé…`, true);
    if (!fails && UP.includes(a)) return confirmUp(okIds);
    load();
  }
  function armTick() {
    if (!arming) return;
    const el = document.querySelector(`[data-id="${arming.id}"][data-a="remove"]`);
    if (el && (el.matches(":hover") || el === document.activeElement)) arming.timer = setTimeout(armTick, 1e3);
    else disarm();
  }
  function disarm(redraw = true) {
    if (!arming) return;
    clearTimeout(arming.timer);
    arming = null;
    if (redraw) render();
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenus();
    if (e.key === "Escape" && arming) return disarm();
    if ($("#dlg").open || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = document.activeElement, typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    if (e.key === "/" && !typing) {
      e.preventDefault();
      return $("#q").focus();
    }
    if ((e.key === "z" || e.key === "Z") && !typing && toastFn) return runToastAction();
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (typing && !(el === $("#q") && e.key === "ArrowDown")) return;
    const trs = [...document.querySelectorAll("#rows tr[data-row]")], cur = el.closest?.("tr[data-row]");
    if (!trs.length) return;
    e.preventDefault();
    const next = trs[Math.max(0, Math.min(trs.length - 1, cur ? trs.indexOf(cur) + (e.key === "ArrowDown" ? 1 : -1) : 0))];
    next.querySelector('[data-a="logs"]')?.focus();
  });
  function renderDlg() {
    if (!$("#dlg").open) return;
    const c = data.find((c2) => c2.ID === logId);
    if (!c) {
      $("#dlg-status").innerHTML = '<span class="text-muted">Este container não existe mais.</span>';
      $("#dlg-acts").innerHTML = "";
      return;
    }
    const b = busy.get(c.ID), t = TONE[b ? "busy" : tone(c)], st = status(c);
    const h = hasHealth(c) && health[c.ID + c.Status];
    if (hasHealth(c) && !h) loadHealth(c.ID);
    $("#dlg-status").innerHTML = `<span class="${t[1]}">${b ? VERB[b] : esc(st[0])}</span>${st[1] && !b ? `<span class="text-muted"> · ${st[1]}</span>` : ""}${b ? "" : errHtml(c)}${h ? `<div class="mt-1 text-xs text-muted">Último healthcheck: <span class="font-mono text-fg-soft">${esc(h)}</span></div>` : ""}`;
    $("#dlg-acts").innerHTML = [PRIMARY[c.State], SECONDARY[c.State]].filter((a) => !!a).map((a) => `<button data-id="dlg" data-a="${a}" ${b ? 'aria-disabled="true"' : ""} aria-label="${LABEL[a]} ${esc(c.Names)}" onclick="act('${a}', '${c.ID}')"
      class="${BTN} ${a === "start" ? "text-ok-fg hover:bg-ok/10" : "text-fg hover:bg-hover"}">${LABEL[a]}</button>`).join("") + (c.State === "running" ? `<button data-id="dlg" data-a="exec" onclick="copyExec('${c.ID}')" class="${BTN} text-fg hover:bg-hover">Copiar docker exec</button>` : "");
  }
  async function fetchLogs(force = false) {
    const lb = $("#lb"), sel = getSelection();
    if (!force && sel?.toString() && lb.contains(sel.anchorNode)) return;
    const atEnd = lb.scrollHeight - lb.scrollTop - lb.clientHeight < 40;
    try {
      const r = await api("/api/logs/" + logId), j = await r.json();
      lb.textContent = r.ok ? j || "(sem logs)" : `Não consegui ler os logs: ${j}`;
      $("#lmeta").textContent = `Últimas 500 linhas · atualizado às ${(/* @__PURE__ */ new Date()).toLocaleTimeString("pt-BR")}`;
    } catch {
      lb.textContent = "Não consegui carregar os logs. O servidor do Docker GUI está rodando?";
    }
    if (atEnd) lb.scrollTop = lb.scrollHeight;
  }
  function logs(id) {
    logId = id;
    $("#lt").textContent = data.find((c) => c.ID === id).Names;
    $("#lb").textContent = "Carregando…";
    $("#lmeta").textContent = "Últimas 500 linhas";
    $("#dlg-msg").innerHTML = "";
    $("#dlg").showModal();
    renderDlg();
    fetchLogs(true);
  }
  function toggleFollow(on = !follow) {
    clearInterval(follow ?? void 0);
    follow = on ? setInterval(() => document.hidden || fetchLogs(), 2e3) : null;
    $("#follow").setAttribute("aria-pressed", String(on));
    $("#refresh").setAttribute("aria-disabled", String(on));
    if (on) fetchLogs();
  }
  function refreshLogs() {
    if (!follow) fetchLogs(true);
  }
  function copyLogs() {
    navigator.clipboard.writeText($("#lb").textContent ?? "").then(() => toast("Logs copiados.", true), () => toast("Não consegui copiar."));
  }
  function afterClose() {
    toggleFollow(false);
    document.querySelector(`[data-id="${logId}"][data-a="logs"]`)?.focus();
  }
  Object.assign(window, {
    act,
    afterClose,
    clearFilters,
    copyAddr,
    copyExec,
    copyLogs,
    filterBy,
    loadHealth,
    menuPick,
    placeMenu,
    refreshLogs,
    runToastAction,
    stackAct,
    toggleFollow
  });
  $("#dlg").addEventListener("close", afterClose);
  $("#q").oninput = render;
  document.addEventListener("visibilitychange", () => document.hidden || load());
  readHash();
  render();
  load();
  setInterval(() => document.hidden || load(), 2e3);
})();
</script>
</body>
</html>
"""
# <<< fim do gerado
PAGE = PAGE.replace("/*CSS*/", CSS)

if __name__ == "__main__":
    main()
