// Os streams do docker_gui.py: docker logs -f, compose logs -f e docker events. Cada um é um processo vivo enquanto
// alguém lê: soltar o stream mata o docker (kill_on_drop), como o select do Python percebe a aba que fechou. As
// mensagens são o "data:" do SSE de lá: nos logs, a linha em JSON; nos eventos, só "1" (algo mudou), uma vez por leva.
use std::collections::VecDeque;
use std::io::Read;
use std::process::Stdio;
use std::sync::{Arc, LazyLock};

use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};

use crate::cli::Ctx;
use crate::normalize::relevant;
use crate::pyfmt::parse_qs;
use crate::router::{Response, caps, compose_query, log_since, log_tail, reply, strs};
use crate::validate as v;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StreamMsg {
    /// o que vai no "data:" do SSE
    Data(String),
    /// o docker terminou (o container parou, o daemon caiu, o podman não tem events)
    End,
}

/// cada stream de eventos é um `docker events` preso enquanto a página está aberta: teto de 8, como no Python
static EVENTS_SLOTS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(8)));

/// As rotas de stream (GET, só leitura). Err: a resposta de erro (400, 404, 500, 503), como o Python responde antes
/// de abrir o SSE
pub async fn open(ctx: &Ctx, path: &str, query: &str) -> Result<BoxStream<'static, StreamMsg>, Response> {
    if path == "/api/events/stream" {
        return events(ctx);
    }
    let logs = caps(r"/api/logs/([0-9a-f]{12,64})/stream", path);
    if logs.is_none() && path != "/api/compose/logs/stream" {
        return Err(reply(404, "not found"));
    }
    // "?tail=" vazio é inválido, não o padrão
    let qs = parse_qs(query, true);
    let tail = log_tail(ctx, &qs)?;
    let since = log_since(ctx, &qs, logs.as_ref().map(|m| m[1].as_str())).await?;
    let args: Vec<String> = match &logs {
        Some(m) => [strs(&["logs", "-f", "--timestamps"]), strs(tail), since, vec![m[1].clone()]].concat(),
        None => {
            let base = compose_query(ctx, query).await?;
            [base, strs(&v::COMPOSE_LOGS), strs(tail), since, strs(&["--follow"])].concat()
        }
    };
    logs_stream(ctx, &args).map_err(|e| reply(500, e.to_string()))
}

/// Um JSON por linha inteira (\r ou \n dentro do log não quebram o SSE), e "end" quando o docker termina
fn logs_stream(ctx: &Ctx, args: &[String]) -> std::io::Result<BoxStream<'static, StreamMsg>> {
    // stdout e stderr no mesmo pipe, como o stderr=STDOUT do Python
    let (mut reader, writer) = std::io::pipe()?;
    let child = {
        let mut cmd = ctx.runner.command(&ctx.cli, args);
        cmd.stdout(Stdio::from(writer.try_clone()?)).stderr(Stdio::from(writer));
        cmd.spawn()?
    };
    let (tx, rx) = mpsc::channel::<Vec<u8>>(64);
    // o pipe do std é bloqueante: uma thread lê e acaba sozinha quando o docker morre e o pipe fecha
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 65536];
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            if tx.blocking_send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    Ok(lines(child, rx, None, true, |rest, chunk, out| {
        // só manda linha inteira (e UTF-8 inteiro)
        rest.extend_from_slice(chunk);
        while let Some(i) = rest.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = rest.drain(..=i).collect();
            out.push_back(StreamMsg::Data(json!(String::from_utf8_lossy(&line)).to_string()));
        }
    }))
}

fn events(ctx: &Ctx) -> Result<BoxStream<'static, StreamMsg>, Response> {
    let Ok(slot) = EVENTS_SLOTS.clone().try_acquire_owned() else {
        return Err(reply(503, crate::i18n::tr(ctx.lang, "streams de eventos demais abertos")));
    };
    // o podman nem sempre entende {{json .}}; o "json" dele já sai um JSON por linha, como o do docker
    let fmt = if ctx.podman() { "json" } else { "{{json .}}" };
    let mut cmd = ctx.runner.command(&ctx.cli, &strs(&["events", "--format", fmt, "--filter", "type=container"]));
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    // binário não encontrado: a página fica no poll, que mostra o erro (a vaga volta junto com o slot)
    let mut child = cmd.spawn().map_err(|e| reply(500, e.to_string()))?;
    let mut stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel::<Vec<u8>>(64);
    tokio::spawn(async move {
        let mut buf = vec![0u8; 65536];
        while let Ok(n @ 1..) = stdout.read(&mut buf).await {
            if tx.send(buf[..n].to_vec()).await.is_err() {
                break;
            }
        }
    });
    Ok(lines(child, rx, Some(slot), false, |rest, chunk, out| {
        rest.extend_from_slice(chunk);
        let end = rest.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
        let done: Vec<u8> = rest.drain(..end).collect();
        // a rajada que chega junta (compose up) vira um aviso só
        if String::from_utf8_lossy(&done).split('\n').any(relevant) {
            out.push_back(StreamMsg::Data("1".into()));
        }
    }))
}

