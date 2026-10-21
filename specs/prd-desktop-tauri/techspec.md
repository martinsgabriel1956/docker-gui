# Techspec: Stivo desktop

## Resumo executivo

O desktop é um app Tauri 2 com **backend próprio em Rust** (`src-tauri/`). O backend replica o contrato da API HTTP do `docker_gui.py` (as mesmas rotas, os mesmos corpos e os mesmos códigos), mas a página o alcança pela IPC do Tauri, não por uma porta de rede. O front continua sendo um só (`src/`). A única diferença entre as versões é uma camada de transporte: na web ela usa fetch, `EventSource` e `WebSocket`; no desktop, `invoke` e `Channel`. A lógica da página (faixa de atenção, regras de notificação, favicon) não é duplicada.

A paridade entre os dois backends é garantida por dois mecanismos. O primeiro são **fixtures de contrato compartilhadas**: entrada do CLI e requisição, com a resposta esperada. Elas rodam no `unittest` e no `cargo test`. O segundo é a **suíte Playwright atual**, que roda sem mudança contra o backend Rust por meio de um binário de teste que o serve por HTTP e nunca entra no instalador. Fechar a janela só a esconde. A página continua viva, ouvindo os eventos, e chama a bandeja e a notificação nativas.

## Arquitetura

### Visão de componentes

```
src/ (um front só)
  app.ts            lógica da página; importa o transporte de '#transport'
  transport.ts      interface Transport (e as preferências, só no desktop)
  transport-web.ts  fetch / EventSource / WebSocket (o que existe hoje)    → build.py → docker_gui.py
  transport-desktop.ts  invoke / Channel do Tauri                         → build.py → src-tauri/dist/index.html
  (package.json "imports": '#transport' → web por padrão, desktop com a condição "desktop" do esbuild;
   o build.py gera as duas páginas sempre, e o --check confere as duas)

docker_gui.py       inalterado na lógica; ganha só o replay das fixtures de contrato nos testes

src-tauri/core/     crate stivo-core: sem Tauri, sem HTTP, o equivalente ao backend Python
  src/cli.rs        Runner (executa o binário com prazo e kill ao soltar, sem console no Windows) e Ctx
  src/router.rs     handle(Request) -> Reply: as rotas de /api/* (Json ou o Ndjson do compose)
  src/normalize.rs  podman → formato docker; images/volumes/networks/stats/history/summary
  src/validate.rs   regex e listas fixas (IMAGE_RE, NAME_RE, PORT_RE…), run_argv
  src/compose.rs    o compose em stream: linhas e {"code"}, segue até o fim mesmo sem leitor
  src/streams.rs    logs -f, compose logs -f e events como Stream (soltar mata o docker)
  src/terminal.rs   docker exec -it num PTY (portable-pty: Unix PTY e ConPTY)
  src/page.rs       where() e os data-* da página (o mesmo para o app e para o harness)
  src/i18n.rs       mensagens em pt e en, a tabela EN do Python (i18n_en.rs, conferida por teste)
  src/pyfmt.rs      repr(), %g e parse_qs do Python, para a resposta sair igual
  src/bin/harness.rs  SÓ TESTE (feature "harness"): o núcleo servido por HTTP, mesmo contrato do Python
  tests/contract.rs   os casos de tests/contract/ no cargo test

src-tauri/src/      o app Tauri (crate stivo)
  ipc.rs            comandos: api, stream_*, term_*, prefs_get, prefs_set
  page.rs           protocolo dg:// que serve a página com os data-* injetados
  background.rs     bandeja (ícone, tooltip, menu Abrir/Preferências/Sair), notificação e fechar → esconder
  prefs.rs          preferências em <app_config>/prefs.json, com a validação do que vem da tela
  lib.rs / main.rs  montagem: single-instance, window-state, log, título da janela, ajustes de memória
```

**Fluxo de dado (desktop):**

