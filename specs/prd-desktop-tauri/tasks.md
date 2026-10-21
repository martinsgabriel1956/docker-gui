# Tasks: Stivo desktop

Fonte: [prd.md](prd.md) e [techspec.md](techspec.md). Branch: `feat/desktop-tauri` (base `develop`). Um commit por task, na convenção do repositório: título em pt-BR que diz o que muda e por quê, corpo curto em prosa e `Co-Authored-By` no fim.

O repositório não tem `CLAUDE.md` nem diretório de regras. As regras citadas vêm do PRODUCT.md, do README e do DESIGN.md.

**Ordem e dependências:** T1 → T2 → T3 → T4 → (T5, T6, T7) → T8 → T9 → T10 → T11 → T12 → T13 → T14 → T15.

- T1 (transporte) bloqueia T8 (casca Tauri).
- T3 (contrato) bloqueia T4 a T7 (core Rust).
- T8 bloqueia T10 (segundo plano) e T11 (preferências).
- T9 (ícone) bloqueia T10.

**Antes de executar, os commits são agrupados em três PRs para a `develop`:**
- **PR A:** T1 e T2. Só front e textos, sem Rust; pode entrar sozinho.
- **PR B:** T3 a T12. O app desktop.
- **PR C:** T13 a T15. Distribuição.

O lote é executado inteiro nesta sessão; a divisão em PRs é só na hora de abrir.

---

## T1. Camada de transporte no front

**Escopo:** o `app.ts` passa a falar com o backend só por uma interface `Transport`; a versão web continua idêntica.

**Contexto:** é a etapa 1 do sequenciamento do techspec e destrava a casca Tauri (T8). São cinco pontos de transporte: o `api()` com fetch (17 chamadas), o NDJSON do compose (`readOut`), o `EventSource` dos eventos, o dos logs e o `WebSocket` do terminal. A notificação e o favicon também passam pela interface (`attention` e `notify`), porque no desktop eles viram a bandeja e a notificação nativa. Techspec: "Interfaces principais" e "Dois entrypoints no esbuild".

**Skills:** `tdd` (os testes atuais são a rede de proteção; nenhum muda), `ponytail`.

**Regras:** "O CI confere o gerado" (o `build.py --check` continua passando); o front segue compilado e embutido no `docker_gui.py`.

**Steps:**

1. Criar o `src/transport.ts`. Há um ajuste em relação ao techspec: o `ndjson` devolve o status e, se a rota recusou antes de o compose rodar, o corpo de erro. É o que o `composeAct` usa hoje (o `r.ok ? readOut : r.json()`). Também é preciso atualizar a seção "Interfaces principais" do techspec.

```ts
// src/transport.ts: a única coisa que muda entre a versão web (docker_gui.py) e o desktop (Tauri)
export interface ApiResponse { ok: boolean; status: number; json(): Promise<unknown> }
export interface Closer { close(): void }
export interface StreamHandlers { open?(): void; data(line: string): void; end(): void; error(closed: boolean): void }
export interface TermHandlers { open(): void; data(b: Uint8Array): void; notice(text: string): void; close(): void }
export interface Term { send(data: string): void; resize(cols: number, rows: number): void; close(): void }
export interface Transport {
  desktop: boolean;
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResponse>;
  stream(path: string, query: Record<string, string>, on: StreamHandlers): Closer;   // query sem token
  // POST com resposta NDJSON (compose): cada linha string vai para onLine; o fim {code}. Recusa antes de rodar: error
  ndjson(path: string, body: unknown, onLine: (line: string) => void): Promise<{status: number; code: number; error?: unknown}>;
  terminal(id: string, cols: number, rows: number, on: TermHandlers): Term;
  attention(badge: string, svg: string): void;   // web: favicon; desktop: bandeja
  notify(title: string, body: string, onClick: () => void): void;
}
```

2. Criar o `src/transport-web.ts` movendo o código que já existe, sem mudar comportamento: token do `#t=`/`localStorage`, cabeçalho `X-Docker-GUI-Token`, token na query do `EventSource` e do `WebSocket`, o `select` do primeiro `{cols, rows}`, e o favicon (o `<link rel=icon>` e o "só troca o href se mudou"). O `notify` faz `new Notification` com o `try/catch` de hoje. O `canAsk`, o `notifying` e o `askNotify` continuam no `app.ts`, porque são da página web; o desktop responde `notifying() = true` pela flag `desktop`.

```ts
// src/transport-web.ts
export function webTransport(): Transport {
  const TOKEN = readToken();  // o IIFE de hoje, movido
  const icon = document.head.appendChild(Object.assign(document.createElement('link'), {rel: 'icon'}));
  return {
    desktop: false,
    request: (method, path, body) => fetch(path, {method, headers: {'X-Docker-GUI-Token': TOKEN,
      ...(body === undefined ? {} : {'Content-Type': 'application/json'})}, body: body === undefined ? undefined : JSON.stringify(body)}),
    stream(path, query, on) { /* new EventSource(`${path}?${new URLSearchParams({...query, t: TOKEN})}`), onopen/onmessage/'end'/onerror */ },
    async ndjson(path, body, onLine) { /* fetch POST; !ok → {status, code: -1, error: await r.json()}; ok → o readOut de hoje */ },
    terminal(id, cols, rows, on) { /* o WebSocket de hoje; string → on.notice, binário → on.data */ },
    attention(_badge, svg) { const href = 'data:image/svg+xml,' + encodeURIComponent(svg); if (icon.getAttribute('href') !== href) icon.href = href; },
    notify(title, body, onClick) { try { const n = new Notification(title, {body}); n.onclick = () => { onClick(); n.close(); }; } catch { /* Android */ } },
  };
}
```

