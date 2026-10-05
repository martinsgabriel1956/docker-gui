"""Testes do backend. Só stdlib: o docker CLI é trocado por mock, exceto em RealDockerTest."""
import errno
import http.client
import io
import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from typing import ClassVar
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

    def request(self, method, path, host=None, token=docker_gui.TOKEN, body=None):
        headers = {"Host": f"localhost:{self.port}" if host is None else host}
        if token is not None:
            headers["X-Docker-GUI-Token"] = token
        if isinstance(body, dict):
            body = json.dumps(body)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            conn.request(method, path, body=body, headers=headers)
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
            for method, path in (("GET", "/api/containers"), ("GET", "/api/stats"), ("GET", f"/api/logs/{HEX_ID}"),
                                 ("GET", f"/api/health/{HEX_ID}"), ("GET", f"/api/inspect/{HEX_ID}"),
                                 ("GET", f"/api/inspect/{HEX_ID}/env"), ("POST", f"/api/stop/{HEX_ID}"),
                                 ("GET", "/api/df"), ("POST", "/api/prune/images")):
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


class StatsTest(ServerTest):

    def test_lines_become_json_array(self):
        rows = [{"ID": "a" * 12, "CPUPerc": "0.52%", "MemUsage": "10.5MiB / 1.944GiB", "MemPerc": "0.53%"}]
        self.docker.return_value = ok(json.dumps(rows[0]) + "\n")
        self.assertEqual(self.request("GET", "/api/stats"), (200, rows))
        self.docker.assert_called_once_with("stats", "--no-stream", "--format", "{{json .}}")

    def test_docker_error_is_500_with_stderr(self):
        self.docker.return_value = fail("Cannot connect to the Docker daemon\n")
        self.assertEqual(self.request("GET", "/api/stats"), (500, "Cannot connect to the Docker daemon"))


class LogsAndHealthTest(ServerTest):

    def test_logs_join_stdout_and_stderr(self):
        self.docker.return_value = ok("out\n", "err\n")
        self.assertEqual(self.request("GET", f"/api/logs/{HEX_ID}"), (200, "out\nerr\n"))
        self.docker.assert_called_once_with("logs", "--timestamps", "--tail", "500", HEX_ID)

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


@unittest.skipUnless(os.name == "posix", "usa script shell")
class LogsStreamTest(ServerTest):
    """Logs ao vivo (SSE): o docker é um script shell de verdade, porque o stream roda um processo longo."""

    def setUp(self):
        super().setUp()
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.dir = d.name
        patcher = mock.patch.dict(os.environ, {"PATH": d.name + os.pathsep + os.environ.get("PATH", "")})
        patcher.start()
        self.addCleanup(patcher.stop)

    def fake_docker(self, body):
        path = os.path.join(self.dir, "docker")
        with open(path, "w") as f:
            f.write(f'#!/bin/sh\necho "$@" > {self.dir}/args\n{body}\n')
        os.chmod(path, 0o755)

    def path(self, token=docker_gui.TOKEN):
        return f"/api/logs/{HEX_ID}/stream" + (f"?t={token}" if token is not None else "")

    def test_lines_become_events_and_end(self):
        self.fake_docker("printf 'um\\ndois\\r\\nsem quebra no fim'")
        status, body = self.request("GET", self.path())
        self.assertEqual(status, 200)
        self.assertEqual(body, 'data: "um\\n"\n\ndata: "dois\\r\\n"\n\ndata: "sem quebra no fim"\n\nevent: end\ndata:\n\n')
        with open(os.path.join(self.dir, "args")) as f:
            self.assertEqual(f.read().split(), ["logs", "-f", "--timestamps", "--tail", "500", HEX_ID])

    def test_token_goes_in_query(self):
        self.fake_docker("echo nunca")
        for token in (None, "", "errado", docker_gui.TOKEN[:-1]):
            status, _ = self.request("GET", self.path(token))  # o header com o token certo não vale aqui
            self.assertEqual(status, 401, token)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "args")))

    def test_disconnect_kills_docker_and_server_keeps_serving(self):
        self.fake_docker(f"echo $$ > {self.dir}/pid\necho oi\nexec sleep 30")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", self.path(), headers={"Host": f"localhost:{self.port}"})
        r = conn.getresponse()
        self.assertEqual(r.getheader("Content-Type"), "text/event-stream; charset=utf-8")
        self.assertEqual(r.readline(), b'data: "oi\\n"\n')
        # com o stream aberto, o resto da API continua respondendo
        self.assertEqual(self.request("GET", "/api/containers"), (200, []))
        with open(os.path.join(self.dir, "pid")) as f:
            pid = int(f.read())
        r.close()  # a resposta segura o socket aberto: sem fechar as duas, a conexão não cai
        conn.close()
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)
        self.fail("docker logs -f continuou vivo depois que o cliente desconectou")


