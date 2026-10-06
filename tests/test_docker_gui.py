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
from urllib.parse import urlencode

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
                                 ("GET", "/api/df"), ("POST", "/api/prune/images"), ("GET", "/api/images"),
                                 ("GET", "/api/volumes"), ("GET", "/api/networks"), ("POST", f"/api/rm/image/{HEX_ID}"),
                                 ("POST", "/api/rm/volume/pgdata"), ("POST", f"/api/rm/network/{HEX_ID}"),
                                 ("POST", "/api/run")):
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

    def test_podman_uses_json_array_and_is_normalized(self):
        self.docker.return_value = ok(json.dumps(PODMAN_STATS, indent=1) + "\n")
        with mock.patch.object(docker_gui, "CLI", ["/usr/bin/podman"]):
            self.assertEqual(self.request("GET", "/api/stats"), (200, [PODMAN_STATS_EXPECTED]))
        self.docker.assert_called_once_with("stats", "--no-stream", "--format", "json")


# `podman stats --no-stream --format json` do podman 5: array indentado, nomes em snake_case, tudo em texto
PODMAN_STATS = [{"id": "3f1c2b9a8e7d", "name": "loja_db_1", "cpu_time": "1.5s", "cpu_percent": "0.52%",
                 "avg_cpu": "0.40%", "mem_usage": "10.5MB / 2.06GB", "mem_percent": "0.51%",
                 "net_io": "1.2kB / 648B", "block_io": "0B / 4.1kB", "pids": "3"}]
PODMAN_STATS_EXPECTED = {"ID": "3f1c2b9a8e7d", "Name": "loja_db_1", "CPUPerc": "0.52%", "MemUsage": "10.5MB / 2.06GB",
                         "MemPerc": "0.51%", "NetIO": "1.2kB / 648B", "BlockIO": "0B / 4.1kB"}


class NormalizeStatsTest(unittest.TestCase):
    """Saída do `podman stats` -> o formato do `docker stats` que a página lê."""

    def test_docker_lines_pass_through(self):
        row = {"ID": "a" * 12, "CPUPerc": "0.52%", "MemUsage": "10.5MiB / 1.944GiB", "MemPerc": "0.53%",
               "NetIO": "1.2kB / 648B", "BlockIO": "0B / 0B"}
        self.assertEqual(docker_gui.stats(json.dumps(row) + "\n"), [row])
        self.assertEqual(docker_gui.stats(""), [])

    def test_podman_array(self):
        self.assertEqual(docker_gui.stats(json.dumps(PODMAN_STATS, indent=1)), [PODMAN_STATS_EXPECTED])
        self.assertEqual(docker_gui.stats("[]\n"), [])

    def test_podman_raw_struct_from_docker_shim(self):
        # podman-docker: `docker stats --format '{{json .}}'` chama o podman, que serializa a struct crua (números)
        raw = {"AvgCPU": 0.4, "ContainerID": "3f1c2b9a8e7d" + "0" * 52, "Name": "loja_db_1", "CPU": 0.5234,
               "MemUsage": 10_500_000, "MemLimit": 2_060_000_000, "MemPerc": 0.509,
               "Network": {"eth0": {"RxBytes": 1200, "TxBytes": 648}, "eth1": {"RxBytes": 34, "TxBytes": 0}},
               "BlockInput": 0, "BlockOutput": 4096, "PIDs": 3}
        self.assertEqual(docker_gui.stats(json.dumps(raw) + "\n"), [
            {"ID": "3f1c2b9a8e7d", "Name": "loja_db_1", "CPUPerc": "0.52%", "MemUsage": "10.5MB / 2.06GB",
             "MemPerc": "0.51%", "NetIO": "1.234kB / 648B", "BlockIO": "0B / 4.096kB"}])
        # sem rede (network none) e sem nada medido ainda
        got = docker_gui.from_podman_stats({"ContainerID": "b" * 64, "Network": None})
        self.assertEqual((got["CPUPerc"], got["MemUsage"], got["NetIO"]), ("0.00%", "0B / 0B", "0B / 0B"))

    def test_podman_size_matches_go_units(self):
        # go-units HumanSize: base 1000, 4 algarismos significativos
        for n, want in ((0, "0B"), (648, "648B"), (1200, "1.2kB"), (10_500_000, "10.5MB"), (2_060_000_000, "2.06GB"),
                        (1_234_567, "1.235MB"), (5 * 10**15, "5PB")):
            self.assertEqual(docker_gui.podman_size(n), want, n)


class LogsAndHealthTest(ServerTest):

    def test_logs_join_stdout_and_stderr(self):
        self.docker.return_value = ok("out\n", "err\n")
        self.assertEqual(self.request("GET", f"/api/logs/{HEX_ID}"), (200, "out\nerr\n"))
        self.docker.assert_called_once_with("logs", "--timestamps", "--tail", "500", HEX_ID, timeout=docker_gui.READ_TIMEOUT)

    def test_logs_tail_from_whitelist(self):
        cases = {"500": ["--tail", "500"], "2000": ["--tail", "2000"], "10000": ["--tail", "10000"], "all": []}
        for tail, args in cases.items():
            self.docker.reset_mock()
            self.assertEqual(self.request("GET", f"/api/logs/{HEX_ID}?tail={tail}")[0], 200, tail)
            # o log inteiro pode demorar: "all" ganha o prazo longo
            timeout = docker_gui.ACTION_TIMEOUT if tail == "all" else docker_gui.READ_TIMEOUT
            self.docker.assert_called_once_with("logs", "--timestamps", *args, HEX_ID, timeout=timeout)

    def test_logs_tail_outside_whitelist_never_reaches_docker(self):
        for tail in ("", "1", "499", "501", "-1", "0", "100000", "ALL", "+500", "500%20--help", "--help",
                     "500;rm", "all%00", "500&tail=all"):
            status, _ = self.request("GET", f"/api/logs/{HEX_ID}?tail={tail}")
            self.assertIn(status, (400, 404), tail)
        self.assertEqual(self.request("GET", f"/api/logs/{HEX_ID}?tail=500&tail=all"), (400, "tail inválido"))
        for query in ("tail=500&x=1", "x=1", "t=1&tail=500", "since=5m&until=1m"):
            status, _ = self.request("GET", f"/api/logs/{HEX_ID}?{query}")
            self.assertEqual(status, 404, query)  # só ?tail= e ?since=, e nada mais
        self.docker.assert_not_called()

    def test_logs_since_from_whitelist(self):
        for since in ("5m", "15m", "1h", "24h"):
            self.docker.reset_mock()
            self.assertEqual(self.request("GET", f"/api/logs/{HEX_ID}?tail=2000&since={since}")[0], 200, since)
            self.docker.assert_called_once_with("logs", "--timestamps", "--tail", "2000", "--since", since, HEX_ID,
                                                timeout=docker_gui.READ_TIMEOUT)

    def test_logs_since_start_reads_started_at(self):
        # docker: texto; podman: data com fuso. Os dois saem RFC 3339 no {{json}}
        for started in ("2026-10-06T12:00:01.123456789Z", "2026-10-06T09:00:01.5-03:00"):
            self.docker.reset_mock()
            self.docker.side_effect = [ok(json.dumps(started) + "\n"), ok("oi\n")]
            self.assertEqual(self.request("GET", f"/api/logs/{HEX_ID}?since=start"), (200, "oi\n"), started)
            self.assertEqual(self.docker.call_args_list, [
                mock.call("inspect", "--format", "{{json .State.StartedAt}}", HEX_ID),
                mock.call("logs", "--timestamps", "--tail", "500", "--since", started, HEX_ID, timeout=docker_gui.READ_TIMEOUT)])

    def test_logs_since_start_without_a_date_is_500(self):
        for out in (fail("No such container\n"), ok('"--help"\n'), ok('{"x": 1}\n'), ok("não é json\n")):
            self.docker.reset_mock()
            self.docker.side_effect = [out]
            status, _ = self.request("GET", f"/api/logs/{HEX_ID}?since=start")
            self.assertEqual(status, 500, out)
            self.assertEqual(self.docker.call_count, 1)  # o logs não roda

    def test_logs_since_outside_whitelist_never_reaches_docker(self):
        for since in ("", "5", "10m", "1d", "--help", "5m;rm", "2026-01-01T00:00:00Z", "START", "start&since=5m"):
            status, body = self.request("GET", f"/api/logs/{HEX_ID}?since={since}")
            self.assertEqual((status, body), (400, "since inválido"), since)
        self.docker.assert_not_called()

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
class StreamTest(ServerTest):
    """Base dos streams SSE: o docker é um script shell de verdade, porque o stream roda um processo longo."""

    def setUp(self):
        super().setUp()
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.dir = d.name
        patcher = mock.patch.dict(os.environ, {"PATH": d.name + os.pathsep + os.environ.get("PATH", "")})
        patcher.start()
        self.addCleanup(patcher.stop)

    def fake_docker(self, body, name="docker"):
        path = os.path.join(self.dir, name)
        with open(path, "w") as f:
            f.write(f'#!/bin/sh\necho "$@" > {self.dir}/args\n{body}\n')
        os.chmod(path, 0o755)

    def wait_dead(self, what):
        with open(os.path.join(self.dir, "pid")) as f:
            pid = int(f.read())
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)
        self.fail(f"{what} continuou vivo depois que o cliente desconectou")