3. No `app.ts`, injetar o transporte. O `app.ts` vira um módulo que exporta `start(t: Transport)`, e todo o código de topo passa para dentro dele. Para não reindentar 1.900 linhas, uma variável de módulo `let T: Transport` é atribuída no `start()`. O código de topo que roda na importação (consts que leem o `dataset`, o `Object.assign(window, …)` e os timers iniciais) vai para o fim do `start()`; as funções continuam no nível do módulo e usam `T`. As 17 chamadas `api(path, opts)` viram `T.request(method, path, body)`. O `setIcon(badge)` monta o SVG (o mesmo de hoje) e chama `T.attention(badge, svg)`.

4. Criar o `src/entry-web.ts` com `start(webTransport())`. O `build.py` passa a usar `ENTRY = SRC / "entry-web.ts"`.

5. Rodar `python3 build.py`. O `docker_gui.py` muda só no bloco gerado (o JS reorganizado).

**Plano de teste:** `npx tsc -p .`, `node --test tests/format.test.js`, `python3 build.py --css --check`, `python -m unittest` e `npx playwright test` (os 17 specs, sem mudar nenhum). Sem diferença de comportamento visível.

---

## T2. Nome visível: Docker GUI → Stivo (versão web)

**Escopo:** todo nome de produto visível passa a ser Stivo; os identificadores técnicos ficam.

**Contexto:** PRD seção 6 (RF6.1 a RF6.3) e a decisão "Nome Stivo só onde é visível" do techspec. Isso entra na versão web antes do desktop para as duas nascerem com o mesmo nome. "Docker" e "Podman" só aparecem como compatibilidade.

**Skills:** `impeccable` (o `clarify` para os textos que citam o nome: "o servidor do Stivo"), `humanizer` (o README).

**Regras:** a voz do PRODUCT.md (pt-BR direto, frases curtas); toda string nova tem a sua chave no `en.json` (o `tests/test_i18n.py` confere).

**Steps:**

1. O `src/page.html` passa a ter `<title>Stivo</title>` e o `<h1>` passa a ser `Stivo`. No `app.ts`, o `TITLE` (`Stivo · ${CTX}`) e as 11 mensagens "do Docker GUI" passam a dizer "do Stivo". O `en.json` recebe as chaves novas e perde as antigas.
2. No `docker_gui.py`, o `print` e o `EN` passam a dizer "Stivo em {url}" / "Stivo at {url}", e o `description` do argparse fica "Stivo: gerenciador de containers Docker e Podman no navegador. Só stdlib + docker CLI.".
3. No `tests/e2e/fixtures.ts`, a regex vira `/(?:Stivo|Docker GUI) (?:em|at) (http:\S+)/`, para o harness (T4) e o Python casarem com o mesmo padrão. Os outros testes que procuram "Docker GUI" (`i18n`, `list`, `problems`) passam a esperar "Stivo".
4. O README passa a ter `# Stivo` e o subtítulo "Gerenciador de containers para Docker e Podman, no navegador…". As outras ocorrências viram Stivo. O comando `python3 docker_gui.py` não muda. Uma nota curta no topo diz que o projeto se chamava Docker GUI.
5. No DESIGN.md, por enquanto, só o `name:` do frontmatter e a menção ao título na tipografia ("só o 'Stivo' do cabeçalho"). O resto o `/impeccable document` refaz no fim (T12).

**Plano de teste:** `python -m unittest` (inclui o `test_i18n`), `npx tsc -p .`, `python3 build.py --check` e `npx playwright test`. Um `grep -rn "Docker GUI"` em `src/`, `docker_gui.py` (fora do bloco gerado), `README.md` e `tests/` só pode encontrar a nota de "antigo nome" e a regex de compatibilidade.

---

## T3. Fixtures de contrato e replay no Python

**Escopo:** a pasta `tests/contract/`, com um caso JSON por comportamento de cada rota, lida por um `tests/test_contract.py` que roda contra o `Handler` atual.

**Contexto:** é a etapa 2 do techspec ("Estratégia de teste", "Contrato"). Isso formaliza o comportamento antes de copiá-lo para o Rust; os mesmos arquivos serão lidos pelo `cargo test` (T4). O escopo do contrato são as rotas que chamam o `docker()`. Os streams (`logs/stream`, `compose/logs/stream`, `events/stream`), o NDJSON do compose e o `exec` usam o `subprocess.Popen` direto e ficam com a cobertura E2E (Playwright contra os dois backends) e com os testes unitários do Rust. Isso precisa ser explicitado na "Estratégia de teste" do techspec, que hoje sugere cobertura total.

**Skills:** `tdd`.

**Regras:** os testes do backend usam só a stdlib (README); o `docker` é trocado por mock, como em `tests/test_docker_gui.py`.

**Steps:**

