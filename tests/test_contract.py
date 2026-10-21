"""Contrato da API (tests/contract/): o mesmo conjunto de casos que o backend Rust do desktop roda no cargo test."""
import json
import pathlib
import re
import unittest

import docker_gui
from tests.contract import play

ID = "0123456789ab"


class ContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = play.serve()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_cases(self):
        for path in play.cases():
            case = json.loads(path.read_text())
            with self.subTest(path.relative_to(play.HERE).as_posix()):
                status, body = play.play(self.server, case)
                self.assertEqual((status, body), (case["response"]["status"], case["response"]["body"]))


class CoverageTest(unittest.TestCase):
    """Toda rota que chama o docker() tem pelo menos um caso: rota nova sem caso deixaria os dois backends divergirem
    sem ninguém ver. As listas saem das tabelas do próprio docker_gui.py; as rotas avulsas, do código do Handler."""

    def routes(self):
        get = ["/api/containers", "/api/stats", "/api/df", "/api/info", *(f"/api/{k}" for k in docker_gui.OBJECTS),
               *(f"/api/{r}/{ID}" for r in ("logs", "health", "history", "top", "diff", "inspect")), f"/api/inspect/{ID}/env",
               "/api/compose/logs", "/api/compose/services"]
        post = [*(f"/api/{a}/{ID}" for a in docker_gui.ACTIONS), *(f"/api/prune/{k}" for k in docker_gui.PRUNE),
                *(f"/api/rm/{k}/" for k in docker_gui.REMOVE), "/api/run", "/api/pull",
                *(f"/api/compose/{a}" for a in [*docker_gui.COMPOSE, *docker_gui.COMPOSE_SERVICE])]
        return [("GET", p) for p in get] + [("POST", p) for p in post]

    def test_every_route_has_a_case(self):
        seen = set()
        for path in play.cases():
            req = json.loads(path.read_text())["request"]
            seen.add((req["method"], re.sub(r"[0-9a-f]{12,64}", ID, req["path"].partition("?")[0])))
        for method, route in self.routes():
            with self.subTest(f"{method} {route}"):
                self.assertTrue(any(m == method and (p == route or route.endswith("/") and p.startswith(route)) for m, p in seen),
                                "rota sem caso em tests/contract/")

    def test_handler_routes_are_known(self):
        # as rotas com regex do Handler: uma nova aqui precisa entrar em routes() (e ganhar caso) ou ser stream
        src = pathlib.Path(docker_gui.__file__).read_text()
        self.assertEqual(len(re.findall(r're\.fullmatch\(r"/api', src)), 13,
                         "rota nova no Handler: acrescente-a em CoverageTest.routes() e em tests/contract/")


if __name__ == "__main__":
    unittest.main()
