"""Toda frase da interface tem tradução em inglês, e o dicionário não guarda frase que ninguém usa.

A página: as chaves são os t`...` de src/*.ts (com {0}, {1}... no lugar de cada ${...}) e os textos e atributos
visíveis do src/page.html; o dicionário é o src/en.json. O servidor: os tr("...") do docker_gui.py e o EN dele.
"""
import json
import pathlib
import re
import unittest
from html.parser import HTMLParser

import docker_gui

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
ESCAPES = {"n": "\n", "t": "\t"}
LETTERS = re.compile(r"[A-Za-zÀ-ÿ]")
PLACEHOLDER = re.compile(r"\{\d+\}")


def skip_string(text, i, quote):
    """Índice logo depois da string que abre em text[i] (aspas simples ou duplas)."""
    i += 1
    while text[i] != quote:
        i += 2 if text[i] == "\\" else 1
    return i + 1


def read_template(text, i):
    """Lê o template literal que abre em text[i] (a crase). Devolve (chave, índice depois da crase final): o texto
    cozido, com {n} no lugar de cada ${...}, como o t() do i18n.ts monta."""
    key, n, i = "", 0, i + 1
    while text[i] != "`":
        if text[i] == "\\":
            key += ESCAPES.get(text[i + 1], text[i + 1])
            i += 2
        elif text.startswith("${", i):
            i, depth = i + 2, 1
            while depth:  # pula a expressão, com as strings e templates dentro dela
                c = text[i]
                if c in "'\"":
                    i = skip_string(text, i, c)
                    continue
                if c == "`":
                    i = read_template(text, i)[1]
                    continue
                depth += {"{": 1, "}": -1}.get(c, 0)
                i += 1
            key += f"{{{n}}}"
            n += 1
        else:
            key += text[i]
            i += 1
    return key, i + 1


def ts_keys():
    keys = {}
    for f in sorted(SRC.glob("*.ts")):
        text = f.read_text()
        for m in re.finditer(r"(?<![\w$.])t`", text):
            keys.setdefault(read_template(text, m.end() - 1)[0], f.name)
    return keys


class PageText(HTMLParser):
    """Textos e atributos visíveis do page.html, com os espaços juntados (como o translatePage do i18n.ts)."""

    ATTRS = ("aria-label", "title", "placeholder", "data-empty")

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.keys, self.skip = set(), 0

    def add(self, s):
        s = " ".join((s or "").split())
        if LETTERS.search(s):
            self.keys.add(s)

    # CSS, JS, teclas e comandos não se traduzem
    SKIP = ("style", "script", "kbd", "code")

    def handle_starttag(self, tag, attrs):
        self.skip += tag in self.SKIP
        for k, v in attrs:
            if k in self.ATTRS:
                self.add(v)

    def handle_endtag(self, tag):
        self.skip -= tag in self.SKIP

    def handle_data(self, data):
        if not self.skip:
            self.add(data)


def page_keys():
    p = PageText()
    p.feed((SRC / "page.html").read_text())
    return p.keys


class PageI18nTest(unittest.TestCase):

    def setUp(self):
        self.en = json.loads((SRC / "en.json").read_text())
        self.keys = {**dict.fromkeys(page_keys(), "page.html"), **ts_keys()}

    def test_every_key_has_english(self):
        missing = sorted(k for k in self.keys if k not in self.en)
        self.assertEqual(missing, [], "sem tradução em src/en.json")

    def test_no_unused_english(self):
        self.assertEqual(sorted(set(self.en) - set(self.keys)), [], "chave do src/en.json que ninguém usa")

    def test_placeholders_match(self):
        for k, v in self.en.items():
            self.assertEqual(sorted(PLACEHOLDER.findall(k)), sorted(PLACEHOLDER.findall(v)), k)

    def test_reader_follows_nesting(self):
        text = "t`a ${b ? `c ${t`d`}` : 'e}'} f ${\"}\"}\\n`"
        self.assertEqual(read_template(text, 1), ("a {0} f {1}\n", len(text)))


class ServerI18nTest(unittest.TestCase):

    def test_every_message_has_english(self):
        src = (ROOT / "docker_gui.py").read_text()
        msgs = {json.loads(m) for m in re.findall(r'\btr\(("(?:[^"\\]|\\.)*")\)', src)}
        self.assertTrue(msgs)
        self.assertEqual(sorted(msgs - set(docker_gui.EN)), [], "sem tradução no EN do docker_gui.py")
        self.assertEqual(sorted(set(docker_gui.EN) - msgs), [], "chave do EN que ninguém usa")
        for k, v in docker_gui.EN.items():
            self.assertEqual(re.findall(r"\{\w*\}", k), re.findall(r"\{\w*\}", v), k)

    def test_tr_follows_lang(self):
        k = next(iter(docker_gui.EN))
        self.assertEqual(docker_gui.tr(k), k)
        try:
            docker_gui.LANG = "en"
            self.assertEqual(docker_gui.tr(k), docker_gui.EN[k])
            self.assertEqual(docker_gui.tr("sem tradução"), "sem tradução")
        finally:
            docker_gui.LANG = "pt"

    def test_lang_from_env_and_locale(self):
        for env, want in (({"DOCKER_GUI_LANG": "en", "LANG": "pt_BR.UTF-8"}, "en"), ({"LANG": "pt_BR.UTF-8"}, "pt"),
                          ({"LC_ALL": "en_US.UTF-8", "LANG": "pt_BR.UTF-8"}, "en"), ({"LANG": "C.UTF-8"}, "en"),
                          ({"DOCKER_GUI_LANG": "pt-BR"}, "pt"), ({"LC_MESSAGES": "pt_PT"}, "pt")):
            self.assertEqual(docker_gui.system_lang(env), want, env)


if __name__ == "__main__":
    unittest.main()
