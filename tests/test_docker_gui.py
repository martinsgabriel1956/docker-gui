"""Testes do backend. Só stdlib: o docker CLI é trocado por mock, exceto em RealDockerTest."""
import errno
import http.client
import io
import json
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from unittest import mock

import docker_gui

HEX_ID = "0123456789ab"


def ok(stdout="", stderr=""):
    return subprocess.CompletedProcess([], 0, stdout, stderr)


def fail(stderr):
    return subprocess.CompletedProcess([], 1, "", stderr)


class ServerTest(unittest.TestCase):
    """Sobe o servidor de verdade numa porta livre, com o docker trocado por mock."""

    mock_docker = True

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), docker_gui.Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        if self.mock_docker:
            patcher = mock.patch.object(docker_gui, "docker", return_value=ok())
            self.docker = patcher.start()
            self.addCleanup(patcher.stop)

    def request(self, method, path, host=None, token=docker_gui.TOKEN):
        headers = {"Host": f"localhost:{self.port}" if host is None else host}
        if token is not None:
            headers["X-Docker-GUI-Token"] = token
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            conn.request(method, path, headers=headers)
            r = conn.getresponse()
            body = r.read().decode()
            return r.status, json.loads(body) if r.getheader("Content-Type", "").startswith("application/json") else body
        finally:
            conn.close()


class HostTest(ServerTest):
    """Validação do Host contra DNS rebinding."""

    def test_page_on_localhost_and_ip(self):
        for host in (f"localhost:{self.port}", f"127.0.0.1:{self.port}"):
            status, body = self.request("GET", "/", host=host, token=None)
            self.assertEqual(status, 200, host)
            self.assertIn("<!doctype html>", body)

    def test_page_has_embedded_css(self):
        _, body = self.request("GET", "/", token=None)
        self.assertNotIn("/*CSS*/", body)
        self.assertIn("tailwindcss", body)

    def test_foreign_host_is_forbidden(self):
        for host in (f"evil.com:{self.port}", "evil.com", f"localhost:{self.port + 1}", "localhost", ""):
            for method, path in (("GET", "/"), ("GET", "/api/containers"), ("POST", f"/api/stop/{HEX_ID}")):
                status, _ = self.request(method, path, host=host)
                self.assertEqual(status, 403, (host, method, path))
        self.docker.assert_not_called()

    def test_host_uses_real_port_not_default(self):
        # regressão: com fallback de porta, comparar com a constante PORT recusaria tudo
        self.assertNotEqual(self.port, docker_gui.PORT)
        status, _ = self.request("GET", "/api/containers")
        self.assertEqual(status, 200)


class TokenTest(ServerTest):

    def test_api_requires_token(self):
        for token in (None, "", "errado", docker_gui.TOKEN[:-1], docker_gui.TOKEN + "x"):
            for method, path in (("GET", "/api/containers"), ("GET", f"/api/logs/{HEX_ID}"),
                                 ("GET", f"/api/health/{HEX_ID}"), ("POST", f"/api/stop/{HEX_ID}")):
                status, _ = self.request(method, path, token=token)
                self.assertEqual(status, 401, (token, method, path))
        self.docker.assert_not_called()

    def test_valid_token(self):
        status, _ = self.request("GET", "/api/containers")
        self.assertEqual(status, 200)


class ContainersTest(ServerTest):

    def test_lines_become_json_array(self):
        rows = [{"ID": "a" * 12, "Names": "web"}, {"ID": "b" * 12, "Names": "db"}]
        self.docker.return_value = ok("\n".join(json.dumps(r) for r in rows) + "\n")
        status, body = self.request("GET", "/api/containers")
        self.assertEqual((status, body), (200, rows))
        self.docker.assert_called_once_with("ps", "-a", "--format", "{{json .}}")

    def test_empty_list(self):
        self.assertEqual(self.request("GET", "/api/containers"), (200, []))

    def test_docker_error_is_500_with_stderr(self):
        self.docker.return_value = fail("permission denied while trying to connect\n")
        self.assertEqual(self.request("GET", "/api/containers"), (500, "permission denied while trying to connect"))