struct Proc {
    // morre com o stream: o kill_on_drop do Command mata o docker
    _child: tokio::process::Child,
    _slot: Option<OwnedSemaphorePermit>,
    rx: mpsc::Receiver<Vec<u8>>,
    rest: Vec<u8>,
    out: VecDeque<StreamMsg>,
    done: bool,
    /// nos logs, o que sobrou sem \n no fim também vai; nos eventos, não
    flush_rest: bool,
}

type Chunk = fn(&mut Vec<u8>, &[u8], &mut VecDeque<StreamMsg>);

fn lines(
    child: tokio::process::Child,
    rx: mpsc::Receiver<Vec<u8>>,
    slot: Option<OwnedSemaphorePermit>,
    flush_rest: bool,
    chunk: Chunk,
) -> BoxStream<'static, StreamMsg> {
    let p = Proc { _child: child, _slot: slot, rx, rest: Vec::new(), out: VecDeque::new(), done: false, flush_rest };
    futures_util::stream::unfold((p, chunk), |(mut p, chunk)| async move {
        loop {
            if let Some(m) = p.out.pop_front() {
                return Some((m, (p, chunk)));
            }
            if p.done {
                return None;
            }
            match p.rx.recv().await {
                Some(c) => chunk(&mut p.rest, &c, &mut p.out),
                None => {
                    // o docker terminou: o que sobrou sem \n (só nos logs) e o "end"
                    p.done = true;
                    if p.flush_rest && !p.rest.is_empty() {
                        p.out.push_back(StreamMsg::Data(json!(String::from_utf8_lossy(&p.rest)).to_string()));
                    }
                    p.out.push_back(StreamMsg::End);
                }
            }
        }
    })
    .boxed()
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::cli::{Output, RunError, Runner};
    use crate::i18n::Lang;

    struct Script(String);

    #[async_trait::async_trait]
    impl Runner for Script {
        async fn run(&self, _: &[String], _: &[String], _: Duration) -> Result<Output, RunError> {
            unreachable!()
        }
        fn command(&self, _: &[String], _: &[String]) -> tokio::process::Command {
            crate::cli::command(&["sh".into()], &["-c".into(), self.0.clone()])
        }
    }

    fn ctx(script: &str) -> Ctx {
        Ctx {
            cli: vec!["docker".into()],
            lang: Lang::Pt,
            runner: Arc::new(Script(script.into())),
            now: Arc::new(|| 0.0),
        }
    }

    #[tokio::test]
    async fn logs_whole_lines_rest_and_end() {
        let s = open(
            &ctx("printf 'um\\nd'; sleep 0.1; printf 'ois\\n'; echo erro >&2; printf fim"),
            "/api/logs/0123456789ab/stream",
            "",
        )
        .await
        .unwrap();
        let got: Vec<StreamMsg> = s.collect().await;
        let d = |s: &str| StreamMsg::Data(json!(s).to_string());
        assert_eq!(got, vec![d("um\n"), d("dois\n"), d("erro\n"), d("fim"), StreamMsg::End]);
    }

    #[tokio::test]
    async fn logs_validate_like_python() {
        let c = ctx("true");
        assert_eq!(open(&c, "/api/logs/0123456789ab/stream", "tail=").await.err().unwrap().status, 400);
        assert_eq!(open(&c, "/api/logs/0123456789ab/stream", "since=2d").await.err().unwrap().status, 400);
        assert_eq!(open(&c, "/api/logs/WEB/stream", "").await.err().unwrap().status, 404);
    }

    #[tokio::test]
    async fn events_one_notice_per_batch_and_ignore_exec() {
        let script =
            r#"printf '{"Action":"exec_start: x"}\n'; sleep 0.1; printf '{"Action":"start"}\n{"Action":"die"}\n'"#;
        let got: Vec<StreamMsg> = open(&ctx(script), "/api/events/stream", "").await.unwrap().collect().await;
        assert_eq!(got, vec![StreamMsg::Data("1".into()), StreamMsg::End]);
    }

    #[tokio::test]
    async fn dropping_the_stream_kills_the_docker() {
        let pidfile = std::env::temp_dir().join(format!("stivo-stream-{}", std::process::id()));
        let script = format!("echo $$ > {}; exec sleep 30", pidfile.display());
        let s = open(&ctx(&script), "/api/logs/0123456789ab/stream", "").await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let pid = std::fs::read_to_string(&pidfile).unwrap().trim().to_string();
        drop(s);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let alive = std::process::Command::new("kill").args(["-0", &pid]).status().unwrap().success();
        let _ = std::fs::remove_file(&pidfile);
        assert!(!alive, "o docker continuou vivo depois que o stream foi solto");
    }
}
