# Tasks: Abrir a pasta do projeto compose

Lote em 3 tasks, nesta ordem: conferência no núcleo → comando do desktop → menu nas duas versões (com E2E e README).

**Ajustes ao techspec, decididos aqui** (o techspec é atualizado junto, no Histórico):

1. **A conferência dos labels vira uma função pública do núcleo**, `stivo_core::router::compose_project(ctx, project, dir)`, com teste unitário. Ela embrulha o `compose_base`, que é `pub(crate)` e devolve o argv. O techspec previa testar o comando `open_dir` com o opener injetado.
2. **O smoke do desktop não ganha o caso da pasta.** O `e2e/desktop-smoke.sh` dirige a janela só pelo X (xdotool), e chegar ao item do menu "⋯" por coordenada seria frágil. Ficam testados assim:
   - a conferência dos labels, no teste unitário do núcleo;
   - o item do menu, no E2E da versão web (o harness serve a página web, que copia);
   - a chamada ao opener (uma linha do plugin), num item novo do checklist manual da release, no Linux e no Windows.
3. **As mensagens do `open_dir` ficam no próprio app** (pt e en no código, como o `prefs.rs` faz com as dele), não na tabela do núcleo. Só o desktop as usa.

---

## T1. `compose_project` no núcleo

**Escopo:** função pública que confere se o par `{project, dir}` existe nos labels dos containers, com teste unitário.

**Contexto:** techspec, "Visão de componentes" e RF2.1 do PRD (a pasta é sempre a que os labels declaram). A regra é a do `up`/`down` (`compose_base`), reaproveitada sem duplicar.

**Skills a carregar:** `tdd`.

**Regras a respeitar:**
- `cargo fmt` e `clippy -D warnings`.
- Teste com um `Runner` falso, como o `Script` do `compose.rs`.

**Steps:**

1. Teste primeiro, num `#[cfg(test)] mod tests` em `router.rs`. É um runner que devolve o `ps` com as linhas de `COMPOSE_FORMAT`:

```rust
    struct Ps(&'static str);
    #[async_trait::async_trait]
    impl Runner for Ps {
        async fn run(&self, _: &[String], _: &[String], _: Duration) -> Result<Output, RunError> {
            Ok(Output { code: 0, stdout: self.0.into(), stderr: String::new() })
        }
        fn command(&self, _: &[String], _: &[String]) -> tokio::process::Command { unreachable!() }
    }
    #[tokio::test]
    async fn compose_project_only_what_the_labels_say() {
        let ctx = Ctx { cli: vec!["docker".into()], lang: Lang::Pt, runner: Arc::new(Ps("[\"shop\",\"/srv/shop\",\"\",\"api\"]\n")),
                        now: Arc::new(|| 0.0) };
        assert!(compose_project(&ctx, "shop", "/srv/shop").await.is_ok());
        assert_eq!(compose_project(&ctx, "shop", "/etc").await.unwrap_err().status, 404);
        assert_eq!(compose_project(&ctx, "outro", "/srv/shop").await.unwrap_err().status, 404);
    }
```

2. A função, junto do `compose_base`:

```rust
/// O par {project, dir} existe nos labels dos containers? (o "Abrir pasta" do desktop: abre só o que o compose declarou)
pub async fn compose_project(ctx: &Ctx, project: &str, dir: &str) -> Result<(), Response> {
    compose_base(ctx, project, dir, None).await.map(|_| ())
}
```

**Plano de teste:** `cargo test -p stivo-core`, `cargo fmt --check` e `clippy -p stivo-core -D warnings` verdes.

---

## T2. Comando `open_dir` no desktop, com o `tauri-plugin-opener`

**Escopo:** o comando `open_dir(project, dir)` recusa daemon remoto, confere os labels pelo `compose_project`, confere se a pasta existe e abre no gerenciador de arquivos. Junto:
- o plugin com versão fixa;
- o comando no `build.rs` e na capability, sem nenhuma permissão `opener:*` para a página;
- o `openDir` no `transport-desktop`.

**Contexto:** techspec, "Visão de componentes" e "Decisões principais" (o opener chamado só pelo Rust); PRD, RF1.2, RF1.4, RF2.1 e RF2.2.

**Skills a carregar:** `security-best-practices` (capability mínima; o caminho conferido antes de abrir).

**Regras a respeitar:**
- Versão fixa no `Cargo.toml` e `Cargo.lock` versionado (techspec do desktop).
- Só a janela main chama comandos (capability).
- `log::warn!` sem o caminho (privacidade).

**Steps:**

1. Dependência: `cargo add tauri-plugin-opener@2 --manifest-path src-tauri/Cargo.toml -p stivo`, depois fixar a versão exata resolvida (`=2.x.y`) no `Cargo.toml`. No `lib.rs`, `.plugin(tauri_plugin_opener::init())` junto dos outros.

2. `src-tauri/src/ipc.rs`:

```rust
/// "Abrir pasta" do projeto compose: só a pasta que os labels declaram (a mesma conferência do up e do down), só com
/// daemon local (com o remoto, a pasta está na outra máquina) e só pasta: o gerenciador de arquivos abre, nada executa.
/// Err: o texto para o aviso
#[tauri::command]
pub async fn open_dir(app: tauri::AppHandle, state: State<'_, AppState>, project: String, dir: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let ctx = state.ctx();
    let say = |pt: &str, en: &str| if ctx.lang == stivo_core::Lang::En { en } else { pt }.to_string();
    if stivo_core::page::where_(&ctx).await.2 {
        return Err(say("o daemon é remoto: a pasta fica na outra máquina", "the daemon is remote: the folder is on the other machine"));
    }
    stivo_core::router::compose_project(&ctx, &project, &dir).await.map_err(|r| r.body.as_str().unwrap_or_default().to_string())?;
    if !std::path::Path::new(&dir).is_dir() {
        return Err(format!("{} {dir}", say("A pasta não existe mais:", "The folder no longer exists:")));
    }
    app.opener().open_path(&dir, None::<&str>).map_err(|e| {
        log::warn!("abrir a pasta do projeto: {e}");
        format!("{} {dir}", say("Não consegui abrir a pasta:", "Could not open the folder:"))
    })
}
```

   No `lib.rs`, `ipc::open_dir` entra no `generate_handler!`; no `build.rs`, `"open_dir"` entra em `COMMANDS`; no `capabilities/main.json`, `"allow-open-dir"`.

3. `src/transport.ts`: o `Transport` ganha

```ts
  // "Abrir pasta" do projeto compose: só no desktop (a web copia o caminho). A mensagem de erro, ou null
  openDir?(project: string, dir: string): Promise<string | null>;
```

   `src/transport-desktop.ts`: `openDir: (project, dir) => invoke('open_dir', {project, dir}).then(() => null, e => String(e))`.

   `tests/transport-desktop.test.js`: o `openDir` chama o `invoke` com o comando e os argumentos, e devolve `null` ou a mensagem.

**Plano de teste:**
- `cargo build -p stivo`, `cargo clippy -p stivo --all-targets -D warnings` e `cargo test -p stivo` verdes.
- `npm run test:js` e `npx tsc -p .` verdes.

---

## T3. O item no menu do projeto, nas duas versões; E2E e README

**Escopo:** o menu "⋯" do projeto ganha "Abrir pasta" (desktop) ou "Copiar caminho da pasta" (web), com o caminho no `title`. Nenhum dos dois aparece com daemon remoto ou sem pasta. Vem com o E2E da versão web nos dois backends e a linha no README.

**Contexto:** PRD, RF1.1 a RF1.5; techspec, "Visão de componentes" (front).

**Skills a carregar:** `frontend-design:frontend-design` (o item no padrão do `MENU_ITEM`).

**Regras a respeitar:**
- `esc` no caminho.
- Handler no `Object.assign(window, …)`.
- Textos no `en.json`.
- `build.py` depois.
- Chrome do sistema no E2E.

**Steps:**

1. `src/app.ts`, no `groupHead`, um grupo próprio antes do `down`:

```ts
  // a pasta do projeto: o desktop abre no gerenciador de arquivos, a web copia o caminho (pode estar por SSH ou no
  // celular). Com daemon remoto a pasta é da outra máquina, então nenhum dos dois
  const dirItem = dir && !REMOTE ? `<button data-id="stack-${ek}" data-a="m-dir" data-p="${ek}" title="${esc(dir)}"
      onclick="menuPick(this); projectDir(this.dataset.p)" class="${MENU_ITEM} text-fg">${T.openDir ? t`Abrir pasta` : t`Copiar caminho da pasta`}</button>` : '';
```

   Na lista `groups`, o `dirItem` entra antes do `down`.

2. A ação:

```ts
async function projectDir(p: string) {
  const c = data.find(c => project(c) === p), dir = c && workingDir(c);
  if (!dir) return;
  if (!T.openDir) {
    return navigator.clipboard.writeText(dir).then(() => toast(t`Caminho copiado: ${dir}`, true), () => toast(t`Não consegui copiar. O caminho é: ${dir}`));
  }
  const err = await T.openDir(p, dir);
  if (err) toast(err);
}
```

   `projectDir` entra no `Object.assign(window, …)`. No `en.json`: "Abrir pasta", "Copiar caminho da pasta", "Caminho copiado: {0}" e "Não consegui copiar. O caminho é: {0}".

3. `tests/e2e/compose.spec.ts`:
   - **Item e clipboard:** o menu do projeto `shop` (com o `working_dir` `/srv/shop`) tem "Copiar caminho da pasta" com `title="/srv/shop"`. Clicar põe `/srv/shop` no clipboard e mostra "Caminho copiado: /srv/shop".
   - **Daemon remoto:** com `context: {Name: 'prod', Host: 'tcp://10.0.0.5:2376'}`, o item não aparece.
   - Nos dois backends (o harness serve a página web, então o item é o de copiar).

4. README, na linha do compose (menu "⋯" do projeto): "Abrir pasta" no desktop e "Copiar caminho da pasta" na web; nenhum dos dois com daemon remoto. No checklist manual da release do desktop, se ele estiver no README ou no techspec do desktop, entra "Abrir pasta abre o gerenciador de arquivos (Linux e Windows)".

5. `python3 build.py --css`; a suíte E2E inteira nos dois backends.

**Plano de teste:** `npx tsc -p .`, `npm run test:js`, `python -m unittest`, `build.py --check` e o E2E inteiro nos dois backends verdes.