1. O Rust abre a janela em `dg://localhost/` (no Windows, `http://dg.localhost/`). O `page.rs` serve o `src-tauri/dist/index.html` gerado pelo `build.py` com os `data-cli`, `data-where`, `data-host`, `data-remote` e `data-lang` injetados a partir das preferências, como o `main()` do Python faz hoje.
2. O `app.ts` chama `T.request('GET', '/api/containers')`. O `transport-desktop` vira `invoke('api', {method, path, body})`, o `ipc.rs` chama `stivo_core::handle` e o roteador executa o CLI, normaliza a saída e devolve `{status, body}`.
3. Os streams abrem com `invoke('stream_open', {method, path, query, body, channel})`: GET para eventos e logs (mensagens `{data}` e `{end}`, o mesmo do SSE), POST para o compose (mensagens `{line}` e `{end}`, o mesmo do NDJSON). O Rust empurra pelo `Channel` até o fim ou até `stream_close`; a recusa antes de abrir volta como `{status, body}`.
4. O terminal abre com `invoke('term_open', {id, cols, rows, channel})` no primeiro resize que a página faz. A saída do PTY vai pelo `Channel` em bytes crus (ArrayBuffer) e o fim como `{closed: true}`; a entrada (`term_input`, síncrono, para as teclas não se embaralharem) e o resize voltam por comandos.
5. Quando a faixa de atenção muda, a página chama `invoke('attention', {badge, tooltip, icon})`. O `icon` é o SVG do favicon passado a PNG de 64 px num canvas; o `background.rs` troca o ícone e o tooltip da bandeja.
6. Para notificar, a página chama `invoke('notify', {title, body})` no lugar de `new Notification`. As regras de quando notificar continuam todas no front. O clique (ação default no Linux) traz a janela e manda o evento `notification-click`; a página põe o foco no Logs de quem caiu, como no clique da versão web.
7. O `<title>` da página (contexto e contagens) vira o título da janela (`on_document_title_changed`).

**Fluxo de teste (harness):** o `src-tauri/core/src/bin/harness.rs` imprime `Stivo em http://localhost:<porta>/#t=<token>`, como o Python. Ele serve a página da web (o `PAGE` do `docker_gui.py`) e aplica nas rotas o mesmo `core::router`, com SSE para os streams e WebSocket para o terminal. O `fixtures.ts` escolhe o binário por `GUI_BACKEND=python|rust`.

## Design de implementação

### Interfaces principais

Transporte do front: o único ponto em que as versões divergem.

```ts
export interface Transport {   // src/transport.ts
  desktop: boolean;
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResponse>;
  // o EventSource de hoje: open a cada (re)conexão, uma linha por mensagem, end no fim, error(closed)
  stream(path: string, query: Record<string, string>, on: StreamHandlers): Closer;
  // POST com resposta NDJSON (compose): linhas para onLine; {status, code} no fim, ou o JSON de erro se recusou antes
  ndjson(path: string, body: unknown, onLine: (line: string) => void): Promise<{status: number; code: number; error?: unknown}>;
  // o tamanho vai pelo resize no open (o servidor só sobe o exec depois dele); notice = aviso em texto do servidor
  terminal(id: string, on: {open(): void; data(b: Uint8Array): void; notice(t: string): void; close(): void}): Term;
  attention(badge: string, svg: string): void;                 // web: favicon (como hoje); desktop: bandeja
  notify(title: string, body: string, onClick: () => void): void;  // web: new Notification (como hoje)
}
```

Comandos Tauri (`ipc.rs` e `background.rs`). A janela `main` é a única com permissão para usá-los (capability).

```rust
#[tauri::command] async fn api(method: String, path: String, body: Option<Value>) -> Result<ApiReply, String>;
#[tauri::command] async fn stream_open(method: String, path: String, query: String, body: Option<Value>,
                                       channel: Channel<Value>) -> Result<u32, ApiReply>;
#[tauri::command] fn stream_close(id: u32);
#[tauri::command] fn term_open(id: String, cols: u16, rows: u16, channel: Channel<InvokeResponseBody>) -> Result<u32, String>;
#[tauri::command] fn term_input(term: u32, data: String);      // síncrono: as teclas na ordem
#[tauri::command] fn term_resize(term: u32, cols: u16, rows: u16);
#[tauri::command] fn term_close(term: u32);
#[tauri::command] fn attention(badge: String, tooltip: String, icon: Vec<u8>);
#[tauri::command] fn notify(title: String, body: String);
#[tauri::command] async fn prefs_get() -> Result<PrefsView, String>;   // as preferências e os contextos do docker
#[tauri::command] async fn prefs_set(prefs: Choice) -> Result<(), String>;  // valida, salva, aplica e recarrega
```

Núcleo (`core`), testável sem Tauri:

