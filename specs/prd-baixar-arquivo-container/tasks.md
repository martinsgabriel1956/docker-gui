# Tasks: Baixar arquivo do container

Lote em 4 tasks, nesta ordem: backend Python → núcleo Rust (com o harness) → front e E2E (nos dois backends) → desktop.

**Ajustes ao techspec, decididos aqui** (o techspec é atualizado junto, no Histórico):

1. **O caminho é conferido por código, não pela regex `/[^\x00]{0,4095}`.** As duas versões conferem a mesma regra: começa com `/`, sem NUL, até 4096 caracteres. No Rust, uma classe Unicode repetida 4095 vezes passa do limite de tamanho do `regex`.
2. **O `docker cp` pronto do 413 é montado pela página, não pelo servidor.** O servidor só tem o ID; a página tem o nome do container, o caminho e o CLI (`data-cli`), como o "Copiar docker exec". O corpo do 413 é só a mensagem, uma string como os outros erros.
3. **O `saveBlob` fica no `transport-web.ts`**, que é quem baixa. O `downloadLogs` continua como está: o `app.ts` não alcança o `transport-web` (o `#transport` é um ou outro), e três linhas repetidas custam menos que outro módulo.
4. **Cancelar na web não mata o `docker cp` na hora.** O servidor lê tudo antes de responder, então a conexão fechada só aparece na escrita. Quem limita o processo são os 100 MB e os 120 s, como no desktop. A escrita numa conexão que fechou é ignorada.
5. **O smoke do desktop não ganha o `cp_save`.** Ele dirige o app só pelo X: chegar ao item do menu "⋯" por coordenada seria frágil, e trocar o diálogo por uma variável de ambiente deixaria no binário de release (o que o CI testa) um jeito de gravar sem a escolha da pessoa, contra o RF2.3. O `cp_out` tem os testes do núcleo; o `cp_save` (diálogo e gravação) entra no checklist manual da release, no Linux e no Windows.
6. **Erros:** o container que sumiu ganha mensagem própria (404, "o container não existe mais"), separada do caminho que não existe. Os stderr do Docker (`No such container`) e do Podman (`no such container`) são conferidos antes, porque o do Podman também traz "no such file or directory". O resto vai com o stderr do docker (500).

Mensagens novas do servidor (pt → en), nas duas tabelas (o `EN` do Python e o `i18n_en.rs`):
- "caminho inválido: use um caminho absoluto (começa com /), de até 4096 caracteres" → "invalid path: use an absolute path (starting with /), up to 4096 characters"
- "{path} não existe no container" → "{path} does not exist in the container"
- "o container não existe mais" → "the container no longer exists"
- "{path} passa de 100 MB, o limite daqui" → "{path} is over 100 MB, the limit here"

---

## T1. Backend Python: `cp_out` e a rota `/api/cp/<id>`

**Escopo:** `cp_out` com `Popen`, leitura até 100 MB e `tarfile`, a rota binária com `send_bytes`, os testes e o caso de contrato da recusa.

**Contexto:** techspec, "Visão de componentes" (`docker_gui.py`), "Modelos de dado" (nome e erros), "Endpoints de API" e "Decisões principais" (ler até o limite e só então responder). PRD, RF1.3 a RF1.5, RF3.1 e RF3.2.

**Skills a carregar:** `tdd` (os testes primeiro) e `security-best-practices` (rota binária: `attachment`, `nosniff`, nome saneado, token só no header).

**Regras a respeitar:**
- `docker_gui.py` só com a biblioteca padrão (`tarfile`, `io`, `urllib.parse.quote`).
- Nenhum shell, argumentos em lista; o `id` pela regex de sempre.
- A rota **não** entra na lista de rotas que aceitam o token na query.
- Toda mensagem nova pelo `tr`, com a entrada no `EN` (`tests/test_i18n.py`).

**Steps:**

1. Testes primeiro, numa classe `CpTest(StreamTest)` em `tests/test_docker_gui.py`. O docker falso é um script que imprime um tar montado no teste:

```python
class CpTest(StreamTest):
    """Baixar arquivo: o docker cp escreve um tar no stdout; arquivo vira o conteúdo, pasta vira o tar."""

    def tar(self, *members):  # (nome, conteúdo | None para pasta)
        path = os.path.join(self.dir, "out.tar")
        with tarfile.open(path, "w") as t:
            for name, data in members:
                info = tarfile.TarInfo(name)
                if data is None:
                    info.type = tarfile.DIRTYPE
                    t.addfile(info)
                else:
                    info.size = len(data)
                    t.addfile(info, io.BytesIO(data))
        return path

    def test_file_comes_with_its_name_and_bytes(self):
        self.fake_docker(f"cat {self.tar(('error.log', b'\\x00bin\\xff'))}")
        self.assertEqual(docker_gui.cp_out(HEX_ID, "/var/log/nginx/error.log"), (200, "error.log", b"\x00bin\xff"))
        with open(os.path.join(self.dir, "args")) as f:
            self.assertEqual(f.read().split(), ["cp", "-L", f"{HEX_ID}:/var/log/nginx/error.log", "-"])

    def test_folder_comes_as_tar(self):
        path = self.tar(("reports", None), ("reports/a.txt", b"a"))
        self.fake_docker(f"cat {path}")
        with open(path, "rb") as f:
            self.assertEqual(docker_gui.cp_out(HEX_ID, "/app/reports/"), (200, "reports.tar", f.read()))

    def test_podman_has_no_dash_l(self):
        self.fake_docker(f"cat {self.tar(('x', b'1'))}", name="podman")
        with mock.patch.object(docker_gui, "CLI", ["podman"]):
            docker_gui.cp_out(HEX_ID, "/x")
        with open(os.path.join(self.dir, "args")) as f:
            self.assertEqual(f.read().split(), ["cp", f"{HEX_ID}:/x", "-"])

    def test_over_the_limit_is_413_and_kills_docker(self):
        self.fake_docker(f"echo $$ > {self.dir}/pid; exec head -c 100000 /dev/zero")  # exec: o pid é o do head
        with mock.patch.object(docker_gui, "MAX_CP", 1000):
            self.assertEqual(docker_gui.cp_out(HEX_ID, "/big")[0], 413)
        self.wait_dead("o docker cp")

    def test_missing_path_and_container(self):
        for stderr, msg in [
            ("Error response from daemon: Could not find the file /x in container web", "/x não existe no container"),
            ('Error: "/x" could not be found on container web: no such file or directory', "/x não existe no container"),
            ("Error response from daemon: No such container: 0123456789ab", "o container não existe mais"),
            ('Error: no container with name or ID "0123456789ab" found: no such container', "o container não existe mais"),
        ]:
            with self.subTest(stderr):
                self.fake_docker(f"echo '{stderr}' >&2; exit 1")
                self.assertEqual(docker_gui.cp_out(HEX_ID, "/x"), (404, "", msg))

    def test_invalid_path_never_runs(self):
        for path in ["", "etc/passwd", "/a\x00b", "/" + "a" * 4096]:
            with self.subTest(path[:10]):
                self.assertEqual(docker_gui.cp_out(HEX_ID, path)[0], 400)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "args")))

    def test_name_is_sanitized(self):
        self.assertEqual(docker_gui.cp_name("/", True), "root.tar")
        self.assertEqual(docker_gui.cp_name("/a\\b\x01c", False), "a_b_c")

    def test_route_sends_attachment(self):
        self.fake_docker(f"cat {self.tar(('relatório.txt', b'ok'))}")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        conn.request("GET", f"/api/cp/{HEX_ID}?path=/app/relat%C3%B3rio.txt",
                     headers={"Host": f"localhost:{self.port}", "X-Docker-GUI-Token": docker_gui.TOKEN})
        r = conn.getresponse()
        self.assertEqual((r.status, r.read()), (200, b"ok"))
        self.assertEqual(r.getheader("Content-Type"), "application/octet-stream")
        self.assertEqual(r.getheader("Content-Disposition"), "attachment; filename*=UTF-8''relat%C3%B3rio.txt")
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        conn.close()
        self.assertEqual(self.request("GET", f"/api/cp/{HEX_ID}?path=/x&t={docker_gui.TOKEN}", token=None)[0], 401)
```

2. A função, perto do `diff()`:

```python
MAX_CP = 100 * 1024 * 1024  # o tar inteiro passa pela memória: da aba na web, do app no desktop
```

```python
def cp_name(path, folder):
    """Nome do download: o último pedaço do caminho (a raiz vira root), sem barra nem caractere de controle."""
    base = re.sub(r"[\x00-\x1f\x7f/\\]", "_", path.rstrip("/").rsplit("/", 1)[-1] or "root")
    return base + ".tar" if folder else base


def cp_out(cid, path):
    """docker cp <id>:<path> - (um tar no stdout), lido até MAX_CP: (200, nome, bytes) ou (status, "", mensagem).
    Arquivo sai com o conteúdo; pasta (ou o que não for arquivo comum) sai como o tar. O -L segue o link dentro do
    container; o podman já segue e não tem a flag"""
    if not path.startswith("/") or "\x00" in path or len(path) > 4096:
        return 400, "", tr("caminho inválido: use um caminho absoluto (começa com /), de até 4096 caracteres")
    try:
        p = subprocess.Popen([*CLI, "cp", *([] if podman() else ["-L"]), f"{cid}:{path}", "-"],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as e:
        return 500, "", str(e)
    late = []
    timer = threading.Timer(ACTION_TIMEOUT, lambda: (late.append(1), p.kill()))
    timer.start()
    with p:
        try:
            data = p.stdout.read(MAX_CP + 1)
            if len(data) > MAX_CP:
                p.kill()
                return 413, "", tr("{path} passa de 100 MB, o limite daqui").format(path=path)
            err = p.stderr.read().decode(errors="replace").strip()
        finally:
            timer.cancel()
    if late:
        return 500, "", tr("{cli} {cmd} não respondeu em {timeout}s. O daemon está travado?").format(
            cli=CLI[0], cmd="cp", timeout=ACTION_TIMEOUT)
    if p.returncode:
        low = err.lower()
        if "no such container" in low:
            return 404, "", tr("o container não existe mais")
        if "could not find the file" in low or "no such file or directory" in low:
            return 404, "", tr("{path} não existe no container").format(path=path)
        return 500, "", err
    try:
        with tarfile.open(fileobj=io.BytesIO(data)) as t:
            first = t.next()
            if first is not None and first.isfile():
                return 200, cp_name(path, False), t.extractfile(first).read()
    except tarfile.TarError:
        return 500, "", tr("formato inesperado na saída do {cmd}").format(cmd=f"{CLI[0]} cp")
    return 200, cp_name(path, True), data
```