class LogsStreamTest(StreamTest):
    """Logs ao vivo (SSE)."""

    def path(self, token=docker_gui.TOKEN):
        return f"/api/logs/{HEX_ID}/stream" + (f"?t={token}" if token is not None else "")

    def test_lines_become_events_and_end(self):
        self.fake_docker("printf 'um\\ndois\\r\\nsem quebra no fim'")
        status, body = self.request("GET", self.path())
        self.assertEqual(status, 200)
        self.assertEqual(body, 'data: "um\\n"\n\ndata: "dois\\r\\n"\n\ndata: "sem quebra no fim"\n\nevent: end\ndata:\n\n')
        with open(os.path.join(self.dir, "args")) as f:
            self.assertEqual(f.read().split(), ["logs", "-f", "--timestamps", "--tail", "500", HEX_ID])

    def test_tail_from_whitelist(self):
        cases = {"500": ["--tail", "500"], "2000": ["--tail", "2000"], "10000": ["--tail", "10000"], "all": []}
        for tail, args in cases.items():
            self.fake_docker("echo oi")
            status, _ = self.request("GET", self.path() + f"&tail={tail}")
            self.assertEqual(status, 200, tail)
            with open(os.path.join(self.dir, "args")) as f:
                self.assertEqual(f.read().split(), ["logs", "-f", "--timestamps", *args, HEX_ID])

    def test_tail_outside_whitelist_is_400_without_docker(self):
        self.fake_docker("echo nunca")
        for query in ("tail=", "tail=1", "tail=-1", "tail=ALL", "tail=500%20--help", "tail=--help", "tail=500;rm",
                      "tail=500&tail=all", "tail=10000%00"):
            status, body = self.request("GET", self.path() + "&" + query)
            self.assertEqual((status, body), (400, "tail inválido"), query)
        # sem token, nem chega a olhar o tail
        self.assertEqual(self.request("GET", f"/api/logs/{HEX_ID}/stream?tail=x")[0], 401)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "args")))

    def test_token_goes_in_query(self):
        self.fake_docker("echo nunca")
        for token in (None, "", "errado", docker_gui.TOKEN[:-1]):
            status, _ = self.request("GET", self.path(token))  # o header com o token certo não vale aqui
            self.assertEqual(status, 401, token)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "args")))

    def test_compose_project_stream(self):
        # o par {project, dir} é conferido nos labels (docker mockado); o compose logs -f roda o script
        self.docker.return_value = ok(ComposeTest.PS)
        self.fake_docker("printf 'api-1  | oi\\n'")
        status, body = self.request("GET", "/api/compose/logs/stream?" + urlencode({**ComposeTest.SHOP, "t": docker_gui.TOKEN}))
        self.assertEqual((status, body), (200, 'data: "api-1  | oi\\n"\n\nevent: end\ndata:\n\n'))
        with open(os.path.join(self.dir, "args")) as f:
            self.assertEqual(f.read().split(), [*ComposeTest.BASE, "logs", "--no-color", "--timestamps", "--tail", "500", "--follow"])

    def test_since_goes_to_the_stream(self):
        self.fake_docker("echo oi")
        self.assertEqual(self.request("GET", self.path() + "&since=15m")[0], 200)
        with open(os.path.join(self.dir, "args")) as f:
            self.assertEqual(f.read().split(), ["logs", "-f", "--timestamps", "--tail", "500", "--since", "15m", HEX_ID])
        os.remove(os.path.join(self.dir, "args"))
        self.assertEqual(self.request("GET", self.path() + "&since=1d"), (400, "since inválido"))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "args")))

    def test_compose_project_stream_tail(self):
        self.docker.return_value = ok(ComposeTest.PS)
        self.fake_docker("true")
        q = {**ComposeTest.SHOP, "t": docker_gui.TOKEN}
        self.assertEqual(self.request("GET", "/api/compose/logs/stream?" + urlencode({**q, "tail": "all"}))[0], 200)
        with open(os.path.join(self.dir, "args")) as f:
            self.assertEqual(f.read().split(), [*ComposeTest.BASE, "logs", "--no-color", "--timestamps", "--follow"])
        os.remove(os.path.join(self.dir, "args"))
        for tail in ("", "1", "--help", "500;rm"):
            self.assertEqual(self.request("GET", "/api/compose/logs/stream?" + urlencode({**q, "tail": tail})),
                             (400, "tail inválido"), tail)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "args")))

    def test_compose_stream_checks_token_and_project(self):
        self.docker.return_value = ok(ComposeTest.PS)
        self.fake_docker("echo nunca")
        for q, code in (({**ComposeTest.SHOP}, 401), ({**ComposeTest.SHOP, "t": "errado"}, 401),
                        ({"project": "shop", "dir": "/srv/blog", "t": docker_gui.TOKEN}, 404),
                        ({"project": "shop", "t": docker_gui.TOKEN}, 400)):
            status, _ = self.request("GET", "/api/compose/logs/stream?" + urlencode(q))  # o header com o token não vale
            self.assertEqual(status, code, q)
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
        r.close()  # a resposta segura o socket aberto: sem fechar as duas, a conexão não cai
        conn.close()
        self.wait_dead("docker logs -f")