class LogsAndHealthTest(ServerTest):

    def test_logs_join_stdout_and_stderr(self):
        self.docker.return_value = ok("out\n", "err\n")
        self.assertEqual(self.request("GET", f"/api/logs/{HEX_ID}"), (200, "out\nerr\n"))
        self.docker.assert_called_once_with("logs", "--tail", "500", HEX_ID)

    def test_logs_error(self):
        self.docker.return_value = fail("No such container")
        self.assertEqual(self.request("GET", f"/api/logs/{HEX_ID}"), (500, "No such container"))

    def test_health(self):
        health = {"Status": "unhealthy", "Log": [{"ExitCode": 1, "Output": "boom"}]}
        self.docker.return_value = ok(json.dumps(health) + "\n")
        self.assertEqual(self.request("GET", f"/api/health/{HEX_ID}"), (200, health))
        self.docker.assert_called_once_with("inspect", "--format", "{{json .State.Health}}", HEX_ID)

    def test_health_error(self):
        self.docker.return_value = fail("No such object\n")
        self.assertEqual(self.request("GET", f"/api/health/{HEX_ID}"), (500, "No such object"))


class ActionsTest(ServerTest):

    def test_each_action_runs_expected_command(self):
        expected = {"start": ["start"], "stop": ["stop"], "restart": ["restart"], "pause": ["pause"],
                    "unpause": ["unpause"], "remove": ["rm", "-f"]}
        self.assertEqual(docker_gui.ACTIONS, expected)  # mudou a allowlist? reveja o teste e a segurança
        for action, args in expected.items():
            self.docker.reset_mock()
            self.assertEqual(self.request("POST", f"/api/{action}/{HEX_ID}"), (200, ""), action)
            self.docker.assert_called_once_with(*args, HEX_ID, timeout=docker_gui.ACTION_TIMEOUT)

    def test_action_error_is_500_with_stderr(self):
        self.docker.return_value = fail("Error: container is not running\n")
        self.assertEqual(self.request("POST", f"/api/pause/{HEX_ID}"), (500, "Error: container is not running"))

    def test_unknown_action(self):
        for action in ("exec", "kill", "rm", "commit", "STOP"):
            status, _ = self.request("POST", f"/api/{action}/{HEX_ID}")
            self.assertEqual(status, 404, action)
        self.docker.assert_not_called()

    def test_get_does_not_run_actions(self):
        status, _ = self.request("GET", f"/api/stop/{HEX_ID}")
        self.assertEqual(status, 404)
        self.docker.assert_not_called()


class IdValidationTest(ServerTest):
    """O ID vai direto para o argv do docker: só hex, de 12 a 64 caracteres."""

    BAD_IDS = ("0123456789a",                       # curto demais
               "0" * 65,                            # longo demais
               "0123456789AB",                      # maiúsculas
               "my-container",                      # nome em vez de ID
               "0123456789ab;rm",                   # injeção
               "0123456789ab%20--help",
               "../0123456789ab",
               "0123456789ab/../../x",
               "0123456789ab?x=1",
               "--help0123456789")

    def test_bad_ids_never_reach_docker(self):
        for bad in self.BAD_IDS:
            for method, path in (("POST", f"/api/stop/{bad}"), ("GET", f"/api/logs/{bad}"), ("GET", f"/api/health/{bad}")):
                status, _ = self.request(method, path)
                self.assertEqual(status, 404, path)
        self.docker.assert_not_called()

    def test_full_64_char_id(self):
        status, _ = self.request("POST", f"/api/stop/{'f' * 64}")
        self.assertEqual(status, 200)

    def test_unknown_path(self):
        for path in ("/api", "/api/", "/api/containers/", "/favicon.ico", "/index.html"):
            status, _ = self.request("GET", path)
            self.assertEqual(status, 404, path)


class DockerCallTest(unittest.TestCase):

    def test_passes_args_and_default_timeout(self):
        with mock.patch.object(subprocess, "run", return_value=ok("x")) as run:
            self.assertEqual(docker_gui.docker("ps", "-a").stdout, "x")
        run.assert_called_once_with(["docker", "ps", "-a"], capture_output=True, text=True,
                                    timeout=docker_gui.READ_TIMEOUT, check=False)

    def test_custom_timeout(self):
        with mock.patch.object(subprocess, "run", return_value=ok()) as run:
            docker_gui.docker("stop", HEX_ID, timeout=99)
        self.assertEqual(run.call_args[1]["timeout"], 99)  # .kwargs só existe a partir do 3.8

    def test_timeout_becomes_error_result(self):
        with mock.patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired(["docker"], 15)):
            r = docker_gui.docker("ps", "-a")
        self.assertEqual(r.returncode, 124)
        self.assertEqual(r.stdout, "")
        self.assertIn("docker ps não respondeu em 15s", r.stderr)

    def test_timeout_with_real_process(self):
        # um "docker" que trava de verdade: o processo tem que ser morto no prazo
        if os.name != "posix":
            self.skipTest("usa script shell")
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, "docker")
            with open(fake, "w") as f:
                f.write("#!/bin/sh\nexec sleep 30\n")
            os.chmod(fake, 0o755)
            with mock.patch.dict(os.environ, {"PATH": d + os.pathsep + os.environ.get("PATH", "")}):
                r = docker_gui.docker("ps", timeout=0.5)
        self.assertEqual(r.returncode, 124)


