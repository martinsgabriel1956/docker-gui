# Tasks: Mudanças no filesystem do container

Lote em 4 tasks, nesta ordem: rota nos dois backends → funções puras → seção no modal → E2E e README.

**Ajuste ao techspec, decidido aqui:** o `diffHtml` não vai para o `format.ts`. Ele seria o único gerador de HTML ali, e o padrão do projeto é o `format.ts` com dados e o `app.ts` com a marcação (o `topTable`/`topHtml`; o `healthHtml` do healthcheck seguiu o mesmo). A lista é desenhada no `app.ts` com DOM, como o `paint` dos logs, porque o trecho do filtro é marcado pelo `markInto` que já existe (ele escreve com `textContent`, sem HTML). O `format.ts` fica com o tipo, o `DIFF_MAX` e o `diffSummary`. O techspec é atualizado junto.

---

## T1. Rota `GET /api/diff/<id>` nos dois backends

**Escopo:** a rota roda `docker diff <id>` com o prazo de ação e devolve `[{"k": "A"|"C"|"D", "p": "/caminho"}]`. Vem com `diff()` no Python e no `normalize.rs`, casos de contrato, testes unitários e o `diff` no docker falso.

**Contexto:** techspec, "Visão de componentes" e "Endpoints". O backend separa o tipo do caminho para o resumo e o filtro. O prazo é o `ACTION_TIMEOUT` (120 s), porque o diff percorre a camada gravável inteira.

**Skills a carregar:** `tdd`.

**Regras a respeitar:**
- Rota nos dois backends, com os mesmos casos de contrato.
- O `id` passa pela regex de sempre (`[0-9a-f]{12,64}`).
- `docker_gui.py` só com a biblioteca padrão.

**Steps:**

1. Casos de contrato em `tests/contract/reads/` (o vermelho), com `["diff", "0123456789ab"]`:
   - `diff.json`: stdout `"C /etc\nA /etc/nginx.conf\nD /tmp/x\nA /app/meu arquivo.txt\n"` → `200 [{"k":"C","p":"/etc"},{"k":"A","p":"/etc/nginx.conf"},{"k":"D","p":"/tmp/x"},{"k":"A","p":"/app/meu arquivo.txt"}]` (o caminho com espaço vai inteiro);
   - `diff-vazio.json`: stdout vazio → `200 []`;
   - `diff-erro.json`: código 1, `Error response from daemon: No such container: 0123456789ab` → `500` com o stderr.

2. `docker_gui.py`, junto do `history()`:

```py
def diff(out):
    """Saída do `docker diff` (e do `podman diff`): "C /etc", "A /etc/x" -> [{"k": "C", "p": "/etc"}, ...]. O caminho é
    tudo depois do espaço (pode ter espaço); linha fora do formato fica de fora."""
    return [{"k": line[0], "p": line[2:]} for line in out.splitlines()
            if len(line) > 2 and line[0] in "ACD" and line[1] == " "]
```

   No `do_GET`, depois do `/api/top`:

```py
        m = re.fullmatch(r"/api/diff/([0-9a-f]{12,64})", self.path)
        if m:  # o que mudou no filesystem do container em relação à imagem; percorre a camada gravável: prazo de ação
            r = docker("diff", m[1], timeout=ACTION_TIMEOUT)
            return self.send(500, json.dumps(r.stderr.strip())) if r.returncode else self.send(200, json.dumps(diff(r.stdout)))
```

3. `normalize.rs`:

```rust
/// Saída do `docker diff` -> [{"k", "p"}] (o diff do Python): o caminho é tudo depois do espaço
pub fn diff(out: &str) -> Value {
    Value::Array(out.lines().filter_map(|l| {
        let (k, p) = l.split_at_checked(2)?;
        (matches!(k, "A " | "C " | "D ") && !p.is_empty()).then(|| json!({"k": &k[..1], "p": p}))
    }).collect())
}
```

   E no `router.rs` (`get`), depois do `/api/top`:

```rust
    if let Some(m) = caps(r"/api/diff/([0-9a-f]{12,64})", &full) {
        // percorre a camada gravável inteira: o prazo das ações, não o de leitura
        let r = ctx.docker(&["diff", &m[1]], ACTION_TIMEOUT).await;
        return Ok(if r.code != 0 { reply(500, r.stderr.trim()) } else { reply(200, n::diff(&r.stdout)) });
    }
```

4. Testes unitários do parse:
   - Python (`tests/test_docker_gui.py`): caminho com espaço, linha em branco, linha fora do formato (`"X /y"`, `"C"`).
   - Rust (`normalize.rs`, `#[cfg(test)]`): os mesmos casos.

5. `tests/e2e/fake-docker/docker`: `elif cmd == "diff":` imprime `find(state, ref).get("diff", "")`. Funciona com o container parado, como o docker. No `fixtures.ts`, o `Container` ganha `diff?: string`, e o cabeçalho do docker falso documenta o campo.

**Plano de teste:**
- `python -m unittest` (contrato, cobertura de rotas e o parse) e `cargo test -p stivo-core` verdes.
- `cargo fmt --check` e `clippy -D warnings` limpos.