1. Formato (`tests/contract/<grupo>/<caso>.json`):

```json
{ "desc": "podman: Names em lista e portas como objetos viram o formato do docker ps",
  "lang": "pt", "cli": ["podman"],
  "calls": [{"args": ["ps", "-a", "--format", "json"], "stdout": "[{\"Names\": [\"web\"], …}]", "stderr": "", "code": 0}],
  "request": {"method": "GET", "path": "/api/containers", "body": null},
  "response": {"status": 200, "body": [{"Names": "web", "…": "…"}]} }
```

2. O replay em Python é um servidor como o do `ServerTest`. Ele troca o `docker_gui.docker` por um `side_effect` que consome a lista `calls` em ordem (argumentos diferentes falham o teste com o esperado e o recebido) e troca também o `CLI` e o `LANG`. Ao fim, confere que todas as `calls` foram consumidas e que o status e o corpo batem.

```python
class ContractTest(unittest.TestCase):
    def test_cases(self):
        for path in sorted(CONTRACT.rglob("*.json")):
            case = json.loads(path.read_text())
            with self.subTest(path.relative_to(CONTRACT).as_posix()):
                calls = iter(case["calls"])
                def fake(*args, timeout=None):
                    exp = next(calls, None)
                    self.assertIsNotNone(exp, f"chamada a mais: {args}")
                    self.assertEqual(list(args), exp["args"])
                    return subprocess.CompletedProcess(args, exp["code"], exp["stdout"], exp["stderr"])
                with mock.patch.object(docker_gui, "docker", side_effect=fake), \
                     mock.patch.object(docker_gui, "CLI", case["cli"]), mock.patch.object(docker_gui, "LANG", case["lang"]):
                    status, body = self.request(case["request"])
                self.assertEqual((status, body), (case["response"]["status"], case["response"]["body"]))
                self.assertIsNone(next(calls, None), "chamada esperada não aconteceu")
```

3. Teste de cobertura: uma lista `ROUTES` com os padrões das rotas que chamam o `docker()`, conferida contra os `re.fullmatch` e os `LISTS`, `OBJECTS`, `PRUNE`, `REMOVE` e `ACTIONS` do `Handler`. Cada padrão precisa de pelo menos um caso. Rota nova sem caso faz o teste falhar.
4. Casos: para cada rota, o caminho feliz, o erro do CLI (500 com o stderr) e o argumento recusado (`calls: []`, 400/404). Mais as variantes Podman de containers, stats, images, volumes e networks (cada conversão do `from_podman*`), as recusas do `run` (bind mount, nome inválido, porta, env, restart e campo extra), as redes padrão no `rm`, e um caso em `en` por mensagem traduzida. Os primeiros casos saem dos testes atuais do `tests/test_docker_gui.py`, sem removê-los.

**Plano de teste:** `python -m unittest tests.test_contract` verde em todos os casos. O teste de cobertura falha se uma rota for removida da lista. O `python -m unittest` completo continua verde nas versões de Python da matriz do CI (3.7+: sem sintaxe nova).

---

## T4. Esqueleto Tauri, núcleo `core` e harness HTTP

**Escopo:** o `src-tauri/` compila, com o `core` (cli, i18n, router vazio), o replay de contrato no `cargo test` e um harness que serve a página web e responde 404 a toda rota.

**Contexto:** começo da etapa 3 do techspec ("Visão de componentes", "Núcleo", "Fluxo de teste (harness)"). Com isso pronto, cada grupo de rotas (T5 a T7) fica verde quando passa nas fixtures e nos specs Playwright dele contra o harness.

**Skills:** `tdd`, `security-best-practices` (o harness repete as checagens de `Host`, token e `Origin` do Python, mesmo sendo só de teste).

**Regras:** versões fixas (os crates com versão exata e o `Cargo.lock` versionado, como no `package-lock.json`); nenhum shell no host.

**Steps:**

1. `npm i -E -D @tauri-apps/cli@2.12.x` e `npm i -E @tauri-apps/api@2.12.x` (a última 2.12 publicada). `npx tauri init` com `src-tauri/`, `productName` `Stivo`, `identifier` `io.github.martinsgabriel1956.Stivo` e `frontendDist` `dist`. Depois, remover o que o template gera e não usamos.
2. `Cargo.toml` (edition 2024, o profile de release do Paddock):

```toml
[features]
harness = ["dep:axum", "dep:tokio-tungstenite"]   # só o binário de teste; nunca no instalador

[dependencies]
tauri = { version = "~2.12", features = ["tray-icon"] }
serde = { version = "=1.0.x", features = ["derive"] }   # versões exatas na hora de adicionar
serde_json = "=1.0.x"
tokio = { version = "=1.x", features = ["process", "io-util", "time", "sync", "macros", "rt-multi-thread"] }
regex = "=1.x"
portable-pty = "=0.9.x"
log = "=0.4.x"
axum = { version = "=0.8.x", features = ["ws"], optional = true }

[[bin]]
name = "harness"
required-features = ["harness"]
```

3. `core/cli.rs`: o `Runner` do techspec, com a implementação real em `tokio::process::Command`, `kill_on_drop(true)`, timeout e `CREATE_NO_WINDOW` no Windows (`creation_flags(0x0800_0000)`). As constantes de prazo são as do Python (`READ_TIMEOUT`, `ACTION_TIMEOUT`, `COMPOSE_TIMEOUT`, `RUN_TIMEOUT`).