class RelevantEventTest(unittest.TestCase):
    """Que linha do docker/podman events vale um aviso "a lista mudou"."""

    def test_docker(self):
        line = '{"Type":"container","Action":"%s","Actor":{"ID":"abc","Attributes":{}},"scope":"local"}'
        for action in ("create", "start", "die", "destroy", "pause", "rename", "health_status: unhealthy"):
            self.assertTrue(docker_gui.relevant(line % action), action)
        # o healthcheck é um exec a cada intervalo: sem filtrar, a lista seria buscada a cada probe
        for action in ("exec_create: /bin/sh -c test -f /tmp/ok", "exec_start: /bin/sh -c true", "exec_die",
                       "attach", "resize", "top", "archive-path"):
            self.assertFalse(docker_gui.relevant(line % action), action)

    def test_old_docker_and_podman(self):
        self.assertTrue(docker_gui.relevant(b'{"status":"start","id":"abc"}'))
        self.assertTrue(docker_gui.relevant(b'{"ID":"abc","Status":"health_status","HealthStatus":"unhealthy","Type":"container"}'))
        self.assertTrue(docker_gui.relevant(b'{"ID":"abc","Name":"web","Status":"died","Type":"container"}'))
        self.assertFalse(docker_gui.relevant(b'{"ID":"abc","Name":"web","Status":"exec_died","Type":"container"}'))
        self.assertFalse(docker_gui.relevant(b'{"ID":"abc","Name":"web","Status":"exec","Type":"container"}'))

    def test_unknown_lines_count_as_change(self):
        for line in (b"2026-10-05 container start abc (image=web)", b"[1]", b'{"Action": 5}', b"\xff"):
            self.assertTrue(docker_gui.relevant(line), line)
        self.assertFalse(docker_gui.relevant(b"  "))


