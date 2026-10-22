# Techspec: Iniciar com o sistema

## Resumo executivo

Um módulo próprio do app desktop (`src-tauri/src/autostart.rs`) registra e remove o início automático pelo mecanismo de cada sistema:

- **Linux:** um arquivo `.desktop` em `$XDG_CONFIG_HOME/autostart/` (padrão `~/.config/autostart/`), com `TryExec` apontando para o binário. Quando o pacote é removido, a sessão ignora a entrada sozinha.
- **Windows:** um valor em `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, apagado na desinstalação por um hook do NSIS e por uma custom action do MSI.

O estado real é lido do sistema a cada `prefs_get` (não fica no `prefs.json`). O app iniciado com `--autostart` cria a janela invisível e vai direto para a bandeja.

## Arquitetura

### Visão de componentes

- **`src-tauri/src/autostart.rs`** (novo): `enabled()` e `set(on)`, com `#[cfg(target_os)]` para cada sistema.
- **`src-tauri/src/ipc.rs`**: o `PrefsView` ganha `autostart: bool` (lido por `autostart::enabled()`); o `Choice` do `prefs_set` ganha `autostart: bool`. Se o `set` falhar, a resposta é um erro com o motivo e nada mais é salvo (RF1.4).
- **`src-tauri/src/lib.rs`**:
  - `--autostart` em `std::env::args()` cria a janela com `.visible(false)`;
  - o callback do `single-instance` ignora uma segunda execução com `--autostart` (não traz a janela);
  - o `window-state` deixa de restaurar a visibilidade (`StateFlags::all() - VISIBLE`).
- **Front**: `src/page.html` ganha a caixa `#pref-autostart` na tela de preferências, junto das notificações. O `src/app.ts` (`openPrefs`/`savePrefs`) a lê e envia, e `src/transport.ts` acrescenta o campo aos tipos `DesktopPrefs` e `Prefs`.
- **Instaladores do Windows**:
  - NSIS: `src-tauri/windows/hooks.nsh` (`NSIS_HOOK_POSTUNINSTALL`, fora do `$UpdateMode`), em `bundle.windows.nsis.installerHooks`.
  - WiX: `src-tauri/windows/autostart.wxs` (custom action `reg delete … /f` com `Return="ignore"`, condicionada a `REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE`), em `bundle.windows.wix.fragmentPaths`. O fragmento entra no MSI pelo `Component` vazio `AutostartCleanup`, em `componentRefs`: o Tauri não tem `customActionRefs`.

## Design de implementação

### Interfaces principais

```rust
// src-tauri/src/autostart.rs
pub fn enabled() -> bool;                       // o arquivo / o valor existe e aponta para este executável
pub fn set(on: bool) -> std::io::Result<()>;    // idempotente; desligar o que não existe é Ok
const ARG: &str = "--autostart";
```

Arquivo no Linux (`io.github.martinsgabriel1956.Stivo.desktop`):

```ini
[Desktop Entry]
Type=Application
Name=Stivo
Exec="<current_exe>" --autostart
TryExec=<current_exe>
X-GNOME-Autostart-enabled=true
NoDisplay=true
```

O valor no Windows tem o nome `Stivo` e o conteúdo `"<current_exe>" --autostart`.

### Modelos de dado

- O `PrefsView` e o `Choice` ganham `autostart: bool`. Nada novo no `prefs.json`: a fonte da verdade é o sistema (RF1.3).

### Endpoints de API

Nenhum. Só comandos Tauri que já existem (`prefs_get` e `prefs_set`).

## Pontos de integração

- **XDG Autostart:** o `TryExec` faz a sessão ignorar a entrada quando o binário não existe. Isso vale para GNOME, KDE e XFCE, e é o que cumpre o RF3.1 no Linux, onde o pacote não pode mexer no home do usuário.
- **Registro do Windows:** `winreg` (`=0.56.0`, que já está no `Cargo.lock` pelo Tauri) só no alvo Windows.
- **Desinstalação:**
  - O NSIS do Tauri instala por usuário (`currentUser`), então o `HKCU` do hook é o do usuário certo.
  - No MSI (por máquina), a custom action roda com o usuário que desinstala. Se esse usuário não for o que ligou a opção, a entrada sobra; o Windows apenas não encontra o executável no login.

## Estratégia de teste

- **Unitário (Rust, Linux):** `set(true)` grava o arquivo com o `Exec` e o `TryExec` do executável atual em um `XDG_CONFIG_HOME` temporário; `enabled()` reflete o arquivo; `set(false)` apaga; apagar o arquivo por fora faz `enabled()` voltar `false`.
- **Unitário (front):** o `transport-desktop` envia o campo `autostart` no `prefs_set`.
- **Smoke do desktop** (`e2e/desktop-smoke.sh`), que dirige o app só pelo X (gravar e apagar o arquivo fica no teste unitário):
  - executar com `--autostart` não mostra janela (`xdotool search --onlyvisible` vazio) e o ícone/processo está de pé;
  - uma segunda execução com `--autostart` não mostra a janela, e uma sem o argumento mostra.
