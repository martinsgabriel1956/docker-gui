# Tasks: Baixar e atualizar imagens

Lote em 4 tasks, nesta ordem: rota nos dois backends → funções puras → aba Imagens → E2E e README.

**Ajustes ao techspec, decididos aqui** (o techspec é atualizado junto, no Histórico):

1. **O prazo estourado diz o comando certo.** O `compose_stream` (Python) e o `compose::stream` (Rust) escrevem "docker compose não respondeu em 600s" com o "compose" fixo. Para o pull, a mensagem diria "compose". A mensagem passa a usar o primeiro argumento (`args[0]`: `compose` ou `pull`), sem parâmetro novo.
2. **A validação da imagem vira uma função própria** nos dois backends: `image_ok()` no Python e `v::image_ok()` no Rust, usadas pelo `run_argv` e pelo pull. Assim a regra fica num lugar só.
3. **A saída ao vivo do pull usa o `addOut` do compose**, com a chave `pull:<ref>` e o mesmo `<pre data-out>`, mas numa área própria da aba Imagens (`#pulls`), não numa linha de tabela.
4. **"Mudou?" compara a tag também sem o prefixo do Docker Hub.** O Podman lista `docker.io/library/postgres:17` para quem digitou `postgres:17`. O `sameRef` aceita os dois.

---

## T1. Rota `POST /api/pull` nos dois backends

**Escopo:** `POST /api/pull {image}`. A rota valida a imagem pela regra do "Novo container" e roda `pull -- <image>` no stream do compose (NDJSON, 600 s, segue sem leitor). A mensagem de prazo passa a dizer o comando. Vem com o caso de contrato da recusa, a cobertura de rotas e o `pull` no docker falso.

**Contexto:** techspec, "Visão de componentes" e "Decisões principais" (reaproveitar o stream do compose).

**Skills a carregar:** `tdd`; `security-best-practices` (argumento vindo da página: regex e `--`).

**Regras a respeitar:**
- Nada vindo da página vira argumento livre: a regex e o `--`.
- Rota nos dois backends, com caso de contrato.
- `docker_gui.py` só com a biblioteca padrão.

**Steps:**

1. Contrato (o vermelho):
   - `tests/contract/writes/pull-invalida.json`: `POST /api/pull {"image": "-v/etc:/x"}` → `400 "imagem inválida: use repo[:tag] ou repo@sha256:…"`, com `calls: []`;
   - `pull-sem-corpo.json`: corpo `null` → o mesmo 400, sem chamada;
   - a lista `post` do `CoverageTest.routes()` ganha `"/api/pull"`. O stream bem-sucedido chama o `Popen` direto e fica com os unitários do Rust e o E2E, como o compose.

2. `docker_gui.py`:

```py
def image_ok(image):
    """A regra de referência de imagem do run e do pull: repo[:tag] ou repo@sha256:..., até MAX_IMAGE."""
    return isinstance(image, str) and len(image) <= MAX_IMAGE and bool(IMAGE_RE.fullmatch(image))
```

   O `run_argv` passa a usar `image_ok(image)`. No `do_POST`, antes do compose, entra `if self.path == "/api/pull": return self.pull()`:

```py
    def pull(self):
        """docker pull da imagem do corpo {image}, com a saída em stream como a do compose: segue até o fim mesmo que a
        página feche, e só o prazo de 10 min o interrompe. O "--" fecha as opções, mesmo com a regex já impedindo o "-"."""
        try:
            image = self.json_body().get("image")
        except (ValueError, AttributeError):
            image = None
        if not image_ok(image):
            return self.send(400, json.dumps(tr("imagem inválida: use repo[:tag] ou repo@sha256:…")))
        return self.compose_stream(["pull", "--", image])
```

   No `compose_stream`, a mensagem de prazo usa `cmd=args[0]` no lugar de `"compose"`. As chamadas do compose começam por `"compose"`, então nada muda para elas.

3. Rust:
   - `validate.rs`: `pub fn image_ok(image: &str) -> bool { image.chars().count() <= MAX_IMAGE && IMAGE_RE.is_match(image) }`, usada também pelo `run_argv`.
   - `router.rs` (`post`), antes do compose:

```rust
    if full == "/api/pull" {
        let image = req.body.as_ref().and_then(|b| b.get("image")?.as_str()).unwrap_or("");
        if !v::image_ok(image) {
            return Reply::Json(reply(400, tr(ctx.lang, "imagem inválida: use repo[:tag] ou repo@sha256:…")));
        }
        // o "--" fecha as opções, mesmo com a regex já impedindo o "-"
        return Reply::Ndjson(crate::compose::stream(ctx, vec!["pull".into(), "--".into(), image.into()]));
    }
```

   - `compose.rs`: na mensagem de prazo, `("cmd", &args[0])` no lugar de `("cmd", "compose")`.
   - Teste unitário em `validate.rs`: `image_ok` aceita `postgres:17` e `ghcr.io/a/b@sha256:…`, e recusa `-v`, `UPPER` e uma string de 513 caracteres.