class InspectTest(ServerTest):
    """Resumo do inspect. O env sai mascarado; o valor real só vem pelo /env."""

    INFO: ClassVar[dict] = {
        "HostConfig": {"RestartPolicy": {"Name": "on-failure", "MaximumRetryCount": 3}},
        "NetworkSettings": {"Networks": {"app_default": {"IPAddress": "172.18.0.2"}, "host": {"IPAddress": ""}}},
        "Mounts": [{"Type": "volume", "Name": "pgdata", "Source": "/var/lib/docker/volumes/pgdata/_data",
                    "Destination": "/var/lib/postgresql/data", "RW": True, "Driver": "local"}],
        "Config": {"Env": ["POSTGRES_PASSWORD=s3cr3t=x", "EMPTY=", "BARE"]}}

    def test_env_masked_by_default(self):
        self.docker.return_value = ok(json.dumps(self.INFO) + "\n")
        status, body = self.request("GET", f"/api/inspect/{HEX_ID}")
        self.assertEqual(status, 200)
        self.assertEqual(body, {
            "Restart": "on-failure:3",
            "Networks": {"app_default": "172.18.0.2", "host": ""},
            "Mounts": [{"Type": "volume", "Name": "pgdata", "Source": "/var/lib/docker/volumes/pgdata/_data",
                        "Destination": "/var/lib/postgresql/data", "RW": True}],
            "Env": [["POSTGRES_PASSWORD", None], ["EMPTY", None], ["BARE", None]]})
        self.docker.assert_called_once_with("inspect", "--format", "{{json .}}", HEX_ID)

    def test_env_revealed_on_request(self):
        self.docker.return_value = ok(json.dumps(self.INFO))
        _, body = self.request("GET", f"/api/inspect/{HEX_ID}/env")
        self.assertEqual(body["Env"], [["POSTGRES_PASSWORD", "s3cr3t=x"], ["EMPTY", ""], ["BARE", ""]])

    def test_minimal_inspect(self):
        # container sem restart policy, rede, mount nem env (ou campos null, como o docker às vezes manda)
        for info in ({}, {"HostConfig": {"RestartPolicy": {"Name": "", "MaximumRetryCount": 0}},
                          "NetworkSettings": {"Networks": None}, "Mounts": None, "Config": {"Env": None}}):
            self.assertEqual(docker_gui.summary(info), {"Restart": "no", "Networks": {}, "Mounts": [], "Env": []})

    def test_inspect_error(self):
        self.docker.return_value = fail("Error: No such object: 0123456789ab\n")
        self.assertEqual(self.request("GET", f"/api/inspect/{HEX_ID}"), (500, "Error: No such object: 0123456789ab"))


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


