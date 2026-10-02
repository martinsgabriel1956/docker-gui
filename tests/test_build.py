"""O docker_gui.py distribuído precisa bater com src/. O CSS é conferido no CI (python3 build.py --css --check)."""
import unittest
from unittest import mock

import build
import docker_gui


class BuildTest(unittest.TestCase):

    def test_docker_gui_in_sync_with_src(self):
        old, new = build.build()
        self.assertEqual(old, new, "docker_gui.py desatualizado: rode python3 build.py")

    def test_page_has_no_placeholders(self):
        self.assertNotIn("/*JS*/", docker_gui.PAGE)
        self.assertNotIn("/*CSS*/", docker_gui.PAGE)

    def test_scripts_embedded_in_order(self):
        # app.js usa as funções de format.js no mesmo escopo: format.js tem que vir antes
        page = docker_gui.PAGE
        positions = [page.index((build.SRC / f).read_text()) for f in build.SCRIPTS]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(build.SCRIPTS[0], "format.js")

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


if __name__ == "__main__":
    unittest.main()