class EventsStreamTest(StreamTest):
    """Eventos da lista (SSE): um "data: 1" por leva de eventos que importam, nada do evento em si."""

    def path(self, token=docker_gui.TOKEN):
        return "/api/events/stream" + (f"?t={token}" if token is not None else "")

    def test_batch_becomes_one_message_and_end(self):
        self.fake_docker("""cat <<'EOF'
{"Type":"container","Action":"exec_start: sh -c curl -f localhost","Actor":{"ID":"abc"}}
{"Type":"container","Action":"exec_die","Actor":{"ID":"abc"}}
EOF
sleep 0.3
cat <<'EOF'
{"Type":"container","Action":"health_status: unhealthy","Actor":{"ID":"abc"}}
{"Type":"container","Action":"die","Actor":{"ID":"abc"}}
EOF""")
        status, body = self.request("GET", self.path())
        self.assertEqual(status, 200)
        self.assertEqual(body, "data: 1\n\nevent: end\ndata:\n\n")  # os exec do healthcheck não avisam nada
        with open(os.path.join(self.dir, "args")) as f:
            self.assertEqual(f.read().strip(), "events --format {{json .}} --filter type=container")

    def test_podman_uses_json_format(self):
        self.fake_docker("""echo '{"ID":"abc","Status":"start","Type":"container"}'""", name="podman")
        with mock.patch.object(docker_gui, "CLI", ["podman"]):
            self.assertEqual(self.request("GET", self.path()), (200, "data: 1\n\nevent: end\ndata:\n\n"))
        with open(os.path.join(self.dir, "args")) as f:
            self.assertEqual(f.read().strip(), "events --format json --filter type=container")

    def test_token_goes_in_query(self):
        self.fake_docker("echo nunca")
        for token in (None, "", "errado", docker_gui.TOKEN[:-1]):
            status, _ = self.request("GET", self.path(token))  # o header com o token certo não vale aqui
            self.assertEqual(status, 401, token)
        self.assertEqual(self.request("GET", self.path(), host="evil.example:80")[0], 403)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "args")))

    def test_missing_binary_is_500_and_frees_slot(self):
        class SlowRelease(threading.BoundedSemaphore):
            def release(self, *args):  # vaga devolvida devagar: a resposta não pode sair antes dela
                time.sleep(0.3)
                super().release(*args)

        # quem recebe o 500 e tenta de novo na hora já acha a vaga livre
        with mock.patch.object(docker_gui, "EVENTS_SLOTS", SlowRelease(1)):
            with mock.patch.object(docker_gui, "CLI", [os.path.join(self.dir, "nao-existe")]):
                self.assertEqual(self.request("GET", self.path())[0], 500)
            self.fake_docker("true")
            self.assertEqual(self.request("GET", self.path()), (200, "event: end\ndata:\n\n"))

    def test_disconnect_kills_docker_and_frees_slot(self):
        self.fake_docker(f"echo $$ > {self.dir}/pid\nexec sleep 30")
        with mock.patch.object(docker_gui, "EVENTS_SLOTS", threading.BoundedSemaphore(1)):
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
            conn.request("GET", self.path(), headers={"Host": f"localhost:{self.port}"})
            r = conn.getresponse()
            self.assertEqual(r.getheader("Content-Type"), "text/event-stream; charset=utf-8")
            # sem vaga: recusa na hora, sem rodar outro docker events (a página fica no poll de 2 s)
            self.assertEqual(self.request("GET", self.path())[0], 503)
            for _ in range(50):
                if os.path.exists(os.path.join(self.dir, "pid")):
                    break
                time.sleep(0.1)
            r.close()
            conn.close()
            self.wait_dead("docker events")
            self.fake_docker("true")
            for _ in range(50):  # a vaga volta logo depois de o processo morrer
                if self.request("GET", self.path())[0] == 200:
                    return
                time.sleep(0.1)
            self.fail("a vaga do stream não foi devolvida")


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
    """O cliente só escolhe o projeto (e o serviço); diretório, arquivos e serviços saem dos labels dos containers."""

    # uma linha por container: projeto, pasta, arquivos e serviço
    PS = "\n".join(json.dumps(r) for r in (
        ["shop", "/srv/shop", "/srv/shop/compose.yml,/srv/shop/compose.override.yml", "api"],
        ["shop", "/srv/shop", "/srv/shop/compose.yml,/srv/shop/compose.override.yml", "db"],
        ["blog", "/srv/blog", "/srv/blog/compose.yml", "web"])) + "\n"
    SHOP: ClassVar[dict] = {"project": "shop", "dir": "/srv/shop"}
    BASE = ("compose", "-p", "shop", "--project-directory", "/srv/shop",
            "-f", "/srv/shop/compose.yml", "-f", "/srv/shop/compose.override.yml")

    @staticmethod
    def ps_call():
        return mock.call("ps", "-a", "--filter", "label=com.docker.compose.project", "--format", docker_gui.COMPOSE_FORMAT)

    def test_each_action_builds_argv_from_labels(self):
        self.assertEqual(docker_gui.COMPOSE, {"up": ["up", "-d"], "rebuild": ["up", "-d", "--build"],
                                              "down": ["down"], "pull": ["pull"]})
        for action, args in docker_gui.COMPOSE.items():
            self.docker.reset_mock()
            self.docker.side_effect = [ok(self.PS), ok(stderr="Container shop-api-1  Started\n")]
            self.assertEqual(self.request("POST", f"/api/compose/{action}", body=self.SHOP),
                             (200, "Container shop-api-1  Started"), action)
            self.assertEqual(self.docker.call_args_list, [self.ps_call(), mock.call(
                *self.BASE, *args, timeout=docker_gui.COMPOSE_TIMEOUT)])

    def test_restart_one_service(self):
        self.assertEqual(docker_gui.COMPOSE_SERVICE, {"restart": ["restart"], "build": ["up", "-d", "--build", "--no-deps"]})
        self.docker.side_effect = [ok(self.PS), ok(stderr="Container shop-db-1  Started\n")]
        self.assertEqual(self.request("POST", "/api/compose/restart", body={**self.SHOP, "service": "db"}),
                         (200, "Container shop-db-1  Started"))
        self.assertEqual(self.docker.call_args_list, [self.ps_call(), mock.call(
            *self.BASE, "restart", "--", "db", timeout=docker_gui.COMPOSE_TIMEOUT)])

    def test_build_one_service(self):
        # reconstrói e recria só o api: --no-deps deixa o db como está
        self.docker.side_effect = [ok(self.PS), ok(stderr="Container shop-api-1  Started\n")]
        self.assertEqual(self.request("POST", "/api/compose/build", body={**self.SHOP, "service": "api"}),
                         (200, "Container shop-api-1  Started"))
        self.assertEqual(self.docker.call_args_list, [self.ps_call(), mock.call(
            *self.BASE, "up", "-d", "--build", "--no-deps", "--", "api", timeout=docker_gui.COMPOSE_TIMEOUT)])

    def test_restart_service_must_be_from_the_project(self):
        # web existe, mas é do blog; o resto não é serviço de ninguém (nem vira flag do compose)
        for service in ("web", "nope", "--help", "-t", "db api", "DB"):
            self.docker.reset_mock()
            self.docker.side_effect = None
            self.docker.return_value = ok(self.PS)
            self.assertEqual(self.request("POST", "/api/compose/restart", body={**self.SHOP, "service": service}),
                             (404, "serviço não encontrado no projeto"), service)
            self.assertEqual(self.docker.call_args_list, [self.ps_call()])

    def test_restart_without_valid_service_is_400_without_docker(self):
        for body in (self.SHOP, {**self.SHOP, "service": ""}, {**self.SHOP, "service": 1},
                     {**self.SHOP, "service": ["db"]}, {**self.SHOP, "service": None}, {"service": "db"}):
            for action in docker_gui.COMPOSE_SERVICE:  # o build sem serviço não vira o rebuild do projeto inteiro
                status, _ = self.request("POST", f"/api/compose/{action}", body=body)
                self.assertEqual(status, 400, (action, body))
        self.docker.assert_not_called()

    def test_restart_unknown_pair_is_404(self):
        self.docker.return_value = ok(self.PS)
        status, _ = self.request("POST", "/api/compose/restart", body={"project": "shop", "dir": "/srv/blog", "service": "web"})
        self.assertEqual(status, 404)
        self.assertEqual(self.docker.call_args_list, [self.ps_call()])

    def logs_path(self, **q):
        return "/api/compose/logs?" + urlencode(q)

    def test_project_logs_in_time_order(self):
        # sem -f, o compose despeja um container de cada vez; a fração do RFC3339Nano vem sem os zeros do fim
        out = ("db-1   | 2026-10-05T14:04:48.6213387Z db 0\n"
               "db-1   | 2026-10-05T14:04:50Z db 2\n"
               "api-1  | 2026-10-05T14:04:48.62Z api 0\n"
               "api-1  | 2026-10-05T14:04:49.5Z api 1 \r com \\r\n")
        self.docker.side_effect = [ok(self.PS), ok(out, "WARN obsoleto\n")]
        self.assertEqual(self.request("GET", self.logs_path(project="shop", dir="/srv/shop")), (200, (
                         "api-1  | 2026-10-05T14:04:48.62Z api 0\n"
                         "db-1   | 2026-10-05T14:04:48.6213387Z db 0\n"
                         "api-1  | 2026-10-05T14:04:49.5Z api 1 \r com \\r\n"
                         "db-1   | 2026-10-05T14:04:50Z db 2\n")))
        self.assertEqual(self.docker.call_args_list, [self.ps_call(), mock.call(
            *self.BASE, "logs", "--no-color", "--timestamps", "--tail", "500", timeout=docker_gui.READ_TIMEOUT)])

    def test_project_logs_tail_from_whitelist(self):
        # mesma whitelist dos logs de um container; no compose o --tail vale por container
        cases = {"500": ["--tail", "500"], "2000": ["--tail", "2000"], "10000": ["--tail", "10000"], "all": []}
        for tail, args in cases.items():
            self.docker.reset_mock()
            self.docker.side_effect = [ok(self.PS), ok("")]
            self.assertEqual(self.request("GET", self.logs_path(**self.SHOP, tail=tail))[0], 200, tail)
            timeout = docker_gui.ACTION_TIMEOUT if tail == "all" else docker_gui.READ_TIMEOUT
            self.assertEqual(self.docker.call_args_list, [self.ps_call(), mock.call(
                *self.BASE, "logs", "--no-color", "--timestamps", *args, timeout=timeout)], tail)

    def test_project_logs_since(self):
        self.docker.side_effect = [ok(self.PS), ok("")]
        self.assertEqual(self.request("GET", self.logs_path(**self.SHOP, since="1h"))[0], 200)
        self.assertEqual(self.docker.call_args_list, [self.ps_call(), mock.call(
            *self.BASE, "logs", "--no-color", "--timestamps", "--tail", "500", "--since", "1h", timeout=docker_gui.READ_TIMEOUT)])
        self.docker.reset_mock()
        # "start" é de um container só: no projeto, cada um subiu numa hora
        for since in ("start", "", "--help"):
            self.assertEqual(self.request("GET", self.logs_path(**self.SHOP, since=since)), (400, "since inválido"), since)
        self.docker.assert_not_called()

    def test_project_logs_tail_outside_whitelist_is_400_without_docker(self):
        for tail in ("", "1", "-1", "ALL", "--help", "500 --help", "500;rm", ["500", "all"]):
            status, body = self.request("GET", self.logs_path(**self.SHOP) + "&" + urlencode({"tail": tail}, doseq=True))
            self.assertEqual((status, body), (400, "tail inválido"), tail)
        self.docker.assert_not_called()

    def test_by_time_keeps_lines_without_timestamp_on_top(self):
        self.assertEqual(docker_gui.by_time(""), "")
        self.assertEqual(docker_gui.by_time("a | 2026-01-01T00:00:02Z x\nsem hora\n\nb | 2026-01-01T00:00:01Z y"),
                         "sem hora\nb | 2026-01-01T00:00:01Z y\na | 2026-01-01T00:00:02Z x\n")

    def test_project_logs_errors(self):
        self.docker.return_value = ok(self.PS)
        for path in (self.logs_path(project="shop", dir="/srv/blog"), self.logs_path(project="nope", dir="/srv/shop")):
            self.docker.reset_mock()
            self.assertEqual(self.request("GET", path), (404, "projeto compose não encontrado"), path)
            self.assertEqual(self.docker.call_args_list, [self.ps_call()])
        self.docker.reset_mock()
        for path in ("/api/compose/logs", self.logs_path(project="shop"), self.logs_path(project="", dir="/srv/shop")):
            self.assertEqual(self.request("GET", path)[0], 400, path)
        # o token só vale no header: na query, só as rotas de stream aceitam
        for token, path in ((None, self.logs_path(**self.SHOP)), (None, self.logs_path(**self.SHOP, t=docker_gui.TOKEN))):
            self.assertEqual(self.request("GET", path, token=token)[0], 401, path)
        self.docker.assert_not_called()
        self.docker.side_effect = [ok(self.PS), fail("no such service\n")]
        self.assertEqual(self.request("GET", self.logs_path(**self.SHOP)), (500, "no such service"))

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
        for action in ("start", "rm", "UP", "exec", "Build", "logs"):
            status, _ = self.request("POST", f"/api/compose/{action}", body=self.SHOP)
            self.assertEqual(status, 404, action)
        self.docker.assert_not_called()

    def test_requires_token(self):
        status, _ = self.request("POST", "/api/compose/up", token=None, body=self.SHOP)
        self.assertEqual(status, 401)
        self.docker.assert_not_called()