class ComposeTest(ServerTest):
    """O cliente só escolhe o projeto; diretório e arquivos saem dos labels dos containers."""

    PS = "\n".join(json.dumps(r) for r in (
        ["shop", "/srv/shop", "/srv/shop/compose.yml,/srv/shop/compose.override.yml"],
        ["blog", "/srv/blog", "/srv/blog/compose.yml"])) + "\n"
    SHOP: ClassVar[dict] = {"project": "shop", "dir": "/srv/shop"}

    def ps_call(self):
        return mock.call("ps", "-a", "--filter", "label=com.docker.compose.project", "--format", docker_gui.COMPOSE_FORMAT)

    def test_each_action_builds_argv_from_labels(self):
        self.assertEqual(docker_gui.COMPOSE, {"up": ["up", "-d"], "down": ["down"], "pull": ["pull"]})
        for action, args in docker_gui.COMPOSE.items():
            self.docker.reset_mock()
            self.docker.side_effect = [ok(self.PS), ok(stderr="Container shop-api-1  Started\n")]
            self.assertEqual(self.request("POST", f"/api/compose/{action}", body=self.SHOP),
                             (200, "Container shop-api-1  Started"), action)
            self.assertEqual(self.docker.call_args_list, [self.ps_call(), mock.call(
                "compose", "-p", "shop", "--project-directory", "/srv/shop",
                "-f", "/srv/shop/compose.yml", "-f", "/srv/shop/compose.override.yml", *args,
                timeout=docker_gui.COMPOSE_TIMEOUT)])

    def test_compose_error_is_500_with_stderr(self):
        self.docker.side_effect = [ok(self.PS), fail("pull access denied\n")]
        self.assertEqual(self.request("POST", "/api/compose/pull", body=self.SHOP), (500, "pull access denied"))

    def test_ps_error_is_500(self):
        self.docker.return_value = fail("Cannot connect to the Docker daemon\n")
        self.assertEqual(self.request("POST", "/api/compose/up", body=self.SHOP), (500, "Cannot connect to the Docker daemon"))

    def test_unknown_pair_is_404_without_compose(self):
        for body in ({"project": "shop", "dir": "/tmp/evil"}, {"project": "shop", "dir": "/srv/blog"},
                     {"project": "nope", "dir": "/srv/shop"}):
            self.docker.reset_mock()
            self.docker.side_effect = None
            self.docker.return_value = ok(self.PS)
            status, _ = self.request("POST", "/api/compose/down", body=body)
            self.assertEqual(status, 404, body)
            self.assertEqual(self.docker.call_args_list, [self.ps_call()])

    def test_invalid_body_is_400_without_docker(self):
        for body in (None, "", "não é json", "[]", '"shop"', "{}", '{"project": "shop"}',
                     '{"project": 1, "dir": "/srv/shop"}', '{"project": "", "dir": "/srv/shop"}',
                     json.dumps({**self.SHOP, "x": "a" * docker_gui.MAX_BODY})):
            status, _ = self.request("POST", "/api/compose/up", body=body)
            self.assertEqual(status, 400, body and body[:40])
        self.docker.assert_not_called()

    def test_unknown_action(self):
        for action in ("start", "rm", "UP", "exec", "build"):
            status, _ = self.request("POST", f"/api/compose/{action}", body=self.SHOP)
            self.assertEqual(status, 404, action)
        self.docker.assert_not_called()

    def test_requires_token(self):
        status, _ = self.request("POST", "/api/compose/up", token=None, body=self.SHOP)
        self.assertEqual(status, 401)
        self.docker.assert_not_called()