```rust
#[async_trait::async_trait]
pub trait Runner: Send + Sync {                              // trocado por um falso nos testes de contrato
    async fn run(&self, cli: &[String], args: &[String], timeout: Duration) -> Result<Output, RunError>;
    fn command(&self, cli: &[String], args: &[String]) -> tokio::process::Command;  // streams, compose e testes
}
pub struct Ctx { pub cli: Vec<String>, pub lang: Lang, pub runner: Arc<dyn Runner>, pub now: Clock }
pub struct Request { pub method: Method, pub path: String, pub query: String, pub body: Option<Value> }
pub enum Reply { Json(Response), Ndjson(BoxStream<'static, Value>) }
pub async fn handle(ctx: &Ctx, req: Request) -> Reply;
pub async fn streams::open(ctx: &Ctx, path: &str, query: &str) -> Result<BoxStream<'static, StreamMsg>, Response>;
pub fn terminal::open(cli: &[String], id: &str, cols: u16, rows: u16, on_data, on_close) -> io::Result<Arc<Terminal>>;
```

### Modelos de dado

- **`ApiResponse { status: u16, body: Value }`**: o corpo é o mesmo JSON que o Python devolve, com as mesmas mensagens de erro traduzidas.
- **`StreamMsg`**: `Data(String)` | `End`, o `data:` / `event: end` do SSE (nos logs, a linha em JSON; nos eventos, `1`). O NDJSON do compose é um `Stream<Value>` (strings e, no fim, `{"code": n}`).
- **Terminal pelo canal**: bytes crus (`InvokeResponseBody::Raw`) e, no fim, `{"closed": true}`.
- **`Prefs { cli: Option<String>, context: Option<String>, lang: Option<String>, notifications: Option<bool>, close_hint_shown: bool }`**: `None` significa "o padrão de hoje" (`DOCKER_GUI_CLI` ou docker; `DOCKER_CONTEXT` ou o contexto atual; locale). O arquivo é JSON em `<app_config>/prefs.json`. `cli` só aceita `docker` ou `podman` (nome ou caminho absoluto de um binário com esse nome), e `context` só um nome que o `docker context ls` devolveu.
- **Fixture de contrato** (`tests/contract/<rota>/<caso>.json`):

```json
{ "desc": "o que o caso confere", "lang": "pt", "cli": ["docker"], "now": 1700000000.5,
  "calls": [{ "args": ["ps", "-a", "--format", "{{json .}}"], "stdout": "…", "stderr": "", "code": 0 }],
  "request": { "method": "GET", "path": "/api/containers", "body": null },
  "response": { "status": 200, "body": [] } }
```

O runner falso confere que as chamadas saíram nessa ordem e com esses argumentos. Isso cobre também a validação: um caso de "argumento recusado" tem `calls: []`. O `now` (opcional) fixa o relógio do `--until` do histórico. O `tests/contract/play.py --record` grava os `args` e a `response` de um caso novo a partir do Python, para revisar no diff.

### Endpoints de API

Nenhum endpoint novo. O contrato são as rotas que existem hoje no `Handler` do `docker_gui.py` (`/api/containers`, `stats`, `df`, `images|volumes|networks`, `logs/<id>`, `health`, `history`, `top`, `inspect[/env]`, `compose/logs`, `compose/services`, os streams `logs/<id>/stream`, `compose/logs/stream` e `events/stream`, `exec/<id>`, e os POSTs de ação, `compose/<ação>`, `run`, `prune/<tipo>` e `rm/<tipo>/<ref>`). As rotas de leitura e escrita entram pelo `api`, os streams pelo `stream_open` e o `exec` pelo `term_*`. A autenticação por token, `Host` e `Origin` só existe no Python e no harness: na IPC, quem chama é sempre a própria janela.

## Pontos de integração