class ServeTest(unittest.TestCase):

    def bind(self):
        """Ocupa uma porta livre até o fim do teste."""
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        s.listen()
        self.addCleanup(s.close)
        return s.getsockname()[1]

    @staticmethod
    def free_port():
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def close_later(self, server):
        self.addCleanup(server.server_close)
        return server

    def test_explicit_free_port(self):
        port = self.free_port()
        server = self.close_later(docker_gui.serve(port))
        self.assertEqual(server.server_address, ("127.0.0.1", port))

    def test_listens_only_on_loopback(self):
        server = self.close_later(docker_gui.serve(0))
        self.assertEqual(server.server_address[0], "127.0.0.1")

    def test_explicit_busy_port_exits(self):
        busy = self.bind()
        with self.assertRaises(SystemExit) as cm:
            docker_gui.serve(busy)
        self.assertIn(f"Porta {busy} ocupada", str(cm.exception.code))

    def test_default_busy_falls_back_to_next(self):
        busy = self.bind()
        with mock.patch.object(docker_gui, "PORT", busy):
            server = self.close_later(docker_gui.serve(None))
        self.assertIn(server.server_address[1], range(busy + 1, busy + 10))

    def test_all_default_ports_busy_exits(self):
        err = OSError(errno.EADDRINUSE, "Address already in use")
        with mock.patch.object(docker_gui, "ThreadingHTTPServer", side_effect=err) as srv, \
                self.assertRaises(SystemExit) as cm:
            docker_gui.serve(None)
        self.assertEqual(srv.call_count, 10)
        self.assertIn(f"Portas {docker_gui.PORT}-{docker_gui.PORT + 9} ocupadas", str(cm.exception.code))

    def test_other_bind_errors_propagate(self):
        err = OSError(errno.EACCES, "Permission denied")
        with mock.patch.object(docker_gui, "ThreadingHTTPServer", side_effect=err) as srv, \
                self.assertRaises(OSError):
            docker_gui.serve(None)
        self.assertEqual(srv.call_count, 1)  # não mascara erro de permissão tentando outras portas


def client_frame(payload, opcode=2, mask=b"\x01\x02\x03\x04"):
    """Frame como o navegador manda: FIN e mascarado."""
    n = len(payload)
    size = bytes([0x80 | n]) if n < 126 else struct.pack("!BH", 0x80 | 126, n) if n < 1 << 16 \
        else struct.pack("!BQ", 0x80 | 127, n)
    return bytes([0x80 | opcode]) + size + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))


