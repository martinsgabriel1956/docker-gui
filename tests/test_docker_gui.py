"""Testes do backend. Só stdlib: o docker CLI é trocado por mock, exceto em RealDockerTest."""
import errno
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
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

    def test_podman_uses_json_array_and_is_normalized(self):
        self.docker.return_value = ok(json.dumps(PODMAN_PS, indent=2) + "\n")
        with mock.patch.object(docker_gui, "CLI", ["/usr/bin/podman"]):
            status, body = self.request("GET", "/api/containers")
        self.assertEqual((status, body), (200, PODMAN_EXPECTED))
        self.docker.assert_called_once_with("ps", "-a", "--format", "json")


# `podman ps -a --format json` do podman 5: array, Id inteiro, Names lista, Ports objetos, Labels dict
PODMAN_PS = [
    {"AutoRemove": False, "Command": ["postgres"], "CreatedAt": "2 hours ago", "CIDFile": "", "Exited": False,
     "ExitedAt": 1759480000, "ExitCode": 0, "ExposedPorts": {"5432": ["tcp"]},
     "Id": "3f1c2b9a8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170f5e4d3c",
     "Image": "docker.io/library/postgres:16", "ImageID": "b2c9" + "0" * 60, "IsInfra": False,
     "Labels": {"com.docker.compose.project": "loja", "com.docker.compose.service": "db",
                "com.docker.compose.depends_on": "cache:service_started:false,api:service_started:false"},
     "Mounts": ["/var/lib/postgresql/data"], "Names": ["loja_db_1"], "Namespaces": {}, "Networks": ["loja_default"],
     "Pid": 4242, "Pod": "", "PodName": "",
     "Ports": [{"host_ip": "", "container_port": 5432, "host_port": 5432, "range": 1, "protocol": "tcp"},
               {"host_ip": "127.0.0.1", "container_port": 3000, "host_port": 8000, "range": 4, "protocol": "tcp,udp"}],
     "Restarts": 0, "Size": None, "StartedAt": 1759480000, "State": "running", "Status": "Up 2 hours (starting)",
     "Created": 1759480000},
    {"AutoRemove": False, "Command": None, "CreatedAt": "3 days ago", "Exited": True, "ExitedAt": 1759200000,
     "ExitCode": 137, "Id": "a" * 64, "Image": "localhost/worker:dev", "Labels": None, "Mounts": [],
     "Names": ["worker"], "Networks": [], "Pid": 0, "Pod": "", "PodName": "", "Ports": None,
     "State": "stopped", "Status": "Exited (137) 3 days ago", "Created": 1759100000},
]
PODMAN_EXPECTED = [
    {"ID": PODMAN_PS[0]["Id"], "Names": "loja_db_1", "Image": "docker.io/library/postgres:16", "State": "running",
     "Status": "Up 2 hours (health: starting)",
     "Ports": "0.0.0.0:5432->5432/tcp, 127.0.0.1:8000-8003->3000-3003/tcp, 127.0.0.1:8000-8003->3000-3003/udp",
     "Labels": "com.docker.compose.project=loja,com.docker.compose.service=db,"
               "com.docker.compose.depends_on=cache:service_started:false,api:service_started:false"},
    {"ID": "a" * 64, "Names": "worker", "Image": "localhost/worker:dev", "State": "exited",
     "Status": "Exited (137) 3 days ago", "Ports": "", "Labels": ""},
]


class NormalizeTest(unittest.TestCase):
    """Saída do podman -> o formato do `docker ps` que a página lê."""

    def test_docker_lines_pass_through(self):
        row = {"ID": "a" * 12, "Names": "web", "Ports": "0.0.0.0:80->80/tcp", "Labels": "a=1"}
        self.assertEqual(docker_gui.containers(json.dumps(row) + "\n"), [row])
        self.assertEqual(docker_gui.containers(""), [])

    def test_podman_array(self):
        self.assertEqual(docker_gui.containers(json.dumps(PODMAN_PS, indent=2)), PODMAN_EXPECTED)
        self.assertEqual(docker_gui.containers("[]\n"), [])

    def test_podman_lines_from_docker_shim(self):
        # podman-docker: `docker ps --format '{{json .}}'` chama o podman e sai uma linha por container
        out = "\n".join(json.dumps(c) for c in PODMAN_PS)
        self.assertEqual(docker_gui.containers(out), PODMAN_EXPECTED)

    def test_podman3_camel_case_ports_and_states(self):
        c = {"Id": "b" * 64, "Names": ["a", "b"], "State": "configured", "Status": "Created",
             "Ports": [{"hostPort": 8080, "containerPort": 80, "protocol": "tcp", "hostIP": ""},
                       {"hostPort": 0, "containerPort": 9000, "protocol": "tcp", "hostIP": ""}]}
        got = docker_gui.from_podman(c)
        self.assertEqual((got["Names"], got["State"], got["Ports"]), ("a,b", "created", "0.0.0.0:8080->80/tcp, 9000/tcp"))


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

    def test_cli_and_context_prefix_args(self):
        with mock.patch.object(docker_gui, "CLI", ["podman", "--context", "prod"]), \
                mock.patch.object(subprocess, "run", return_value=ok()) as run:
            docker_gui.docker("ps", "-a")
        self.assertEqual(run.call_args[0][0], ["podman", "--context", "prod", "ps", "-a"])

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
        import tempfile
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


class MainTest(unittest.TestCase):

    def test_cli_from_env_and_context_flag(self):
        # patch com o próprio valor: o main() troca os globais e o mock os devolve no fim
        with mock.patch.object(docker_gui, "CLI", docker_gui.CLI), mock.patch.object(docker_gui, "PAGE", docker_gui.PAGE), \
                mock.patch.dict(os.environ, {"DOCKER_GUI_CLI": "podman"}), \
                mock.patch.object(sys, "argv", ["docker_gui.py", "--context", "a b"]), \
                mock.patch.object(docker_gui, "serve", side_effect=SystemExit):
            self.assertRaises(SystemExit, docker_gui.main)  # para antes de abrir porta e navegador
            self.assertEqual(docker_gui.CLI, ["podman", "--context", "a b"])
            # o "Copiar docker exec" da página usa o mesmo comando, com aspas de shell e escapado no HTML
            self.assertIn('data-cli="podman --context &#x27;a b&#x27;"', docker_gui.PAGE)


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
