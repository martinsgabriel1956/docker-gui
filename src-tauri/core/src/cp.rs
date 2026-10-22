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
    let base: String =
        base.chars().map(|c| if c.is_ascii_control() || c == '/' || c == '\\' { '_' } else { c }).collect();
    if folder { format!("{base}.tar") } else { base }
}

pub async fn cp_out(ctx: &Ctx, id: &str, path: &str) -> Result<CpFile, Response> {
    cp_out_max(ctx, id, path, MAX_CP).await
}

async fn cp_out_max(ctx: &Ctx, id: &str, path: &str, max: usize) -> Result<CpFile, Response> {
    if !path_ok(path) {
        let msg = "caminho inválido: use um caminho absoluto (começa com /), de até 4096 caracteres";
        return Err(reply(400, tr(ctx.lang, msg)));
    }
    let mut args = vec!["cp".to_string()];
    if !ctx.podman() {
        args.push("-L".into()); // segue o link dentro do container; o podman já segue e não tem a flag
    }
    args.extend([format!("{id}:{path}"), "-".into()]);
    let mut child = ctx
        .runner
        .command(&ctx.cli, &args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| reply(500, e.to_string()))?; // binário que não existe
    let (mut out, mut err) = (child.stdout.take().expect("stdout"), child.stderr.take().expect("stderr"));
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
        Err(_) => {
            let secs = ACTION_TIMEOUT.as_secs().to_string();
            let msg = "{cli} {cmd} não respondeu em {timeout}s. O daemon está travado?";
            Err(reply(500, trf(ctx.lang, msg, &[("cli", &ctx.cli[0]), ("cmd", "cp"), ("timeout", &secs)])))
        }
        Ok(Err(e)) => Err(reply(500, e.to_string())),
        Ok(Ok(None)) => Err(reply(413, trf(ctx.lang, "{path} passa de 100 MB, o limite daqui", &[("path", path)]))),
        Ok(Ok(Some((status, _, err)))) if !status.success() => {
            let low = err.to_lowercase();
            // antes: o do podman também diz "no such file or directory"
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
    let bad = || {
        let cmd = format!("{} cp", ctx.cli[0]);
        reply(500, trf(ctx.lang, "formato inesperado na saída do {cmd}", &[("cmd", &cmd)]))
    };
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
            None if data.is_empty() => return Err(bad()), // o docker cp saiu bem sem escrever o tar
            None => None,
            Some(Err(_)) => return Err(bad()),
        }
    };
    Ok(match file {
        Some(data) => CpFile { name: name(path, false), data },
        None => CpFile { name: name(path, true), data },
    })
}

