"""O docker_gui.py distribuído precisa bater com src/. O CSS é conferido no CI (python3 build.py --css --check)."""
import re
import unittest
from unittest import mock

import build
import docker_gui


class BuildTest(unittest.TestCase):

    @unittest.skipUnless(build.ESBUILD.exists(), "precisa do esbuild (npm ci); no CI roda no job frontend")
    def test_docker_gui_in_sync_with_src(self):
        old, new = build.build()
        self.assertEqual(old, new, "docker_gui.py desatualizado: rode python3 build.py")

    def test_page_has_no_placeholders(self):
        self.assertNotIn("/*JS*/", docker_gui.PAGE)
        self.assertNotIn("/*CSS*/", docker_gui.PAGE)

    def test_embedded_js_is_compiled(self):
        # o navegador recebe JS puro num IIFE: sem import/export nem anotação de tipo
        script = docker_gui.PAGE[docker_gui.PAGE.index("<script>"):docker_gui.PAGE.index("</script>")]
        self.assertIn("(() => {", script)
        self.assertNotRegex(script, r"(?m)^\s*(import|export)\s")
        self.assertNotRegex(script, r"\b(interface|type)\s+\w+\s*[={]")

    def test_html_handlers_are_exposed_on_window(self):
        # dentro do IIFE nada é global: toda função que o HTML chama (onclick="act(...)") precisa estar no
        # Object.assign(window, {...}) do app.ts, senão o botão quebra só em tempo de execução
        app = (build.SRC / "app.ts").read_text()
        html = app + (build.SRC / "page.html").read_text()
        handlers = re.findall(r'\bon(?:click|toggle|input)="([^"]*)"', html)
        called = {name for h in handlers for name in re.findall(r"(?<![\w.])([A-Za-z_]\w*)\(", h)}
        exposed = set(re.findall(r"\w+", re.search(r"Object\.assign\(window, \{(.*?)\}\)", app, re.DOTALL)[1]))
        self.assertTrue(called, "nenhum handler encontrado: a regex quebrou?")
        self.assertEqual(called - exposed, set(), "chamadas pelo HTML mas não expostas no window")
        self.assertEqual(exposed - called, set(), "expostas no window sem ninguém chamar")

    def test_raw_rejects_what_breaks_the_string(self):
        for bad in ('a """ b', "termina em barra\\"):
            with self.assertRaises(SystemExit):
                build.raw("X", bad)
        self.assertEqual(build.raw("X", "ok"), 'X = r"""ok"""\n')

    def test_page_requires_single_js_placeholder(self):
        with mock.patch.object(build, "SRC") as src:
            src.__truediv__.side_effect = lambda name: mock.Mock(read_text=lambda: "<html></html>")
            with self.assertRaises(SystemExit):
                build.page()

    def test_bundle_without_npm_ci_explains_what_to_do(self):
        with mock.patch.object(build, "ESBUILD", build.ROOT / "nao-existe"), self.assertRaises(SystemExit) as cm:
            build.bundle()
        self.assertIn("npm ci", str(cm.exception.code))


if __name__ == "__main__":
    unittest.main()