class RunArgvTest(unittest.TestCase):
    """Corpo do POST /api/run -> argv: cada campo por regex ou lista fixa, e nenhum valor vira flag."""

    def argv(self, **body):
        return docker_gui.run_argv({"image": "nginx", **body})

    def assertRejected(self, **body):
        with self.assertRaises((ValueError, TypeError), msg=repr(body)[:80]):
            self.argv(**body)

    def test_minimal(self):
        self.assertEqual(self.argv(), ["run", "-d", "--restart=no", "--", "nginx"])

    def test_full(self):
        argv = self.argv(image="ghcr.io/acme/api:1.4", name="api", ports=["8080:80", "5353:53/udp", "9000:9000/tcp"],
                         env=["DATABASE_URL=postgres://u:p@db/x?a=1&b=2", "_X=", "MSG=olá; rm -rf / $(id)", "OPT=--privileged"],
                         restart="unless-stopped", volume="api-data:/var/lib/api")
        self.assertEqual(argv, [
            "run", "-d", "--restart=unless-stopped", "--name=api",
            "-p", "127.0.0.1:8080:80/tcp", "-p", "127.0.0.1:5353:53/udp", "-p", "127.0.0.1:9000:9000/tcp",
            "-e", "DATABASE_URL=postgres://u:p@db/x?a=1&b=2", "-e", "_X=", "-e", "MSG=olá; rm -rf / $(id)", "-e", "OPT=--privileged",
            "--mount=type=volume,source=api-data,target=/var/lib/api", "--", "ghcr.io/acme/api:1.4"])

    def test_values_never_look_like_flags(self):
        # o que vem depois de -p/-e e o que não é flag fixa nunca começa com "-"
        argv = self.argv(name="a1", ports=["1:1"], env=["A=-x"], volume="v1:/v")
        for flag, value in zip(argv, argv[1:]):
            if flag in ("-p", "-e"):
                self.assertFalse(value.startswith("-"), value)
        self.assertEqual(argv[-2:], ["--", "nginx"])

    def test_ports_bind_loopback_unless_asked(self):
        self.assertIn("127.0.0.1:8080:80/tcp", self.argv(ports=["8080:80"]))
        self.assertIn("127.0.0.1:8080:80/tcp", self.argv(ports=["8080:80"], all_interfaces=False))
        self.assertIn("0.0.0.0:8080:80/tcp", self.argv(ports=["8080:80"], all_interfaces=True))
        for v in ("true", 1, None, "0.0.0.0"):
            self.assertRejected(ports=["8080:80"], all_interfaces=v)

    def test_restart_allowlist(self):
        self.assertEqual(docker_gui.RESTART, ("no", "on-failure", "unless-stopped", "always"))
        for r in docker_gui.RESTART:
            self.assertIn(f"--restart={r}", self.argv(restart=r))
        for r in ("", "ALWAYS", "on-failure:3", "always --privileged", "-d", "sempre", None, 1):
            self.assertRejected(restart=r)

    def test_valid_images(self):
        for image in ("nginx", "nginx:1.25-alpine", "library/nginx:latest", "docker.io/library/redis:7",
                      "ghcr.io/acme/api:1.4", "localhost:5000/minha_app:v1.0", "registry-1.example.com:443/a/b/c",
                      "my.app__x-y", f"redis@sha256:{'a' * 64}", f"redis:7@sha256:{'0' * 64}"):
            self.assertEqual(self.argv(image=image)[-2:], ["--", image], image)

    def test_flag_injection_in_image(self):
        for image in ("", "-it", "--privileged", "--network=host", "-v/:/host", "--rm", "-", " nginx", "nginx ",
                      "nginx --privileged", "nginx;id", "nginx\nid", "nginx\n", "Nginx", "nginx:", ":latest", "nginx:-x",
                      "nginx@sha256:abc", "nginx@md5:" + "a" * 32, "../nginx", "/nginx", "a//b", "nginx$(id)", "ngínx",
                      "a" * 600, None, 1, ["nginx"]):
            self.assertRejected(image=image)
        with self.assertRaises(ValueError):
            docker_gui.run_argv({})  # imagem é obrigatória

    def test_bad_names(self):
        for name in ("a", "-x", "--privileged", "--name=x", ".web", "_web", "web app", "web;id", "../x", "web/x",
                     "wéb", "x" * 129, "web\n", 1):
            self.assertRejected(name=name)
        self.assertIn("--name=a1", self.argv(name="a1"))
        self.assertFalse(any(a.startswith("--name") for a in self.argv(name="")))  # vazio: o docker escolhe

    def test_bad_ports(self):
        for port in ("8080", "0:80", "80:0", "65536:80", "80:65536", "99999:80", "8080:80/sctp", "8080:80/TCP",
                     "127.0.0.1:8080:80", "0.0.0.0:8080:80", "8080-8090:80", "-p", "--privileged", " 8080:80",
                     "8080:80 ", "8080:80/tcp/x", "8080:80\n", "8080:٨٠", ":80", "8080:", 8080):
            self.assertRejected(ports=[port])
        self.assertRejected(ports="8080:80")  # lista, não string
        self.assertRejected(ports=["8080:80", "8080:81"])  # mesma porta do host
        self.assertRejected(ports=[f"{p}:80" for p in range(1, docker_gui.MAX_ITEMS + 2)])
        self.assertIn("127.0.0.1:53:53/udp", self.argv(ports=["53:53/tcp", "53:53/udp"]))  # tcp e udp não colidem

    def test_bad_env(self):
        for env in ("A", "=x", "1A=x", "A-B=x", "A B=x", "-e=x", "--privileged=1", "A.B=x", "Á=x", " A=x",
                    "A=x\0y", "A=" + "x" * (docker_gui.MAX_ENV_VALUE + 1), "K" * 300 + "=x", 1):
            self.assertRejected(env=[env])
        self.assertRejected(env="A=1")
        self.assertRejected(env=["A=1", "A=2"])
        big = "A=" + "x" * docker_gui.MAX_ENV_VALUE
        self.assertIn(big, self.argv(env=[big]))
        self.assertIn("MULTI=a\nb = c", self.argv(env=["MULTI=a\nb = c"]))  # o valor é livre, fora o NUL

    def test_bad_volumes(self):
        for volume in ("/etc:/x", "/:/host", "./data:/data", "../data:/data", "~/data:/data", "data", "data:",
                       "data:relative", "data:/", "data:/x:ro", "data:/x,type=bind", "data:/a/../b", "data:/a/./b",
                       "data:/..", "data:/a//b", "d:/data", "C:/data", "-v:/x", "--privileged:/x", "data :/x",
                       "data:/a b", "data:/x\n", "data/x:/y", "x" * 129 + ":/data", "data:" + "/a" * 600, 1):
            self.assertRejected(volume=volume)
        self.assertIn("--mount=type=volume,source=pg.data_1,target=/var/lib/postgresql/data",
                      self.argv(volume="pg.data_1:/var/lib/postgresql/data"))

    def test_unsupported_fields_are_rejected(self):
        # nada é ignorado em silêncio: pedir --privileged recusa o pedido inteiro
        for key in ("privileged", "cap_add", "network", "pid", "devices", "command", "entrypoint", "volumes", "user"):
            with self.assertRaises(ValueError) as cm:
                docker_gui.run_argv({"image": "nginx", key: True})
            self.assertIn(key, str(cm.exception))
        for body in (None, [], "nginx", ["image", "nginx"]):
            self.assertRaises(TypeError, docker_gui.run_argv, body)