3. No `Handler`, o irmão do `send` e a rota (depois do `token_ok`, junto das outras de leitura por ID):

```python
    def send_bytes(self, data, name):
        """O download: o conteúdo do container nunca é interpretado (octet-stream, attachment, nosniff)"""
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(name, safe='')}")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        with contextlib.suppress(OSError):  # a página cancelou: a conexão já fechou
            self.wfile.write(data)
```

```python
        m = re.fullmatch(r"/api/cp/([0-9a-f]{12,64})", path)
        if m:  # baixar arquivo ou pasta do container (também parado); prazo de ação, até 100 MB
            code, name, out = cp_out(m[1], parse_qs(query, keep_blank_values=True).get("path", [""])[0])
            return self.send_bytes(out, name) if code == 200 else self.send(code, json.dumps(out))
```

Imports novos: `contextlib`, `io`, `tarfile` e `quote` (no `from urllib.parse import`).

4. As quatro mensagens no `EN`.

5. Contrato e cobertura:
   - `tests/contract/reads/cp-caminho-invalido.json`: `GET /api/cp/0123456789ab?path=etc/passwd`, `calls: []`, 400 com a mensagem.
   - O `CoverageTest.routes()` ganha `f"/api/cp/{ID}"`.
   - O `test_handler_routes_are_known` passa de 13 para 14.

   A leitura binária fica com os unitários e o E2E (techspec, "Estratégia de teste").

**Plano de teste:** `python3 -m unittest tests.test_docker_gui tests.test_contract tests.test_i18n` verde.

---

## T2. Núcleo Rust: `cp.rs`, `Reply::File` e o harness

**Escopo:** `stivo_core::cp::cp_out` com o `tar` (versão fixa), `Reply::File(CpFile)` no roteador, o harness servindo os mesmos cabeçalhos do Python, e o `api` da IPC devolvendo 404 para a rota.

**Contexto:** techspec, "Visão de componentes" (`cp.rs`, `router.rs`, `harness.rs`, `api` da IPC) e "Interfaces principais". O `Runner::run` devolve o stdout como `String` (lossy), que não serve para binário. O `cp` usa o `runner.command()`, como o `compose.rs`, e os testes trocam o programa por um `sh`.

**Skills a carregar:** `tdd`.

**Regras a respeitar:**
- Versão fixa no `core/Cargo.toml` (`tar = "=0.4.46"`, sem features padrão que não usamos: `default-features = false`).
- Mensagens no `i18n_en.rs` iguais às do `EN` do Python (o teste `i18n_matches_python`).
- Nada de caminho no log.
- `cargo fmt` e `clippy -D warnings` no workspace (com `--features stivo-core/harness`).

**Steps:**

1. `src-tauri/core/src/cp.rs`:

```rust
// Baixar arquivo do container (o cp_out do docker_gui.py): docker cp <id>:<path> - escreve um tar no stdout, lido até
// MAX_CP. Arquivo sai com o conteúdo e o nome; pasta (ou o que não for arquivo comum) sai como o tar inteiro.
// O Runner::run devolve texto: aqui o processo é aberto pelo command(), como o compose, para ler bytes
use std::io::Read;
use std::process::Stdio;

use tokio::io::AsyncReadExt;

use crate::cli::{ACTION_TIMEOUT, Ctx};
use crate::i18n::{tr, trf};
use crate::router::{Response, reply};

pub const MAX_CP: usize = 100 * 1024 * 1024;

pub struct CpFile {
    pub name: String,
    pub data: Vec<u8>,
}

/// absoluto, sem NUL, até 4096 caracteres (o mesmo teste do Python)
pub fn path_ok(path: &str) -> bool {
    path.starts_with('/') && !path.contains('\0') && path.chars().count() <= 4096
}

/// o último pedaço do caminho (a raiz vira root), sem barra nem caractere de controle
pub fn name(path: &str, folder: bool) -> String {
    let base = path.trim_end_matches('/').rsplit('/').next().filter(|b| !b.is_empty()).unwrap_or("root");
    let base: String = base.chars().map(|c| if c.is_ascii_control() || c == '/' || c == '\\' { '_' } else { c }).collect();
    if folder { format!("{base}.tar") } else { base }
}

pub async fn cp_out(ctx: &Ctx, id: &str, path: &str) -> Result<CpFile, Response> {
    cp_out_max(ctx, id, path, MAX_CP).await
}

async fn cp_out_max(ctx: &Ctx, id: &str, path: &str, max: usize) -> Result<CpFile, Response> {
    if !path_ok(path) {
        return Err(reply(400, tr(ctx.lang, "caminho inválido: use um caminho absoluto (começa com /), de até 4096 caracteres")));
    }
    let mut args = vec!["cp".to_string()];
    if !ctx.podman() {
        args.push("-L".into()); // segue o link dentro do container; o podman já segue e não tem a flag
    }
    args.extend([format!("{id}:{path}"), "-".into()]);
    let mut child = ctx.runner.command(&ctx.cli, &args).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| reply(500, e.to_string()))?;
    let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let work = async {
        let mut data = Vec::new();
        (&mut out).take(max as u64 + 1).read_to_end(&mut data).await?;
        if data.len() > max {
            return Ok(None); // o kill_on_drop do command() mata o docker cp
        }
        let mut e = Vec::new();
        err.read_to_end(&mut e).await?;
        Ok::<_, std::io::Error>(Some((child.wait().await?, data, String::from_utf8_lossy(&e).trim().to_string())))
    };
    match tokio::time::timeout(ACTION_TIMEOUT, work).await {
        Err(_) => Err(reply(500, trf(ctx.lang, "{cli} {cmd} não respondeu em {timeout}s. O daemon está travado?",
            &[("cli", &ctx.cli[0]), ("cmd", "cp"), ("timeout", &ACTION_TIMEOUT.as_secs().to_string())]))),
        Ok(Err(e)) => Err(reply(500, e.to_string())),
        Ok(Ok(None)) => Err(reply(413, trf(ctx.lang, "{path} passa de 100 MB, o limite daqui", &[("path", path)]))),
        Ok(Ok(Some((status, _, err)))) if !status.success() => {
            let low = err.to_lowercase();
            Err(if low.contains("no such container") {
                reply(404, tr(ctx.lang, "o container não existe mais"))
            } else if low.contains("could not find the file") || low.contains("no such file or directory") {
                reply(404, trf(ctx.lang, "{path} não existe no container", &[("path", path)]))
            } else {
                reply(500, err)
            })
        }
        Ok(Ok(Some((_, data, _)))) => unpack(ctx, path, data),
    }
}

/// o primeiro membro do tar: arquivo comum vira o conteúdo; o resto, o tar inteiro
fn unpack(ctx: &Ctx, path: &str, data: Vec<u8>) -> Result<CpFile, Response> {
    let bad = || reply(500, trf(ctx.lang, "formato inesperado na saída do {cmd}", &[("cmd", &format!("{} cp", ctx.cli[0]))]));
    let file = {
        let mut ar = tar::Archive::new(&data[..]);
        let mut entries = ar.entries().map_err(|_| bad())?;
        match entries.next() {
            Some(Ok(mut e)) if e.header().entry_type().is_file() => {
                let mut buf = Vec::new();
                e.read_to_end(&mut buf).map_err(|_| bad())?;
                Some(buf)
            }
            Some(Ok(_)) => None,
            _ => return Err(bad()),
        }
    };
    Ok(match file {
        Some(data) => CpFile { name: name(path, false), data },
        None => CpFile { name: name(path, true), data },
    })
}
```

2. Testes no próprio `cp.rs` (`#[cfg(all(test, unix))]`): um `Runner` que guarda os argumentos e devolve um `sh -c` com o roteiro do teste. O tar é montado com o `tar::Builder` num arquivo temporário (`cat <arquivo>`). Os mesmos casos da T1:
   - arquivo vira os bytes e o nome;
   - pasta vira o tar e o `.tar`;
   - Podman sem `-L` (pelo `cli: ["podman"]`);
   - mais que o `max` vira 413 e o processo morre (o `pid` gravado pelo script some);
   - os quatro stderr viram os dois 404;
   - caminho inválido vira 400 sem chamar o `command`;
   - nome saneado.

3. `router.rs`:
   - `Reply` ganha `File(crate::cp::CpFile)`, com o comentário "o download do docker cp: bytes e nome".
   - No `handle`, antes do `match`, a rota (o `get` devolve `Step<Response>` e não alcança o `Reply`):

