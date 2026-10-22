// Executar o CLI (docker ou podman, com o --context): o docker() do Python. Nenhum shell: binário e lista de argumentos.
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use crate::i18n::{Lang, trf};

// leitura (ps, logs, inspect) é rápida; stop/restart esperam o stop_grace_period do container
pub const READ_TIMEOUT: Duration = Duration::from_secs(15);
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(120);
// pull e up baixam imagens (e o --build compila); o run baixa a imagem se ela faltar
pub const COMPOSE_TIMEOUT: Duration = Duration::from_secs(600);
pub const RUN_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug)]
pub enum RunError {
    Timeout,
    Spawn(String),
}

#[async_trait::async_trait]
pub trait Runner: Send + Sync {
    /// cli: binário e flags globais; args: o resto (é o que o contrato confere)
    async fn run(&self, cli: &[String], args: &[String], timeout: Duration) -> Result<Output, RunError>;

    /// processo longo (streams, compose, exec): quem chama liga os pipes. Os testes trocam o programa por um falso
    fn command(&self, cli: &[String], args: &[String]) -> tokio::process::Command {
        command(cli, args)
    }
}

/// tokio::process::Command do CLI, sem janela de console no Windows e morto se o handle cair
pub fn command(cli: &[String], args: &[String]) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(&cli[0]);
    c.args(&cli[1..]).args(args).stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: sem isso cada consulta pisca um console
    c
}

pub struct RealRunner;

#[async_trait::async_trait]
impl Runner for RealRunner {
    async fn run(&self, cli: &[String], args: &[String], timeout: Duration) -> Result<Output, RunError> {
        let child = command(cli, args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| RunError::Spawn(e.to_string()))?;
        // sem prazo, um daemon travado prende uma task por poll para sempre; o kill_on_drop mata o docker que passou dele
        match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Err(_) => Err(RunError::Timeout),
            Ok(Err(e)) => Err(RunError::Spawn(e.to_string())),
            Ok(Ok(o)) => Ok(Output {
                code: o.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
            }),
        }
    }
}

pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

/// O que cada requisição precisa: o CLI escolhido, a língua das mensagens, quem executa e o relógio
#[derive(Clone)]
pub struct Ctx {
    pub cli: Vec<String>,
    pub lang: Lang,
    pub runner: Arc<dyn Runner>,
    pub now: Clock,
}

impl Ctx {
    pub fn new(cli: Vec<String>, lang: Lang) -> Ctx {
        Ctx {
            cli,
            lang,
            runner: Arc::new(RealRunner),
            now: Arc::new(|| {
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
            }),
        }
    }

    /// O docker() do Python: prazo estourado vira código 124 com a mensagem; binário que não existe, 127 com o erro
    pub async fn docker(&self, args: &[&str], timeout: Duration) -> Output {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        self.docker_owned(&args, timeout).await
    }

    pub async fn docker_owned(&self, args: &[String], timeout: Duration) -> Output {
        match self.runner.run(&self.cli, args, timeout).await {
            Ok(o) => o,
            Err(RunError::Timeout) => Output {
                code: 124,
                stdout: String::new(),
                stderr: trf(
                    self.lang,
                    "{cli} {cmd} não respondeu em {timeout}s. O daemon está travado?",
                    &[
                        ("cli", &self.cli[0]),
                        ("cmd", args.first().map_or("", |s| s)),
                        ("timeout", &timeout.as_secs().to_string()),
                    ],
                ),
            },
            Err(RunError::Spawn(e)) => {
                log::warn!("não consegui executar {}: {e}", self.cli[0]);
                Output { code: 127, stdout: String::new(), stderr: e }
            }
        }
    }

    /// pelo nome do binário (podman, /usr/bin/podman, podman.exe), como o podman() do Python
    pub fn podman(&self) -> bool {
        let bin = &self.cli[0];
        let base = bin.rsplit(['/', '\\']).next().unwrap_or(bin);
        base.starts_with("podman")
    }
}