class WebSocketFramesTest(unittest.TestCase):

    def test_accept_key_from_rfc(self):
        self.assertEqual(docker_gui.ws_accept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")

    def test_server_frame_lengths(self):
        for n, head in ((5, b"\x82\x05"), (200, b"\x82\x7e\x00\xc8"), (70000, b"\x82\x7f" + (70000).to_bytes(8, "big"))):
            payload = os.urandom(n)
            self.assertEqual(docker_gui.ws_frame(payload), head + payload, n)
        self.assertEqual(docker_gui.ws_frame(b"\x03\xe8", 8), b"\x88\x02\x03\xe8")

    def test_read_unmasks(self):
        # exemplo do RFC 6455 5.7: "Hello" mascarado
        rfc = bytes.fromhex("818537fa213d7f9f4d5158")
        self.assertEqual(docker_gui.ws_read(io.BytesIO(rfc)), (1, b"Hello"))
        for n in (0, 5, 200, 70000):
            payload = os.urandom(n)
            self.assertEqual(docker_gui.ws_read(io.BytesIO(client_frame(payload))), (2, payload), n)

    def test_rejects_bad_frames(self):
        good = client_frame(b"hello")
        too_big = b"\x82\xff" + (docker_gui.WS_MAX + 1).to_bytes(8, "big") + b"\x00" * 4
        for bad in (b"", b"\x82",
                    docker_gui.ws_frame(b"hello"),  # sem máscara
                    good[:-1], good[:4],            # cortados no meio do payload e da máscara
                    too_big, b"\x82\xff" + b"\xff" * 8):
            self.assertIsNone(docker_gui.ws_read(io.BytesIO(bad)), bad[:12])


FAKE_EXEC = """#!/bin/sh
echo $$ > "$FAKE_EXEC_DIR/pid"
printf '%s\\n' "$@" > "$FAKE_EXEC_DIR/args"
IFS= read -r line
stty size
echo "got:$line"
"""


@unittest.skipUnless(os.name == "posix", "PTY só existe em Unix")
class TerminalTest(ServerTest):
    """WebSocket de /api/exec contra um docker falso no PATH: grava pid e argv, lê uma linha e mostra o tamanho."""

    mock_docker = False

    def setUp(self):
        super().setUp()
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        fake = os.path.join(self.dir, "docker")
        with open(fake, "w") as f:
            f.write(FAKE_EXEC)
        os.chmod(fake, 0o755)
        env = {"PATH": self.dir + os.pathsep + os.environ.get("PATH", ""), "FAKE_EXEC_DIR": self.dir}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)

    def connect(self, path=None, origin="", headers=None):
        """Handshake cru. Devolve (status, headers, socket, arquivo de leitura)."""
        origin = f"http://localhost:{self.port}" if origin == "" else origin
        lines = [f"GET {path or f'/api/exec/{HEX_ID}?t={docker_gui.TOKEN}'} HTTP/1.1", f"Host: localhost:{self.port}"]
        if origin is not None:
            lines.append(f"Origin: {origin}")
        hdrs = {"Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
                "Sec-WebSocket-Version": "13"}
        hdrs.update(headers or {})
        lines += [f"{k}: {v}" for k, v in hdrs.items() if v is not None]
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        self.addCleanup(sock.close)
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("utf-8"))
        f = sock.makefile("rb")
        self.addCleanup(f.close)
        status = int(f.readline().split()[1])
        got = {}
        for line in iter(f.readline, b"\r\n"):
            k, _, v = line.decode().partition(":")
            got[k.lower()] = v.strip()
        return status, got, sock, f

    @staticmethod
    def recv(f):
        head = f.read(2)
        n = head[1] & 0x7F
        if n >= 126:
            n = int.from_bytes(f.read(2 if n == 126 else 8), "big")
        return head[0] & 0x0F, f.read(n)

    def no_process(self):
        self.assertFalse(os.path.exists(os.path.join(self.dir, "pid")), "o docker exec não devia ter rodado")

    def started(self):
        path = os.path.join(self.dir, "pid")
        for _ in range(100):
            if os.path.exists(path):
                with open(path) as f:
                    pid = f.read().strip()
                if pid:
                    return int(pid)
            time.sleep(0.05)
        self.fail("o docker exec não rodou")

    def open_session(self):
        status, headers, sock, f = self.connect()
        self.assertEqual(status, 101)
        self.assertEqual(headers["sec-websocket-accept"], "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
        sock.sendall(client_frame(b'{"cols": 80, "rows": 24}', 1))
        return sock, f

    def test_origin_rejected(self):
        p = self.port
        for origin in (None, "null", f"https://localhost:{p}", f"http://localhost:{p + 1}", f"http://evil.com:{p}",
                       "http://localhost", f"http://127.0.0.1:{p}.evil.com"):
            self.assertEqual(self.connect(origin=origin)[0], 403, origin)
        self.no_process()

    def test_origin_on_ip_accepted(self):
        status, _, sock, _ = self.connect(origin=f"http://127.0.0.1:{self.port}")
        self.assertEqual(status, 101)

    def test_token_rejected(self):
        for query in ("", "?t=", "?t=errado", f"?t={docker_gui.TOKEN[:-1]}", f"?t={docker_gui.TOKEN}x",
                      "?t=%C3%A7", "?t=ç", f"?x={docker_gui.TOKEN}"):
            self.assertEqual(self.connect(f"/api/exec/{HEX_ID}{query}")[0], 401, query)
        self.no_process()

    def test_bad_ids_never_run(self):
        for bad in IdValidationTest.BAD_IDS:
            status = self.connect(f"/api/exec/{bad}?t={docker_gui.TOKEN}")[0]
            self.assertIn(status, (401, 404), bad)
        self.no_process()

    def test_needs_upgrade_headers(self):
        for headers in ({"Upgrade": None}, {"Upgrade": "h2c"}, {"Sec-WebSocket-Key": None}):
            self.assertEqual(self.connect(headers=headers)[0], 400, headers)
        self.no_process()

    def test_session(self):
        sock, f = self.open_session()
        sock.sendall(client_frame(b'{"cols": 100, "rows": 30}', 1) + client_frame(b"hello\n"))
        out = b""
        while True:
            op, data = self.recv(f)
            if op == 8:
                break
            self.assertEqual(op, 2)
            out += data
        self.assertEqual(data, struct.pack("!H", 1000))  # o processo saiu: close normal
        self.assertIn(b"30 100", out)
        self.assertIn(b"got:hello", out)
        with open(os.path.join(self.dir, "args")) as a:
            self.assertEqual(a.read().splitlines(), ["exec", "-it", HEX_ID, *docker_gui.SHELL])

    def test_ping_pong(self):
        sock, f = self.open_session()
        sock.sendall(client_frame(b"abc", 9))
        self.assertEqual(self.recv(f), (10, b"abc"))

    def test_closing_socket_kills_process(self):
        sock, f = self.open_session()
        pid = self.started()
        sock.shutdown(socket.SHUT_RDWR)
        for _ in range(100):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.05)
        self.fail("o docker exec continuou rodando depois que o navegador fechou")

    def test_first_message_must_be_size(self):
        status, _, sock, f = self.connect()
        self.assertEqual(status, 101)
        sock.sendall(client_frame(b"ls\n"))
        self.assertEqual(f.read(), b"")  # fecha sem rodar nada
        self.no_process()