class DiskTest(ServerTest):

    def test_df_lines_become_json_array(self):
        rows = [{"Type": "Images", "TotalCount": "10", "Active": "7", "Size": "4.01GB", "Reclaimable": "1.2GB (29%)"},
                {"Type": "Build Cache", "TotalCount": "2", "Active": "0", "Size": "16.38kB", "Reclaimable": "16.38kB"}]
        self.docker.return_value = ok("\n".join(json.dumps(r) for r in rows) + "\n")
        self.assertEqual(self.request("GET", "/api/df"), (200, rows))
        self.docker.assert_called_once_with("system", "df", "--format", "{{json .}}", timeout=docker_gui.ACTION_TIMEOUT)

    def test_df_error(self):
        self.docker.return_value = fail("Cannot connect to the Docker daemon\n")
        self.assertEqual(self.request("GET", "/api/df"), (500, "Cannot connect to the Docker daemon"))

    def test_each_prune_runs_expected_command(self):
        expected = {"images": ["image", "prune", "-a", "-f"], "volumes": ["volume", "prune", "-f"],
                    "buildcache": ["builder", "prune", "-a", "-f"]}
        self.assertEqual(docker_gui.PRUNE, expected)  # mudou a allowlist? reveja o teste e o aviso na página
        self.docker.return_value = ok("Deleted Images:\nx\n\nTotal reclaimed space: 1.2GB\n")
        for kind, args in expected.items():
            self.docker.reset_mock()
            self.assertEqual(self.request("POST", f"/api/prune/{kind}"),
                             (200, "Deleted Images:\nx\n\nTotal reclaimed space: 1.2GB"), kind)
            self.docker.assert_called_once_with(*args, timeout=docker_gui.ACTION_TIMEOUT)

    def test_prune_error_is_500_with_stderr(self):
        self.docker.return_value = fail("Error response from daemon: a prune operation is already running\n")
        self.assertEqual(self.request("POST", "/api/prune/volumes"),
                         (500, "Error response from daemon: a prune operation is already running"))

    def test_unknown_prune_kind(self):
        for kind in ("system", "containers", "all", "Images", "images/x", HEX_ID):
            status, _ = self.request("POST", f"/api/prune/{kind}")
            self.assertEqual(status, 404, kind)
        self.docker.assert_not_called()

    def test_get_does_not_prune(self):
        status, _ = self.request("GET", "/api/prune/images")
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
            for method, path in (("POST", f"/api/stop/{bad}"), ("GET", f"/api/logs/{bad}"), ("GET", f"/api/health/{bad}"),
                                 ("GET", f"/api/inspect/{bad}"), ("GET", f"/api/inspect/{bad}/env"),
                                 ("GET", f"/api/logs/{bad}/stream?t={docker_gui.TOKEN}")):
                status, _ = self.request(method, path)
                self.assertEqual(status, 404, path)
        self.docker.assert_not_called()

    def test_full_64_char_id(self):
        status, _ = self.request("POST", f"/api/stop/{'f' * 64}")
        self.assertEqual(status, 200)

    def test_unknown_path(self):
        for path in ("/api", "/api/", "/api/containers/", "/favicon.ico", "/index.html",
                     f"/api/inspect/{HEX_ID}/", f"/api/inspect/{HEX_ID}/envx", f"/api/inspect/{HEX_ID}?env=1"):
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