---

## T2. Tipo, limite e resumo no `format.ts`

**Escopo:** `DiffItem`, `DIFF_MAX = 500` e `diffSummary`, com testes.

**Contexto:** techspec, "Interfaces principais", sem o `diffHtml` (ver o ajuste no topo).

**Skills a carregar:** `tdd`.

**Regras a respeitar:** o `format.ts` não toca no DOM; os textos passam pelo `t```.

**Steps:**

1. Teste primeiro:

```js
test('diffSummary conta por tipo, com singular e plural', () => {
  const d = (k, p = '/x') => ({k, p});
  assert.equal(f.diffSummary([d('A'), d('A'), d('C'), d('D')]), '2 adicionados · 1 alterado · 1 apagado');
  assert.equal(f.diffSummary([d('C'), d('C')]), '2 alterados');
  assert.equal(f.diffSummary([]), '');
});
```

2. No `src/format.ts`, depois do `healthSummary`:

```ts
// uma linha do `docker diff`, já separada pelo servidor: A(dicionado), C (alterado), D (apagado)
export type DiffItem = {k: 'A' | 'C' | 'D'; p: string};
export const DIFF_MAX = 500;  // a lista mostra até aqui; o filtro vale para todos
export function diffSummary(items: DiffItem[]): string {
  const n = (k: DiffItem['k']) => items.filter(d => d.k === k).length, a = n('A'), c = n('C'), d = n('D');
  return [a && (a === 1 ? t`1 adicionado` : t`${a} adicionados`), c && (c === 1 ? t`1 alterado` : t`${c} alterados`),
          d && (d === 1 ? t`1 apagado` : t`${d} apagados`)].filter(Boolean).join(' · ');
}
```

3. As chaves no `src/en.json`.

**Plano de teste:** `npm run test:js`, `npx tsc -p .` e `python -m unittest tests.test_i18n` verdes.

---

## T3. A seção "Mudanças" no modal de logs

**Escopo:** quarta seção do modal, `<details id="diff">`, carregada ao abrir:
- resumo, nota sobre os volumes, filtro, Atualizar e Copiar;
- a lista até 500 itens, com o tipo em cor e texto e o trecho do filtro marcado;
- "Mostrando 500 de N; use o filtro para achar o resto".

**Contexto:** PRD, RF1.1 a RF1.7 e RF2.1 a RF2.2; techspec, "Visão de componentes". Segue o modelo do `#procs` e do `#hist`: lê só ao abrir, desiste se o modal trocou de container, fecha e limpa no `afterClose` e some nos logs de projeto.

**Skills a carregar:** `frontend-design:frontend-design` (seção no estilo das outras três, tipo em cor e texto, foco visível).

**Regras a respeitar:**
- Caminho vindo do container é texto: `textContent`/`markInto`, nunca `innerHTML` com o caminho.
- Os textos do `page.html` têm chave no `en.json` (o `test_i18n` lê o `page.html`).
- Handlers no `Object.assign(window, …)`.
- `build.py` depois.

**Steps:**

1. `src/page.html`, depois do `#procs`:

```html
    <!-- o que mudou no filesystem do container em relação à imagem (docker diff): o "o que escreveu aqui dentro?" de quem
         passou a falhar sem ser recriado. Só vai ao docker quando abre, e funciona com o container parado -->
    <details id="diff" ontoggle="this.open && loadDiff()" class="text-xs">
      <summary class="…as mesmas classes dos outros…">Mudanças no filesystem (docker diff)</summary>
      <div class="mt-1 flex flex-wrap items-center gap-2">
        <label for="diff-q" class="sr-only">Filtrar caminhos</label>
        <input id="diff-q" type="search" placeholder="Filtrar caminhos…" autocomplete="off" spellcheck="false" class="…as do #lf…">
        <button onclick="loadDiff()" class="…as do Copiar dos logs…">Atualizar</button>
        <button onclick="copyDiff()" class="…">Copiar</button>
      </div>
      <p class="mt-1 text-muted">Volumes e bind mounts ficam de fora: o docker diff só vê a camada do container.</p>
      <div id="diff-body" class="mt-1 max-h-48 overflow-auto">Carregando…</div>
    </details>
```

2. `src/app.ts`, depois do `loadTop`:

```ts
// mudanças no filesystem (docker diff): a última leitura fica guardada para o filtro e o Copiar, que valem sobre todas
let diffItems: DiffItem[] | null = null;
const DIFF_KIND: Record<DiffItem['k'], [string, string]> =
  {A: [t`adicionado`, 'text-ok-fg'], C: [t`alterado`, 'text-warn-fg'], D: [t`apagado`, 'text-bad-fg']};
async function loadDiff() {
  const id = logId;
  let err: string | null = null, items: DiffItem[] | null = null;
  try {
    const r = await api(`/api/diff/${id}`), j: unknown = await r.json();
    if (r.ok) items = j as DiffItem[]; else err = t`Não consegui ler as mudanças: ${j}`;
  } catch { err = t`Não consegui ler as mudanças.`; }
  if (id !== logId || !$<HTMLDetailsElement>('#diff').open) return;
  diffItems = items;
  if (err) $('#diff-body').textContent = err; else paintDiff();
}
const diffHits = () => {
  const re = logFilter($<HTMLInputElement>('#diff-q').value.trim());
  return {re, hits: re ? diffItems!.filter(d => re.test(d.p)) : diffItems!};
};
function paintDiff() {
  if (!diffItems) return;
  const body = $('#diff-body');
  if (!diffItems.length) { body.innerHTML = `<p class="text-muted">${t`Nada mudou em relação à imagem.`}</p>`; return; }
  const {re, hits} = diffHits(), el = (tag: string, cls: string, text = '') =>
    Object.assign(document.createElement(tag), {className: cls, textContent: text});
  const ol = el('ol', 'font-mono space-y-0.5');
  for (const d of hits.slice(0, DIFF_MAX)) {
    const [txt, cls] = DIFF_KIND[d.k], li = el('li', '');
    li.append(el('span', `inline-block w-24 font-sans ${cls}`, txt));
    markInto(li, d.p, re);
    ol.append(li);
  }
  body.replaceChildren(el('p', 'mb-1 text-fg-soft', diffSummary(diffItems) + (re ? ` · ${t`${hits.length} no filtro`}` : '')), ol,
    ...(hits.length > DIFF_MAX ? [el('p', 'mt-1 text-muted', t`Mostrando ${DIFF_MAX} de ${hits.length}; use o filtro para achar o resto.`)] : []));
}
function copyDiff() {
  if (!diffItems) return;
  navigator.clipboard.writeText(diffHits().hits.map(d => `${d.k} ${d.p}`).join('\n'))
    .then(() => toast(t`Mudanças copiadas.`, true), () => toast(t`Não consegui copiar.`));
}
```

3. Ligações:
   - `$('#diff-q').oninput = paintDiff`, junto do `#lf`. O mesmo `keydown` do `#lf`: com texto, `Esc` limpa e redesenha; vazio, deixa o modal fechar.
   - `openLogs` (1442): `$('#diff').hidden` entra na mesma linha do `#insp`/`#hist`/`#procs` (só um container).
   - `afterClose` (1668): `'diff'` entra na lista, `diffItems = null` e `#diff-q` vazio.
   - `loadDiff` e `copyDiff` no `Object.assign(window, …)`.

4. `src/en.json`:
   - os textos do `page.html`: "Mudanças no filesystem (docker diff)", "Filtrar caminhos", "Filtrar caminhos…" e a nota dos volumes (o "Atualizar" e o "Copiar" já existem);
   - os do `app.ts`: os três tipos, as mensagens, "{0} no filtro" e "Mostrando {0} de {1}; use o filtro para achar o resto.".

5. `python3 build.py --css`.

**Plano de teste:**
- `npx tsc -p .`, `npm run test:js`, `python -m unittest` e `build.py --check` verdes.
- A suíte E2E de hoje verde.

---

## T4. E2E e README

**Escopo:** casos E2E da seção, nos dois backends, e a linha no README.

**Contexto:** techspec, "Estratégia de teste"; o README descreve cada seção do modal (Histórico, Processos, Configuração).

**Skills a carregar:** `tdd`; `systematic-debugging`, se os backends divergirem.

**Regras a respeitar:**
- Pular um spec no Rust não é correção.
- Chrome do sistema (`PW_CHROMIUM_PATH=/usr/bin/google-chrome`).

**Steps:**

1. `tests/e2e/inspect.spec.ts`, com casos novos:
   - **Lista:** `app` com `diff: 'C /etc\nA /etc/nginx.conf\nD /tmp/x\nA /app/<b>x</b>.txt'`.
     - Abrir a seção mostra "2 adicionados · 1 alterado · 1 apagado" e 4 itens, com o tipo em texto.
     - O caminho com `<b>` aparece literal (escapado).
     - O filtro `etc` deixa 2 itens, com o `<mark>` no trecho, e o resumo ganha "2 no filtro".
     - `Esc` no filtro limpa.
   - **Container parado:** `cron` parado, também com `diff`. A seção aparece e lista (o `#procs` some, o `#diff` não).
   - **Sem mudanças:** "Nada mudou em relação à imagem."
   - **Muitas mudanças:** 600 linhas mostram 500 e "Mostrando 500 de 600…". O filtro acha um item depois do 500º.
   - **Copiar:** com o filtro, o clipboard recebe só as linhas filtradas, no formato `C /etc`.
   - **Logs de projeto:** a seção não aparece.

2. README, na lista do modal de logs (depois de "Processos"): **Mudanças no filesystem**, o `docker diff` do container. Inclui:
   - o tipo (adicionado, alterado, apagado) e o resumo;
   - o filtro por caminho e o Copiar;
   - funciona com o container parado;
   - volumes e bind mounts ficam de fora;
   - lê só ao abrir.

3. A suíte inteira nos dois backends.

**Plano de teste:** a suíte E2E inteira verde nos dois backends.
