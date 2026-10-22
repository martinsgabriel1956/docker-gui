# Techspec: Abrir a pasta do projeto compose

## Resumo executivo

Duas implementações pequenas, uma por versão, decididas no front pelo `T.desktop` e escondidas com daemon remoto (`REMOTE`):

- **Web:** "Copiar caminho da pasta" é só front: copia o `workingDir(c)` que a página já tem e já mostra. Não há rota nova.
- **Desktop:** "Abrir pasta" chama um comando Tauri novo, `open_dir(project, dir)`. O comando confere a pasta contra os labels com o `compose_project` do núcleo (um embrulho público do `compose_base`) (a mesma conferência do `up` e do `down`), recusa daemon remoto e pasta que não existe, e abre a pasta com o `tauri-plugin-opener`, chamado só pelo Rust. A página não ganha nenhuma permissão do plugin.

## Arquitetura

### Visão de componentes

- **`src/transport.ts`**: o `Transport` ganha `openDir?(project, dir): Promise<string | null>` (a mensagem de erro, ou `null`), que só existe no desktop, no estilo do `prefs.set`.
- **`src/transport-desktop.ts`**: `openDir` = `invoke('open_dir', {project, dir}).then(() => null, e => String(e))`.
- **`src/app.ts`**, no `groupHead`, menu "⋯" do projeto (`dirItem`, um grupo próprio antes do `down`), com a ação `projectDir(p)`:
  - com `REMOTE` ou sem `dir`, o item não aparece;
  - com `T.openDir`, o item é "Abrir pasta";
  - sem ele, é "Copiar caminho da pasta" (`navigator.clipboard.writeText(dir)` e o aviso "Caminho copiado").
  - O `title` do item é o caminho (RF1.5).
- **`src-tauri/src/ipc.rs`**: o comando `open_dir`, que:
  - recusa se o `where_` do contexto for remoto;
  - confere o par com `stivo_core::router::compose_project(ctx, project, dir)`, que embrulha o `compose_base` (`pub(crate)`, devolve o argv do compose);
  - confere `Path::new(dir).is_dir()`;
  - chama `app.opener().open_path(dir, None::<&str>)`.
- **`src-tauri/capabilities/main.json`**: acrescenta só `allow-open-dir`. Nenhuma permissão `opener:*` vai para a janela.
- **`src-tauri/Cargo.toml` e `lib.rs`**: `tauri-plugin-opener` com versão fixa e `.plugin(tauri_plugin_opener::init())`.

## Design de implementação

### Interfaces principais

```rust
#[tauri::command]
async fn open_dir(app: AppHandle, state: State<'_, AppState>, project: String, dir: String) -> Result<(), String>;
// Err(texto em pt ou en, escrito no próprio app): "O daemon é remoto…", "projeto compose não encontrado" (o 404 do
// compose_base, traduzido pelo núcleo), "A pasta não existe mais: <dir>" ou "Não consegui abrir a pasta: <dir>"
pub async fn compose_project(ctx: &Ctx, project: &str, dir: &str) -> Result<(), Response>;   // stivo_core::router
```

```ts
openDir?(project: string, dir: string): Promise<string | null>;
```

### Modelos de dado

Nenhum novo.

### Endpoints de API

Nenhum. Na web não há rota (só clipboard). No desktop é um comando da IPC fora do `api`, porque abrir algo no sistema não tem equivalente no contrato HTTP.

## Pontos de integração

- **`tauri-plugin-opener`**: o `open_path` usa o gerenciador de arquivos padrão (`xdg-open` / D-Bus FileManager1 no Linux e `ShellExecute` no Windows).
- **`compose_base`**: roda `ps -a --filter label=com.docker.compose.project` e exige que `[project, dir]` exista nos labels. É a garantia do RF2.1.

## Estratégia de teste