```rust
pub struct Output { pub code: i32, pub stdout: String, pub stderr: String }
#[async_trait::async_trait]  // ou trait com async fn nativo (edition 2024) se o dyn não for preciso
pub trait Runner: Send + Sync {
    async fn run(&self, args: &[String], timeout: Duration) -> Output;          // docker(*args, timeout=…)
    fn spawn(&self, args: &[String], pty: Option<(u16, u16)>) -> io::Result<Spawned>;  // streams e exec
}
pub struct Ctx { pub cli: Vec<String>, pub lang: Lang, pub runner: Arc<dyn Runner> }
```

4. `core/i18n.rs`: `tr(lang, "texto pt")` usando a mesma tabela do `EN` do Python. Um teste em Rust confere que o conjunto de chaves é igual ao do `EN`, lido do `docker_gui.py` por regex, para as duas tabelas nunca divergirem.
5. `core/router.rs`: `handle(&Ctx, Request) -> Response`, com um `match` sobre método e caminho no mesmo formato do `Handler` (`/api/(\w+)/([0-9a-f]{12,64})`…), tudo 404 por enquanto.
6. `tests/contract.rs`: lê `../tests/contract/**/*.json`, monta um `Runner` falso que consome as `calls` e compara a resposta. Os casos de rotas ainda não implementadas falham; para o lote andar sem vermelho permanente, cada task T5 a T7 liga o seu grupo numa lista `IMPLEMENTED` no topo do teste, e a T7 remove a lista (tudo obrigatório).
7. `src/bin/harness.rs`: axum em `127.0.0.1:<--port|0>`. Ele serve `GET /` com o HTML da versão web (o `PAGE` do `docker_gui.py`, extraído pelo `build.py --harness-page` para `src-tauri/target/harness-page.html`, ou lido do bloco gerado) com os `data-*` injetados, e confere `Host`, `X-Docker-GUI-Token` e `Origin` como o Python. Ele imprime `Stivo em http://localhost:<porta>/#t=<token>`, delega as rotas `/api/*` ao `core::router` e aceita `--cli`, `--lang` e as mesmas variáveis de ambiente.
8. No `tests/e2e/fixtures.ts`, `start()` escolhe o processo por `process.env.GUI_BACKEND`: `python3 docker_gui.py --port 0` ou `src-tauri/target/debug/harness --port 0`. O `package.json` ganha os scripts `test:e2e:rust` e `build:harness`.

**Plano de teste:** `cargo build --features harness`, `cargo test` (i18n e contrato dos grupos ligados, nenhum ainda), `cargo clippy -- -D warnings` e `cargo fmt --check`. O harness sobe e o `GUI_BACKEND=rust npx playwright test list.spec.ts` falha com 404, o que confirma que o encanamento funciona.

---

## T5. core Rust: listas e leituras

**Escopo:** `GET /api/containers`, `stats`, `df`, `images`, `volumes`, `networks`, `logs/<id>`, `health/<id>`, `history/<id>`, `top/<id>`, `inspect/<id>[/env]`, `compose/logs` e `compose/services`, com a normalização Podman.

**Contexto:** techspec "Visão de componentes" (`normalize.rs`, `validate.rs`) e etapa 3. É a porta, função por função, de `containers()`, `from_podman()`, `stats()`, `from_podman_stats()`, `images()`, `volumes()`, `volume_sizes()`, `networks()`, `usage()`, `history()`, `summary()`, `by_time()`, `log_tail`/`log_since` e `compose_query`/`compose_base`/`compose_services`.

**Skills:** `tdd` (cada função portada nasce de um caso de contrato vermelho), `no-workarounds` (divergência de formato se corrige na causa, não com um caso especial no teste).

**Regras:** "falar a língua do CLI": as mesmas flags e o mesmo `--format` do Python, argumento por argumento (as fixtures conferem); nenhum argumento vindo da página chega ao CLI sem passar pela regex (`[0-9a-f]{12,64}`, `LOG_TAIL`, `LOG_SINCE` e o par project/dir conferido nos labels).

**Steps:**

1. `core/validate.rs`: as constantes e regex do Python, copiadas literalmente (`ID_RE`, `LOG_TAIL`, `LOG_SINCE`, `STARTED_RE`, `IMAGE_RE`, `NAME_RE`, `PORT_RE`, `ENV_RE`, `VOLUME_RE` e os `_HOST`/`_PATH`), com um teste de tabela por regex.
2. `core/normalize.rs`: uma função por normalizador do Python, com `serde_json::Value` na entrada e na saída (o formato é JSON solto do CLI; tipar seria inventar um schema que o docker não garante). Erro de formato dá o 500 "formato inesperado na saída do {cmd}", como no `objects()`.
3. No `core/router.rs`, as rotas acima, na ordem do `do_GET`.
4. Ligar os grupos `lists` e `reads` no `IMPLEMENTED` do contrato.

**Plano de teste:** `cargo test` com o contrato dos grupos verde. `GUI_BACKEND=rust npx playwright test list problems filters stats disk inspect rerender` verde, e as mesmas suítes com `GUI_BACKEND=python`.

