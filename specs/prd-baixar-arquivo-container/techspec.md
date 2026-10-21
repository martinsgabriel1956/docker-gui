# Techspec: Baixar arquivo do container

## Resumo executivo

O núcleo da feature é uma função nos dois backends, `cp_out(id, path)`. Ela roda `docker cp -L <id>:<path> -` (um tar no stdout) e lê no máximo 100 MB, matando o processo se passar. Depois abre o tar em memória: se o primeiro membro é um arquivo, devolve o conteúdo dele com o nome original; se é uma pasta, devolve o tar inteiro como `<nome>.tar`.

Cada versão entrega o resultado do seu jeito:

- **Web:** rota `GET /api/cp/<id>?path=…` com resposta binária. A página faz `fetch` com o token no header e transforma o resultado num `Blob` com `<a download>`, como o "Baixar" dos logs.
- **Desktop:** um comando `cp_save(id, path)`. Ele chama a mesma função do núcleo, abre a janela "Salvar como" do sistema (`tauri-plugin-dialog`, só pelo Rust) já com o nome, e grava o arquivo.

O limite de 100 MB vale para as duas versões.

## Arquitetura

### Visão de componentes

- **`docker_gui.py`**:
  - `cp_out(id, path) -> (status, name, bytes)`, com `subprocess.Popen` e leitura em blocos até `MAX_CP + 1`, e `tarfile.open(fileobj=BytesIO(buf))` para o primeiro membro;
  - a rota em `do_GET` responde com `application/octet-stream` e `Content-Disposition: attachment; filename*=UTF-8''<nome>`.
  - O `send()` ganha um irmão `send_bytes(code, data, name)`.
- **`src-tauri/core/src/cp.rs`** (novo): `cp_out(ctx, id, path) -> Result<CpFile, Response>`, com o `tar` como dependência nova do núcleo.
  - O `router.rs` ganha a rota com o novo `Reply::File(CpFile)`.
  - O `bin/harness.rs` serve `Reply::File` com os mesmos cabeçalhos do Python.
  - O `api` da IPC devolve 404 para essa rota (o desktop usa o `cp_save`).
- **`src-tauri/src/ipc.rs`**: o comando `cp_save(id, path)`, que chama `stivo_core::cp::cp_out` e depois `app.dialog().file().set_file_name(name).blocking_save_file()` (numa task de bloqueio). Devolve `{saved: true}`, `{saved: false}` (a pessoa cancelou) ou um erro.
- **`src/transport.ts`**: o `Transport` ganha `cpOut(id, path, signal): Promise<CpResult>`.
  - Web: `fetch` com o header do token e `AbortSignal`; status 200 vira `blob()` com o nome do `Content-Disposition` e o `saveBlob`; outro status vira o JSON de erro.
  - Desktop: `invoke('cp_save')`. O `signal` só faz a página parar de esperar.
- **`src/app.ts`**:
  - item "Baixar arquivo…" no menu "⋯" do container (`more`, 491 a 494) e no menu do modal (1150 a 1156);
  - um `<dialog id="cp">` pequeno, com o campo do caminho, um `<datalist>` com os últimos caminhos, os botões Baixar e Cancelar, e o estado "Baixando…";
  - o `saveBlob(name, blob)` sai do `downloadLogs`, que passa a usá-lo.
- **`localStorage`**: `docker-gui-cp`, com até 5 caminhos por nome de container (por nome, porque o container recriado continua sendo "o mesmo"). Leitura e escrita em try/catch, como as outras chaves.

## Design de implementação

### Interfaces principais

```py
MAX_CP = 100 * 1024 * 1024
CP_PATH_RE = re.compile(r"/[^\x00]{0,4095}")    # absoluto, sem NUL, até 4 KB
def cp_out(cid: str, path: str) -> tuple[int, str, bytes | str]:  # (200, nome, dados) | (4xx/500, "", mensagem)
```

