// As rotas /api/* do Handler do docker_gui.py, sem HTTP: o mesmo roteador atende a IPC do app desktop e o harness dos
// testes. A autenticação (token, Host, Origin) fica de fora: na IPC, quem chama é a própria janela; no harness, o
// servidor confere antes de chegar aqui. A ordem dos testes e as mensagens seguem o do_GET e o do_POST de lá.
use std::sync::LazyLock;

use futures_util::stream::BoxStream;
use regex::Regex;
use serde_json::{Value, json};

use crate::cli::{ACTION_TIMEOUT, Ctx, READ_TIMEOUT};
use crate::i18n::{tr, trf};
use crate::normalize::{self as n, Use};
use crate::pyfmt::{parse_qs, qs_get};
use crate::validate as v;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Clone, Debug)]
pub struct Request {
    pub method: Method,
    /// sem a query
    pub path: String,
    /// sem o "?"
    pub query: String,
    /// None: sem corpo ou corpo que não é JSON (o Python responde igual aos dois)
    pub body: Option<Value>,
}

impl Request {
    /// "/api/logs/<id>?tail=500" -> path e query
    pub fn new(method: Method, target: &str, body: Option<Value>) -> Request {
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        Request { method, path: path.to_string(), query: query.to_string(), body }
    }

    /// o self.path do Python: algumas rotas casam com o caminho inteiro, com a query
    pub fn full(&self) -> String {
        if self.query.is_empty() { self.path.clone() } else { format!("{}?{}", self.path, self.query) }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: Value,
}

pub fn reply(status: u16, body: impl Into<Value>) -> Response {
    Response { status, body: body.into() }
}

pub enum Reply {
    Json(Response),
    /// o compose: uma linha de saída por item (string) e, no fim, {"code": n}
    Ndjson(BoxStream<'static, Value>),
}

/// o early return do Python (self.send(...); return None): o erro já é a resposta
type Step<T> = Result<T, Response>;

fn not_found() -> Response {
    reply(404, "not found")
}

fn caps(re: &str, s: &str) -> Option<Vec<String>> {
    static CACHE: LazyLock<std::sync::Mutex<Vec<(String, Regex)>>> = LazyLock::new(Default::default);
    let mut cache = CACHE.lock().unwrap();
    let re = match cache.iter().find(|(k, _)| k == re) {
        Some((_, r)) => r.clone(),
        None => {
            let r = Regex::new(&format!("^(?:{re})$")).unwrap();
            cache.push((re.to_string(), r.clone()));
            r
        }
    };
    re.captures(s).map(|c| c.iter().map(|m| m.map_or(String::new(), |m| m.as_str().to_string())).collect())
}

pub async fn handle(ctx: &Ctx, req: Request) -> Reply {
    match req.method {
        Method::Get => Reply::Json(get(ctx, &req).await.unwrap_or_else(|e| e)),
        Method::Post => post(ctx, &req).await,
    }
}

async fn get(ctx: &Ctx, req: &Request) -> Step<Response> {
    let (path, full) = (req.path.as_str(), req.full());
    if path == "/api/compose/logs" {
        // todos os serviços juntos, em ordem cronológica
        let qs = parse_qs(&req.query, true);
        let tail = log_tail(ctx, &qs)?;
        let since = log_since(ctx, &qs, None).await?;
        let base = compose_query(ctx, &req.query).await?;
        let args: Vec<String> = [&base[..], &strs(&v::COMPOSE_LOGS), &strs(tail), &since].concat();
        // sem --tail, o log inteiro de todos os containers: o prazo das ações
        let r = ctx.docker_owned(&args, if tail.is_empty() { ACTION_TIMEOUT } else { READ_TIMEOUT }).await;
        return Ok(if r.code != 0 { reply(500, r.stderr.trim()) } else { reply(200, n::by_time(&r.stdout)) });
    }
    if path == "/api/compose/services" {
        let base = compose_query(ctx, &req.query).await?;
        return Ok(reply(200, compose_services(ctx, &base).await?));
    }
    if full == "/api/containers" || full == "/api/stats" || full == "/api/df" {
        // o ps e o stats do podman só saem completos em "json" (um array); o resto em um JSON por linha
        let fmt = if full != "/api/df" && ctx.podman() { "json" } else { "{{json .}}" };
        let r = match full.as_str() {
            "/api/containers" => ctx.docker(&["ps", "-a", "--format", fmt], READ_TIMEOUT).await,
            "/api/stats" => ctx.docker(&["stats", "--no-stream", "--format", fmt], READ_TIMEOUT).await,
            // o df soma o tamanho dos volumes na hora: pode passar do prazo de leitura
            _ => ctx.docker(&["system", "df", "--format", fmt], ACTION_TIMEOUT).await,
        };
        if r.code != 0 {
            return Ok(reply(500, r.stderr.trim()));
        }
        let body = match full.as_str() {
            "/api/containers" => n::containers(&r.stdout),
            "/api/stats" => n::stats(&r.stdout),
            _ => serde_json::from_str(&format!("[{}]", r.stdout.lines().collect::<Vec<_>>().join(","))).ok(),
        };
        let cmd = format!("{} {}", ctx.cli[0], full.trim_start_matches("/api/"));
        return Ok(body.map_or_else(|| format_error(ctx, &cmd), |b| reply(200, b)));
    }
    if let Some(m) = caps(r"/api/(\w+)", &full)
        && ["images", "volumes", "networks"].contains(&m[1].as_str())
    {
        return Ok(objects(ctx, &m[1]).await);
    }
    if let Some(m) = caps(r"/api/logs/([0-9a-f]{12,64})", path) {
        let qs = parse_qs(&req.query, true);
        if qs.iter().any(|(k, _)| k != "tail" && k != "since") {
            return Ok(not_found()); // só ?tail= e ?since=
        }
        let tail = log_tail(ctx, &qs)?;
        let since = log_since(ctx, &qs, Some(&m[1])).await?;
        let args: Vec<String> = [&strs(&["logs", "--timestamps"]), &strs(tail), &since, &[m[1].clone()][..]].concat();
        // o log inteiro pode ser grande: sem --tail, o prazo das ações
        let r = ctx.docker_owned(&args, if tail.is_empty() { ACTION_TIMEOUT } else { READ_TIMEOUT }).await;
        return Ok(reply(if r.code != 0 { 500 } else { 200 }, format!("{}{}", r.stdout, r.stderr)));
    }
    if let Some(m) = caps(r"/api/health/([0-9a-f]{12,64})", &full) {
        // saída dos probes do healthcheck (não aparece em docker logs)
        let r = ctx.docker(&["inspect", "--format", "{{json .State.Health}}", &m[1]], READ_TIMEOUT).await;
        return Ok(if r.code != 0 {
            reply(500, r.stderr.trim())
        } else {
            serde_json::from_str::<Value>(r.stdout.trim())
                .map_or_else(|_| reply(500, r.stdout.trim()), |b| reply(200, b))
        });
    }
    if let Some(m) = caps(r"/api/history/([0-9a-f]{12,64})", &full) {
        // --until: sem ele o docker events fica esperando eventos novos. O segundo seguinte, para não perder o que
        // acabou de acontecer
        let until = ((ctx.now)() as i64 + 1).to_string();
        let filter = format!("container={}", m[1]);
        let fmt = if ctx.podman() { "json" } else { "{{json .}}" };
        let args = [
            "events",
            "--since",
            "24h",
            "--until",
            &until,
            "--filter",
            &filter,
            "--filter",
            "type=container",
            "--format",
            fmt,
        ];
        let r = ctx.docker(&args, READ_TIMEOUT).await;
        return Ok(if r.code != 0 { reply(500, r.stderr.trim()) } else { reply(200, n::history(&r.stdout)) });
    }
    if let Some(m) = caps(r"/api/top/([0-9a-f]{12,64})", &full) {
        let r = ctx.docker(&["top", &m[1]], READ_TIMEOUT).await;
        return Ok(reply(
            if r.code != 0 { 500 } else { 200 },
            if r.code != 0 { r.stderr.trim() } else { r.stdout.trim() },
        ));
    }
    if let Some(m) = caps(r"/api/inspect/([0-9a-f]{12,64})(/env)?", &full) {
        // resumo do inspect; só o /env (pedido explícito na página) traz os valores do env
        let r = ctx.docker(&["inspect", "--format", "{{json .}}", &m[1]], READ_TIMEOUT).await;
        if r.code != 0 {
            return Ok(reply(500, r.stderr.trim()));
        }
        let info: Value = serde_json::from_str(&r.stdout).unwrap_or(Value::Null);
        return Ok(reply(200, n::summary(&info, !m[2].is_empty())));
    }
    Ok(not_found())
}

async fn post(ctx: &Ctx, _req: &Request) -> Reply {
    let _ = ctx;
    Reply::Json(not_found())
}

fn strs(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

fn format_error(ctx: &Ctx, cmd: &str) -> Response {
    reply(500, trf(ctx.lang, "formato inesperado na saída do {cmd}", &[("cmd", cmd)]))
}

/// Imagens, volumes ou redes, cada uma com os containers que a usam, no mesmo formato para docker e podman
async fn objects(ctx: &Ctx, kind: &str) -> Response {
    let argv: &[&str] = match kind {
        "images" => &["image", "ls", "--no-trunc"],
        "volumes" => &["volume", "ls"],
        _ => &["network", "ls", "--no-trunc"],
    };
    let fmt = if ctx.podman() { "json" } else { "{{json .}}" };
    let r = ctx.docker(&[argv, &["--format", fmt]].concat(), READ_TIMEOUT).await;
    let mut use_ = if r.code != 0 {
        return reply(500, r.stderr.trim());
    } else {
        match usage(ctx).await {
            Ok(u) => u,
            Err(e) => return reply(500, e),
        }
    };
    if kind == "volumes" {
        use_.size = volume_sizes(ctx).await;
    }
    let body = n::rows(&r.stdout).and_then(|items| match kind {
        "images" => n::images(&items, &use_),
        "volumes" => n::volumes(&items, &use_),
        _ => n::networks(&items, &use_),
    });
    let cmd = [&[ctx.cli[0].as_str()][..], argv].concat().join(" ");
    body.map_or_else(|| format_error(ctx, &cmd), |b| reply(200, b))
}

/// Quem usa cada imagem, volume e rede: um ps e um inspect de todos os containers de uma vez. Erro: o stderr
async fn usage(ctx: &Ctx) -> Result<Use, String> {
    let r = ctx.docker(&["ps", "-a", "-q", "--no-trunc"], READ_TIMEOUT).await;
    if r.code != 0 {
        return Err(r.stderr.trim().to_string());
    }
    let ids: Vec<String> = r.stdout.split_whitespace().map(String::from).collect();
    if ids.is_empty() {
        return Ok(Use::default());
    }
    let r = ctx.docker_owned(&[strs(&["container", "inspect"]), ids].concat(), READ_TIMEOUT).await;
    // container removido entre o ps e o inspect: o docker sai com erro, mas lista os outros
    if !r.stdout.trim_start().starts_with('[') {
        return Err(r.stderr.trim().to_string());
    }
    let items: Vec<Value> = serde_json::from_str(&r.stdout).map_err(|e| e.to_string())?;
    Ok(n::usage_from_inspect(&items))
}

/// Tamanho de cada volume, do `system df -v` (o volume ls não diz). Podman e qualquer falha: sem tamanho
async fn volume_sizes(ctx: &Ctx) -> serde_json::Map<String, Value> {
    if ctx.podman() {
        return Default::default();
    }
    let r = ctx.docker(&["system", "df", "-v", "--format", "{{json .Volumes}}"], ACTION_TIMEOUT).await;
    if r.code != 0 {
        return Default::default();
    }
    let parsed: Option<Vec<Value>> = serde_json::from_str::<Value>(&r.stdout).ok().and_then(|v| match v {
        Value::Null => Some(vec![]),
        Value::Array(a) => Some(a),
        _ => None,
    });
    parsed
        .and_then(|vs| {
            vs.iter()
                .map(|v| Some((v.get("Name")?.as_str()?.to_string(), v.get("Size").cloned().unwrap_or(json!("")))))
                .collect::<Option<serde_json::Map<_, _>>>()
        })
        .unwrap_or_default()
}

/// ?tail= (padrão 500) -> as flags da lista fixa; fora dela, 400
fn log_tail(ctx: &Ctx, qs: &[(String, Vec<String>)]) -> Step<&'static [&'static str]> {
    let default = vec!["500".to_string()];
    let tail = qs_get(qs, "tail").unwrap_or(&default);
    match (tail.len(), tail.first().and_then(|t| v::log_tail(t))) {
        (1, Some(flags)) => Ok(flags),
        _ => Err(reply(400, tr(ctx.lang, "tail inválido"))),
    }
}

/// ?since= (padrão: o log inteiro) -> as flags da lista fixa, ou o --since com o início atual do container (start)
async fn log_since(ctx: &Ctx, qs: &[(String, Vec<String>)], cid: Option<&str>) -> Step<Vec<String>> {
    let Some(since) = qs_get(qs, "since") else { return Ok(vec![]) };
    if since.len() == 1
        && let Some(flags) = v::log_since(&since[0])
    {
        return Ok(strs(flags));
    }
    let (true, Some(cid)) = (since == &["start"], cid) else { return Err(reply(400, tr(ctx.lang, "since inválido"))) };
    // {{json}}: o docker guarda o StartedAt como texto e o podman como data; em JSON os dois saem RFC 3339
    let r = ctx.docker(&["inspect", "--format", "{{json .State.StartedAt}}", cid], READ_TIMEOUT).await;
    let started = (r.code == 0).then(|| serde_json::from_str::<Value>(&r.stdout).ok()).flatten();
    match started.as_ref().and_then(Value::as_str).filter(|s| v::STARTED_RE.is_match(s)) {
        Some(s) => Ok(strs(&["--since", s])),
        None => {
            let msg = if r.stderr.trim().is_empty() {
                tr(ctx.lang, "não consegui ler quando o container subiu")
            } else {
                r.stderr.trim().to_string()
            };
            Err(reply(500, msg))
        }
    }
}

/// {project, dir} na query das rotas GET (os logs do projeto) -> compose_base
async fn compose_query(ctx: &Ctx, query: &str) -> Step<Vec<String>> {
    let qs = parse_qs(query, false);
    let get = |k| qs_get(&qs, k).and_then(|v| v.first()).cloned().unwrap_or_default();
    let (project, dir) = (get("project"), get("dir"));
    if project.is_empty() || dir.is_empty() {
        return Err(reply(400, tr(ctx.lang, "query inválida: esperado ?project=...&dir=...")));
    }
    compose_base(ctx, &project, &dir, None).await
}

/// Começo do argv (compose -p, --project-directory e os -f) montado só com os labels dos containers: o par
/// {project, dir} tem que existir neles e o service, se veio, ser um dos serviços desse projeto
pub(crate) async fn compose_base(ctx: &Ctx, project: &str, wd: &str, service: Option<&str>) -> Step<Vec<String>> {
    let r = ctx
        .docker(
            &["ps", "-a", "--filter", "label=com.docker.compose.project", "--format", v::COMPOSE_FORMAT],
            READ_TIMEOUT,
        )
        .await;
    if r.code != 0 {
        return Err(reply(500, r.stderr.trim()));
    }
    let rows: Vec<Vec<Value>> = r
        .stdout
        .lines()
        .filter_map(|l| serde_json::from_str::<Vec<Value>>(l).ok())
        .filter(|row| row.len() >= 2 && row[0] == project && row[1] == wd)
        .collect();
    if rows.is_empty() {
        return Err(reply(404, tr(ctx.lang, "projeto compose não encontrado")));
    }
    if let Some(svc) = service
        && !rows.iter().any(|row| row.get(3).and_then(Value::as_str) == Some(svc))
    {
        return Err(reply(404, tr(ctx.lang, "serviço não encontrado no projeto")));
    }
    let mut base = strs(&["compose", "-p", project, "--project-directory", wd]);
    for f in rows[0].get(2).and_then(Value::as_str).unwrap_or("").split(',').filter(|f| !f.is_empty()) {
        base.extend(["-f".to_string(), f.to_string()]);
    }
    Ok(base)
}

/// Serviços do arquivo do compose (config --services), inclusive os que nunca subiram
pub(crate) async fn compose_services(ctx: &Ctx, base: &[String]) -> Step<Vec<String>> {
    let r = ctx.docker_owned(&[base, &strs(&["config", "--services"])].concat(), READ_TIMEOUT).await;
    if r.code != 0 {
        return Err(reply(500, r.stderr.trim()));
    }
    Ok(r.stdout.split_whitespace().map(String::from).collect())
}