- **CLI do Docker ou do Podman:** o mesmo binário, as mesmas flags e os mesmos prazos do Python (`READ_TIMEOUT`, `ACTION_TIMEOUT`, `COMPOSE_TIMEOUT` = 600 s e `RUN_TIMEOUT`). No Windows, todo processo sai com `CREATE_NO_WINDOW`, para não piscar um console a cada consulta. Se o binário não existir ou o daemon estiver parado, a resposta é a mesma de hoje (500 com o stderr, ou o erro de spawn), e a página já mostra o estado "docker fora do ar".
- **PTY:** `portable-pty`. No Linux é um PTY de verdade, como hoje; no Windows é ConPTY, então o terminal ganha TTY real sem o `script` dentro do container. O modo pipe (`DOCKER_GUI_TERMINAL=pipe`) continua só no Python.
- **Bandeja:** recurso `tray-icon` do Tauri. No Linux depende do `libayatana-appindicator` (ver riscos).
- **Notificação:** `notify-rust`. No Linux usa a ação `default`, e o clique chama `notify::activate(target)`. No Windows o toast traz o app à frente (o single-instance recebe a ativação). Ao mostrar a janela, o `target` vai para a página por um evento `focus-target`.
- **Plugins:** `single-instance` (RF2.7) e `window-state` (RF3.2). Preferências num arquivo JSON simples, sem plugin de store.

## Estratégia de teste

**Contrato (as duas versões):** `tests/contract/` com casos para cada rota que chama o `docker()` (as de leitura e as ações). Os streams, o NDJSON do compose e o terminal chamam o `subprocess.Popen` direto no Python e ficam com o E2E nos dois backends e com os testes unitários do Rust. Os casos cobrem: o caminho feliz, o erro do CLI, o argumento recusado, o Podman (cada formato de saída que o `from_podman*` converte) e as mensagens em pt e en. São lidos pelo `tests/test_contract.py` (unittest, trocando o `docker()` como os testes atuais já fazem) e pelo `src-tauri/tests/contract.rs` (`cargo test`, com um `Runner` falso). Um caso novo protege as duas versões de uma vez. Os testes unitários atuais do Python continuam e viram fonte dos primeiros casos.

**Unitário (Rust):** `validate` (tabela das regex e do `run_argv`, inclusive o que é recusado de propósito: bind mount, `--privileged`), `normalize` e `prefs` (validação e defaults). A única coisa mockada é o `Runner`.

**Front:** o `node:test` do `format.ts` segue igual. O `transport-desktop` ganha um teste com o `invoke` falso (uma rota, um stream com fim e um terminal com resize), sem Tauri.

**E2E de paridade:** os 17 specs do Playwright rodam duas vezes no CI, com `GUI_BACKEND=python` e com `GUI_BACKEND=rust` (o harness), contra o mesmo docker falso. Os testes do modo pipe do terminal são marcados como só do Python. Qualquer outro spec que precise ser pulado no Rust é uma lacuna de paridade e bloqueia o merge.

**Desktop (o que o harness não cobre):** `e2e/desktop-smoke.sh` no Linux, com Xvfb e `xdotool` (o mesmo método do Paddock; o `tauri-driver` exige o WebKitWebDriver, que a distro não empacota). O script confere que o app abre e lista os containers do docker falso, que fechar esconde a janela e o processo continua, que um container caindo gera uma notificação em até 5 s (lida do `dbus-monitor`), que a contagem chega à bandeja e que uma segunda execução traz a janela de volta. No Windows, um checklist manual por release.

**Métricas do PRD (`scripts/`):** `size.sh` (o `.deb`, o `.rpm` e o `.msi` com até 20 MB, conferido no CI) e `memory.sh` (PSS da árvore de processos, com o app e o `WebKitWebProcess`/`msedgewebview2`, depois de 2 min com a janela fechada; teto de 150 MB).

## Sequenciamento

1. **Transporte no front.** Extrair o `Transport` do `app.ts` e criar o `transport-web` (escolhido pelo `#transport` do `package.json`). O `build.py` gera o mesmo `docker_gui.py`. Os testes atuais provam que nada mudou. Isso destrava todo o resto e entra sozinho, sem Rust.
2. **Fixtures de contrato + replay no Python.** Formalizam o comportamento antes de copiá-lo.
3. **`core` em Rust + harness**, rota por rota, na ordem das fixtures: listas e ações, depois logs e streams, compose, run e remoções, e por fim o terminal. Cada grupo fica pronto quando passa nas fixtures e nos specs Playwright dele contra o harness.
4. **Casca Tauri:** `page.rs`, `ipc.rs` e `transport-desktop`. A janela funciona com paridade.
5. **Segundo plano:** fechar → esconder, bandeja, notificação, single-instance e window-state. Medir a memória aqui, cedo: se estourar, a decisão de "esconder em vez de destruir" é reaberta aqui.
6. **Preferências:** tela e `prefs.rs`.
7. **CI e distribuição:** build de Linux e Windows, tetos de tamanho e GitHub Releases. Depois AUR e winget (só apontam para a release). Flathub e Snap por último, depois da investigação de confinamento (ver riscos).