#[cfg(all(test, unix))]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use super::*;
    use crate::cli::{Output, RunError, Runner};
    use crate::i18n::Lang;

    /// troca o docker por um sh com o roteiro do teste e guarda os argumentos
    struct Script(String, Mutex<Option<Vec<String>>>);

    #[async_trait::async_trait]
    impl Runner for Script {
        async fn run(&self, _: &[String], _: &[String], _: Duration) -> Result<Output, RunError> {
            unreachable!()
        }
        fn command(&self, _: &[String], args: &[String]) -> tokio::process::Command {
            *self.1.lock().unwrap() = Some(args.to_vec());
            crate::cli::command(&["sh".into()], &["-c".into(), self.0.clone()])
        }
    }

    fn ctx(cli: &str, script: &str) -> (Ctx, Arc<Script>) {
        let s = Arc::new(Script(script.into(), Mutex::new(None)));
        (Ctx { cli: vec![cli.into()], lang: Lang::Pt, runner: s.clone(), now: Arc::new(|| 0.0) }, s)
    }

    /// pasta temporária só deste teste, com o tar montado (nome, conteúdo | None para pasta)
    fn tar(test: &str, members: &[(&str, Option<&[u8]>)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("stivo-cp-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut b = tar::Builder::new(std::fs::File::create(dir.join("out.tar")).unwrap());
        for (name, data) in members {
            let mut h = tar::Header::new_gnu();
            h.set_mode(0o644);
            match data {
                None => {
                    h.set_entry_type(tar::EntryType::Directory);
                    h.set_size(0);
                    b.append_data(&mut h, name, std::io::empty()).unwrap();
                }
                Some(d) => {
                    h.set_size(d.len() as u64);
                    b.append_data(&mut h, name, *d).unwrap();
                }
            }
        }
        b.finish().unwrap();
        dir
    }

    #[tokio::test]
    async fn file_comes_with_its_name_and_bytes() {
        let dir = tar("file", &[("error.log", Some(b"\x00bin\xff"))]);
        let (ctx, s) = ctx("docker", &format!("cat {}/out.tar", dir.display()));
        let f = cp_out(&ctx, "0123456789ab", "/var/log/nginx/error.log").await.ok().unwrap();
        assert_eq!((f.name.as_str(), f.data.as_slice()), ("error.log", &b"\x00bin\xff"[..]));
        assert_eq!(s.1.lock().unwrap().clone().unwrap(), ["cp", "-L", "0123456789ab:/var/log/nginx/error.log", "-"]);
    }

    #[tokio::test]
    async fn folder_comes_as_tar() {
        let dir = tar("folder", &[("reports", None), ("reports/a.txt", Some(b"a"))]);
        let (ctx, _) = ctx("docker", &format!("cat {}/out.tar", dir.display()));
        let f = cp_out(&ctx, "0123456789ab", "/app/reports/").await.ok().unwrap();
        assert_eq!(f.name, "reports.tar");
        assert_eq!(f.data, std::fs::read(dir.join("out.tar")).unwrap());
    }

    #[tokio::test]
    async fn podman_has_no_dash_l() {
        let dir = tar("podman", &[("x", Some(b"1"))]);
        let (ctx, s) = ctx("podman", &format!("cat {}/out.tar", dir.display()));
        assert_eq!(cp_out(&ctx, "0123456789ab", "/x").await.ok().unwrap().data, b"1");
        assert_eq!(s.1.lock().unwrap().clone().unwrap(), ["cp", "0123456789ab:/x", "-"]);
    }

    #[tokio::test]
    async fn over_the_limit_is_413_and_kills_docker() {
        let dir = tar("big", &[]);
        let pid = dir.join("pid");
        let (ctx, _) = ctx("docker", &format!("echo $$ > {}; exec head -c 100000 /dev/zero", pid.display()));
        let r = cp_out_max(&ctx, "0123456789ab", "/big", 1000).await.err().unwrap();
        assert_eq!(r, reply(413, "/big passa de 100 MB, o limite daqui"));
        let pid = std::fs::read_to_string(pid).unwrap().trim().to_string();
        for _ in 0..50 {
            if !std::path::Path::new(&format!("/proc/{pid}")).exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("o docker cp continuou vivo");
    }

    #[tokio::test]
    async fn docker_errors() {
        for (stderr, status, msg) in [
            (
                "Error response from daemon: Could not find the file /x in container web",
                404,
                "/x não existe no container",
            ),
            (
                "Error: \"/x\" could not be found on container web: no such file or directory",
                404,
                "/x não existe no container",
            ),
            ("Error response from daemon: No such container: 0123456789ab", 404, "o container não existe mais"),
            (
                "Error: no container with name or ID \"0123456789ab\" found: no such container",
                404,
                "o container não existe mais",
            ),
            ("Error response from daemon: permission denied", 500, "Error response from daemon: permission denied"),
        ] {
            let (ctx, _) = ctx("docker", &format!("echo '{stderr}' >&2; exit 1"));
            assert_eq!(cp_out(&ctx, "0123456789ab", "/x").await.err().unwrap(), reply(status, msg), "{stderr}");
        }
        let (ctx, _) = ctx("docker", "exit 0"); // sem tar nenhum
        assert_eq!(cp_out(&ctx, "0123456789ab", "/x").await.err().unwrap().status, 500);
    }

    #[tokio::test]
    async fn invalid_path_never_runs() {
        let (ctx, s) = ctx("docker", "exit 0");
        for path in ["", "etc/passwd", "/a\0b", &format!("/{}", "a".repeat(4096))] {
            let r = cp_out(&ctx, "0123456789ab", path).await.err().unwrap();
            assert_eq!(r.status, 400, "{path:.10}");
        }
        assert!(s.1.lock().unwrap().is_none());
        assert!(path_ok(&format!("/{}", "a".repeat(4095))));
    }

    #[test]
    fn name_is_sanitized() {
        assert_eq!(name("/", true), "root.tar");
        assert_eq!(name("/a\\b\x01c", false), "a_b_c");
        assert_eq!(name("/app/relatório.txt", false), "relatório.txt");
    }
}