```rust
pub async fn handle(ctx: &Ctx, req: Request) -> Reply {
    if req.method == Method::Get
        && let Some(m) = caps(r"/api/cp/([0-9a-f]{12,64})", &req.path)
    {
        // baixar arquivo ou pasta do container (também parado): bytes, não JSON
        let qs = parse_qs(&req.query, true);
        let path = qs_get(&qs, "path").and_then(|v| v.first()).map_or("", String::as_str);
        return crate::cp::cp_out(ctx, &m[1], path).await.map_or_else(Reply::Json, Reply::File);
    }
    // ...
```

4. `lib.rs` do núcleo: `pub mod cp;`. O `i18n_en.rs` ganha as quatro mensagens.

5. Harness, o mesmo do `send_bytes` do Python:

```rust
        Reply::File(f) => {
            let mut r = send(200, &Value::Null);
            let disposition = format!("attachment; filename*=UTF-8''{}", utf8_percent_encode(&f.name, NON_ALPHANUMERIC));
            *r.body_mut() = Body::from(f.data);
            let h = r.headers_mut();
            h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
            h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).unwrap());
            h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
            r
        }
```

   O `percent-encoding` já é dependência do núcleo. O `quote(safe='')` do Python deixa `_.-~` sem codificar; o `NON_ALPHANUMERIC` codifica: o conjunto vira `NON_ALPHANUMERIC.remove(b'_').remove(b'.').remove(b'-').remove(b'~')`, para os dois mandarem o mesmo cabeçalho.

6. `tests/contract.rs`: `Reply::File(_) => (0, Value::String("arquivo fora do escopo do contrato".into()))`. `src-tauri/src/ipc.rs` (`api`): `Reply::File(_) => Ok(ApiReply { status: 404, body: "not found".into() })`, porque o desktop baixa pelo `cp_save` (T4).

**Plano de teste:**
- `cargo test --workspace`: os unitários do `cp.rs`, o contrato com o caso da T1 e o `i18n_matches_python`.
- `cargo fmt --all --check` e `cargo clippy --workspace --all-targets --features stivo-core/harness -- -D warnings`.
- `npm run build:harness`.

---

## T3. Front: "Baixar arquivo…", o diálogo, os últimos caminhos e o E2E

**Escopo:** o item no "⋯" da linha e do modal, o `<dialog id="cp">`, o `cpOut` da web (com `saveBlob`), o `localStorage` dos últimos caminhos, o `cp` no docker falso, o E2E nos dois backends e a linha no README.

**Contexto:** techspec, "Visão de componentes" (`transport.ts`, `app.ts`, `localStorage`) e "Decisões principais" (web por `fetch` e `Blob`, token no header). PRD, RF1.1, RF1.2, RF1.6, RF2.1, RF3.1 (o comando pronto), RF3.2, RF3.3 e "Experiência do usuário": diálogo no estilo do "Novo container", Enter baixa, Esc fecha, o title com o comando, região viva.

**Skills a carregar:**
- `impeccable` (o diálogo no padrão do DESIGN.md: tokens, foco, estados ocupado e erro);
- `security-best-practices` (o `Blob` nunca é aberto pela página; o token fora da URL);
- `feature-prints` (o print do diálogo, se você quiser na PR).

**Regras a respeitar:**
- Toda frase visível (`t\`…\`` e `page.html`) com tradução no `src/en.json` (`tests/test_i18n.py`).
- `localStorage` sempre em try/catch, como as outras chaves `docker-gui-*`.
- `build.py` gera o `docker_gui.py` e o `src-tauri/dist/index.html`, que entram no commit (`build.py --check` no CI).
- E2E com o Chrome do sistema: `PW_CHROMIUM_PATH=/usr/bin/google-chrome`.

**Steps:**

1. `transport.ts`:

```ts
// baixar arquivo do container: na web o arquivo vem pela memória da aba e sai como download; no desktop, a janela
// "Salvar como" do sistema (saved: false se a pessoa cancelou). O signal cancela a espera
export type CpResult = {ok: true; saved: boolean; name: string} | {ok: false; status: number; error: string};
// ... no Transport:
  cpOut(id: string, path: string, signal: AbortSignal): Promise<CpResult>;
```

2. `transport-web.ts`:

```ts
// o download do navegador a partir de bytes que já estão na aba
function saveBlob(name: string, blob: Blob) {
  const a = Object.assign(document.createElement('a'), {href: URL.createObjectURL(blob), download: name});
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href));
}

// fetch com o token no header (um link direto poria o token no histórico de downloads); até 100 MB na memória
async function cpOut(id: string, path: string, signal: AbortSignal): Promise<CpResult> {
  const r = await fetch(`/api/cp/${id}?${new URLSearchParams({path})}`, {headers: {'X-Docker-GUI-Token': TOKEN}, signal});
  if (!r.ok) return {ok: false, status: r.status, error: String(await r.json())};
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(r.headers.get('Content-Disposition') ?? '')?.[1] ?? 'arquivo');
  saveBlob(name, await r.blob());
  return {ok: true, saved: true, name};
}
```

   O `transport-desktop.ts` ganha um `cpOut` provisório que devolve `{ok: false, status: 501, …}`, para o `tsc` passar até a T4.

