# Tasks: Iniciar com o sistema

Lote em 5 tasks, nesta ordem: módulo `autostart` → `--autostart` no app → preferências (IPC e tela) → instaladores do Windows → smoke.

**Ajustes ao techspec, decididos aqui** (o techspec é atualizado junto, no Histórico):

1. **O ramo do Windows do `autostart.rs` entra na T1**, junto com o do Linux: é o mesmo módulo, com `#[cfg]`. A T4 fica só com os instaladores e o checklist. Ele não compila nesta máquina; quem confere é o job do Windows no CI (`clippy` e `tauri build`).
2. **O WiX do Tauri não tem `customActionRefs`** (só `componentRefs`, `componentGroupRefs`, `featureRefs`…). O fragmento ganha um `Component` vazio, referenciado em `componentRefs`, e referenciar qualquer elemento de um `Fragment` traz o fragmento inteiro para o MSI, com a `CustomAction` e a linha dela no `InstallExecuteSequence`.
3. **Atualizar não pode apagar a escolha (RF3.2).** O techspec não previa isto:
   - o hook do NSIS só apaga o valor fora do `$UpdateMode` (o Tauri desinstala a versão velha com `/UPDATE`);
   - a custom action do MSI roda com `REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE`.
4. **O smoke não liga a opção pela IPC.** O `e2e/desktop-smoke.sh` dirige o app só pelo X, sem chamar comando da IPC. Gravar e apagar o arquivo fica no teste unitário da T1; o smoke cobre o `--autostart` (janela escondida, bandeja de pé, instância única).
5. **Onde fica o checklist manual do Windows:** numa seção nova do `packaging/README.md`. O repositório não tinha um.
6. **RF1.4 na tela:** se o `prefs_set` falhar, a caixa volta ao estado de quando a tela abriu (`defaultChecked`). Qualquer erro do `prefs_set` acontece antes de o início automático mudar, ou é a própria recusa dele; então o estado de antes é o real, sem uma segunda chamada ao `prefs_get`.

---

## T1. Módulo `autostart` (Linux e Windows)

**Escopo:** `src-tauri/src/autostart.rs` com `enabled()`, `set(on)` e `ARG`, o `winreg` só no alvo Windows e o teste do Linux.

**Contexto:** techspec, "Visão de componentes", "Interfaces principais" e "Decisões principais" (módulo próprio em vez do `tauri-plugin-autostart`, por causa do `TryExec`). PRD, RF1.3 (o estado é o do sistema), RF2.1 (sessão do usuário, sem administrador) e RF3.1 no Linux (o `TryExec` faz a sessão ignorar a entrada depois de desinstalar).

**Skills a carregar:** `tdd` (o teste do Linux primeiro) e `security-best-practices` (o caminho gravado vem do `current_exe`, nunca da página).

**Regras a respeitar:**
- Versão fixa no `Cargo.toml` (`winreg = "=0.56.0"`, a que já está no `Cargo.lock` pelo Tauri), só em `[target.'cfg(windows)'.dependencies]`.
- `cargo fmt` (o `rustfmt.toml` do projeto) e `clippy -D warnings`.

**Steps:**

1. Teste primeiro, no próprio módulo. Um teste só, porque ele mexe no `XDG_CONFIG_HOME` do processo e testes em paralelo não podem disputar a variável:

```rust
#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn linux_entry_follows_the_file() {
        let dir = std::env::temp_dir().join(format!("stivo-autostart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // SAFETY: o único teste do crate que lê ou escreve esta variável
        unsafe { std::env::set_var("XDG_CONFIG_HOME", &dir) };
        let file = dir.join("autostart/io.github.martinsgabriel1956.Stivo.desktop");
        assert!(!enabled());
        set(false).unwrap(); // desligar o que não existe é Ok
        set(true).unwrap();
        let exe = std::env::current_exe().unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains(&format!("Exec=\"{}\" --autostart\n", exe.display())));
        assert!(text.contains(&format!("TryExec={}\n", exe.display())));
        assert!(enabled());
        std::fs::remove_file(&file).unwrap(); // apagado por fora (painel do GNOME): a tela mostra desligado
        assert!(!enabled());
        set(true).unwrap();
        set(false).unwrap();
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

2. O módulo. A entrada vale só se for exatamente a que o app grava: desligada pelo GNOME (`X-GNOME-Autostart-enabled=false`) ou apontando para outro executável conta como desligada (RF1.3):

```rust
// Iniciar com o sistema: o mecanismo de login de cada sistema, na sessão do usuário e sem administrador. O estado é o
// do sistema, lido a cada vez (a pessoa pode apagar a entrada por fora); nada vai para o prefs.json
use std::io;

