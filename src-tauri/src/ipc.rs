// Os comandos que a página chama (src/transport-desktop.ts): uma casca fina sobre o núcleo. O formato é o da API HTTP
// da versão web, então o mesmo roteador (stivo_core::handle) atende aqui e no harness dos testes.
use std::sync::atomic::Ordering;

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{Value, json};
use stivo_core::streams::StreamMsg;
use stivo_core::{Method, Reply, Request, terminal, validate};
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::AppState;

#[derive(Serialize)]
pub struct ApiReply {
    status: u16,
    body: Value,
}

fn method(m: &str) -> Method {
    if m == "POST" { Method::Post } else { Method::Get }
}

/// Leitura e escrita: o mesmo que um fetch para /api/... na versão web
#[tauri::command]
pub async fn api(
    state: State<'_, AppState>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<ApiReply, String> {
    match stivo_core::handle(&state.ctx(), Request::new(self::method(&method), &path, body)).await {
        Reply::Json(r) => Ok(ApiReply { status: r.status, body: r.body }),
        Reply::Ndjson(_) => Err("rota com stream: use stream_open".into()),
    }
}

/// Os streams: GET (logs ao vivo, logs do projeto, eventos) como o EventSource, mensagens {data} e {end}; POST (o
/// compose) como o NDJSON, mensagens {line} e {end}. A recusa antes de abrir volta como {status, body}
#[tauri::command]
pub async fn stream_open(
    state: State<'_, AppState>,
    method: String,
    path: String,
    query: String,
    body: Option<Value>,
    channel: Channel<Value>,
) -> Result<u32, ApiReply> {
    let ctx = state.ctx();
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    let task = if self::method(&method) == Method::Get {
        let mut s = stivo_core::streams::open(&ctx, &path, &query)
            .await
            .map_err(|r| ApiReply { status: r.status, body: r.body })?;
        tauri::async_runtime::spawn(async move {
            while let Some(m) = s.next().await {
                let msg = match m {
                    StreamMsg::Data(d) => json!({"data": d}),
                    StreamMsg::End => json!({"end": true}),
                };
                if channel.send(msg).is_err() {
                    break; // a página foi embora: soltar o stream mata o docker
                }
            }
        })
    } else {
        let mut lines = match stivo_core::handle(&ctx, Request::new(Method::Post, &path, body)).await {
            Reply::Ndjson(lines) => lines,
            Reply::Json(r) => return Err(ApiReply { status: r.status, body: r.body }),
        };
        tauri::async_runtime::spawn(async move {
            // o compose segue até o fim mesmo que a página saia: aqui só deixa de mandar
            while let Some(line) = lines.next().await {
                let _ = channel.send(json!({"line": line}));
            }
            let _ = channel.send(json!({"end": true}));
        })
    };
    state.streams.lock().unwrap().insert(id, task);
    Ok(id)
}

#[tauri::command]
pub fn stream_close(state: State<'_, AppState>, id: u32) {
    if let Some(t) = state.streams.lock().unwrap().remove(&id) {
        t.abort();
    }
}

/// Terminal: docker exec -it num PTY. A saída vai em bytes pelo canal e o fim como {closed: true}
#[tauri::command]
pub fn term_open(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
    channel: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    if !validate::ID_RE.is_match(&id) {
        return Err("not found".into());
    }
    let out = channel.clone();
    let term = terminal::open(
        &state.ctx().cli,
        &id,
        cols,
        rows,
        move |b| drop(out.send(InvokeResponseBody::Raw(b))),
        move || drop(channel.send(InvokeResponseBody::Json(r#"{"closed":true}"#.into()))),
    )
    .map_err(|e| e.to_string())?;
    let n = state.next.fetch_add(1, Ordering::Relaxed);
    state.terms.lock().unwrap().insert(n, term);
    Ok(n)
}

/// síncrono de propósito: os comandos síncronos rodam na ordem em que chegam, então as teclas não se embaralham
#[tauri::command]
pub fn term_input(state: State<'_, AppState>, term: u32, data: String) {
    if let Some(t) = state.terms.lock().unwrap().get(&term) {
        let _ = t.write(data.as_bytes());
    }
}

#[tauri::command]
pub fn term_resize(state: State<'_, AppState>, term: u32, cols: u16, rows: u16) {
    if let Some(t) = state.terms.lock().unwrap().get(&term) {
        let _ = t.resize(cols, rows);
    }
}

#[tauri::command]
pub fn term_close(state: State<'_, AppState>, term: u32) {
    if let Some(t) = state.terms.lock().unwrap().remove(&term) {
        t.close(); // o shell dentro do container pode sobreviver (moby#9098)
    }
}