---

## T6. core Rust: ações, run, remoções, prune e compose (NDJSON)

**Escopo:** os POSTs de ação, `run`, `rm/<tipo>/<ref>`, `prune/<tipo>` e `compose/<ação>` (com a saída em stream).

**Contexto:** techspec etapa 3. Portar `ACTIONS`, `run_argv()` (a regra de segurança mais sensível: 127.0.0.1 por padrão, 0.0.0.0 só com `all_interfaces`, sem bind mount), `remove()` (rede padrão recusada pelo nome vindo do docker), `PRUNE` e `compose()` com `COMPOSE`/`COMPOSE_SERVICE`. O compose devolve NDJSON: uma string por linha e `{"code": n}` no fim, e não é interrompido se o cliente sair (só pelo prazo de 10 min).

**Skills:** `tdd`, `security-best-practices` (revisão do `run_argv` e do `compose_base` contra o Python).

**Regras:** "A GUI nunca amplia o que o docker já permite"; ações destrutivas sem `-f` (o docker recusa o que estiver em uso).

**Steps:**

1. `validate::run_argv(body: &Value) -> Result<Vec<String>, String>`, que imita o Python linha por linha (`RUN_FIELDS`, `RESTART`, o `seen` de portas duplicadas, o `--publish 127.0.0.1:h:c/proto`). As recusas ficam nas fixtures (T3).
2. As rotas de POST. O compose usa o `Runner::spawn` (stdout e stderr juntos) e um tipo de resposta extra no router:

```rust
pub enum Reply { Json(Response), Ndjson(BoxStream<'static, String>) }   // a última linha é {"code": n}
pub async fn handle(ctx: &Ctx, req: Request) -> Reply;
```

3. Harness: o `Reply::Ndjson` vira `application/x-ndjson` com corpo em streaming.
4. Testes unitários do compose NDJSON com o `Runner` falso (linhas, código no fim, prazo estourado, -1 quando o processo morre) e o grupo `writes` no `IMPLEMENTED`.

**Plano de teste:** `cargo test`. `GUI_BACKEND=rust npx playwright test actions bulk create compose disk` verde, e o mesmo com `GUI_BACKEND=python`.

---

## T7. core Rust: streams (logs, compose logs, eventos) e terminal

**Escopo:** `logs/<id>/stream`, `compose/logs/stream` e `events/stream` como `Stream<StreamMsg>`, e o `exec/<id>` num PTY com `portable-pty`.

**Contexto:** techspec "Modelos de dado" (`StreamMsg`, `TermMsg`) e "Pontos de integração" (PTY). Mesmo ciclo de vida do Python: processo morto quando o consumidor some; `End` quando o docker termina; o `events` só avisa que algo mudou (o filtro `relevant()` e a rajada que vira um aviso só), com o limite de 8 streams de eventos (`EVENTS_SLOTS`). O terminal não tem modo pipe: no Windows, o ConPTY dá TTY de verdade.

**Skills:** `tdd`, `systematic-debugging` (stream e PTY são onde a paridade costuma escorregar).

**Regras:** sem processo órfão nem zumbi (o Python recolhe no SIGTERM; no Rust, `kill_on_drop` e um `Drop` que espera o filho).

**Steps:**

1. `core/streams.rs`: `pub fn stream(ctx, req) -> Result<BoxStream<'static, StreamMsg>, Response>`. Ele valida igual ao `do_GET` (token fora: no harness ele é conferido antes), divide em linhas inteiras e manda `End` no EOF. Um `Drop` no guard mata o processo.
2. `core/terminal.rs`: abre o PTY no tamanho pedido, `cli exec -it <id> sh -c 'exec $(command -v bash || echo sh)'` (o `SHELL` do Python), com a saída num `mpsc` e `write`, `resize` e `close`. O `TTY_INIT`, o `TTY_MARK` e o `PIPE_SHELL` não vêm para o Rust.
3. Harness: SSE (`data: <json>\n\n`, `event: end`) e WebSocket com o mesmo protocolo de hoje (a primeira mensagem é `{cols, rows}` em texto, depois binário nos dois sentidos, e resize como texto JSON), conferindo o `Origin`.
4. Remover a lista `IMPLEMENTED`: todo caso de contrato vira obrigatório.
5. No `terminal.spec.ts`, os testes do modo pipe (`DOCKER_GUI_TERMINAL=pipe`) ganham `test.skip(process.env.GUI_BACKEND === 'rust', 'modo pipe só existe no Python (o Rust usa ConPTY no Windows)')`. É o único skip permitido.

**Plano de teste:** `cargo test` (streams com o `Runner` falso: linhas partidas no meio, EOF, consumidor que some e processo morto). A suíte E2E inteira com `GUI_BACKEND=rust` e com `GUI_BACKEND=python`, verde, com só o skip do modo pipe.

---

## T8. Casca Tauri: página `dg://`, IPC e transporte desktop

**Escopo:** o app abre uma janela com a página, fala com o `core` pela IPC e funciona com paridade (sem bandeja ainda).

**Contexto:** techspec etapa 4, "Fluxo de dado (desktop)", "Página servida por protocolo próprio" e "IPC genérica". É a página da web com o `entry-desktop`.