3. `page.html`: o `<dialog id="cp">`, com as classes do `#prefs`:
   - cabeçalho: "Baixar arquivo", o nome do container em mono (`#cp-name`) e o ×;
   - o campo `#cp-path` com `list="cp-recent"`, `autocomplete="off"`, `spellcheck="false"`, placeholder `/var/log/nginx/error.log` e `aria-describedby="cp-hint cp-err"`;
   - o `<datalist id="cp-recent">`;
   - a dica `#cp-hint`: "Caminho absoluto dentro do container. Uma pasta chega como .tar. Até 100 MB.";
   - o `#cp-err` do campo e o `#cp-msg` (`role="alert"`) do erro do servidor;
   - Cancelar e Baixar (`#cp-go`, submit).

4. `app.ts`:

```ts
// baixar arquivo do container (docker cp): os últimos caminhos por nome de container (recriado, continua o mesmo)
const CP_KEY = 'docker-gui-cp';
const cpAll = (): Record<string, string[]> => { try { return JSON.parse(localStorage.getItem(CP_KEY) || '{}'); } catch { return {}; } };
let cpFor: Container | null = null, cpAbort: AbortController | null = null;
// o comando equivalente, com o caminho entre aspas se precisar (o do 413 e o title do item)
const cpCmd = (name: string, path: string) =>
  `${document.documentElement.dataset.cli} cp ${name}:${/^[\w./@%+=:,-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`} .`;

function openCp(id: string) {
  cpFor = data.find(c => c.ID === id) ?? null;
  if (!cpFor) return;
  const recent = cpAll()[cpFor.Names] ?? [], input = $<HTMLInputElement>('#cp-path');
  $('#cp-name').textContent = cpFor.Names;
  $('#cp-recent').replaceChildren(...recent.map(p => Object.assign(document.createElement('option'), {value: p})));
  input.value = recent[0] ?? '';
  input.removeAttribute('aria-invalid');
  $('#cp-err').textContent = $('#cp-msg').textContent = '';
  $<HTMLDialogElement>('#cp').showModal();
  input.select();
}

async function cpGo(e: SubmitEvent) {
  e.preventDefault();
  const input = $<HTMLInputElement>('#cp-path'), path = input.value.trim(), c = cpFor, go = $('#cp-go');
  if (!c || cpAbort) return;
  if (!path.startsWith('/')) {  // o servidor confere de novo
    input.setAttribute('aria-invalid', 'true');
    $('#cp-err').textContent = t`Use o caminho absoluto, começando com /.`;
    return input.focus();
  }
  input.removeAttribute('aria-invalid');
  $('#cp-err').textContent = $('#cp-msg').textContent = '';
  const abort = cpAbort = new AbortController();
  go.setAttribute('aria-disabled', 'true'); go.textContent = t`Baixando…`;
  const r = await T.cpOut(c.ID, path, abort.signal)
    .catch((): CpResult => ({ok: false, status: 0, error: t`Sem resposta do servidor.`}));
  cpAbort = null;
  go.removeAttribute('aria-disabled'); go.textContent = t`Baixar`;
  if (abort.signal.aborted) return;  // cancelou: nada a dizer
  if (!r.ok) {
    $('#cp-msg').innerHTML = esc(r.error) + (r.status === 413 ? `<span class="block mt-1">${t`Pelo terminal:`} <code class="font-mono">${esc(cpCmd(c.Names, path))}</code>
      <button type="button" onclick="copyCp()" class="ml-1 underline underline-offset-4 rounded focus-visible:outline-2 focus-visible:outline-accent">${t`Copiar`}</button></span>` : '');
    return;
  }
  try {
    const all = cpAll();
    all[c.Names] = [path, ...(all[c.Names] ?? []).filter(p => p !== path)].slice(0, 5);
    localStorage.setItem(CP_KEY, JSON.stringify(all));
  } catch { /* aba privada: vale só agora */ }
  $<HTMLDialogElement>('#cp').close();
  if (r.saved) toast(t`Baixado: ${r.name}`, true);
}
// fechar (×, Cancelar ou Esc) no meio do download cancela
function cpClosed() { cpAbort?.abort(); cpAbort = null; }
function copyCp() {
  const cmd = cpCmd(cpFor!.Names, $<HTMLInputElement>('#cp-path').value.trim());
  navigator.clipboard.writeText(cmd).then(() => toast(t`Copiado: ${cmd}`, true), () => toast(t`Não consegui copiar. O comando é: ${cmd}`));
}
```

   Ligações:
   - `$('#cp-form').addEventListener('submit', cpGo)`, `$('#cp').addEventListener('close', cpClosed)` e `copyCp`/`openCp` no `Object.assign(window, …)`;
   - no "⋯" da linha, antes do remover, `['cp', t\`Baixar arquivo…\`]` para todos os estados (o `MenuAction` ganha `'cp'`), com `onclick` `openCp('${c.ID}')` e `title="${esc(cpCmd(c.Names, '<caminho>'))}"`;
   - o mesmo item no "⋯" do modal (`#dlg-acts`).

5. `en.json`: as frases novas do `app.ts` e do `page.html`.

6. Docker falso: o campo `files` por container (`{caminho: texto}`; uma pasta é qualquer prefixo de caminho com `/`) e o `cp`:

```python
def cp(state, args):
    """cp [-L] <id>:<caminho> -: um tar no stdout, como o docker; arquivo ou pasta a partir de "files"."""
    ref, _, src = args[-2].partition(":")
    c, src = find(state, ref), src.rstrip("/") or "/"
    files = c.get("files", {})
    inside = {p: v for p, v in files.items() if p.startswith(src.rstrip("/") + "/")}
    if src not in files and not inside:
        fail(f"Error response from daemon: Could not find the file {src} in container {c['Names']}")
    base, buf = src.rsplit("/", 1)[-1] or "/", io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as t:
        def add(name, text=None):
            info = tarfile.TarInfo(name)
            if text is None:
                info.type = tarfile.DIRTYPE
                return t.addfile(info)
            data = text.encode()
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
        if src in files:
            add(base, files[src])
        else:
            add(base)
            for p, text in sorted(inside.items()):
                add(base + p[len(src.rstrip("/")):], text)
    sys.stdout.buffer.write(buf.getvalue())
```

   No `main`, `elif cmd == "cp": cp(state, args)`, dentro do lock como o `diff`, e uma linha nova na docstring.

7. `fixtures.ts`: `files?: Record<string, string>` no `Container`.

8. E2E em `tests/e2e/actions.spec.ts`:

```ts
const download = async (d: import('@playwright/test').Download) => {
  const chunks: Buffer[] = [];
  for await (const chunk of await d.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

test('Baixar arquivo: um arquivo de container parado, com o nome dele, e o caminho fica para a próxima', async ({ page, gui }) => {
  await gui.open({ containers: [stopped('web', { files: { '/var/log/nginx/error.log': 'upstream timed out\n' } })] });
  await menu(page, 'web').click();
  await page.getByRole('button', { name: 'Baixar arquivo…' }).click();
  await page.getByLabel('Caminho no container').fill('/var/log/nginx/error.log');
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByLabel('Caminho no container').press('Enter')]);
  expect(d.suggestedFilename()).toBe('error.log');
  expect((await download(d)).toString()).toBe('upstream timed out\n');
  await expect(toast(page)).toHaveText('Baixado: error.log');
  await menu(page, 'web').click();
  await page.getByRole('button', { name: 'Baixar arquivo…' }).click();
  await expect(page.getByLabel('Caminho no container')).toHaveValue('/var/log/nginx/error.log');
  await expect(page.locator('#cp-recent option')).toHaveCount(1);
});

test('Baixar arquivo: uma pasta chega como .tar', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('api', { files: { '/app/reports/a.txt': 'a', '/app/reports/b.txt': 'b' } })] });
  // ... abre pelo "⋯", /app/reports/, Baixar
  expect(d.suggestedFilename()).toBe('reports.tar');
  expect((await download(d)).includes('reports/a.txt')).toBe(true);
});

test('Baixar arquivo: caminho que não existe e caminho relativo', async ({ page, gui }) => {
  // relativo: o campo recusa sem pedir (aria-invalid e a dica); /nao/existe: "/nao/existe não existe no container"
});
```

9. README, na lista do que a página faz: "**Baixar arquivo** de um container (também parado): uma pasta chega como `.tar`, até 100 MB."

**Plano de teste:**
- `npm run typecheck`, `python3 build.py` e depois `build.py --check`;
- `npm run test:js`;
- `python3 -m unittest tests.test_i18n`;
- os três testes novos nos dois backends: `PW_CHROMIUM_PATH=/usr/bin/google-chrome npx playwright test actions -g "Baixar arquivo"`, com e sem `GUI_BACKEND=rust` (depois do `npm run build:harness`).

---

## T4. Desktop: `cp_save` com a janela "Salvar como"

**Escopo:** o `tauri-plugin-dialog` (versão fixa, chamado só pelo Rust), o comando `cp_save`, a capability, o `cpOut` do `transport-desktop` com teste, e o item no checklist manual da release.

**Contexto:** techspec, "Visão de componentes" (`ipc.rs`), "Pontos de integração" (`tauri-plugin-dialog` sem permissão `dialog:*` para a página) e "Decisões principais" (uma implementação no núcleo, duas entregas; o cancelamento no desktop só para de esperar). PRD, RF2.2 (a janela do sistema já com o nome) e RF2.3 (nada gravado sem a escolha). Ajuste 5 do topo (sem smoke).

**Skills a carregar:** `security-best-practices` (capability mínima: só o `allow-cp-save`; o destino vem do diálogo, nunca da página).

**Regras a respeitar:**
- Versão fixa (`tauri-plugin-dialog = "=2.8.3"`, que pede o tauri 2.12) e `Cargo.lock` versionado.
- Só a janela main chama comandos (`build.rs` e `capabilities/main.json`).
- `log::warn!` sem caminho: só o tipo do erro ao gravar.

**Steps:**

1. `Cargo.toml` com o plugin. No `lib.rs`, `.plugin(tauri_plugin_dialog::init())` e `ipc::cp_save` no `generate_handler!`. No `build.rs`, `"cp_save"`; na capability, `"allow-cp-save"`.

2. `ipc.rs`:

```rust
#[derive(Serialize)]
pub struct CpSaved {
    saved: bool,
    name: String,
}

/// "Baixar arquivo…": o mesmo cp_out da versão web, e o arquivo vai para onde a pessoa escolher na janela "Salvar
/// como" do sistema (nada é gravado sem essa escolha). Err: {status, body}, como a recusa do api
#[tauri::command]
pub async fn cp_save(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<CpSaved, ApiReply> {
    use tauri_plugin_dialog::DialogExt;
    if !validate::ID_RE.is_match(&id) {
        return Err(ApiReply { status: 404, body: "not found".into() });
    }
    let ctx = state.ctx();
    let f = stivo_core::cp::cp_out(&ctx, &id, &path).await.map_err(|r| ApiReply { status: r.status, body: r.body })?;
    let name = f.name.clone();
    let mut dialog = app.dialog().file().set_file_name(&f.name);
    if let Some(w) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&w);
    }
    let en = ctx.lang == stivo_core::Lang::En;
    // o diálogo bloqueia: fora da thread da janela
    let saved = tauri::async_runtime::spawn_blocking(move || {
        let Some(dest) = dialog.blocking_save_file().and_then(|p| p.into_path().ok()) else { return Ok(false) };
        std::fs::write(dest, f.data).map(|_| true).map_err(|e| {
            log::warn!("baixar arquivo: não gravou ({})", e.kind());
            format!("{} {}", if en { "Could not save the file:" } else { "Não consegui gravar o arquivo:" }, e.kind())
        })
    })
    .await
    .map_err(|e| ApiReply { status: 500, body: e.to_string().into() })?
    .map_err(|e| ApiReply { status: 500, body: e.into() })?;
    Ok(CpSaved { saved, name })
}
```

3. `transport-desktop.ts`, no lugar do provisório:

```ts
  // o diálogo "Salvar como" é do Rust; o signal só faz a página parar de esperar (o docker cp vai até o fim)
  cpOut: (id, path) => invoke<{saved: boolean; name: string}>('cp_save', {id, path}).then(
    r => ({ok: true as const, ...r}),
    e => { const r = refusal(e); return {ok: false as const, status: r.status, error: String(r.body)}; }),
```

4. `tests/transport-desktop.test.js`:

```js
test('cpOut: cp_save com id e caminho; a recusa vira {ok: false} com o status e a mensagem', async () => {
  onInvoke = () => ({saved: true, name: 'error.log'});
  assert.deepEqual(await T.cpOut('0123456789ab', '/var/log/x', new AbortController().signal), {ok: true, saved: true, name: 'error.log'});
  assert.deepEqual(calls.at(-1), ['cp_save', {id: '0123456789ab', path: '/var/log/x'}]);
  onInvoke = () => { throw {status: 404, body: '/x não existe no container'}; };
  assert.deepEqual(await T.cpOut('0123456789ab', '/x', new AbortController().signal), {ok: false, status: 404, error: '/x não existe no container'});
});
```

5. Checklist manual da release (techspec do desktop, "Estratégia de teste"), no Linux e no Windows:
   - baixar um arquivo e uma pasta pelo "⋯": a janela do sistema vem com o nome, e o arquivo gravado é o do container;
   - cancelar a janela não grava nada.

**Plano de teste:**
- `cargo build -p stivo`, `cargo clippy -p stivo --all-targets -- -D warnings` e `cargo test -p stivo`;
- `npm run test:js` e `npm run typecheck`;
- o smoke do desktop inteiro continua verde (o plugin não quebra a abertura).
- À mão, no app de debug (`dbus-run-session`, com o docker de verdade), se houver container: baixar um arquivo pelo "⋯" e conferir a janela "Salvar como" com o nome.