/// o login abre o app com este argumento: a janela nasce escondida, direto na bandeja
pub const ARG: &str = "--autostart";

/// desligar o que não existe não é erro
fn absent_ok(r: io::Result<()>) -> io::Result<()> {
    match r {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

// Linux: XDG Autostart. O TryExec faz a sessão ignorar a entrada quando o pacote é removido (RF3.1)
#[cfg(target_os = "linux")]
fn file() -> Option<std::path::PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|d| !d.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".config")))?;
    Some(config.join("autostart/io.github.martinsgabriel1956.Stivo.desktop"))
}

// ponytail: o caminho vai sem o escape do Exec (aspas, $, crase); o current_exe é /usr/bin/stivo nos pacotes
#[cfg(target_os = "linux")]
fn entry() -> io::Result<String> {
    let exe = std::env::current_exe()?;
    let exe = exe.display();
    Ok(format!(
        "[Desktop Entry]\nType=Application\nName=Stivo\nExec=\"{exe}\" {ARG}\nTryExec={exe}\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n"
    ))
}

#[cfg(target_os = "linux")]
pub fn enabled() -> bool {
    let (Some(f), Ok(want)) = (file(), entry()) else { return false };
    std::fs::read_to_string(f).is_ok_and(|have| have == want)
}

#[cfg(target_os = "linux")]
pub fn set(on: bool) -> io::Result<()> {
    let f = file().ok_or_else(|| io::Error::other("sem HOME"))?;
    if !on {
        return absent_ok(std::fs::remove_file(f));
    }
    std::fs::create_dir_all(f.parent().expect("autostart/"))?;
    std::fs::write(f, entry()?)
}

// Windows: o valor Stivo em HKCU\...\Run, apagado na desinstalação pelos instaladores (windows/hooks.nsh e
// windows/autostart.wxs)
#[cfg(windows)]
const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
fn line() -> io::Result<String> {
    Ok(format!("\"{}\" {ARG}", std::env::current_exe()?.display()))
}

#[cfg(windows)]
pub fn enabled() -> bool {
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let have = hkcu.open_subkey(RUN).and_then(|k| k.get_value::<String, _>("Stivo"));
    matches!((have, line()), (Ok(have), Ok(want)) if have == want)
}

#[cfg(windows)]
pub fn set(on: bool) -> io::Result<()> {
    let (run, _) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).create_subkey(RUN)?;
    if on { run.set_value("Stivo", &line()?) } else { absent_ok(run.delete_value("Stivo")) }
}
```

3. `mod autostart;` no `lib.rs` e, no `Cargo.toml`:

```toml
[target.'cfg(windows)'.dependencies]
# o "Iniciar com o sistema" no HKCU\...\Run: a mesma versão que o Tauri já traz
winreg = "=0.56.0"
```

Até a T3 usar o módulo, o `clippy` reclama de código morto: a T1 entra com `#[allow(dead_code)]` no `mod autostart;`, e a T3 tira.

**Plano de teste:** `cargo test -p stivo autostart`, `cargo fmt --check` e `cargo clippy -p stivo --all-targets -- -D warnings` verdes no Linux. O ramo do Windows fica para o job do Windows no CI.

---

## T2. `--autostart`: janela escondida, instância única e `window-state` sem `VISIBLE`

**Escopo:** com `--autostart`, a janela nasce invisível. Uma segunda execução com o argumento não traz a janela, e o `window-state` deixa de salvar e restaurar a visibilidade.

**Contexto:** techspec, "Visão de componentes" (`lib.rs`) e "Decisões principais" (criar invisível em vez de esconder depois, para não piscar no login; sem `VISIBLE` para a visibilidade salva não brigar com o argumento). PRD, RF2.2 (direto na bandeja, sem o aviso da primeira vez que fecha), RF2.3 (pelo menu do sistema continua abrindo a janela) e a borda da sessão restaurada (uma instância só).