@unittest.skipUnless(os.environ.get("DOCKER_GUI_E2E") == "1" and shutil.which("docker"),
                     "defina DOCKER_GUI_E2E=1 (precisa de um daemon Docker)")
class RealDockerTest(ServerTest):
    """Fluxo completo contra o Docker de verdade: garante que o formato do CLI ainda é o que a página espera."""

    mock_docker = False
    IMAGE = "busybox:latest"

    @classmethod
    def setUpClass(cls):
        # sem "docker pull": o run só baixa se faltar a imagem, o que poupa o rate limit do Docker Hub
        r = subprocess.run(["docker", "run", "-d", "--stop-timeout", "1", "--label", "docker-gui-test=1",
                            cls.IMAGE, "sleep", "300"], capture_output=True, text=True, check=False)
        if r.returncode:
            raise RuntimeError(f"não consegui criar o container de teste: {r.stderr.strip()}")
        cls.cid = r.stdout.strip()
        super().setUpClass()

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["docker", "rm", "-f", cls.cid], capture_output=True, check=False)
        super().tearDownClass()

    def state(self):
        _, rows = self.request("GET", "/api/containers")
        return next(c for c in rows if self.cid.startswith(c["ID"]))

    def test_lifecycle(self):
        c = self.state()
        for field in ("ID", "Names", "Image", "State", "Status", "Ports", "Labels"):
            self.assertIn(field, c)  # campos que a página lê
        self.assertEqual(c["State"], "running")
        self.assertIn("docker-gui-test=1", c["Labels"])

        short = c["ID"]
        for action, state in (("pause", "paused"), ("unpause", "running"), ("stop", "exited"), ("start", "running")):
            self.assertEqual(self.request("POST", f"/api/{action}/{short}"), (200, ""), action)
            self.assertEqual(self.state()["State"], state, action)

        status, logs = self.request("GET", f"/api/logs/{short}")
        self.assertEqual(status, 200)
        self.assertIsInstance(logs, str)

        status, health = self.request("GET", f"/api/health/{short}")
        self.assertEqual((status, health), (200, None))  # sem HEALTHCHECK na imagem

        self.assertEqual(self.request("POST", f"/api/remove/{short}"), (200, ""))
        _, rows = self.request("GET", "/api/containers")
        self.assertFalse(any(self.cid.startswith(r["ID"]) for r in rows))

    def test_action_on_missing_container(self):
        status, err = self.request("POST", f"/api/stop/{'0' * 64}")
        self.assertEqual(status, 500)
        self.assertIn("No such container", err)


if __name__ == "__main__":
    unittest.main()
