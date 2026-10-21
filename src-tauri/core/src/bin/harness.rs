//! Só teste: o núcleo servido por HTTP com o mesmo contrato do docker_gui.py, para os specs do Playwright rodarem
//! contra ele (GUI_BACKEND=rust). Serve a página da web (o PAGE do docker_gui.py) e confere Host, token e Origin como o
//! Python. Nunca entra no instalador: o app desktop fala com o núcleo pela IPC, sem porta aberta.
//!
//!     cargo run -p stivo-core --features harness --bin harness -- --port 0
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade, rejection::WebSocketUpgradeRejection};
use axum::extract::{Path as AxPath, State};
use axum::http::{HeaderMap, HeaderValue, Method as HttpMethod, StatusCode, Uri, header};
use axum::response::Response;
use axum::routing::get;
use futures_util::StreamExt;
use serde_json::Value;
use stivo_core::i18n::trf;
use stivo_core::streams::StreamMsg;
use stivo_core::{Ctx, Lang, Method, Reply, Request, terminal};

const MAX_BODY: usize = 64 * 1024;

struct App {
    ctx: Ctx,
    token: String,
    port: u16,
    page: String,
}

/// O PAGE do docker_gui.py (o bloco gerado pelo build.py), com o CSS no lugar do /*CSS*/
fn web_page() -> String {
    let path = std::env::var("STIVO_WEB_PAGE_SRC")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../docker_gui.py").to_string());
    let src = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let raw = |name: &str| {
        let start = src.find(&format!("\n{name} = r\"\"\"")).unwrap_or_else(|| panic!("{name} não encontrado"))
            + name.len()
            + 8;
        let end = start + src[start..].find("\"\"\"").unwrap();
        src[start..end].to_string()
    };
    raw("PAGE").replace("/*CSS*/", &raw("CSS"))
}

fn token() -> String {
    let mut b = [0u8; 24];
    getrandom::fill(&mut b).expect("sem fonte de aleatoriedade");
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    b.chunks(3)
        .flat_map(|c| {
            let n = (c[0] as u32) << 16 | (c[1] as u32) << 8 | c[2] as u32;
            (0..4).rev().map(move |i| A[(n >> (6 * i) & 63) as usize] as char)
        })
        .collect()
}

fn send(status: u16, body: &Value) -> Response {
    let mut r = Response::new(Body::from(body.to_string()));
    *r.status_mut() = StatusCode::from_u16(status).unwrap();
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    // a página nunca vai num iframe de outro site (clickjacking), como no Python
    h.insert("content-security-policy", HeaderValue::from_static("frame-ancestors 'none'"));
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    r
}

