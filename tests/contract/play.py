"""Contrato da API compartilhado entre o docker_gui.py e o backend Rust do desktop (src-tauri/tests/contract.rs).

Cada caso (tests/contract/<grupo>/<caso>.json) diz o que o docker responde a cada chamada, a requisição e a resposta
esperada. O replay troca o docker() por um falso que confere as chamadas em ordem. Escopo: as rotas que chamam o
docker(); os streams, o NDJSON do compose e o terminal usam o Popen direto e ficam com o E2E nos dois backends.

    python3 tests/contract/play.py --record tests/contract/lists/ps-vazio.json

grava "args" de cada chamada e a "response" a partir do comportamento atual do Python: confira o diff antes de
commitar (o caso vira contrato para as duas versões).
"""
import http.client
import json
import pathlib
import subprocess
import sys
import threading
from http.server import ThreadingHTTPServer
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import docker_gui

HERE = pathlib.Path(__file__).resolve().parent
NOW = 1700000000.5  # o relógio dos casos (o --until do histórico depende dele)


class Mismatch(AssertionError):
    pass


def serve():
    server = ThreadingHTTPServer(("127.0.0.1", 0), docker_gui.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def play(server, case, record=False):
    """Roda o caso; devolve (status, corpo). Sem record, Mismatch na primeira chamada diferente ou a mais."""
    calls, made = case["calls"], []

    def fake(*args, timeout=None):
        if len(made) >= len(calls):
            raise Mismatch(f"chamada a mais: {list(args)}")
        exp = calls[len(made)]
        made.append(list(args))
        if not record and list(args) != exp["args"]:
            raise Mismatch(f"chamada {len(made)}: esperava {exp['args']}, veio {list(args)}")
        return subprocess.CompletedProcess(args, exp["code"], exp["stdout"], exp["stderr"])

    errors = []

    def guarded(*args, **kw):
        try:
            return fake(*args, **kw)
        except Mismatch as e:
            errors.append(e)
            return subprocess.CompletedProcess(args, 99, "", "mismatch")

    req = case["request"]
    port = server.server_address[1]
    with mock.patch.object(docker_gui, "docker", side_effect=guarded), \
            mock.patch.object(docker_gui, "CLI", case["cli"]), mock.patch.object(docker_gui, "LANG", case["lang"]), \
            mock.patch.object(docker_gui.time, "time", return_value=case.get("now", NOW)):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        body = None if req["body"] is None else json.dumps(req["body"])
        conn.request(req["method"], req["path"], body=body,
                     headers={"Host": f"localhost:{port}", "X-Docker-GUI-Token": docker_gui.TOKEN,
                              **({"Content-Type": "application/json"} if body else {})})
        r = conn.getresponse()
        status, raw = r.status, r.read().decode()
        conn.close()
    if errors:
        raise errors[0]
    if len(made) < len(calls):
        raise Mismatch(f"chamada esperada não aconteceu: {calls[len(made)]['args'] if not record else len(made)}")
    if record:
        for c, args in zip(calls, made):
            c["args"] = args
    return status, json.loads(raw)


def cases():
    return sorted(p for p in HERE.rglob("*.json"))


def record(paths):
    server = serve()
    try:
        for p in map(pathlib.Path, paths):
            case = json.loads(p.read_text())
            status, body = play(server, case, record=True)
            case["response"] = {"status": status, "body": body}
            ordered = {k: case[k] for k in ("desc", "lang", "cli", "now", "calls", "request", "response") if k in case}
            p.write_text(json.dumps(ordered, ensure_ascii=False, indent=2) + "\n")
            print(f"{p}: {status}")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    if sys.argv[1:2] != ["--record"] or len(sys.argv) < 3:
        sys.exit(__doc__)
    record(sys.argv[2:])