4. Docker falso (`tests/e2e/fake-docker/docker`), comando `pull`, com o estado `registry: {ref: ID}` (o que o registry tem) e `pull_delay` opcional:
   - **`ref` fora do `registry`:** sai com `Error response from daemon: pull access denied for <repo>, repository does not exist or may require 'docker login'`.
   - **Senão:** imprime linhas de progresso (`<ref>: Pulling from library/x`, `abc123: Pull complete`) com `flush` e o atraso entre elas, fora do lock.
   - **Atualização do `images`:**
     - mesma tag com o mesmo ID: imprime `Status: Image is up to date for <ref>`;
     - mesma tag com outro ID: a linha antiga vira `<none>:<none>` (dangling, como o docker) e entra a nova;
     - tag nova: entra a linha nova.
   - O `fixtures.ts` ganha `registry?: Record<string, string>` e `pull_delay?: number`.

**Plano de teste:**
- `python -m unittest` (contrato e cobertura) e `cargo test -p stivo-core` verdes.
- `cargo fmt --check` e `clippy -D warnings` limpos.

---

## T2. Funções puras do pull no `format.ts`

**Escopo:** `withTag`, `sameRef` e `pullOutcome`, com testes.

**Contexto:** techspec, "Decisões principais" ("mudou?" pelo ID antes e depois). As funções ficam puras, sem a lista na mão.

**Skills a carregar:** `tdd`.

**Regras a respeitar:** o `format.ts` não toca no DOM.

**Steps:**

1. Testes primeiro:

```js
test('withTag põe o latest quando falta tag (e respeita porta e digest)', () => {
  assert.equal(f.withTag('postgres'), 'postgres:latest');
  assert.equal(f.withTag('postgres:17'), 'postgres:17');
  assert.equal(f.withTag('localhost:5000/app'), 'localhost:5000/app:latest');  // o ":5000" é a porta, não a tag
  assert.equal(f.withTag('app@sha256:' + 'a'.repeat(64)), 'app@sha256:' + 'a'.repeat(64));
});
test('sameRef casa a tag da lista com a digitada, com o prefixo do Docker Hub do podman', () => {
  assert.ok(f.sameRef('postgres:17', 'postgres:17'));
  assert.ok(f.sameRef('docker.io/library/postgres:17', 'postgres:17'));
  assert.ok(f.sameRef('docker.io/acme/api:1', 'acme/api:1'));
  assert.ok(!f.sameRef('postgres:16', 'postgres:17'));
});
test('pullOutcome compara o ID da tag antes e depois', () => {
  assert.equal(f.pullOutcome(null, 'sha256:a'), 'new');
  assert.equal(f.pullOutcome('sha256:a', 'sha256:a'), 'same');
  assert.equal(f.pullOutcome('sha256:a', 'sha256:b'), 'updated');
  assert.equal(f.pullOutcome(null, null), 'missing');  // por digest, ou tag que a lista mostra de outro jeito
});
```

2. `src/format.ts`, junto do `IMAGE_RE`:

```ts
// a referência com a tag explícita: sem tag (nem digest), o docker usa a latest. O ":" depois da última "/" é tag;
// antes dela, é a porta do registry
export const withTag = (ref: string): string => /@sha256:|:[^/]*$/.test(ref) ? ref : `${ref}:latest`;
// a tag da lista é a digitada? O podman lista as do Docker Hub com o prefixo (docker.io/library/postgres:17)
export const sameRef = (tag: string, ref: string): boolean =>
  [ref, `docker.io/${ref}`, `docker.io/library/${ref}`].includes(tag);
// o que o pull fez com a tag, pelo ID antes e depois (vale para docker e podman, sem ler o texto de status)
export const pullOutcome = (before: string | null, after: string | null): 'new' | 'updated' | 'same' | 'missing' =>
  !after ? 'missing' : !before ? 'new' : before === after ? 'same' : 'updated';
```

**Plano de teste:** `npm run test:js` e `npx tsc -p .` verdes.

---

## T3. Baixar e Atualizar na aba Imagens