async fn dispatch(
    State(app): State<Arc<App>>,
    method: HttpMethod,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    // bloqueia DNS rebinding: só aceita acesso via localhost
    if host != format!("127.0.0.1:{}", app.port) && host != format!("localhost:{}", app.port) {
        return send(403, &Value::from("forbidden"));
    }
    let target = uri.path_and_query().map_or("/", |p| p.as_str());
    if method == HttpMethod::GET && target == "/" {
        let page = stivo_core::page::render(&app.page, &app.ctx).await;
        let mut r = send(200, &Value::Null);
        *r.body_mut() = Body::from(page);
        r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
        return r;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if method == HttpMethod::GET
        && (path == "/api/events/stream"
            || path == "/api/compose/logs/stream"
            || path.starts_with("/api/logs/") && path.ends_with("/stream"))
    {
        // EventSource não manda header custom: só estas rotas (GET, só leitura) aceitam o token na query
        let qs = stivo_core::pyfmt::parse_qs(query, true);
        if stivo_core::pyfmt::qs_get(&qs, "t").and_then(|t| t.first()).map(String::as_str) != Some(&app.token) {
            return send(401, &Value::from(stivo_core::i18n::tr(app.ctx.lang, "token ausente ou inválido")));
        }
        return match stivo_core::streams::open(&app.ctx, path, query).await {
            Err(r) => send(r.status, &r.body),
            Ok(s) => {
                let body = s.map(|m| {
                    Ok::<_, std::convert::Infallible>(match m {
                        StreamMsg::Data(d) => format!("data: {d}\n\n"),
                        StreamMsg::End => "event: end\ndata:\n\n".to_string(),
                    })
                });
                let mut r = Response::new(Body::from_stream(body));
                r.headers_mut()
                    .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream; charset=utf-8"));
                r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
                r
            }
        };
    }
    let token = headers.get("x-docker-gui-token").and_then(|h| h.to_str().ok()).unwrap_or("");
    if token != app.token {
        return send(401, &Value::from(stivo_core::i18n::tr(app.ctx.lang, "token ausente ou inválido")));
    }
    let method = if method == HttpMethod::POST { Method::Post } else { Method::Get };
    // corpo vazio, grande demais ou que não é JSON: None (o Python responde igual aos três)
    let json = (!body.is_empty() && body.len() <= MAX_BODY).then(|| serde_json::from_slice(&body).ok()).flatten();
    match stivo_core::handle(&app.ctx, Request::new(method, target, json)).await {
        Reply::Json(r) => send(r.status, &r.body),
        Reply::Ndjson(lines) => {
            let body = lines.map(|v| Ok::<_, std::convert::Infallible>(format!("{v}\n")));
            let mut r = Response::new(Body::from_stream(body));
            r.headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-ndjson; charset=utf-8"));
            r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            r
        }
    }
}

/// Terminal: WebSocket <-> docker exec num PTY. Mesmo protocolo do Python: a primeira mensagem (texto) é o tamanho,
/// depois texto é o tamanho novo e binário é o que foi digitado; a saída vai em binário, e o close quando o exec acaba
async fn exec(
    State(app): State<Arc<App>>,
    AxPath(id): AxPath<String>,
    uri: Uri,
    headers: HeaderMap,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let header = |k| headers.get(k).and_then(|h: &HeaderValue| h.to_str().ok()).unwrap_or("").to_string();
    let host = header(header::HOST);
    if host != format!("127.0.0.1:{}", app.port) && host != format!("localhost:{}", app.port) {
        return send(403, &Value::from("forbidden"));
    }
    let tr = |s| Value::from(stivo_core::i18n::tr(app.ctx.lang, s));
    if !stivo_core::validate::ID_RE.is_match(&id) {
        return send(404, &Value::from("not found"));
    }
    // WebSocket não passa por CORS: sem conferir o Origin, qualquer site aberto no navegador conectaria aqui
    let origin = header(header::ORIGIN);
    if origin != format!("http://127.0.0.1:{}", app.port) && origin != format!("http://localhost:{}", app.port) {
        return send(403, &tr("origem não permitida"));
    }
    let qs = stivo_core::pyfmt::parse_qs(uri.query().unwrap_or(""), false);
    if stivo_core::pyfmt::qs_get(&qs, "t").and_then(|t| t.first()).map(String::as_str) != Some(&app.token) {
        return send(401, &tr("token ausente ou inválido"));
    }
    let Ok(ws) = ws else { return send(400, &tr("esperava um WebSocket")) };
    ws.on_upgrade(move |socket| session(app, id, socket))
}

async fn session(app: Arc<App>, id: String, mut socket: WebSocket) {
    // a página manda o tamanho logo ao abrir, e o docker só sobe depois dele
    let Some(Ok(Message::Text(first))) = socket.recv().await else { return };
    let Some((cols, rows)) = terminal::parse_size(&first) else { return };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Option<Vec<u8>>>();
    let tx2 = tx.clone();
    let Ok(term) =
        terminal::open(&app.ctx.cli, &id, cols, rows, move |b| drop(tx.send(Some(b))), move || drop(tx2.send(None)))
    else {
        return;
    };
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(Some(b)) => if socket.send(Message::Binary(b.into())).await.is_err() { break },
                _ => {
                    let _ = socket.send(Message::Close(Some(CloseFrame { code: 1000, reason: "".into() }))).await;
                    break;
                }
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(t))) => match terminal::parse_size(&t) {
                    Some((c, r)) => { let _ = term.resize(c, r); }
                    None => break, // mensagem inválida: encerra
                },
                Some(Ok(Message::Binary(b))) => if term.write(&b).is_err() { break },
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                _ => break, // close ou conexão caiu
            },
        }
    }
    term.close(); // o shell dentro do container pode sobreviver (moby#9098)
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let env = |k: &str| std::env::var(k).ok();
    let lang = arg(&args, "--lang").map_or_else(|| Lang::from_env(env), |l| Lang::parse(&l));
    let mut cli = vec![arg(&args, "--cli").or_else(|| env("DOCKER_GUI_CLI")).unwrap_or_else(|| "docker".into())];
    if let Some(c) = arg(&args, "--context") {
        cli.extend(["--context".into(), c]);
    }
    let port: u16 = arg(&args, "--port").map_or(8765, |p| p.parse().expect("--port inválida"));
    let listener =
        tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await.expect("porta ocupada");
    let port = listener.local_addr().unwrap().port();
    let app = Arc::new(App { ctx: Ctx::new(cli, lang), token: token(), port, page: web_page() });
    let url = format!("http://localhost:{port}/#t={}", app.token);
    println!("{}", trf(lang, "Stivo em {url}  (Ctrl+C para sair)", &[("url", &url)]));
    let router = Router::new().route("/api/exec/{id}", get(exec)).fallback(dispatch).with_state(app);
    axum::serve(listener, router).await.unwrap();
}
