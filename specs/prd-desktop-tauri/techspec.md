# Techspec: Stivo desktop

## Resumo executivo

O desktop é um app Tauri 2 com **backend próprio em Rust** (`src-tauri/`). O backend replica o contrato da API HTTP do `docker_gui.py` (as mesmas rotas, os mesmos corpos e os mesmos códigos), mas a página o alcança pela IPC do Tauri, não por uma porta de rede. O front continua sendo um só (`src/`). A única diferença entre as versões é uma camada de transporte: na web ela usa fetch, `EventSource` e `WebSocket`; no desktop, `invoke` e `Channel`. A lógica da página (faixa de atenção, regras de notificação, favicon) não é duplicada.

A paridade entre os dois backends é garantida por dois mecanismos. O primeiro são **fixtures de contrato compartilhadas**: entrada do CLI e requisição, com a resposta esperada. Elas rodam no `unittest` e no `cargo test`. O segundo é a **suíte Playwright atual**, que roda sem mudança contra o backend Rust por meio de um binário de teste que o serve por HTTP e nunca entra no instalador. Fechar a janela só a esconde. A página continua viva, ouvindo os eventos, e chama a bandeja e a notificação nativas.

## Arquitetura

### Visão de componentes

```
src/ (um front só)
  app.ts            lógica da página; importa o transporte de '#transport'
  transport.ts      interface Transport
  transport-web.ts  fetch / EventSource / WebSocket (o que existe hoje)    → build.py → docker_gui.py
  transport-desktop.ts  invoke / Channel do Tauri                         → build.py --desktop → src-tauri/dist/index.html
  (package.json "imports": '#transport' → web por padrão, desktop com a condição "desktop" do esbuild)

docker_gui.py       inalterado na lógica; ganha só o replay das fixtures de contrato nos testes

src-tauri/src/
  core/             sem Tauri, sem HTTP: o equivalente ao backend Python
    cli.rs          executa o binário (docker|podman + --context), com prazo e kill ao soltar
    normalize.rs    podman → formato docker; images/volumes/networks/stats/history/summary
    validate.rs     regex e listas fixas (IMAGE_RE, NAME_RE, PORT_RE…), run_argv, compose_base
    router.rs       handle(Request) -> Response: as rotas de /api/* de hoje
    streams.rs      logs -f, compose logs -f, events, compose NDJSON: Stream de linhas
    terminal.rs     docker exec -it num PTY (portable-pty: Unix PTY e ConPTY)
    i18n.rs         mensagens do backend em pt e en (as mesmas do EN do Python)
  ipc.rs            comandos Tauri: casca fina sobre core::router, streams e terminal
  page.rs           protocolo dg:// que serve a página com os data-* injetados
  tray.rs           bandeja: ícone, tooltip, menu (Abrir, Preferências, Sair)
  notify.rs         notificação nativa com clique → mostrar a janela e focar o alvo
  prefs.rs          preferências em <app_config>/prefs.json
  lib.rs / main.rs  montagem: single-instance, window-state, fechar → esconder
  bin/harness.rs    SÓ TESTE (feature "harness"): core servido por HTTP, mesmo contrato do Python
```

**Fluxo de dado (desktop):**

1. O Rust abre a janela em `dg://localhost/`. O `page.rs` serve o HTML gerado pelo `build.py --desktop` com os `data-cli`, `data-where`, `data-host`, `data-remote` e `data-lang` injetados a partir das preferências, como o `main()` do Python faz hoje.
2. O `app.ts` chama `transport.request('GET', '/api/containers')`. O `transport-desktop` vira `invoke('api', {method, path, body})`, o `ipc.rs` chama `core::router::handle` e o roteador executa o CLI, normaliza a saída e devolve `{status, body}`.
3. Os streams (eventos, logs, NDJSON do compose) abrem com `invoke('stream_open', {path, body, channel})`. O Rust empurra linhas pelo `Channel` até o fim ou até `stream_close`.
4. O terminal abre com `invoke('term_open', {id, cols, rows, channel})`. A saída do PTY vai pelo `Channel`; a entrada e o resize voltam por `term_input` e `term_resize`.
5. Quando a faixa de atenção muda, a página chama `invoke('attention', {count, stale, icon})`. O `icon` é o PNG que o código do favicon já desenha; o `tray.rs` troca o ícone e o tooltip.
6. Para notificar, a página chama `invoke('notify', {title, body, target})` no lugar de `new Notification`. As regras de quando notificar continuam todas no front.

**Fluxo de teste (harness):** o `bin/harness.rs` imprime `Docker GUI em http://127.0.0.1:<porta>/#t=<token>`, como o Python. Ele serve a página da web (`entry-web`) e aplica nas rotas o mesmo `core::router`, com SSE para os streams e WebSocket para o terminal. O `fixtures.ts` escolhe o binário por `GUI_BACKEND=python|rust`.

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

Comandos Tauri (`ipc.rs`). A janela `main` é a única com permissão para usá-los (capability).

```rust
#[tauri::command] async fn api(method: Method, path: String, body: Option<Value>) -> ApiResponse;
#[tauri::command] async fn stream_open(path: String, body: Option<Value>, channel: Channel<StreamMsg>) -> StreamId;
#[tauri::command] fn stream_close(id: StreamId);
#[tauri::command] async fn term_open(id: String, cols: u16, rows: u16, channel: Channel<TermMsg>) -> TermId;
#[tauri::command] fn term_input(term: TermId, data: String);
#[tauri::command] fn term_resize(term: TermId, cols: u16, rows: u16);
#[tauri::command] fn term_close(term: TermId);
#[tauri::command] fn attention(count: u32, stale: bool, icon: Vec<u8>);
#[tauri::command] fn notify(title: String, body: String, target: String);
#[tauri::command] fn prefs_get() -> Prefs;
#[tauri::command] fn prefs_set(prefs: Prefs) -> Result<(), String>;   // valida, salva e recarrega a página
#[tauri::command] async fn contexts() -> Vec<String>;                  // docker context ls (para a tela)
```