class RunTest(ServerTest):

    def test_runs_argv_and_returns_id(self):
        cid = "f" * 64
        self.docker.return_value = ok(cid + "\n", "Unable to find image 'nginx:latest' locally\nlatest: Pulling from library/nginx\n")
        body = {"image": "nginx", "name": "web", "ports": ["8080:80"], "env": ["A=1"], "restart": "always"}
        self.assertEqual(self.request("POST", "/api/run", body=body), (200, cid))
        self.docker.assert_called_once_with(*docker_gui.run_argv(body), timeout=docker_gui.RUN_TIMEOUT)
        self.assertGreaterEqual(docker_gui.RUN_TIMEOUT, 300)  # pode baixar a imagem

    def test_docker_error_is_500_with_stderr(self):
        self.docker.return_value = subprocess.CompletedProcess([], 125, "", "docker: Error response from daemon: port is already allocated.\n")
        self.assertEqual(self.request("POST", "/api/run", body={"image": "nginx"}),
                         (500, "docker: Error response from daemon: port is already allocated."))

    def test_invalid_body_is_400_without_docker(self):
        for body in (None, "", "não é json", "[]", '"nginx"', "{}", b"\xff\xfe",
                     {"image": "--privileged"}, {"image": "nginx", "privileged": True},
                     {"image": "nginx", "ports": ["0.0.0.0:80:80"]}, {"image": "nginx", "env": ["-e"]},
                     {"image": "nginx", "restart": "on-failure:5"}, {"image": "nginx", "volume": "/:/host"},
                     {"image": "nginx", "env": ["A=" + "x" * docker_gui.MAX_BODY]}):
            status, msg = self.request("POST", "/api/run", body=body)
            self.assertEqual(status, 400, repr(body)[:60])
            self.assertIsInstance(msg, str)
        self.docker.assert_not_called()

    def test_validation_message_names_the_field(self):
        self.assertEqual(self.request("POST", "/api/run", body={"image": "nginx", "restart": "x"}),
                         (400, "restart inválido: use no, on-failure, unless-stopped, always"))

    def test_get_does_not_run(self):
        status, _ = self.request("GET", "/api/run")
        self.assertEqual(status, 404)
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
        expected = {"containers": ["container", "prune", "-f"], "images": ["image", "prune", "-a", "-f"],
                    "volumes": ["volume", "prune", "-f"], "buildcache": ["builder", "prune", "-a", "-f"]}
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
        for kind in ("system", "container", "all", "Images", "images/x", HEX_ID):
            status, _ = self.request("POST", f"/api/prune/{kind}")
            self.assertEqual(status, 404, kind)
        self.docker.assert_not_called()

    def test_get_does_not_prune(self):
        status, _ = self.request("GET", "/api/prune/images")
        self.assertEqual(status, 404)
        self.docker.assert_not_called()


IMG, IMG2, NET = "a" * 64, "b" * 64, "c" * 64
# saídas reais do docker 29 (--format '{{json .}}', uma linha por item), sem os campos que o servidor não lê
DOCKER_IMAGES = [
    {"Containers": "2", "CreatedAt": "2026-09-18 00:00:00 +0000 UTC", "ID": f"sha256:{IMG}", "Repository": "app",
     "Size": "116MB", "Tag": "latest"},
    {"Containers": "2", "CreatedAt": "2026-09-18 00:00:00 +0000 UTC", "ID": f"sha256:{IMG}", "Repository": "app",
     "Size": "116MB", "Tag": "1.0"},
    {"Containers": "N/A", "CreatedAt": "2026-05-13 02:21:49 -0300 -03", "ID": f"sha256:{IMG2}", "Repository": "<none>",
     "Size": "6.81MB", "Tag": "<none>"},
]
DOCKER_VOLUMES = [{"Driver": "local", "Links": "N/A", "Mountpoint": "/var/lib/docker/volumes/pgdata/_data",
                   "Name": "pgdata", "Scope": "local"},
                  {"Driver": "local", "Name": "cache", "Scope": "local"}]
DOCKER_NETWORKS = [{"Driver": "bridge", "ID": "d" * 64, "Name": "bridge", "Scope": "local"},
                   {"Driver": "bridge", "ID": NET, "Name": "loja_default", "Scope": "local"},
                   {"Driver": "null", "ID": "e" * 64, "Name": "none", "Scope": "local"}]
# `container inspect` dos dois containers: só o que o usage() lê
INSPECT = [
    {"Name": "/db", "Image": f"sha256:{IMG}", "Mounts": [{"Type": "volume", "Name": "pgdata"}, {"Type": "bind", "Source": "/x"}],
     "NetworkSettings": {"Networks": {"loja_default": {}}}},
    {"Name": "/web", "Image": f"sha256:{IMG}", "Mounts": [],
     "NetworkSettings": {"Networks": {"bridge": {}, "loja_default": {}}}},
]


def fake_docker(out, ps="1111\n2222\n", inspect=None):
    """docker falso por subcomando: o ls devolve `out`; ps -q e container inspect, os dois containers acima."""
    def run(*args, **kw):
        if args[0] == "ps":
            return ok(ps) if isinstance(ps, str) else ps
        if args[:2] == ("container", "inspect"):
            return inspect or ok(json.dumps(INSPECT))
        return out if isinstance(out, subprocess.CompletedProcess) else ok(out)
    return run


def lines(items):
    return "".join(json.dumps(i) + "\n" for i in items)


