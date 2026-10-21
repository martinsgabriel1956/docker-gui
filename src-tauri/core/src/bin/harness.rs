//! Só teste: o núcleo servido por HTTP com o mesmo contrato do docker_gui.py, para os specs do Playwright rodarem
//! contra ele (GUI_BACKEND=rust). Serve a página da web (o PAGE do docker_gui.py) e confere Host, token e Origin como o
//! Python. Nunca entra no instalador: o app desktop fala com o núcleo pela IPC, sem porta aberta.
//!
//!     cargo run -p stivo-core --features harness --bin harness -- --port 0
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method as HttpMethod, StatusCode, Uri, header};
use axum::response::Response;
use futures_util::StreamExt;
use serde_json::Value;
use stivo_core::i18n::trf;
use stivo_core::{Ctx, Lang, Method, Reply, Request};

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
    let router = Router::new().fallback(dispatch).with_state(app);
    axum::serve(listener, router).await.unwrap();
}