**Skills:** `security-best-practices` (capabilities só para a janela `main`, CSP do `dg://`, nenhuma URL remota carregada), `tdd` (o teste do `transport-desktop` com `invoke` falso).

**Regras:** nenhuma porta aberta no desktop (RF5.1); a mesma validação de argumentos (já no `core`).

**Steps:**

1. `src/entry-desktop.ts` e `src/transport-desktop.ts`, sobre `@tauri-apps/api/core` (`invoke`, `Channel`):

```ts
export function desktopTransport(): Transport {
  return {
    desktop: true,
    request: async (method, path, body) => {
      const r = await invoke<{status: number; body: unknown}>('api', {method, path, body: body ?? null});
      return {ok: r.status < 400, status: r.status, json: async () => r.body};
    },
    stream(path, query, on) {
      const ch = new Channel<{data?: string; end?: true; error?: string}>();
      ch.onmessage = m => m.data !== undefined ? on.data(m.data) : m.end ? on.end() : on.error(true);
      const id = invoke<number>('stream_open', {path, query, channel: ch}).then(id => (on.open?.(), id), () => (on.error(true), -1));
      return {close: () => void id.then(i => i >= 0 && invoke('stream_close', {id: i}))};
    },
    // ndjson: stream_open com method POST e body; terminal: term_open/term_input/term_resize/term_close
    attention: (badge, svg) => void svgToPng(svg, 32).then(png => invoke('attention', {badge, icon: [...png]})),
    notify: (title, body) => void invoke('notify', {title, body}),
  };
}
```

2. `build.py --desktop` gera o `src-tauri/dist/index.html` (o mesmo `page.html` com o CSS e o JS do `entry-desktop`), e o `--check` confere os dois arquivos gerados.
3. `src-tauri/src/page.rs`: `register_asynchronous_uri_scheme_protocol("dg", …)` serve o `dist/index.html` embutido (`include_str!`) com os `data-cli`, `data-where`, `data-host`, `data-remote` e `data-lang` substituídos como no `main()` do Python (com escape HTML), e um `where()` equivalente via `docker context inspect`. CSP: `default-src 'self' dg:`, `script-src 'self' 'unsafe-inline'` (JS inline no HTML único, como na web), `connect-src ipc: http://ipc.localhost`, `img-src 'self' data:` e `frame-ancestors 'none'`.
4. `src-tauri/src/ipc.rs`: os comandos do techspec (sem `attention`, `notify` e `prefs_*`, que vêm em T10 e T11), segurando um `State<AppState>` com o `Ctx` e os mapas de streams e terminais abertos.
5. `capabilities/main.json`: só a janela `main`, só os comandos próprios e `core:default`.
6. Um teste `tests/transport-desktop.test.js` (`node:test`) com `invoke` e `Channel` falsos via `globalThis.__TAURI_INTERNALS__`: uma rota, um stream com `End` e um terminal com resize.

**Plano de teste:** `node --test tests/*.test.js`, `cargo test`, `python3 build.py --css --check` e `npx tauri build --debug --bundles deb`. Manual com o docker falso (`PATH` e `FAKE_DOCKER_STATE`): a lista, os logs ao vivo, o compose up com saída, o terminal (vim), o criar container e a remoção em 2 passos. `ss -ltnp` mostrando que o processo do Stivo não escuta nenhuma porta.

---

## T9. Ícone do Stivo e variantes da bandeja

**Escopo:** o ícone do app e o desenho da bandeja (normal, contagem `1` a `9+` e `!`), nos formatos do Tauri, gerados a partir de um SVG-fonte.

**Contexto:** PRODUCT.md "Brand Commitments" (ícone novo, a desenhar; sem baleia nem derivados), PRD RF2.2 e RF3.1. O favicon da web passa a ser o mesmo desenho, então a bandeja e o favicon saem de uma função só (o `setIcon` do `app.ts`).

**Skills:** `impeccable` (`shape` para o ícone dentro do mundo "terminal evoluído": grafite frio, ciano do cursor, sem pílula; o detector roda no fim).

**Regras:** DESIGN.md: a cor é estado e o ciano é o único acento ("A Regra do Cursor Único"); o vermelho da contagem é estado (bad), não decoração. Legível em 16, 22 e 32 px, no tema claro e no escuro da bandeja do sistema.

**Steps:**

1. Uma sessão de `/impeccable shape` para o ícone: duas a três direções, uma escolhida por você. Este é o único ponto do lote que espera uma resposta sua; se ela não vier, sigo com a direção que o `shape` recomendar e registro a escolha no Histórico do PRD.
2. `src-tauri/icons/stivo.svg` (a fonte) e o `npx tauri icon src-tauri/icons/stivo.svg` (png, ico).
3. `setIcon` no `app.ts`: o mesmo SVG-fonte em linha, com o selo de contagem por cima. O `transport.attention(badge, svg)` recebe pronto.
4. DESIGN.md: uma seção "Ícone" em Components (os tamanhos, o selo e o tema da bandeja).

**Plano de teste:** inspeção visual do ícone e das variantes renderizadas a 16, 22 e 32 px sobre fundo claro e escuro (`magick` monta a prancha). `npx playwright test list problems` (o favicon) verde nos dois backends.

---

