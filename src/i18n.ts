// Tradução da página. O texto fica em pt-BR no código, e é ele a chave do dicionário em inglês (en.json):
// t`Reiniciar ${nome}` procura "Reiniciar {0}" e devolve "Restart {0}" com o valor no lugar. Sem tradução, fica o
// pt-BR (o tests/test_i18n.py confere que toda chave tem a sua, e que o en.json não guarda chave que ninguém usa).
import EN from './en.json' with {type: 'json'};

// a língua vem do servidor (--lang, DOCKER_GUI_LANG ou o locale do sistema, no data-lang do <html>); sem ela (testes
// do Node, servidor sem main()), pt-BR
export const LANG: 'pt' | 'en' = globalThis.document?.documentElement.dataset.lang === 'en' ? 'en' : 'pt';
export const LOCALE = LANG === 'en' ? 'en-US' : 'pt-BR';
const dict: Record<string, string> | null = LANG === 'en' ? EN : null;

export function t(s: TemplateStringsArray, ...v: unknown[]): string {
  const key = s.slice(1).reduce((a, x, i) => `${a}{${i}}${x}`, s[0]);
  // um passo só: um valor com "{1}" dentro não é trocado de novo
  return (dict?.[key] ?? key).replace(/\{(\d+)\}/g, (_, i) => String(v[+i]));
}

// o HTML estático (page.html) vem em pt-BR: em inglês, cada texto e atributo visível vira o do dicionário. A chave é o
// texto com os espaços juntados, como o tests/test_i18n.py lê o page.html
const ATTRS = ['aria-label', 'title', 'placeholder', 'data-empty'];
export function translatePage() {
  if (!dict) return;
  document.documentElement.lang = 'en';
  const walk = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.parentElement?.closest('style, script, kbd, code')) continue;  // teclas e comandos não se traduzem
    const v = n.nodeValue!, k = v.replace(/\s+/g, ' ').trim(), en = k && dict[k];
    if (en) n.nodeValue = v.match(/^\s*/)![0] + en + v.match(/\s*$/)![0];
  }
  for (const el of document.querySelectorAll(ATTRS.map(a => `[${a}]`).join(','))) {
    for (const a of ATTRS) {
      const en = dict[el.getAttribute(a)?.replace(/\s+/g, ' ').trim() ?? ''];
      if (en) el.setAttribute(a, en);
    }
  }
}