class WsClient:
    """Cliente WebSocket cru para o /api/exec (junto com ServerTest, que dá o self.port)."""

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

    def open_session(self, path=None):
        status, headers, sock, f = self.connect(path)
        self.assertEqual(status, 101)
        self.assertEqual(headers["sec-websocket-accept"], "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
        sock.sendall(client_frame(b'{"cols": 80, "rows": 24}', 1))
        return sock, f

    def until(self, f, needle=None):
        """Junta a saída do terminal até aparecer needle (sem needle: até o close). Devolve (saída, avisos em texto)."""
        out, notes = b"", []
        while needle is None or needle not in out:
            op, data = self.recv(f)
            if op == 8:
                if needle is None:
                    return out, notes
                self.fail(f"o terminal fechou antes de {needle!r}: {out!r}")
            if op == 1:
                notes.append(data.decode())
            else:
                out += data
        return out, notes

    def resize_and_wait(self, sock, f):
        """Redimensiona com um programa que imprime o tamanho no SIGWINCH já rodando, e espera o tamanho novo."""
        # pro''nto: o eco da linha digitada não tem "pronto"; só a saída do echo, depois do trap instalado
        sock.sendall(client_frame(b"sh -c 'trap \"stty size\" WINCH; echo pro''nto; while :; do sleep 0.1; done'\r"))
        self.until(f, b"pronto\r\n")
        sock.sendall(client_frame(b'{"cols": 100, "rows": 30}', 1))
        self.until(f, b"30 100\r\n")
        sock.sendall(client_frame(b"\x03"))  # Ctrl+C: o TTY manda SIGINT ao laço
        sock.sendall(client_frame(b"exit\r"))
        self.until(f)


@unittest.skipUnless(os.name == "posix", "PTY só existe em Unix")
class TerminalTest(WsClient, ServerTest):
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

    def test_origin_rejected(self):
        p = self.port
        for origin in (None, "null", f"https://localhost:{p}", f"http://localhost:{p + 1}", f"http://evil.com:{p}",
                       "http://localhost", f"http://127.0.0.1:{p}.evil.com"):
            self.assertEqual(self.connect(origin=origin)[0], 403, origin)
        self.no_process()

    def test_origin_on_ip_accepted(self):
        status, _, _sock, _ = self.connect(origin=f"http://127.0.0.1:{self.port}")
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
        sock, _f = self.open_session()
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


FAKE_PIPE_EXEC = """#!/usr/bin/env python3
# docker falso do modo pipe: roda aqui mesmo o que iria para dentro do container (o script, o sh, o stty)
import json, os, sys
d, args = os.environ["FAKE_EXEC_DIR"], sys.argv[1:]
with open(os.path.join(d, "calls"), "a") as f:
    f.write(json.dumps(args) + "\\n")
if os.environ.get("FAKE_EXEC_FAIL"):
    sys.exit("Error response from daemon: container 0123456789ab is not running")
main = args[1] == "-i"  # o exec da sessão; o outro é o stty do redimensionamento
if main:
    with open(os.path.join(d, "pid"), "w") as f:
        f.write(str(os.getpid()))
if os.environ.get("FAKE_NO_SCRIPT"):  # imagem sem script (alpine): só o sh no PATH
    os.environ["PATH"] = os.path.join(d, "bin")
cmd = args[3:] if main else args[2:]
os.execvp(cmd[0], cmd)
"""


class PipeTerminalTest(TerminalTest):
    """O terminal do Windows (DOCKER_GUI_TERMINAL=pipe), em Linux: o docker falso roda o PIPE_SHELL aqui, com o
    script de verdade. Herda os testes de Origin, token, IDs e fechamento do TerminalTest."""

    def setUp(self):
        super().setUp()
        with open(os.path.join(self.dir, "docker"), "w") as f:
            f.write(FAKE_PIPE_EXEC)
        os.mkdir(os.path.join(self.dir, "bin"))
        os.symlink(shutil.which("sh"), os.path.join(self.dir, "bin", "sh"))
        # HOME vazio: o bash do teste não lê o .bashrc de quem roda. Sem HISTFILE, o bash morto por SIGHUP
        # gravaria o histórico na pasta enquanto ela é apagada
        os.environ.update({"DOCKER_GUI_TERMINAL": "pipe", "HOME": self.dir, "HISTFILE": os.devnull, "SHELL": "/bin/sh"})

    def calls(self):
        with open(os.path.join(self.dir, "calls")) as f:
            return [json.loads(line) for line in f]

    def test_ping_pong(self):  # aqui o shell é de verdade e já escreve o prompt: pula a saída até o pong
        sock, f = self.open_session()
        sock.sendall(client_frame(b"abc", 9))
        frame = self.recv(f)
        while frame[0] == 2:
            frame = self.recv(f)
        self.assertEqual(frame, (10, b"abc"))

    @unittest.skipUnless(shutil.which("script"), "precisa do script (util-linux ou busybox)")
    def test_session(self):
        sock, f = self.open_session()
        sock.sendall(client_frame(b"stty size; echo $((6*7))\r"))
        out, notes = self.until(f, b"42\r\n")
        self.assertIn(b"24 80\r\n", out)  # o tamanho chegou ao TTY antes do shell
        self.assertNotIn(b"\x1b_docker-gui", out)  # a marca não vai para a tela
        self.assertEqual(notes, [])
        self.resize_and_wait(sock, f)
        main, resize = self.calls()
        self.assertEqual(main, ["exec", "-i", HEX_ID, *docker_gui.PIPE_SHELL, docker_gui.TTY_INIT.format(80, 24)])
        self.assertEqual(resize[:-1], ["exec", HEX_ID, *docker_gui.TTY_RESIZE, "100", "30"])
        self.assertRegex(resize[-1], r"^/dev/pts/\d+$")

    def test_without_script_server_echoes_and_edits_line(self):
        os.environ["FAKE_NO_SCRIPT"] = "1"
        sock, f = self.open_session()
        # seta para cima (sem TTY não faz nada), "a" apagado com Backspace
        sock.sendall(client_frame(b"echo $((6*7))\x1b[Aa\x7f\r"))
        out, notes = self.until(f, b"42\r\n")
        self.assertEqual(notes, [docker_gui.NO_TTY])  # a página mostra o aviso
        self.assertIn(b"echo $((6*7))a\b \b\r\n", out)  # eco feito pelo servidor
        sock.sendall(client_frame(b'{"cols": 100, "rows": 30}', 1))  # sem TTY, nada a redimensionar
        sock.sendall(client_frame(b"exit\r"))
        self.until(f)
        self.assertEqual(len(self.calls()), 1)

    def test_docker_error_reaches_the_screen(self):
        os.environ["FAKE_EXEC_FAIL"] = "1"
        _sock, f = self.open_session()
        out, _ = self.until(f)
        self.assertIn(b"is not running\r\n", out)  # sem TTY, o servidor põe o \r

    @unittest.skipUnless(shutil.which("script"), "precisa do script (util-linux ou busybox)")
    def test_windows_never_touches_unix_apis(self):
        """Com os.name == "nt" o modo é o pipe, sem PTY no host, fcntl, termios nem grupo de processos."""
        del os.environ["DOCKER_GUI_TERMINAL"]
        done, real_kill = threading.Event(), docker_gui.kill

        def kill(proc):
            real_kill(proc)
            done.set()

        with mock.patch.object(docker_gui.os, "name", "nt"), mock.patch.object(os, "openpty") as openpty, \
                mock.patch.object(os, "killpg") as killpg, mock.patch.object(docker_gui, "kill", kill), \
                mock.patch.dict(sys.modules, {"fcntl": None, "termios": None}):  # import fcntl falharia
            sock, f = self.open_session()
            sock.sendall(client_frame(b"echo $((6*7))\r"))
            self.until(f, b"42\r\n")
            sock.sendall(client_frame(b"", 8))
            self.assertTrue(done.wait(10), "a sessão não terminou")
        openpty.assert_not_called()
        killpg.assert_not_called()
        self.assertEqual(self.calls()[0][:2], ["exec", "-i"])


class TerminalHelpersTest(unittest.TestCase):

    def test_mode_by_platform(self):
        for name, env, mode in (("posix", None, "pty"), ("nt", None, "pipe"), ("posix", "pipe", "pipe"),
                                ("nt", "pty", "pipe"), ("posix", "outro", "pty")):
            with mock.patch.object(docker_gui.os, "name", name), mock.patch.dict(os.environ):
                os.environ.pop("DOCKER_GUI_TERMINAL", None)
                if env:
                    os.environ["DOCKER_GUI_TERMINAL"] = env
                self.assertEqual(docker_gui.terminal_mode(), mode, (name, env))

    def test_term_size(self):
        self.assertEqual(docker_gui.term_size(b'{"cols": 80, "rows": 24}'), (80, 24))
        # no modo pipe o tamanho entra no comando do shell: só inteiros
        for bad in (b'{"cols": "80; reboot", "rows": 24}', b'{"cols": 80.5, "rows": 24}', b'{"cols": true, "rows": 24}',
                    b'{"cols": -1, "rows": 24}', b'{"cols": 80, "rows": 65536}', b'{"cols": 80}', b"[80, 24]", b"oi",
                    b'{"cols": 80, "rows": 24}\xff'):
            with self.assertRaises((ValueError, KeyError, TypeError), msg=bad):
                docker_gui.term_size(bad)

    def test_cook(self):
        for line, typed, want in (
                ("", b"ls -l\r", ("", b"ls -l\n", b"ls -l\r\n")),
                ("", b"ec", ("ec", b"", b"ec")),
                ("ec", b"ho\r", ("", b"echo\n", b"ho\r\n")),
                ("ab", b"\x7f\x7f\x7f", ("", b"", b"\b \b\b \b")),  # Backspace na linha vazia não apaga o prompt
                ("abc", b"\x03", ("", b"", b"^C\r\n")),
                ("", b"\x1b[A\x1bOPx\t\x1b", ("x", b"", b"x")),  # setas, F1, Tab e Esc somem
                ("", b"a\rb\r", ("", b"a\nb\n", b"a\r\nb\r\n")),  # colar várias linhas
                ("", "ação\r".encode(), ("", "ação\n".encode(), "ação\r\n".encode()))):
            self.assertEqual(docker_gui.cook(line, typed), want, (line, typed))

    def test_kill_on_windows_terminates_the_process(self):
        proc = mock.Mock()
        with mock.patch.object(docker_gui.os, "name", "nt"), mock.patch.object(os, "killpg", create=True) as killpg:
            docker_gui.kill(proc)
        killpg.assert_not_called()
        proc.kill.assert_called_once_with()
        proc.wait.assert_called_once_with()

    @unittest.skipUnless(os.name == "posix", "grupo de processos só existe em Unix")
    def test_kill_on_unix_kills_the_group(self):
        proc = mock.Mock(pid=1234)
        with mock.patch.object(os, "killpg") as killpg:
            docker_gui.kill(proc)
        killpg.assert_called_once_with(1234, signal.SIGKILL)
        proc.kill.assert_not_called()
        proc.wait.assert_called_once_with()


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
class RealDockerTest(WsClient, ServerTest):
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

    def test_exec_terminal(self):  # antes do test_lifecycle (ordem alfabética), que remove o container
        # o modo do Windows (pipe: TTY aberto pelo script do busybox, dentro do container) roda em qualquer sistema
        for mode in ("pty", "pipe") if os.name == "posix" else ("pipe",):
            with self.subTest(mode), mock.patch.dict(os.environ, {"DOCKER_GUI_TERMINAL": mode}):
                sock, f = self.open_session(f"/api/exec/{self.cid}?t={docker_gui.TOKEN}")
                sock.sendall(client_frame(b"stty size; echo $((6*7))\r"))
                out, notes = self.until(f, b"42\r\n")
                self.assertIn(b"24 80\r\n", out)
                self.assertNotIn(b"\x1b_docker-gui", out)
                self.assertEqual(notes, [])
                self.resize_and_wait(sock, f)
                sock.close()

    def test_lifecycle(self):
        c = self.state()
        for field in ("ID", "Names", "Image", "State", "Status", "Ports", "Labels"):
            self.assertIn(field, c)  # campos que a página lê
        self.assertEqual(c["State"], "running")
        self.assertIn("docker-gui-test=1", c["Labels"])

        # a página casa o stats com o ps pelo ID: os dois precisam vir no mesmo formato (curto)
        _, rows = self.request("GET", "/api/stats")
        s = next(s for s in rows if s["ID"] == c["ID"])
        for field in ("CPUPerc", "MemUsage", "MemPerc"):
            self.assertIn(field, s)

        short = c["ID"]
        for action, state in (("pause", "paused"), ("unpause", "running"), ("stop", "exited"), ("start", "running")):
            self.assertEqual(self.request("POST", f"/api/{action}/{short}"), (200, ""), action)
            self.assertEqual(self.state()["State"], state, action)

        status, logs = self.request("GET", f"/api/logs/{short}")
        self.assertEqual(status, 200)
        self.assertIsInstance(logs, str)

        status, health = self.request("GET", f"/api/health/{short}")
        self.assertEqual((status, health), (200, None))  # sem HEALTHCHECK na imagem

        status, insp = self.request("GET", f"/api/inspect/{short}")
        self.assertEqual((status, insp["Restart"]), (200, "no"))
        self.assertIn(["PATH", None], insp["Env"])  # mascarado
        _, insp = self.request("GET", f"/api/inspect/{short}/env")
        self.assertTrue(any(k == "PATH" and v for k, v in insp["Env"]))

        self.assertEqual(self.request("POST", f"/api/remove/{short}"), (200, ""))
        _, rows = self.request("GET", "/api/containers")
        self.assertFalse(any(self.cid.startswith(r["ID"]) for r in rows))

    def test_df(self):
        # só lê: prune nunca roda contra o Docker de verdade
        status, rows = self.request("GET", "/api/df")
        self.assertEqual(status, 200)
        self.assertTrue({"Images", "Local Volumes", "Build Cache"} <= {r["Type"] for r in rows})
        for field in ("TotalCount", "Active", "Size", "Reclaimable"):
            self.assertIn(field, rows[0])  # campos que a página lê

    def test_action_on_missing_container(self):
        status, err = self.request("POST", f"/api/stop/{'0' * 64}")
        self.assertEqual(status, 500)
        self.assertIn("No such container", err)


if __name__ == "__main__":
    unittest.main()