## T10. Segundo plano: bandeja, notificação, instância única e janela

**Escopo:** fechar esconde, a bandeja mostra a contagem e tem menu, as notificações nativas saem com a janela escondida, há só uma instância e a janela lembra o tamanho.

**Contexto:** PRD seção 2 (RF2.1 a RF2.7) e seção 3 (RF3.2, RF3.3); techspec etapa 5, "Fechar esconde a janela" e os riscos "Bandeja no GNOME" e "Memória com a janela escondida". A memória é medida aqui; se passar de 150 MB, a decisão "esconder × destruir" é reaberta (desvio de decisão registrado no techspec).

**Skills:** `systematic-debugging`, `feature-prints` (prints da bandeja e da notificação para o PR).

**Regras:** as regras de quando notificar continuam todas no front (`newProblems` e o `notify` do `app.ts`); o Rust só exibe.

**Steps:**

1. `lib.rs`: `on_window_event(CloseRequested)` com `api.prevent_close()` e `window.hide()`. Na primeira vez, um aviso nativo, "O Stivo continua na bandeja vigiando os containers. Para sair, use Sair no menu da bandeja; abrir o Stivo de novo traz a janela de volta.", e `close_hint_shown` salvo (o `prefs.json` nasce aqui, com só esse campo; o resto vem na T11).
2. `tauri-plugin-single-instance`: a segunda execução chama `show()`, `unminimize()` e `set_focus()`. `tauri-plugin-window-state`: tamanho e posição.
3. `tray.rs`: o ícone inicial, o menu (Abrir Stivo, Preferências…, que fica desabilitado até a T11, e Sair) e o `attention(badge, icon_png)` com `set_icon`, `set_tooltip` ("Stivo · 2 precisam de atenção") e o título no Linux.
4. `notify.rs`: `notify-rust` com a ação `default`. No Linux, uma thread espera a ação e chama `show()` e `emit("focus-target", target)`. No Windows, o toast ativa o app; o argumento de ativação, se o `notify-rust` expuser, chega ao single-instance. O mínimo é abrir a janela (risco do techspec). A página recebe o `focus-target` e rola até o container (a função que o clique na notificação web já chama, `focus()`, ganha o alvo).
5. Front: com `T.desktop`, `notifying()` responde `true` (desligável na T11), o botão "Notificar quando algo der problema" some e o `!document.hidden && document.hasFocus()` continua decidindo não notificar com a janela à frente.
6. `scripts/memory.sh` (adaptado do Paddock: soma de PSS e RSS da árvore do PID) e `scripts/size.sh` (os tetos do PRD sobre os bundles).

**Plano de teste:** `e2e/desktop-smoke.sh` (Xvfb, `xdotool` e `dbus-monitor`), que confere:
- o app abre e lista os containers do docker falso;
- fechar esconde a janela e o processo continua;
- um container que cai gera uma notificação em até 5 s;
- a contagem chega ao tooltip da bandeja;
- uma segunda execução traz a janela de volta.

Também `scripts/memory.sh` depois de 2 min com a janela fechada, com a meta de até 150 MB de PSS e o número registrado no PR.

---

## T11. Preferências

**Escopo:** a tela de preferências (CLI, contexto, idioma, notificações), o `prefs.rs` e a troca com efeito imediato.

**Contexto:** PRD seção 4 (RF4.1 a RF4.4); techspec "Modelos de dado" (`Prefs`) e a decisão do `dg://` que recarrega a página.

**Skills:** `impeccable` (`shape` da tela dentro dos componentes do DESIGN.md: modal, `select` nativo, campos, botões; depois o `audit`), `tdd` (validação do `Prefs`).

**Regras:** DESIGN.md "Inputs / Fields" e "Buttons"; WCAG 2.2 AA (foco, rótulos, teclado); `cli` só aceita docker ou podman, e `context` só um nome que o `docker context ls` devolveu.

**Steps:**

1. `prefs.rs`: o `Prefs` do techspec com `serde(default)`, leitura e gravação atômica (arquivo temporário + rename) em `app_config_dir()/prefs.json`, `effective()` (os padrões: `DOCKER_GUI_CLI`, `DOCKER_CONTEXT`, locale) e `validate()`.
2. Comandos `prefs_get`, `prefs_set` (valida, salva, troca o `Ctx` no `AppState` e chama `webview.reload()`) e `contexts` (`docker context ls --format '{{.Name}}'`).
3. `page.html`: um `<dialog id="prefs">` com o mesmo esqueleto do modal "Novo container", visível só com `T.desktop`, aberto pelo menu da bandeja (evento `open-prefs`) e por um botão no cabeçalho ao lado de "Atalhos" (só no desktop). As strings novas vão para o `en.json`.
4. O menu "Preferências…" da bandeja deixa de ser desabilitado.

**Plano de teste:** `cargo test` (prefs: padrões, valor inválido recusado, arquivo corrompido volta ao padrão). Manual: trocar para Podman (o docker falso responde como `podman` com `FAKE_PODMAN=1` se existir, senão com um podman real) e trocar para um contexto remoto (a faixa âmbar aparece), trocar o idioma e desligar as notificações. Depois, `/impeccable audit` na tela.

---

## T12. CI do desktop e fechamento de design