**Skills a carregar:** nenhuma específica.

**Regras a respeitar:**
- `clippy -D warnings`.
- O aviso "continua na bandeja" sai só no `on_close`; a janela que nasce escondida não passa por ele, então o RF2.2 já vale sem mudança no `background.rs`.

**Steps:**

```rust
pub fn run() {
    // aberto pelo login (autostart.rs): direto na bandeja, sem janela (PRD do iniciar com o sistema, RF2.2)
    let tray_only = std::env::args().any(|a| a == autostart::ARG);
    tauri::Builder::default()
        // abrir o Stivo de novo traz a janela que já existe (e o clique no toast do Windows também passa por aqui);
        // um login de novo com o app aberto (sessão restaurada) não traz
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !argv.iter().any(|a| a == autostart::ARG) {
                background::show_main(app);
            }
        }))
        // sem VISIBLE: quem decide se a janela aparece é o --autostart, não como ela estava ao sair
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
                .build(),
        )
        // ...
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(page::url()))
                .title("Stivo")
                .visible(!tray_only)
                // ...
```

Com `use tauri_plugin_window_state::StateFlags;`.

**Plano de teste:**
- `cargo build -p stivo` e `clippy` verdes.
- À mão, num D-Bus próprio (`dbus-run-session`, por causa do Stivo aberto nesta máquina):
  - `stivo --autostart` não mostra janela e a bandeja recebe a contagem (`bandeja:` no log);
  - uma segunda execução com `--autostart` continua sem janela;
  - uma execução sem o argumento traz a janela.
- O mesmo vira automático na T5.

---

## T3. Preferências: `prefs_get`/`prefs_set` e a caixa na tela

**Escopo:** o `PrefsView` e o `Choice` ganham `autostart`; o `prefs_set` liga e desliga antes de salvar o resto; a tela ganha a caixa "Iniciar com o sistema". Junto: o tipo no `transport.ts`, o teste do `transport-desktop`, o inglês no `en.json` e a linha no README.

**Contexto:** techspec, "Visão de componentes" (`ipc.rs` e Front) e "Modelos de dado" (nada novo no `prefs.json`). PRD, RF1.1 (desligada por padrão), RF1.2 (vale na hora), RF1.3 (estado real), RF1.4 (recusa volta para desligada, com o motivo) e "Experiência do usuário":
- junto das notificações;
- o texto da opção e a explicação;
- o aviso de quem não tem bandeja no GNOME.

**Skills a carregar:**
- `impeccable` (a caixa nova segue o DESIGN.md: a mesma forma da de notificações, foco visível, `aria-describedby` na explicação);
- `security-best-practices` (o `Choice` só aceita booleano; o erro mostrado não traz caminho do home);
- `feature-prints` (o print da tela de preferências, se você quiser na PR).

**Regras a respeitar:**
- Toda frase visível do `page.html` tem tradução no `src/en.json` (`tests/test_i18n.py`), e a mensagem de erro do Rust vem em pt e en, como o `open_dir`.
- `log::warn!` sem caminho (techspec, "Observabilidade").
- Feature só do desktop: a caixa fica no `#prefs`, que já só aparece com `T.prefs`.

**Steps:**

1. `prefs.rs`: o `Choice` ganha `pub autostart: bool` (e o teste `validate_only_what_the_screen_offers` passa `autostart: false`). Não há o que validar: é um booleano.

2. `ipc.rs`:

```rust
#[derive(Serialize)]
pub struct PrefsView {
    // ...
    notifications: bool,
    /// lido do sistema a cada vez, não do prefs.json (RF1.3)
    autostart: bool,
    contexts: Vec<String>,
}
// prefs_get: autostart: crate::autostart::enabled(),
```

No `prefs_set`, logo depois do `validate` e antes de mexer no `state.prefs`. A recusa volta como erro e nada mais é salvo (RF1.4):

```rust
    if prefs.autostart != crate::autostart::enabled() {
        crate::autostart::set(prefs.autostart).map_err(|e| {
            log::warn!("iniciar com o sistema: {}", e.kind());
            let (pt, en_) = ("O sistema recusou o início automático:", "The system refused to start Stivo at login:");
            format!("{} {}", if en { en_ } else { pt }, e.kind())
        })?;
    }
```