A etapa 1 bloqueia a 4, a 2 bloqueia a 3 e a 4 bloqueia a 5 e a 6.

## Observabilidade

- O Python não registra URLs nem comandos, por privacidade. O Rust segue a mesma regra: `log` em nível `warn` para falha de spawn, prazo estourado e stream encerrado com erro, sem argumentos de container, sem env e sem logs dos containers.
- Os logs vão para o diretório de log do app (`tauri-plugin-log`, como no Paddock). Sem telemetria (PRD, fora de escopo).
- O evento `ui://ready`, logado, marca o fim do carregamento e serve de referência para o `memory.sh`.

## Considerações técnicas

### Decisões principais

- **Backend reescrito em Rust, não Python empacotado.** O sidecar com PyInstaller daria paridade de graça, mas estoura as metas do PRD (instalador perto de 20 MB e +30 MB de RAM), é barrado por antivírus no Windows sem assinatura de código (que está fora de escopo) e complica o Flathub, o Snap e o AUR. O backend Python tem cerca de 1.100 linhas, e a reescrita é proporcional a isso. O custo de manter dois backends é pago pelas fixtures de contrato e pela suíte E2E rodando contra os dois.
- **IPC genérica com o formato da API HTTP (`api(method, path, body)`), não um comando tipado por rota.** O mesmo `core::router` atende a IPC e o harness, e é isso que deixa os specs Playwright provarem a lógica do desktop. No `app.ts`, cada chamada muda uma linha, não 17 assinaturas. Alternativa rejeitada: comandos tipados com `tauri-specta`, como no Paddock. Lá a IPC é a interface de verdade; aqui ela duplicaria um contrato que já existe e teria que ser testada à parte.
- **Fechar esconde a janela; a página continua viva.** A faixa de atenção, as regras de notificação ("só quem entra", agrupar, não repetir) e o desenho do favicon continuam com uma implementação só, no front. Alternativa rejeitada: destruir a webview e levar essas regras para o Rust, o que criaria uma segunda cópia para manter em paridade. O risco é a memória, medido na etapa 5.
- **Página servida por protocolo próprio (`dg://`) com os `data-*` injetados.** É o mesmo mecanismo do `PAGE.replace` do Python. Uma mudança de preferência recarrega a página com os valores novos (RF4.3). Rejeitado: um script de inicialização fixo, que ficaria velho depois da troca de contexto.
- **Dois builds no esbuild, não detecção em tempo de execução.** O `app.ts` importa `'#transport'`, e o campo `imports` do `package.json` resolve para o `transport-web.ts` por padrão ou para o `transport-desktop.ts` com a condição `desktop` do esbuild (`--conditions=desktop`). O `docker_gui.py` não carrega nenhum byte do Tauri, e o desktop não carrega o caminho de token e `EventSource`. Rejeitado: um arquivo de entrada por versão com o `app.ts` virando uma função `start(transport)`, que obrigaria a mover todo o código de topo das 1.900 linhas para dentro dela.
- **O Tauri usa o `npm`, não o `pnpm` do Paddock.** Este repositório já tem `package.json` e lockfile com `npm`, com versões fixas. Os pacotes `@tauri-apps/api` e `@tauri-apps/cli` também entram com versão exata. O Tauri fica fixo no minor `~2.12`, como no Paddock.
- **Nome Stivo só onde é visível.** O `productName` e o identificador do app (`io.github.martinsgabriel1956.Stivo`, usado também no Flathub e no winget) usam o nome novo, e os textos da página trocam "Docker GUI" por "Stivo". O `docker_gui.py`, as variáveis `DOCKER_GUI_*`, o cabeçalho `X-Docker-GUI-Token` e as chaves `docker-gui-*` do `localStorage` ficam: não são nome de produto, e trocar quebraria quem já usa a versão web (RF6.3). O e2e da versão web que espera "Docker GUI em http…" na saída do terminal passa a esperar o nome novo; o harness imprime o mesmo.
- **Núcleo num crate à parte (`src-tauri/core`, `stivo-core`), não um módulo do app.** O `cargo test`, o contrato e o harness rodam sem compilar o Tauri e sem o WebKit instalado, e o CI do núcleo fica leve. O app (`src-tauri`) depende dele.
- **Título da janela pela página.** O Tauri não copia o `<title>`, então o `on_document_title_changed` faz isso: o contexto e as contagens aparecem como na aba da versão web (RF3.3).
- **Tamanho medido pelo `.deb`, `.rpm`, `.msi` e `.exe` (NSIS).** O AppImage leva o WebKitGTK dentro, passa de 70 MB e fica fora dos formatos publicados.