class ObjectsTest(ServerTest):
    """Listas de imagens, volumes e redes, com quem usa cada uma."""

    def test_images_one_entry_per_id_with_usage(self):
        self.docker.side_effect = fake_docker(lines(DOCKER_IMAGES))
        self.assertEqual(self.request("GET", "/api/images"), (200, [
            {"ID": IMG, "Tags": ["app:latest", "app:1.0"], "Size": "116MB", "Created": 1789689600,
             "Containers": ["db", "web"]},
            {"ID": IMG2, "Tags": [], "Size": "6.81MB", "Created": 1778649709, "Containers": []},  # dangling
        ]))
        self.assertEqual(self.docker.call_args_list, [
            mock.call("image", "ls", "--no-trunc", "--format", "{{json .}}"), mock.call("ps", "-a", "-q", "--no-trunc"),
            mock.call("container", "inspect", "1111", "2222")])

    def test_volumes_with_usage(self):
        self.docker.side_effect = fake_docker(lines(DOCKER_VOLUMES))
        self.assertEqual(self.request("GET", "/api/volumes"), (200, [
            {"Name": "pgdata", "Driver": "local", "Containers": ["db"]},  # o bind mount não conta
            {"Name": "cache", "Driver": "local", "Containers": []}]))
        self.assertEqual(self.docker.call_args_list[0], mock.call("volume", "ls", "--format", "{{json .}}"))

    def test_networks_mark_builtins(self):
        self.docker.side_effect = fake_docker(lines(DOCKER_NETWORKS))
        self.assertEqual(self.request("GET", "/api/networks"), (200, [
            {"ID": "d" * 64, "Name": "bridge", "Driver": "bridge", "Scope": "local", "Builtin": True, "Containers": ["web"]},
            {"ID": NET, "Name": "loja_default", "Driver": "bridge", "Scope": "local", "Builtin": False,
             "Containers": ["db", "web"]},
            {"ID": "e" * 64, "Name": "none", "Driver": "null", "Scope": "local", "Builtin": True, "Containers": []}]))
        self.assertEqual(self.docker.call_args_list[0], mock.call("network", "ls", "--no-trunc", "--format", "{{json .}}"))

    def test_no_containers_skips_inspect(self):
        self.docker.side_effect = fake_docker(lines(DOCKER_VOLUMES[1:]), ps="")
        self.assertEqual(self.request("GET", "/api/volumes"), (200, [{"Name": "cache", "Driver": "local", "Containers": []}]))
        self.assertEqual(self.docker.call_count, 2)

    def test_container_gone_between_ps_and_inspect(self):
        # o docker sai com 1, mas o stdout tem os que ainda existem
        gone = subprocess.CompletedProcess([], 1, json.dumps(INSPECT[:1]), "Error: No such object: 2222\n")
        self.docker.side_effect = fake_docker(lines(DOCKER_VOLUMES), inspect=gone)
        _, body = self.request("GET", "/api/volumes")
        self.assertEqual(body[0]["Containers"], ["db"])

    def test_errors_are_500_with_stderr(self):
        self.docker.side_effect = fake_docker(fail("Cannot connect to the Docker daemon\n"))
        self.assertEqual(self.request("GET", "/api/images"), (500, "Cannot connect to the Docker daemon"))
        self.docker.side_effect = fake_docker(lines(DOCKER_IMAGES), ps=fail("permission denied\n"))
        self.assertEqual(self.request("GET", "/api/images"), (500, "permission denied"))
        self.docker.side_effect = fake_docker(lines(DOCKER_IMAGES), inspect=fail("daemon travado\n"))
        self.assertEqual(self.request("GET", "/api/images"), (500, "daemon travado"))

    def test_unexpected_format_is_500_not_a_crash(self):
        self.docker.side_effect = fake_docker('{"Nome": "x"}\n')
        status, body = self.request("GET", "/api/volumes")
        self.assertEqual(status, 500)
        self.assertIn("formato inesperado", body)
        self.docker.side_effect = fake_docker("isto não é json\n")
        self.assertEqual(self.request("GET", "/api/images")[0], 500)

    def test_podman_formats_are_normalized(self):
        # podman 5 (--format json): arrays, Id sem "sha256:", tags em Names, tamanho em bytes, criação em epoch;
        # redes em minúsculas e sem escopo. O inspect do container traz Image sem prefixo e Name sem "/"
        images = [{"Id": IMG, "RepoTags": None, "Names": ["localhost/app:latest"], "Size": 115_800_000,
                   "Created": 1789689600, "Containers": 1},
                  {"Id": IMG2, "RepoTags": None, "Names": None, "Size": 999, "Created": 1778649709, "Dangling": True}]
        volumes = [{"Name": "pgdata", "Driver": "local", "Mountpoint": "/x", "CreatedAt": "2026-09-18T00:00:00Z",
                    "Labels": {}, "Scope": "local", "Options": {}}]
        nets = [{"name": "podman", "id": "f" * 64, "driver": "bridge", "network_interface": "podman0", "subnets": []},
                {"name": "loja_default", "id": NET, "driver": "bridge"}]
        inspect = ok(json.dumps([{"Name": "db", "Image": IMG, "Mounts": [{"Type": "volume", "Name": "pgdata"}],
                                  "NetworkSettings": {"Networks": {"loja_default": {}}}}]))
        with mock.patch.object(docker_gui, "CLI", ["podman"]):
            self.docker.side_effect = fake_docker(json.dumps(images, indent=2), inspect=inspect)
            self.assertEqual(self.request("GET", "/api/images"), (200, [
                {"ID": IMG, "Tags": ["localhost/app:latest"], "Size": "116MB", "Created": 1789689600, "Containers": ["db"]},
                {"ID": IMG2, "Tags": [], "Size": "999B", "Created": 1778649709, "Containers": []}]))
            self.assertEqual(self.docker.call_args_list[0], mock.call("image", "ls", "--no-trunc", "--format", "json"))
            self.docker.side_effect = fake_docker(json.dumps(volumes), inspect=inspect)
            self.assertEqual(self.request("GET", "/api/volumes"),
                             (200, [{"Name": "pgdata", "Driver": "local", "Containers": ["db"]}]))
            self.docker.side_effect = fake_docker(json.dumps(nets), inspect=inspect)
            self.assertEqual(self.request("GET", "/api/networks"), (200, [
                {"ID": "f" * 64, "Name": "podman", "Driver": "bridge", "Scope": "local", "Builtin": True, "Containers": []},
                {"ID": NET, "Name": "loja_default", "Driver": "bridge", "Scope": "local", "Builtin": False,
                 "Containers": ["db"]}]))
            self.docker.side_effect = fake_docker("[]\n", ps="")
            self.assertEqual(self.request("GET", "/api/images"), (200, []))

    def test_unknown_list(self):
        for path in ("/api/image", "/api/objects", "/api/images/", "/api/images?all=1"):
            self.assertEqual(self.request("GET", path)[0], 404, path)
        self.docker.assert_not_called()


class HelpersTest(unittest.TestCase):

    def test_epoch(self):
        self.assertEqual(docker_gui.epoch("2026-09-18 00:00:00 +0000 UTC"), 1789689600)
        self.assertEqual(docker_gui.epoch("2026-09-17 21:00:00 -0300 -03"), 1789689600)
        for bad in (None, "", "N/A", "ontem"):
            self.assertIsNone(docker_gui.epoch(bad), bad)

    def test_human_like_docker(self):
        for n, txt in ((0, "0B"), (999, "999B"), (1000, "1kB"), (16380, "16.4kB"), (6_810_000, "6.81MB"),
                       (115_800_000, "116MB"), (4_010_000_000, "4.01GB")):
            self.assertEqual(docker_gui.human(n), txt, n)