- **Windows:** item novo no checklist manual da release (no [techspec do desktop](../prd-desktop-tauri/techspec.md), "Estratégia de teste"): ligar, fazer logout e login, atualizar por cima (a opção continua), desinstalar (MSI e NSIS) e conferir que o valor `Run` sumiu.

## Sequenciamento

1. `autostart.rs` com os testes do Linux.
2. `--autostart` no `lib.rs` (janela invisível, single-instance e `window-state` sem `VISIBLE`).
3. `prefs_get`/`prefs_set` e a tela de preferências.
4. O ramo do Windows e os hooks do NSIS e do WiX.
5. Smoke e checklist.

## Observabilidade

`log::warn!` quando o `set` falha (o erro de IO, sem o caminho do home).

## Considerações técnicas

### Decisões principais

- **Módulo próprio, não o `tauri-plugin-autostart`.** O plugin (via `auto-launch`) não grava `TryExec` no Linux, então a entrada sobraria depois de desinstalar, contra o RF3.1. O módulo próprio tem umas 60 linhas e nenhuma dependência nova fora do `winreg`, que já vem pelo Tauri.
- **Estado lido do sistema, não do `prefs.json`.** Assim a tela mostra o real mesmo se a pessoa apagar a entrada pelo painel do GNOME ou pelo Gerenciador de Tarefas.
- **Janela criada invisível pelo argumento**, não escondida depois de aparecer, para não piscar no login.
- **`window-state` sem `VISIBLE`.** Com a flag, a visibilidade salva ao sair (pela bandeja, com a janela escondida) brigaria com o argumento.

### Riscos conhecidos

- **AppImage**: não é publicado (techspec do desktop), então o `current_exe` é sempre um caminho estável (`/usr/bin/stivo` ou o `Program Files`).
- **MSI por máquina com vários usuários**: a custom action limpa só o `HKCU` de quem desinstala (ver "Pontos de integração").
- **Daemon que sobe depois do app** (Docker Desktop no Windows): o app já mostra o estado de erro e volta sozinho; nada novo.

### Conformidade com regras do projeto

- Feature só do desktop, com o motivo registrado no PRD.
- Versão fixa no `Cargo.toml` (`winreg = "=0.56.0"`, só em `[target.'cfg(windows)'.dependencies]`).
- A tela de preferências segue o DESIGN.md (tokens, foco visível, teclado).

### Conformidade com skills disponíveis

- `tdd` nos testes do `autostart.rs`.
- `security-best-practices`: o caminho escrito vem do `current_exe`, nunca da página; o `Choice` só aceita um booleano.
- `feature-prints` da tela de preferências.

### Arquivos relevantes

- `src-tauri/src/lib.rs`: plugins (68 a 77) e `setup` (92 a 108).
- `src-tauri/src/ipc.rs`: `PrefsView` (145), `prefs_get` (160) e `prefs_set` (174).
- `src-tauri/src/prefs.rs`: `Choice` (69) e `validate` (79).
- `src-tauri/src/background.rs`: `show_main` e `on_close`.
- `src-tauri/tauri.conf.json`: `bundle.windows`.
- `src/page.html` (278 a 323), `src/app.ts` (1889 a 1919) e `src/transport.ts` (16 a 21).
- Novos: `src-tauri/src/autostart.rs`, `src-tauri/windows/hooks.nsh` e `src-tauri/windows/autostart.wxs`.

## Histórico

**2026-10-21**. Documento criado.

**2026-10-22**. Durante o sdd-tasks:
- O ramo do Windows do `autostart.rs` entra junto com o do Linux (mesmo módulo); os instaladores ficam numa task própria.
- O WiX do Tauri não tem `customActionRefs`: o fragmento ganha um `Component` vazio, referenciado em `componentRefs`, que traz o fragmento inteiro (com a custom action) para o MSI.
- Atualizar mantém a escolha (RF3.2): o hook do NSIS só apaga fora do `$UpdateMode`, e a custom action do MSI roda com `REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE`.
- O smoke não liga a opção pela IPC (ele dirige o app só pelo X): gravar e apagar o arquivo fica no teste unitário; o smoke cobre o `--autostart`.
- O checklist manual do Windows fica numa seção nova do `packaging/README.md` (revisto na implementação: ver a entrada seguinte).
- Se o `prefs_set` falhar, a caixa volta ao estado de quando a tela abriu: nenhum erro acontece depois de o início automático mudar.

**2026-10-22**. Reconciliação depois da implementação:
- O checklist manual do Windows foi para o checklist da release que já existia, no [techspec do desktop](../prd-desktop-tauri/techspec.md) (com entrada no Histórico de lá), e não para o `packaging/README.md`: o repositório já tinha esse lugar, e dois checklists se desencontrariam.
- O corpo deste documento passa a descrever o que os instaladores fazem (o `$UpdateMode`, o `NOT UPGRADINGPRODUCTCODE` e o `Component` do WiX) e o que o smoke cobre, no lugar de remeter só ao Histórico.