### Riscos conhecidos

- **Bandeja no GNOME:** sem a extensão AppIndicator, o ícone não aparece. Fechar a janela deixaria o app invisível. Mitigação: o aviso da primeira vez que a janela fecha também diz que abrir o app de novo traz a janela de volta (single-instance), e o README documenta a extensão. A investigar: detectar se existe um host de bandeja (`StatusNotifierWatcher` no D-Bus) e, se não existir, fechar passa a minimizar.
- **Clique na notificação no Windows (RF2.6):** no Linux o clique traz a janela e leva o foco ao Logs de quem caiu. No Windows o `notify-rust` não devolve o clique: o toast traz o app à frente pela instância única, sem levar ao container. Falta conferir num Windows de verdade, junto com a memória (checklist manual da release).
- **Dependências do `.rpm`:** declaradas à mão (`libayatana-appindicator-gtk3`) e ainda não conferidas num Fedora; o `.deb` foi conferido (`dpkg-deb -f`).
- **Flathub e Snap (resolvido na T15: fora da primeira entrega):** o app executa o CLI do host. No Flatpak isso exige `flatpak-spawn --host` e `--talk-name=org.freedesktop.Flatpak`, um contorno do sandbox que as regras do Flathub recusam; no Snap, o confinamento `classic` é reservado a publicadores maduros, e o `strict` com a interface `docker` só alcança o Docker do próprio snap. O RF7.2 voltou ao PRD com essas fontes. Embutir um docker CLI no pacote foi descartado (seria um contorno, e quebraria o Podman e os contextos).
- **Memória com a janela escondida:** medido na T10 com o `scripts/memory.sh --idle` (binário de release, 6 containers, 2 min com a janela fechada, PSS do app e dos processos do WebKit, sem o docker): 163,6 MB sem ajuste, 150,2 MB com o WebKitGTK no modo de cache de visualizador de documentos e sem aceleração por GPU, e 140,8 MB limitando as arenas do malloc da glibc a duas (`mallopt(M_ARENA_MAX, 2)` no `main`). A decisão "esconder em vez de destruir" fica, com uns 9 MB de folga. No Windows (WebView2) a medição ainda falta: entra no checklist manual da release.
- **Divergência silenciosa entre os backends:** algo que não está nas fixtures nem nos specs pode divergir. Mitigação: um teste de cobertura falha se alguma rota do `Handler` não tiver pelo menos um caso de contrato.

### Conformidade com regras do projeto

O repositório não tem `CLAUDE.md` nem diretório de regras. As regras vêm do PRODUCT.md, do README e do DESIGN.md:

- **"A GUI nunca amplia o que o `docker` já permite":** o `validate.rs` traz as mesmas listas e regex do Python, com os casos de recusa nas fixtures de contrato.
- **Nenhum shell no host, argumentos validados:** o Rust executa o binário com `Command` e uma lista de argumentos, nunca uma string de shell. O `SHELL` de dentro do container (`sh -c exec bash||sh`) continua igual.
- **Confirmação em 2 passos e textos:** ficam no front, que é compartilhado. Nada muda.
- **Versões fixas:** é a regra que já vale para o Tailwind, o esbuild e o Playwright. Os crates usam versão fixa e o `Cargo.lock` é versionado.
- **O CI confere o gerado:** o `build.py --check` passa a conferir também o `src-tauri/dist/index.html`.
- **Desvio:** o PRODUCT.md dizia "Platform: web" e "um arquivo só". Isso já foi atualizado para as duas versões. O `docker_gui.py` continua sendo um arquivo único, só com a biblioteca padrão.

### Conformidade com skills disponíveis

