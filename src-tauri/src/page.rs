// A página do app no protocolo próprio dg:// (no Windows, http://dg.localhost): o mesmo HTML da versão web, com o
// transporte do Tauri, e os data-* do <html> preenchidos na hora (CLI, contexto, se é remoto, a língua), como o main()
// do docker_gui.py faz. Recarregar a página relê as preferências.
use tauri::http::{Request, Response, header};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder};

use crate::AppState;

/// gerado pelo build.py a partir de src/ (o CI confere que está em dia)
const PAGE: &str = include_str!("../dist/index.html");

// o JS e o CSS estão em linha no HTML único, como na versão web; nada carrega de fora
const CSP: &str = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; \
                   connect-src ipc: http://ipc.localhost; frame-ancestors 'none'; object-src 'none'; base-uri 'none'";

pub fn url() -> tauri::Url {
    // no Windows e no Android os protocolos próprios viram http://<nome>.localhost
    if cfg!(windows) { "http://dg.localhost/" } else { "dg://localhost/" }.parse().unwrap()
}

pub fn protocol<R: tauri::Runtime>(ctx: UriSchemeContext<'_, R>, req: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let res = if req.uri().path() == "/" {
            let core = app.state::<AppState>().ctx();
            let html = stivo_core::page::render(PAGE, &core).await;
            Response::builder()
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header("Content-Security-Policy", CSP)
                .body(html.into_bytes())
        } else {
            Response::builder().status(404).body(Vec::new())
        };
        responder.respond(res.unwrap());
    });
}