(O `e.kind()` em vez do `e` inteiro: o motivo, "permission denied", sem chance de trazer o caminho.)

3. `lib.rs`: sai o `#[allow(dead_code)]` do `mod autostart;`.

4. `transport.ts`:

```ts
export interface Prefs { cli: string | null; context: string | null; lang: string | null; notifications: boolean; autostart: boolean }
```

5. `page.html`, logo abaixo da caixa de notificações:

```html
      <div>
        <label class="flex items-start gap-2 w-fit coarse:py-2 cursor-pointer">
          <input id="pref-autostart" type="checkbox" aria-describedby="pref-autostart-hint" class="mt-0.5 size-4 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <span>Iniciar com o sistema</span>
        </label>
        <p id="pref-autostart-hint" class="ml-6 max-w-[70ch] text-xs text-muted">Abre na bandeja ao entrar na sua conta. No GNOME sem a extensão AppIndicator, ele roda sem ícone visível.</p>
      </div>
```

6. `app.ts`. No `openPrefs`:

```ts
  const auto = $<HTMLInputElement>('#pref-autostart');
  auto.checked = auto.defaultChecked = p.autostart;  // defaultChecked: o estado real, para voltar se salvar falhar
```

No `savePrefs`, o campo no `set` e a volta no erro:

```ts
  const auto = $<HTMLInputElement>('#pref-autostart');
  const err = await T.prefs!.set({cli: v('cli'), context: v('cli') === 'podman' ? null : v('context'), lang: v('lang'),
                                  notifications: $<HTMLInputElement>('#pref-notify').checked, autostart: auto.checked});
  go.removeAttribute('aria-disabled');
  // com erro nada mudou (nem o início automático): a caixa volta ao que o sistema tem (RF1.4)
  if (err) { $('#prefs-msg').textContent = err; auto.checked = auto.defaultChecked; }
```

7. `en.json`: as duas frases novas do `page.html`.

8. `tests/transport-desktop.test.js`:

```js
test('prefs: set manda o autostart junto e devolve o erro como texto', async () => {
  onInvoke = () => undefined;
  const p = {cli: null, context: null, lang: null, notifications: true, autostart: true};
  assert.equal(await T.prefs.set(p), null);
  assert.deepEqual(calls.at(-1), ['prefs_set', {prefs: p}]);
  onInvoke = () => { throw 'O sistema recusou o início automático: permission denied'; };
  assert.equal(await T.prefs.set(p), 'O sistema recusou o início automático: permission denied');
});
```

9. README, na linha das **Preferências** do desktop: "…idioma, notificações e iniciar com o sistema (abre na bandeja ao entrar na conta)".

**Plano de teste:**
- `cargo test -p stivo` e `clippy` verdes;
- `node --test tests/transport-desktop.test.js`;
- `python -m unittest tests.test_i18n`;
- `python build.py --desktop` sem erro de tipo.
- À mão, no app de debug (`dbus-run-session`, `XDG_CONFIG_HOME` temporário):
  - ligar cria o arquivo e desligar apaga;
  - apagar o arquivo por fora e reabrir as preferências mostra desligado;
  - com `autostart/` sem permissão de escrita, ligar mostra o aviso e a caixa volta para desligada.

---

## T4. Instaladores do Windows: apagar o `Run` na desinstalação

**Escopo:** hook do NSIS e fragmento do WiX que apagam o valor `Stivo` do `HKCU\...\Run` ao desinstalar (não ao atualizar), ligados no `tauri.conf.json`, e o checklist manual no `packaging/README.md`.

**Contexto:** techspec, "Visão de componentes" (instaladores do Windows) e "Pontos de integração" (o NSIS é por usuário; o MSI apaga o `HKCU` de quem desinstala). PRD, RF3.1 (desinstalar remove) e RF3.2 (atualizar mantém). Ajustes 2 e 3 do topo.

**Skills a carregar:** nenhuma específica.

**Regras a respeitar:** sem privilégio de administrador para o app (o `reg delete` dos instaladores é do usuário, no `HKCU`).

**Steps:**

1. `src-tauri/windows/hooks.nsh`:

```nsh
; Iniciar com o sistema (src-tauri/src/autostart.rs): desinstalar apaga o início automático; atualizar (o Tauri
; desinstala a versão velha com /UPDATE) mantém a escolha
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Stivo"
  ${EndIf}
!macroend
```

2. `src-tauri/windows/autostart.wxs`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- Iniciar com o sistema (src-tauri/src/autostart.rs): desinstalar apaga o valor Stivo do HKCU\...\Run de quem
     desinstala; atualizar (UPGRADINGPRODUCTCODE) mantém. O Component vazio existe só para o tauri.conf.json
     referenciar (componentRefs), o que traz o fragmento inteiro para o MSI -->
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Fragment>
    <DirectoryRef Id="TARGETDIR">
      <Component Id="AutostartCleanup" Guid="5d6c0f3e-2b8a-4a51-9a3e-7c1f4e2d9b60" KeyPath="yes" />
    </DirectoryRef>
    <CustomAction Id="RemoveAutostart" Directory="TARGETDIR" Execute="immediate" Impersonate="yes" Return="ignore"
      ExeCommand='"[SystemFolder]reg.exe" delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v Stivo /f' />
    <InstallExecuteSequence>
      <Custom Action="RemoveAutostart" After="InstallFinalize">REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE</Custom>
    </InstallExecuteSequence>
  </Fragment>
</Wix>
```

3. `tauri.conf.json`, em `bundle`:

```json
    "windows": {
      "nsis": { "installerHooks": "windows/hooks.nsh" },
      "wix": { "fragmentPaths": ["windows/autostart.wxs"], "componentRefs": ["AutostartCleanup"] }
    }
```

4. `packaging/README.md`, seção nova **Checklist manual do Windows (a cada release)**, com os itens:
   - instalar o `.exe`, ligar "Iniciar com o sistema", sair da conta e entrar: o Stivo está na bandeja, sem janela;
   - instalar a versão nova por cima: a opção continua ligada;
   - desinstalar: o valor `Stivo` sumiu de `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (`reg query`);
   - o mesmo com o `.msi`.

**Plano de teste:**
- `tauri.conf.json` válido no schema: `npx tauri build --bundles deb` no Linux lê a config inteira.
- O NSIS e o WiX só montam no job do Windows do CI (`tauri build --bundles msi,nsis`), que fica como a verificação deles.
- O comportamento real é o checklist manual.

---

## T5. Smoke do desktop: o `--autostart`

**Escopo:** o `e2e/desktop-smoke.sh` ganha uma quinta parte: o app aberto com `--autostart` fica sem janela e com a bandeja de pé; a segunda execução com o argumento continua sem janela; sem o argumento, a janela vem.

**Contexto:** techspec, "Estratégia de teste" (smoke do desktop), com o ajuste 4 do topo. PRD, RF2.2, RF2.3 e a borda da sessão restaurada.

**Skills a carregar:** nenhuma específica.

**Regras a respeitar:** o smoke roda num X e num D-Bus próprios; nesta máquina, `dbus-run-session` (o script já reentra sozinho).

**Steps:** no fim do script, antes do "tudo certo", e no comentário do topo um item 5:

```bash
# 5. aberto pelo login (--autostart): sem janela, com a bandeja; o login de novo não traz a janela, abrir pelo menu traz
kill "$app"; wait "$app" 2>/dev/null || true
run --autostart >"$work/auto.log" 2>&1 & app=$!; pids+=($app)
wait_for 15 grep -q "bandeja: 1" "$work/auto.log" || fail "aberto com --autostart, a página não mandou a contagem"
visible && fail "aberto com --autostart, a janela apareceu"
run --autostart >>"$work/auto.log" 2>&1 || true
sleep 1
visible && fail "a segunda execução com --autostart trouxe a janela"
[ "$(pgrep -fc "^$bin")" -eq 1 ] || fail "ficou mais de um processo do Stivo"
run >>"$work/auto.log" 2>&1 || true
wait_for 10 visible || fail "abrir sem --autostart não trouxe a janela"
echo "ok: --autostart abre só na bandeja, e abrir pelo menu traz a janela"
```

(O `fail` mostra o `app.log`; esta parte grava no `auto.log`, então o `fail` passa a mostrar os dois.)

**Plano de teste:** `cargo build -p stivo` e depois `e2e/desktop-smoke.sh` verde, inteiro (as cinco partes).