**Escopo:** o CI roda o Rust e o E2E nos dois backends, gera os bundles de Linux e Windows e confere os tetos; o DESIGN.md é atualizado a partir do que foi entregue.

**Contexto:** techspec "Estratégia de teste" e etapa 7 (parte de CI); "FINISH" do brief do Impeccable: não revisado e não documentado é inacabado.

**Skills:** `impeccable` (`document`, para mesclar o DESIGN.md com a T2, a T9 e a T11 e regenerar o sidecar), `feature-prints`.

**Regras:** as versões das actions e das ferramentas ficam fixas, como já é feito com o ruff no `ci.yml`.

**Steps:**

1. `ci.yml`: job `rust` (fmt, clippy, test) em ubuntu; o job `ui` vira uma matriz `backend: [python, rust]` (o rust compila o harness antes); job `desktop` com matriz `ubuntu-22.04` e `windows-latest`, `npx tauri build --bundles deb,rpm` / `msi,nsis`, `scripts/size.sh` e upload dos bundles como artifact.
2. O `frontend` passa a conferir também o `src-tauri/dist/index.html` (`build.py --check` cobre os dois).
3. `/impeccable document` (mesclar).

**Plano de teste:** o CI verde no PR B. O `size.sh` passa nos quatro bundles (até 20 MB).

---

## T13. Release no GitHub

**Escopo:** um workflow que, numa tag `v*`, gera os instaladores de Linux e Windows e os publica numa release.

**Contexto:** PRD RF7.1 e RF7.3; techspec etapa 7.

**Skills:** nenhuma específica.

**Regras:** a release só sai com o CI verde (os testes das duas versões).

**Steps:** `.github/workflows/release.yml` com `on: push: tags: ['v*']`, que reaproveita os jobs de build da T12 (via `workflow_call`) e o `softprops/action-gh-release` com versão fixa. Os checksums SHA-256 vão junto. A versão vem de um lugar só: `tauri.conf.json` e `Cargo.toml` são conferidos contra a tag.

**Plano de teste:** uma tag `v0.0.0-test` num fork ou com `workflow_dispatch` em modo rascunho. A release gerada tem `.deb`, `.rpm`, `.msi`, `.exe` e `SHA256SUMS`.

---

## T14. AUR e winget

**Escopo:** o `PKGBUILD` do AUR (`stivo-bin`, a partir do `.deb` da release) e o manifesto do winget (`MartinsGabriel.Stivo`, a partir do `.msi`).

**Contexto:** PRD RF7.2; techspec etapa 7 ("só apontam para a release").

**Skills:** nenhuma específica.

**Regras:** sem Python como dependência no pacote do desktop (PRD, "Instalação sem dependências"); as dependências reais do AUR são `webkit2gtk-4.1` e `libayatana-appindicator`.

**Steps:** `packaging/aur/PKGBUILD` e `.SRCINFO`; `packaging/winget/` com os três YAML do manifesto (version, installer, defaultLocale), com a descrição "Gerenciador de containers para Docker e Podman" e a licença do `LICENSE`. A publicação de fato (o push no AUR e o PR no `winget-pkgs`) é sua, com as suas contas; o README de `packaging/` diz como fazer.

**Plano de teste:** `makepkg --printsrcinfo` e `namcap` no PKGBUILD (num container `archlinux`); `winget validate` no CI do Windows (job manual).

---

## T15. Flathub e Snap: investigação e manifestos

**Escopo:** descobrir se o Stivo cabe no confinamento do Flatpak e do Snap e, se couber, deixar o manifesto pronto; se não couber, levar o RF7.2 de volta ao PRD.

**Contexto:** techspec, risco "Flathub e Snap". O app executa o CLI do host: no Flatpak isso exige `flatpak-spawn --host` e `--talk-name=org.freedesktop.Flatpak`; no Snap, confinamento `classic`.

**Skills:** `deep-research` (as políticas atuais de revisão do Flathub e da Snap Store para apps que executam binários do host), `no-workarounds` (nada de embutir um docker CLI dentro do pacote para contornar).

**Regras:** "A GUI nunca amplia o que o docker já permite": o pacote não pede mais permissão do que executar o CLI do host.

**Steps:**

1. Pesquisar as políticas, com fontes.
2. Se o Flathub aceitar: `packaging/flatpak/io.github.martinsgabriel1956.Stivo.yml` com o runtime GNOME e o `Runner` usando `flatpak-spawn --host` quando `FLATPAK_ID` existe (um ajuste no `cli.rs`, com teste), mais o metainfo AppStream. Se o Snap aceitar `classic`: `packaging/snap/snapcraft.yaml`.
3. Se algum recusar: atualizar o PRD (RF7.2, Histórico, com a justificativa e as fontes) e o techspec (riscos, Histórico) e registrar no resumo final.

**Plano de teste:** `flatpak-builder --user --install` local e o app listando os containers do host; `snapcraft` local, se aplicável. Ou, no caso de recusa, o PRD e o techspec atualizados com as fontes.

---

## Fora deste lote

- Rodar o `sdd-review` depois da T15: ele reconcilia este arquivo com o código e o apaga.
- A busca de marca "Stivo" no INPI e no USPTO (PRODUCT.md): fica com você, antes da primeira tag.