```rust
pub struct CpFile { pub name: String, pub data: Vec<u8> }
pub async fn cp_out(ctx: &Ctx, id: &str, path: &str) -> Result<CpFile, Response>;
pub enum Reply { Json(Response), Ndjson(BoxStream<'static, Value>), File(CpFile) }

#[tauri::command] async fn cp_save(app: AppHandle, state: State<'_, AppState>, id: String, path: String)
    -> Result<CpSaved, ApiReply>;
```

```ts
export type CpResult = {ok: true; saved: boolean; name: string} | {ok: false; status: number; error: string};
cpOut(id: string, path: string, signal: AbortSignal): Promise<CpResult>;
```

### Modelos de dado

- **Nome do arquivo**: o `basename` do caminho no container. A raiz `/` vira `root`. Uma pasta ganha `.tar`. O nome é saneado para o sistema de arquivos e para o cabeçalho: `/`, `\` e caracteres de controle viram `_`.
- **Erros**:
  - `400`: caminho inválido;
  - `404`: "não existe", a partir do stderr `Could not find the file` (Docker) ou `no such file or directory` (Podman);
  - `413`: "acima de 100 MB", com o `docker cp` pronto no corpo para a página mostrar;
  - `500`: outros, com o stderr.
  - Todos com o texto pelo `tr`.

### Endpoints de API

| Método | Path | Descrição |
|---|---|---|
| GET | `/api/cp/<id>?path=<abs>` | Arquivo (bytes) ou pasta (`.tar`) do container. Token pelo header, como as outras rotas: a rota **não** entra na lista de rotas que aceitam o token na query. Prazo: `ACTION_TIMEOUT` (120 s). |

## Pontos de integração

- **`docker cp -L <id>:<path> -`**: funciona com o container parado e com daemon remoto (o tar vem pelo CLI). O `-L` segue o link simbólico dentro do container (PRD, borda).
- **Podman**: o `podman cp <id>:<path> -` também escreve o tar no stdout. O `-L` não existe no Podman, que já segue links por padrão. A montagem dos argumentos tira a flag quando o CLI é o Podman (o `Ctx` já sabe qual é).
- **`tauri-plugin-dialog`**: usado só pelo Rust, sem permissão `dialog:*` para a página.

## Estratégia de teste

- **Unitário Python e Rust**, com o `Popen`/`Runner` falso devolvendo tars montados no teste:
  - arquivo vira os bytes e o nome;
  - pasta vira o tar e o `.tar`;
  - mais de 100 MB vira 413 e o processo é morto;
  - os stderr de "não existe" do Docker e do Podman viram 404;
  - caminho relativo, com NUL ou longo demais vira 400 sem executar;
  - nome saneado;
  - Podman sem `-L`.
- **Contrato**: só os casos que recusam antes de executar (`reads/cp-caminho-invalido.json`, com `calls: []`). A leitura binária fica com os unitários e o E2E, como os outros `Popen` (techspec do desktop).
- **E2E** (`tests/e2e/actions.spec.ts`): o docker falso ganha `cp`, que monta o tar com o `tarfile` a partir de um campo `files` por container. Casos:
  - baixar um arquivo de texto (o Playwright captura o `download` e confere o nome e o conteúdo);
  - baixar uma pasta como `.tar`;
  - caminho inexistente mostra a mensagem;
  - o caminho usado aparece no `datalist` na vez seguinte.
  - Roda nos dois backends (o harness serve o `Reply::File`).
- **Smoke do desktop**: o `cp_save` com o diálogo trocado por um caminho fixo (variável de ambiente só do binário de teste) e a conferência do arquivo gravado.

## Sequenciamento

1. O `cp_out` no Python e no Rust, com os unitários (o vermelho primeiro).
2. A rota, o `send_bytes`, o `Reply::File` e o harness.
3. O docker falso com `cp`.
4. Front: `cpOut` na web, `saveBlob`, o diálogo, o menu e o `localStorage`. E2E.
5. Desktop: plugin, `cp_save` e `cpOut` no `transport-desktop`. Smoke.

## Observabilidade

Nada de caminho nem de nome de container no log. `log::warn!` só para prazo estourado e falha ao gravar.

## Considerações técnicas

### Decisões principais

- **Ler até o limite e só então responder**, em vez de transmitir em stream. Com 100 MB de teto, a resposta sai com status certo (o 413 antes de qualquer byte) e o `Content-Length` exato, e o tar é aberto com o `tarfile`/`tar` sem truque de stream. Isso custa até 100 MB de RAM durante um download, o que é aceitável para um uso pontual.
- **Web por `fetch` e `Blob`, não por link direto com o token na query.** O link gravaria a URL com o token no histórico de downloads do navegador. O `fetch` mantém o token no header, como todas as outras rotas, e o limite de 100 MB cabe na memória da aba.
- **Uma implementação no núcleo, duas entregas.** O desktop usa a mesma `cp_out` e só troca o fim: grava pelo diálogo, sem passar os bytes pela IPC até a página e de volta.
- **Cancelar** na web aborta o `fetch`, e a conexão fechada faz o servidor matar o `docker cp` na próxima escrita. No desktop, a página para de esperar e descarta o resultado. O `docker cp` termina sozinho, limitado pelos 100 MB e pelos 120 s. *(ponytail: o cancelamento não mata o processo no desktop; se isso pesar, o `cp_save` ganha um id e um `cp_cancel`.)*
- **Dependências novas**: `tar` no núcleo Rust (o Python usa o `tarfile` da biblioteca padrão) e `tauri-plugin-dialog` no app. As duas com versão fixa.

### Riscos conhecidos

- **Arquivo esparso ou dispositivo** (`/dev/zero`): o `docker cp` recusa dispositivos; o esparso conta pelo tamanho no tar e cai no 413.
- **Caminho com `:`**: o `docker cp` divide `<id>:<path>` no primeiro `:`, e o id não tem `:`. O caminho passa inteiro.
- **Memória do desktop durante o download**: um pico de até ~200 MB (o tar e o conteúdo). Isso fica fora da meta de 150 MB ocioso, que mede o app parado.

### Conformidade com regras do projeto

- Só de dentro para fora. O host recebe o arquivo só pelo download do navegador ou pelo destino escolhido no diálogo.
- Caminho validado nos dois backends; o `id` passa pela regex de sempre; nenhum shell.
- Conteúdo do container nunca é interpretado: vai como `application/octet-stream` e `attachment`.
- `docker_gui.py` só com a biblioteca padrão (`tarfile` e `io`).

### Conformidade com skills disponíveis

- `tdd` (`cp_out` primeiro).
- `security-best-practices`: revisão da rota binária, do saneamento do nome e da capability.
- `feature-prints` do diálogo.

### Arquivos relevantes

- `docker_gui.py`: `do_GET` e `send` (576), mais o padrão de `Popen` do `compose_stream` (1033).
- `src-tauri/core/src/router.rs`, `src-tauri/core/src/bin/harness.rs` (62) e `src-tauri/core/Cargo.toml`.
- `src-tauri/src/ipc.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml` e `src-tauri/capabilities/main.json`.
- `src/transport.ts`, `src/transport-web.ts` e `src/transport-desktop.ts`.
- `src/app.ts`: `more` (491), o menu do modal (1150), `downloadLogs` (1550) e o export para `window` (1921).
- `src/page.html`.
- `tests/e2e/fake-docker/docker`, `tests/e2e/actions.spec.ts` e `tests/test_docker_gui.py`.
- Novo: `src-tauri/core/src/cp.rs`.

## Histórico

**2026-10-21**. Documento criado. O limite de 100 MB foi decidido aqui, e o PRD foi atualizado junto (RF3.1).