**Escopo:**
- **Campo:** "Baixar imagem" no topo da aba, validado no front, com a dica "(tag latest)" quando falta tag.
- **Atualizar:** em cada tag de imagem; com mais de uma tag, um botão por tag.
- **Saída ao vivo:** cada pull em andamento mostra a saída numa área própria, e o pull falho fica aberto até o ×.
- **Resultado:** ao fim, a lista é recarregada e o aviso diz se a imagem foi baixada, atualizada ou já estava em dia, e quem continua na versão anterior.

**Contexto:** PRD, RF1.1 a RF1.3, RF2.1 a RF2.3 e RF3.1 a RF3.4; techspec, "Visão de componentes".

**Skills a carregar:** `frontend-design:frontend-design` (campo e botões no padrão da página, foco visível, região viva só no começo e no fim).

**Regras a respeitar:**
- O que vem do docker passa por `esc`.
- O `title` dos botões mostra o comando (`docker pull <ref>`).
- Handlers no `Object.assign(window, …)`.
- Textos do `page.html` e do `app.ts` com chave no `en.json`.
- `build.py` depois.

**Steps:**

1. `src/page.html`, no `#panel-images`, antes do `#df-images`:

```html
    <!-- docker pull: baixar uma imagem pelo nome (a mesma regra do Novo container) e, nos itens, Atualizar a tag -->
    <form id="pull-form" onsubmit="event.preventDefault(); pullImage()" class="flex flex-wrap items-center gap-2">
      <label for="pull-q" class="text-sm text-fg-soft">Baixar imagem</label>
      <input id="pull-q" placeholder="postgres:17" autocomplete="off" spellcheck="false" aria-describedby="pull-hint" class="…as do #q…">
      <button type="submit" title="docker pull" class="…BTN…">Baixar</button>
      <span id="pull-hint" class="text-xs text-muted"></span>
    </form>
    <div id="pulls" class="space-y-2"></div>
```

2. `src/app.ts`:

```ts
// docker pull: um por referência, com a saída ao vivo (o addOut do compose, chave "pull:<ref>"). before: o ID da tag
// antes do pull (null se não havia), para dizer no fim se a imagem mudou
const pulls = new Map<string, Out & {before: string | null}>();
const imageOf = (ref: string) => Array.isArray(objs.images) ? (objs.images as Image[]).find(i => i.Tags.some(tg => sameRef(tg, withTag(ref)))) : undefined;
function pullHint() {
  const v = $<HTMLInputElement>('#pull-q').value.trim();
  $('#pull-hint').textContent = !v ? '' : !IMAGE_RE.test(v) || v.length > 512 ? t`Imagem inválida: use repo[:tag] ou repo@sha256:…, com o caminho em minúsculas.`
    : withTag(v) !== v ? t`(tag latest)` : '';
}
async function pullImage(ref = $<HTMLInputElement>('#pull-q').value.trim()) {
  pullHint();
  if (!ref || !IMAGE_RE.test(ref) || ref.length > 512 || pulls.get(ref)?.code === null) return;
  const p = {what: `docker pull ${ref}`, text: '', code: null as number | null, before: imageOf(ref)?.ID ?? null};
  pulls.set(ref, p); renderPulls();
  $('#shown').textContent = t`Baixando ${ref}…`;
  let msg = '';
  try {
    const r = await T.ndjson('/api/pull', {image: ref}, l => addOut(`pull:${ref}`, p, l + '\n'));
    if (r.status >= 400) { p.code = -2; msg = String(r.error); } else p.code = r.code;
  } catch { p.code = -1; msg = t`sem resposta do servidor do Stivo.`; }
  await loadObjects('images');
  if (p.code === 0) {
    const after = imageOf(ref)?.ID ?? null, out = pullOutcome(p.before, after);
    const old = out === 'updated' && Array.isArray(objs.images) ? (objs.images as Image[]).find(i => i.ID === p.before)?.Containers ?? [] : [];
    toast({new: t`Baixada: ${ref}.`, missing: t`Baixada: ${ref}.`, same: t`${ref} já estava em dia.`,
           updated: t`Atualizada: ${ref}. A versão anterior ficou sem tag.`}[out]
           + (old.length ? ' ' + t`${old.join(', ')} continuam com a versão anterior até serem recriados.` : ''), true);
    pulls.delete(ref);
    if (out !== 'same') $('#pull-q').value = '';
  } else {
    msg ||= p.text;
    toast(t`Não deu para baixar ${ref}. ${errHint(msg) || msg.trim().split('\n').at(-1) || t`Erro sem mensagem.`}`);
    if (p.code === -2) pulls.delete(ref);  // recusado antes de rodar: não há saída para mostrar
  }
  renderPulls(); render();
}
function closePull(ref: string) { pulls.delete(ref); renderPulls(); $('#pull-q').focus(); }
function renderPulls() {
  $('#pulls').innerHTML = [...pulls].map(([ref, p]) => {
    const running = p.code === null, er = esc(ref);
    const state = running ? t`baixando…` : p.code === -1 ? t`sem resposta do servidor` : t`falhou (código ${p.code})`;
    return `<div class="rounded-lg ring-1 ring-line bg-raised/40 p-3"><div class="flex items-center gap-2 font-mono text-xs ${running ? 'text-fg-soft' : 'text-bad-fg'}">
      <span>docker pull ${er} · ${state}</span>${running ? '' : `<button data-r="${er}" onclick="closePull(this.dataset.r)" aria-label="${t`Fechar a saída do docker pull ${er}`}"
        title="${t`Fechar`}" class="ml-auto grid place-items-center shrink-0 w-9 coarse:w-11 ${BTN} text-fg hover:bg-hover">${X_ICON}</button>`}</div>
      <pre data-out="pull:${er}" tabindex="0" aria-label="${t`Saída do docker pull ${er}`}" class="…as do outRow…"></pre></div>`;
  }).join('');
  pulls.forEach((p, ref) => { const pre = outPre(`pull:${ref}`); if (pre) { pre.textContent = p.text; pre.scrollTop = pre.scrollHeight; } });
}
```