- **Unitário Rust** (núcleo): o `compose_project` com um `Runner` falso: o par dos labels passa; outra pasta ou outro projeto dá 404.
- **Unitário front** (`tests/transport-desktop.test.js`): o `openDir` chama o `open_dir` e devolve `null` ou a mensagem.
- **E2E web** (`tests/e2e/compose.spec.ts`): o menu do projeto tem "Copiar caminho da pasta", e o clipboard recebe o `working_dir` da fixture `shop()`. Com contexto remoto, o item não aparece. Roda nos dois backends; no harness, que serve a página web, o item também é o de copiar.
- **Desktop**: sem smoke. O `e2e/desktop-smoke.sh` dirige a janela só pelo X, e chegar ao item do menu por coordenada seria frágil. A chamada ao opener (a recusa do remoto e da pasta inexistente são poucas linhas em volta dela) entra no checklist manual da release, no Linux e no Windows (techspec do desktop).

## Sequenciamento

1. O `compose_project` no núcleo, com o teste.
2. O plugin, o comando `open_dir`, a capability e o `T.openDir`.
3. O item no menu nas duas versões, o E2E da web e o README.

## Observabilidade

`log::warn!` quando o opener falha, sem o caminho.

## Considerações técnicas

### Decisões principais

- **`tauri-plugin-opener` chamado só pelo Rust.** É o plugin oficial, que já trata cada sistema (caminhos com espaço, UNC). Não exportar as permissões dele para a página mantém o RF5.2 do desktop: só a validação do nosso comando decide o que abre.
- **A web copia, sem rota.** O caminho já está na página (vem dos labels na lista de containers). Copiá-lo não toca o host e não precisa de conferência no servidor.
- **Remoto é recusado nos dois lados**: o front esconde o item e o comando recusa, para o caso de a página estar velha depois de uma troca de contexto.

### Riscos conhecidos

- **Linux sem gerenciador de arquivos** (sessão mínima): o opener falha, e o aviso mostra o caminho para a pessoa abrir por conta própria.
- **Pasta em WSL vista do Windows** (`/home/...` de um daemon no WSL): o contexto não é remoto, mas o caminho não existe no Windows. Nesse caso cai no "A pasta não existe mais", com o caminho.

### Conformidade com regras do projeto

- A GUI não amplia o acesso ao host: só abre a pasta que os labels declaram, e nunca executa nada.
- Versão fixa do plugin no `Cargo.toml`, alinhada ao minor do Tauri (`~2.12`).
- Capability mínima (só o comando novo).

### Conformidade com skills disponíveis

- `security-best-practices`: revisão do comando e da capability.
- `feature-prints` do menu.

### Arquivos relevantes

- `src/app.ts`: `groupHead` (`dirItem`), `projectDir` (antes do `svcs`) e o export para `window`.
- `src/transport.ts` e `src/transport-desktop.ts` (`openDir`).
- `src-tauri/src/ipc.rs` (`open_dir`), `src-tauri/src/lib.rs` (plugin e handler), `src-tauri/build.rs` (`COMMANDS`), `src-tauri/Cargo.toml`/`Cargo.lock` e `src-tauri/capabilities/main.json` (e o que o build gera em `gen/schemas/` e `permissions/autogenerated/`).
- `src-tauri/core/src/router.rs`: `compose_project` (com teste), junto do `compose_base`; `src-tauri/core/src/page.rs` (`where_`).
- `README.md` e o checklist manual no techspec do desktop.
- `tests/e2e/compose.spec.ts` e `tests/transport-desktop.test.js`.

## Histórico

**2026-10-21**. Documento criado.

**2026-10-21**. Durante o sdd-tasks:
- A conferência dos labels vira `stivo_core::router::compose_project` (público, com teste unitário), em vez de testar o `open_dir` com o opener injetado.
- O smoke do desktop não ganha o caso da pasta: ele dirige a janela só pelo X, e o item do menu por coordenada seria frágil. A chamada ao opener entra no checklist manual da release.
- As mensagens do `open_dir` ficam no app, em pt e en, como as do `prefs.rs`.

**2026-10-22**. Reconciliação do sdd-review:
- O documento passa a descrever o que foi construído: o `compose_project`, o `openDir` devolvendo a mensagem ou `null` (como o `prefs.set`), as mensagens do `open_dir` escritas no app, os testes e a falta de smoke.
- O `log::warn!` da falha do opener deixou de imprimir o erro dele, que traz o caminho (a regra de log do projeto e a seção de observabilidade deste documento).