class RemoveTest(ServerTest):
    """docker image/volume/network rm, um a um."""

    def test_each_kind_runs_rm_without_force(self):
        self.docker.return_value = ok("Deleted: sha256:aaa\n")
        for path, args in ((f"/api/rm/image/{HEX_ID}", ("image", "rm", HEX_ID)),
                           (f"/api/rm/image/{IMG}", ("image", "rm", IMG)),
                           ("/api/rm/volume/pgdata", ("volume", "rm", "pgdata")),
                           ("/api/rm/volume/loja_db-data.1", ("volume", "rm", "loja_db-data.1")),
                           (f"/api/rm/volume/{IMG}", ("volume", "rm", IMG))):  # volume anônimo: o nome é um hash
            self.docker.reset_mock()
            self.assertEqual(self.request("POST", path), (200, "Deleted: sha256:aaa"), path)
            self.docker.assert_called_once_with(*args, timeout=docker_gui.ACTION_TIMEOUT)

    def test_network_name_comes_from_docker_before_rm(self):
        self.docker.side_effect = [ok("loja_default\n"), ok(f"{NET}\n")]
        self.assertEqual(self.request("POST", f"/api/rm/network/{NET}"), (200, NET))
        self.assertEqual(self.docker.call_args_list, [
            mock.call("network", "inspect", "--format", "{{.Name}}", NET),
            mock.call("network", "rm", NET, timeout=docker_gui.ACTION_TIMEOUT)])

    def test_builtin_networks_are_refused(self):
        self.assertEqual(docker_gui.BUILTIN_NETWORKS, {"bridge", "host", "none", "podman"})
        for name in sorted(docker_gui.BUILTIN_NETWORKS):
            self.docker.reset_mock()
            self.docker.side_effect = [ok(name + "\n")]
            status, body = self.request("POST", f"/api/rm/network/{HEX_ID}")
            self.assertEqual(status, 403, name)
            self.assertIn("rede padrão", body)
            self.docker.assert_called_once_with("network", "inspect", "--format", "{{.Name}}", HEX_ID)  # nunca o rm

    def test_network_inspect_error(self):
        self.docker.return_value = fail(f"Error response from daemon: network {HEX_ID} not found\n")
        self.assertEqual(self.request("POST", f"/api/rm/network/{HEX_ID}"),
                         (500, f"Error response from daemon: network {HEX_ID} not found"))
        self.assertEqual(self.docker.call_count, 1)

    def test_in_use_error_is_500_with_stderr(self):
        msg = "Error response from daemon: remove pgdata: volume is in use - [8341cdc82576]"
        self.docker.return_value = fail(msg + "\n")
        self.assertEqual(self.request("POST", "/api/rm/volume/pgdata"), (500, msg))

    def test_bad_refs_never_reach_docker(self):
        bad = {"image": ("nginx:latest", "nginx", "0123456789AB", "0123456789a", "0" * 65, "-f", "--force",
                         f"{HEX_ID};rm", f"{HEX_ID}%20-f", f"sha256:{IMG}"),
               "network": ("bridge", "host", "loja_default", "0123456789a", f"{HEX_ID}?x=1", "-f"),
               "volume": ("-f", "--help", ".hidden", "_x", "../pgdata", "a%20b", "a;b", "a:b", "pg$data", "a,b",
                          "pgdata?x=1", "%2e%2e"),
               "container": (HEX_ID,), "builder": ("x",), "Image": (HEX_ID,)}
        for kind, refs in bad.items():
            for ref in refs:
                self.assertEqual(self.request("POST", f"/api/rm/{kind}/{ref}")[0], 404, (kind, ref))
        for path in ("/api/rm/volume/", "/api/rm/volume", f"/api/rm/image/{HEX_ID}/x", "/api/rm/volume/a/b"):
            self.assertEqual(self.request("POST", path)[0], 404, path)
        self.docker.assert_not_called()

    def test_get_does_not_remove(self):
        self.assertEqual(self.request("GET", f"/api/rm/image/{HEX_ID}")[0], 404)
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
            self.assertIn('data-where="podman · a b" data-host=""', docker_gui.PAGE)

    def test_where_asks_docker_for_the_current_context(self):
        ok = lambda out: subprocess.CompletedProcess([], 0, out, "")
        with mock.patch.object(docker_gui, "CLI", ["docker"]), mock.patch.object(docker_gui, "docker") as run:
            run.return_value = ok("producao\ttcp://10.0.0.5:2376\n")
            self.assertEqual(docker_gui.where(), ("docker · producao", "tcp://10.0.0.5:2376", True))
            run.return_value = ok("desktop-linux\tunix:///Users/eu/.docker/run/docker.sock\n")  # Docker Desktop: local
            self.assertEqual(docker_gui.where(), ("docker · desktop-linux", "unix:///Users/eu/.docker/run/docker.sock", False))
            run.return_value = subprocess.CompletedProcess([], 1, "", "unknown command")  # docker antigo
            self.assertEqual(docker_gui.where(), ("docker", "", False))
            run.side_effect = FileNotFoundError
            self.assertEqual(docker_gui.where(), ("docker", "", False))


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
        for field in ("CPUPerc", "MemUsage", "MemPerc", "NetIO", "BlockIO"):
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

    def test_events_stream(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        self.addCleanup(conn.close)
        conn.request("GET", f"/api/events/stream?t={docker_gui.TOKEN}", headers={"Host": f"localhost:{self.port}"})
        r = conn.getresponse()
        self.addCleanup(r.close)
        self.assertEqual(r.status, 200)
        time.sleep(1)  # o docker events precisa estar ouvindo antes do create
        c = subprocess.run(["docker", "create", "--label", "docker-gui-test=1", self.IMAGE, "true"],
                           capture_output=True, text=True, check=True).stdout.strip()
        self.addCleanup(subprocess.run, ["docker", "rm", "-f", c], capture_output=True, check=False)
        self.assertEqual(r.readline(), b"data: 1\n")

    def test_run(self):
        # o docker de verdade aceita o argv do run_argv: porta só no loopback, env num item só, volume nomeado
        name = f"docker-gui-test-run-{os.getpid()}"
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        self.addCleanup(subprocess.run, ["docker", "volume", "rm", "-f", name], capture_output=True, check=False)
        self.addCleanup(subprocess.run, ["docker", "rm", "-f", name], capture_output=True, check=False)
        status, cid = self.request("POST", "/api/run", body={
            "image": self.IMAGE, "name": name, "ports": [f"{port}:80"], "env": ["MSG=a b; $(id)"],
            "restart": "on-failure", "volume": f"{name}:/data"})
        self.assertEqual(status, 200, cid)
        r = subprocess.run(["docker", "inspect", "--format", "{{json .}}", cid], capture_output=True, text=True, check=True)
        info = json.loads(r.stdout)
        self.assertEqual(info["Name"], "/" + name)
        self.assertEqual(info["HostConfig"]["RestartPolicy"]["Name"], "on-failure")
        self.assertEqual(info["HostConfig"]["PortBindings"], {"80/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]})
        self.assertIn("MSG=a b; $(id)", info["Config"]["Env"])
        self.assertEqual([(m["Type"], m["Name"], m["Destination"]) for m in info["Mounts"]], [("volume", name, "/data")])

    def test_objects(self):
        # lê as listas; só remove o que o próprio teste cria (um volume e um container parado que o usa)
        vol = name = f"docker-gui-test-{os.getpid()}"
        subprocess.run(["docker", "volume", "create", vol], capture_output=True, check=True)
        subprocess.run(["docker", "create", "--name", name, "-v", f"{vol}:/data", self.IMAGE], capture_output=True, check=True)
        try:
            _, imgs = self.request("GET", "/api/images")
            busybox = next(i for i in imgs if self.IMAGE in i["Tags"])
            self.assertIn(name, busybox["Containers"])
            self.assertIsInstance(busybox["Created"], int)
            _, vols = self.request("GET", "/api/volumes")
            self.assertIn({"Name": vol, "Driver": "local", "Containers": [name]}, vols)
            status, err = self.request("POST", f"/api/rm/volume/{vol}")
            self.assertEqual(status, 500)
            self.assertIn("volume is in use", err)

            _, nets = self.request("GET", "/api/networks")
            bridge = next(n for n in nets if n["Name"] == "bridge")
            self.assertTrue(bridge["Builtin"])
            self.assertEqual(self.request("POST", f"/api/rm/network/{bridge['ID']}")[0], 403)

            subprocess.run(["docker", "rm", name], capture_output=True, check=True)
            self.assertEqual(self.request("POST", f"/api/rm/volume/{vol}"), (200, vol))
        finally:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)
            subprocess.run(["docker", "volume", "rm", vol], capture_output=True, check=False)

    def test_action_on_missing_container(self):
        status, err = self.request("POST", f"/api/stop/{'0' * 64}")
        self.assertEqual(status, 500)
        self.assertIn("No such container", err)


if __name__ == "__main__":
    unittest.main()
