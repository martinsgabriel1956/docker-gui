// O compose com a saída em stream (o compose_stream do docker_gui.py): uma string por linha, o progresso e o build do
// stderr junto, e no fim {"code": n}. O compose vai até o fim mesmo que ninguém leia mais (um down interrompido deixaria
// o projeto pela metade): só o prazo de 10 min o interrompe.
use std::io::BufRead;
use std::process::Stdio;

use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::cli::{COMPOSE_TIMEOUT, Ctx};
use crate::i18n::trf;

pub fn stream(ctx: &Ctx, args: Vec<String>) -> BoxStream<'static, Value> {
    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let ctx = ctx.clone();
    tokio::spawn(async move {
        let code = run(&ctx, &args, &tx).await;
        let _ = tx.send(json!({"code": code}));
    });
    tokio_stream(rx)
}

async fn run(ctx: &Ctx, args: &[String], tx: &mpsc::UnboundedSender<Value>) -> i32 {
    // stdout e stderr no mesmo pipe, na ordem em que saem (o STDOUT do Python)
    let (reader, writer) = match std::io::pipe() {
        Ok(p) => p,
        Err(e) => {
            let _ = tx.send(json!(e.to_string()));
            return 127;
        }
    };
    let child = {
        let mut cmd = ctx.runner.command(&ctx.cli, args);
        cmd.kill_on_drop(false);
        match writer.try_clone() {
            Ok(w) => cmd.stdout(Stdio::from(w)).stderr(Stdio::from(writer)),
            Err(e) => {
                let _ = tx.send(json!(e.to_string()));
                return 127;
            }
        };
        cmd.spawn()
        // o Command sai de escopo aqui e fecha a ponta de escrita que ele guardava: sem isso o reader nunca vê o fim
    };
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(json!(e.to_string())); // binário não encontrado
            return 127;
        }
    };
    let lines = tx.clone();
    let pump = tokio::task::spawn_blocking(move || {
        let mut r = std::io::BufReader::new(reader);
        let mut buf = Vec::new();
        // cada linha assim que ela chega, inteira (UTF-8 inteiro); quem sumiu do outro lado só para de receber
        while r.read_until(b'\n', &mut buf).unwrap_or(0) > 0 {
            let line = String::from_utf8_lossy(&buf);
            let _ = lines.send(json!(line.trim_end_matches(['\r', '\n'])));
            buf.clear();
        }
    });
    let status = tokio::select! {
        s = child.wait() => s.ok(),
        _ = tokio::time::sleep(COMPOSE_TIMEOUT) => None,
    };
    let code = match status {
        Some(s) => s.code().unwrap_or(-1),
        None => {
            let _ = child.kill().await;
            let _ = pump.await;
            let _ = tx.send(json!(trf(
                ctx.lang,
                "{cli} {cmd} não respondeu em {timeout}s. O daemon está travado?",
                &[("cli", &ctx.cli[0]), ("cmd", &args[0]), ("timeout", &COMPOSE_TIMEOUT.as_secs().to_string())],
            )));
            return 124;
        }
    };
    let _ = pump.await;
    code
}

/// o receiver do canal como Stream, sem puxar o tokio-stream inteiro
fn tokio_stream(mut rx: mpsc::UnboundedReceiver<Value>) -> BoxStream<'static, Value> {
    futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx)).boxed()
}

#[cfg(all(test, unix))]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use crate::cli::{Output, RunError, Runner};
    use crate::i18n::Lang;

    /// troca o compose por um sh com o roteiro do teste
    struct Script(&'static str);

    #[async_trait::async_trait]
    impl Runner for Script {
        async fn run(&self, _: &[String], _: &[String], _: Duration) -> Result<Output, RunError> {
            unreachable!()
        }
        fn command(&self, _: &[String], _: &[String]) -> tokio::process::Command {
            crate::cli::command(&["sh".into()], &["-c".into(), self.0.into()])
        }
    }

    fn ctx(script: &'static str) -> Ctx {
        Ctx { cli: vec!["docker".into()], lang: Lang::Pt, runner: Arc::new(Script(script)), now: Arc::new(|| 0.0) }
    }

    #[tokio::test]
    async fn lines_then_code_with_stderr_in_order() {
        let out: Vec<Value> =
            stream(&ctx("echo um; echo dois >&2; printf 'sem fim\\r\\n'; printf tres; exit 3"), vec![]).collect().await;
        assert_eq!(out, vec![json!("um"), json!("dois"), json!("sem fim"), json!("tres"), json!({"code": 3})]);
    }

    #[tokio::test]
    async fn keeps_running_when_nobody_reads() {
        let dir = std::env::temp_dir().join(format!("stivo-compose-{}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let script: &'static str = Box::leak(format!("sleep 0.3; touch {}", dir.display()).into_boxed_str());
        drop(stream(&ctx(script), vec![])); // a página fechou antes do fim
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert!(dir.exists(), "o compose foi interrompido");
        let _ = std::fs::remove_file(&dir);
    }
}