- `tdd`: as fixtures de contrato são escritas antes de cada rota do Rust (o vermelho é o `cargo test` falhando no caso novo).
- `security-best-practices`: revisão da IPC (capabilities, CSP do `dg://`) e do `validate.rs` antes do merge da etapa 4.
- `systematic-debugging` e `no-workarounds`: para divergências de paridade. Pular um spec no Rust não é correção.
- `feature-prints`: prints da bandeja, da notificação e das preferências para o PR.
- `sdd-review`: fechamento, reconciliando este documento com o que foi construído.

### Arquivos relevantes

- `src/app.ts`: os pontos de transporte, nas linhas 23 (`api`), 182 (eventos), 938 (NDJSON do compose), 1458 (logs) e 1604 (terminal); a notificação, nas linhas 202 a 217; o favicon, a partir da linha 220.
- `src/page.html`: os `data-*` do `<html>` e a tela de preferências (só desktop).
- `build.py`: segundo entrypoint e saída `--desktop`.
- `docker_gui.py` (`Handler`, `docker()` e funções de normalização): referência do contrato. A lógica não muda.
- `tests/test_docker_gui.py`: fonte dos primeiros casos de contrato.
- `tests/e2e/fixtures.ts`: `GUI_BACKEND`.
- `tests/e2e/fake-docker/docker`: compartilhado pelos dois backends.
- `.github/workflows/ci.yml`: job Rust, E2E em matriz python/rust, build de Linux e Windows e tetos de tamanho.
- `package.json`: `@tauri-apps/api`, `@tauri-apps/cli` e scripts.
- Novos: `src/transport*.ts`, `src-tauri/**` (o app e o crate `core`), `tests/contract/**` (com o `play.py`), `tests/test_contract.py`, `tests/transport-desktop.test.js`, `e2e/desktop-smoke.sh` (com o `notify-server.py` e o `x11-close.py`), `scripts/size.sh`, `scripts/memory.sh`, `packaging/` (AUR e winget) e `.github/workflows/release.yml`.

## Histórico

**2026-10-21**. Documento criado.

**2026-10-21**. Nome do produto: Stivo (decisão no PRD, seção 6). Acrescentada a decisão de trocar só o nome visível e manter os identificadores técnicos; referência à distribuição renumerada para RF7.2.

**2026-10-21**. Durante a T1: o transporte é escolhido pelo `imports` do `package.json` (`#transport`) com a condição `desktop` do esbuild, em vez de dois arquivos de entrada; a interface ficou com `stream(path, query, handlers)`, `ndjson` devolvendo `{status, code, error}` e `terminal(id, handlers)` com o tamanho pelo `resize` do `open`. O contrato compartilhado cobre as rotas que chamam o `docker()`; streams, NDJSON e terminal ficam com o E2E e os testes do Rust.

**2026-10-21**. T10: medida a memória com a janela fechada (140,8 MB de PSS, dentro do teto de 150 MB) depois de dois ajustes no Linux, o cache e a aceleração do WebKitGTK e as arenas do malloc; a decisão de esconder a janela em vez de destruir a página continua. Notificações com o `notify-rust` direto (no Linux, o clique traz a janela pela ação default) e a bandeja do próprio Tauri, com o ícone em PNG desenhado pela página.

**2026-10-21**. T14 e T15: AUR (`stivo-bin`, a partir do `.deb`) e winget (`MartinsGabriel.Stivo`, a partir do `.msi`) em `packaging/`; Flathub e Snap fora da primeira entrega, pelo PRD. O `.deb` deixa de declarar o AppIndicator à mão (o bundler já o acrescenta por causa da bandeja); o `.rpm` continua declarando.

**2026-10-21**. Reconciliação do sdd-review: a visão de componentes, os comandos, os tipos e o fluxo de dado passam a descrever o que foi construído (o núcleo no crate `stivo-core`, o compose em `compose.rs`, a bandeja e a notificação em `background.rs`, os comandos `stream_open` com método e query, `attention` com badge e tooltip, `notify` sem alvo, `prefs_get` trazendo os contextos, o terminal em bytes crus, o `build.py` gerando as duas páginas sem flag). Decisões novas: o núcleo em crate à parte e o título da janela pela página. Na revisão entraram três correções: o título da janela (RF3.3), o foco no Logs de quem caiu ao clicar na notificação (RF2.6) e o aviso de "servidor caiu" sem mandar rodar o Python no desktop.