3. `objItem` (imagens): na célula de ações, antes do Remover, um "Atualizar" por tag:
   - `<button data-a="pull" data-r="${esc(tag)}" onclick="pullImage(this.dataset.r)" title="docker pull ${esc(tag)}" aria-label="${t`Atualizar ${esc(tag)}`}">`;
   - o texto é "Atualizar" com uma tag só e "Atualizar <tag>" com mais de uma;
   - durante o pull, `aria-disabled` e "Baixando…";
   - imagem sem tag (dangling) não tem o botão.

   O cache `objHtml` já compara o HTML, então o botão muda quando o `pulls` muda (o `render()` chama o `renderObjects`).

4. Ligações: `$('#pull-q').oninput = pullHint`. `pullImage` e `closePull` no `Object.assign(window, …)`. `IMAGE_RE`, `withTag`, `sameRef` e `pullOutcome` no import do `format.ts`.

5. `src/en.json`:
   - do `page.html`: "Baixar imagem" e "Baixar";
   - do `app.ts`: as mensagens novas. "Imagem inválida…" já existe, do Novo container.

6. `python3 build.py --css`.

**Plano de teste:**
- `npx tsc -p .`, `npm run test:js`, `python -m unittest` e `build.py --check` verdes.
- A suíte E2E de hoje verde.

---

## T4. E2E e README

**Escopo:** `tests/e2e/images.spec.ts`, nos dois backends, e o README.

**Contexto:** techspec, "Estratégia de teste".

**Skills a carregar:** `tdd`; `systematic-debugging`, se os backends divergirem.

**Regras a respeitar:**
- Pular um spec no Rust não é correção.
- Chrome do sistema (`PW_CHROMIUM_PATH=/usr/bin/google-chrome`).

**Steps:**

1. `tests/e2e/images.spec.ts`:
   - **Baixar pelo nome:** `postgres:17` com `registry: {'postgres:17': 'sha256:…'}`. Durante o pull (`pull_delay`), a área mostra "docker pull postgres:17 · baixando…" com as linhas. No fim: o aviso "Baixada: postgres:17.", a imagem na lista e o campo vazio.
   - **Sem tag:** digitar `redis` mostra "(tag latest)".
   - **Inválida:** `Postgres` mostra a mensagem de imagem inválida, e nada vai ao docker (o `pull` não aparece nas chamadas).
   - **Atualizar sem mudança:** a imagem `nginx:1.27` já na lista com o mesmo ID do `registry`. "Atualizar" dá "nginx:1.27 já estava em dia."
   - **Atualizar com mudança:** o `registry` com outro ID. O aviso é "Atualizada…", e a antiga aparece como "sem tag".
   - **Falha:** imagem fora do `registry`. O aviso traz a causa traduzida pelo `errHint` (sem login ou não existe), e a saída fica aberta com "falhou (código 1)" até o ×.
   - **Dangling:** a imagem sem tag não tem "Atualizar".

2. README, na linha das imagens: o campo "Baixar imagem" (a mesma regra do Novo container, sem tag usa a latest) e o "Atualizar" por tag. Inclui:
   - a saída ao vivo, que segue mesmo fechando a aba;
   - o aviso de "baixada", "atualizada" (a antiga fica sem tag) ou "já estava em dia";
   - quem continua na versão anterior;
   - login em registry pelo terminal.

3. A suíte inteira nos dois backends.

**Plano de teste:** a suíte E2E inteira verde nos dois backends.
