# Techspec: Abrir a pasta do projeto compose

## Resumo executivo

Duas implementações pequenas, uma por versão, decididas no front pelo `T.desktop` e escondidas com daemon remoto (`REMOTE`):

- **Web:** "Copiar caminho da pasta" é só front: copia o `workingDir(c)` que a página já tem e já mostra. Não há rota nova.
- **Desktop:** "Abrir pasta" chama um comando Tauri novo, `open_dir(project, dir)`. O comando confere a pasta contra os labels com o `compose_base` do núcleo (a mesma conferência do `up` e do `down`), recusa daemon remoto e pasta que não existe, e abre a pasta com o `tauri-plugin-opener`, chamado só pelo Rust. A página não ganha nenhuma permissão do plugin.

## Arquitetura

### Visão de componentes

- **`src/transport.ts`**: o `Transport` ganha `openDir?(project, dir): Promise<{ok: true} | {ok: false; error: string}>`, que só existe no desktop.
- **`src/transport-desktop.ts`**: `openDir` = `invoke('open_dir', {project, dir})`.
- **`src/app.ts`**, no `groupHead`, menu "⋯" do projeto (`groups`, linhas 605 a 607):
  - com `REMOTE` ou sem `dir`, o item não aparece;
  - com `T.openDir`, o item é "Abrir pasta";
  - sem ele, é "Copiar caminho da pasta" (`navigator.clipboard.writeText(dir)` e o aviso "Caminho copiado").
  - O `title` do item é o caminho (RF1.5).
- **`src-tauri/src/ipc.rs`**: o comando `open_dir`, que:
  - recusa se o `where_` do contexto for remoto;
  - confere o par com `stivo_core::router::compose_base(ctx, project, dir, None)` (hoje privado; passa a `pub(crate)` com um wrapper público mínimo);
  - confere `Path::new(dir).is_dir()`;
  - chama `app.opener().open_path(dir, None::<&str>)`.
- **`src-tauri/capabilities/main.json`**: acrescenta só `allow-open-dir`. Nenhuma permissão `opener:*` vai para a janela.
- **`src-tauri/Cargo.toml` e `lib.rs`**: `tauri-plugin-opener` com versão fixa e `.plugin(tauri_plugin_opener::init())`.

## Design de implementação

### Interfaces principais

```rust
#[tauri::command]
async fn open_dir(app: AppHandle, state: State<'_, AppState>, project: String, dir: String) -> Result<(), String>;
// Err(texto traduzido): "daemon remoto", "projeto compose não encontrado" (o 404 do compose_base),
// "A pasta não existe mais: <dir>", ou o erro do opener
```

```ts
openDir?(project: string, dir: string): Promise<{ok: true} | {ok: false; error: string}>;
```

### Modelos de dado

Nenhum novo.

### Endpoints de API

Nenhum. Na web não há rota (só clipboard). No desktop é um comando da IPC fora do `api`, porque abrir algo no sistema não tem equivalente no contrato HTTP.

## Pontos de integração

- **`tauri-plugin-opener`**: o `open_path` usa o gerenciador de arquivos padrão (`xdg-open` / D-Bus FileManager1 no Linux e `ShellExecute` no Windows).
- **`compose_base`**: roda `ps -a --filter label=com.docker.compose.project` e exige que `[project, dir]` exista nos labels. É a garantia do RF2.1.

## Estratégia de teste

- **Unitário Rust**: a validação do `open_dir`, com o opener trocado por uma função injetada. Casos: remoto é recusado; par que não está nos labels é recusado sem chamar o opener; pasta inexistente é recusada; caso feliz chama o opener com o `dir` exato.
- **E2E web** (`tests/e2e/compose.spec.ts`): o menu do projeto tem "Copiar caminho da pasta", e o clipboard recebe o `working_dir` da fixture `shop()`. Com contexto remoto, o item não aparece. Roda nos dois backends; no harness, que serve a página web, o item também é o de copiar.
- **Smoke do desktop**: troca o opener por um script falso (`$PATH` com um `xdg-open` que grava o argumento) e confere o argumento depois do clique pela IPC.

## Sequenciamento

1. O item de copiar na web (só front) e o E2E.
2. O plugin, o comando `open_dir` com os testes e a capability.
3. O `T.openDir` e o item do desktop.
4. Smoke.

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

- `src/app.ts`: `groupHead` (580 a 625), `REMOTE` (266) e `copyExec` (811, como modelo).
- `src/transport.ts` e `src/transport-desktop.ts`.
- `src-tauri/src/ipc.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml` e `src-tauri/capabilities/main.json`.
- `src-tauri/core/src/router.rs`: `compose_base` (430 a 459) e `src-tauri/core/src/page.rs` (`where_`).
- `tests/e2e/compose.spec.ts` e `e2e/desktop-smoke.sh`.

## Histórico

**2026-10-21**. Documento criado.