Núcleo (`core`), testável sem Tauri:

```rust
pub struct Cli { pub argv: Vec<String> }                     // ["docker"] | ["podman"] | [.., "--context", c]
pub trait Runner: Send + Sync {                              // trocado por um falso nos testes de contrato
    async fn run(&self, cli: &Cli, args: &[&str], timeout: Duration) -> Output;
    fn spawn(&self, cli: &Cli, args: &[&str]) -> io::Result<Child>;
}
pub struct Request { pub method: Method, pub path: String, pub query: Vec<(String, String)>, pub body: Option<Value> }
pub struct Response { pub status: u16, pub body: Value }
pub async fn handle(ctx: &Ctx, req: Request) -> Response;   // Ctx = Cli + Runner + Lang
pub fn stream(ctx: &Ctx, req: Request) -> Result<impl Stream<Item = StreamMsg>, Response>;
```

### Modelos de dado

- **`ApiResponse { status: u16, body: Value }`**: o corpo é o mesmo JSON que o Python devolve, com as mesmas mensagens de erro traduzidas.
- **`StreamMsg`**: `Data(String)` | `End` | `Error(String)`. Corresponde ao `data:` / `event: end` do SSE e a uma linha do NDJSON.
- **`TermMsg`**: `Output(Vec<u8>)` | `Closed { code: Option<i32> }`.
- **`Prefs { cli: Option<String>, context: Option<String>, lang: Option<Lang>, notifications: bool, close_hint_shown: bool }`**: `None` significa "o padrão de hoje" (`DOCKER_GUI_CLI` ou docker; `DOCKER_CONTEXT` ou o contexto atual; locale). O arquivo é JSON em `<app_config>/prefs.json`. `cli` só aceita `docker` ou `podman` (nome ou caminho absoluto de um binário com esse nome), e `context` só um nome que o `docker context ls` devolveu.
- **Fixture de contrato** (`tests/contract/<rota>/<caso>.json`):

```json
{ "lang": "pt", "cli": ["docker"],
  "calls": [{ "args": ["ps", "-a", "--format", "{{json .}}"], "stdout": "…", "stderr": "", "code": 0 }],
  "request": { "method": "GET", "path": "/api/containers", "body": null },
  "response": { "status": 200, "body": [] } }
```

O runner falso confere que as chamadas saíram nessa ordem e com esses argumentos. Isso cobre também a validação: um caso de "argumento recusado" tem `calls: []`.

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

1. **Transporte no front.** Extrair o `Transport` do `app.ts` e criar o `transport-web` e o `entry-web`. O `build.py` gera o mesmo `docker_gui.py`. Os testes atuais provam que nada mudou. Isso destrava todo o resto e entra sozinho, sem Rust.
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
- **Tamanho medido pelo `.deb`, `.rpm`, `.msi` e `.exe` (NSIS).** O AppImage leva o WebKitGTK dentro, passa de 70 MB e fica fora dos formatos publicados.

### Riscos conhecidos

- **Bandeja no GNOME:** sem a extensão AppIndicator, o ícone não aparece. Fechar a janela deixaria o app invisível. Mitigação: o aviso da primeira vez que a janela fecha também diz que abrir o app de novo traz a janela de volta (single-instance), e o README documenta a extensão. A investigar: detectar se existe um host de bandeja (`StatusNotifierWatcher` no D-Bus) e, se não existir, fechar passa a minimizar.
- **Clique na notificação no Windows (RF2.6):** o toast traz o app à frente, mas levar ao container específico depende do argumento de ativação. A investigar na etapa 5; o mínimo aceitável é abrir a janela.
- **Flathub e Snap:** o app executa o CLI do host. No Flatpak isso exige `flatpak-spawn --host` e `--talk-name=org.freedesktop.Flatpak`, que é praticamente sair do sandbox e pode ser recusado na revisão do Flathub. No Snap exige confinamento `classic`, com revisão manual. Se algum dos dois for recusado, o RF7.2 volta para o PRD com essa justificativa.
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
- Novos: `src/transport*.ts`, `src/entry-*.ts`, `src-tauri/**`, `tests/contract/**`, `tests/test_contract.py`, `e2e/desktop-smoke.sh` e `scripts/size.sh`, `scripts/memory.sh`.

## Histórico

**2026-10-21**. Documento criado.

**2026-10-21**. Nome do produto: Stivo (decisão no PRD, seção 6). Acrescentada a decisão de trocar só o nome visível e manter os identificadores técnicos; referência à distribuição renumerada para RF7.2.

**2026-10-21**. Durante a T1: o transporte é escolhido pelo `imports` do `package.json` (`#transport`) com a condição `desktop` do esbuild, em vez de dois arquivos de entrada; a interface ficou com `stream(path, query, handlers)`, `ndjson` devolvendo `{status, code, error}` e `terminal(id, handlers)` com o tamanho pelo `resize` do `open`. O contrato compartilhado cobre as rotas que chamam o `docker()`; streams, NDJSON e terminal ficam com o E2E e os testes do Rust.

**2026-10-21**. T10: medida a memória com a janela fechada (140,8 MB de PSS, dentro do teto de 150 MB) depois de dois ajustes no Linux, o cache e a aceleração do WebKitGTK e as arenas do malloc; a decisão de esconder a janela em vez de destruir a página continua. Notificações com o `notify-rust` direto (no Linux, o clique traz a janela pela ação default) e a bandeja do próprio Tauri, com o ícone em PNG desenhado pela página.
