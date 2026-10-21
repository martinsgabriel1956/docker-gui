//! Stivo desktop: a janela com a página da versão web, falando com o núcleo (stivo-core) pela IPC, sem porta aberta.
mod ipc;
mod page;

use std::collections::HashMap;
use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex, RwLock};

use stivo_core::terminal::Terminal;
use stivo_core::{Ctx, Lang};
use tauri::{WebviewUrl, WebviewWindowBuilder};

pub struct AppState {
    ctx: RwLock<Ctx>,
    streams: Mutex<HashMap<u32, tauri::async_runtime::JoinHandle<()>>>,
    terms: Mutex<HashMap<u32, Arc<Terminal>>>,
    next: AtomicU32,
}

impl AppState {
    fn new() -> AppState {
        // os padrões de hoje: DOCKER_GUI_CLI (ou docker) e a língua do sistema; o DOCKER_CONTEXT o próprio docker lê
        let env = |k: &str| std::env::var(k).ok();
        let cli = vec![env("DOCKER_GUI_CLI").filter(|c| !c.is_empty()).unwrap_or_else(|| "docker".into())];
        AppState {
            ctx: RwLock::new(Ctx::new(cli, Lang::from_env(env))),
            streams: Mutex::default(),
            terms: Mutex::default(),
            next: AtomicU32::new(1),
        }
    }

    pub fn ctx(&self) -> Ctx {
        self.ctx.read().unwrap().clone()
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .register_asynchronous_uri_scheme_protocol("dg", page::protocol)
        .invoke_handler(tauri::generate_handler![
            ipc::api,
            ipc::stream_open,
            ipc::stream_close,
            ipc::term_open,
            ipc::term_input,
            ipc::term_resize,
            ipc::term_close,
        ])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(page::url()))
                .title("Stivo")
                .inner_size(1280.0, 820.0)
                .min_inner_size(480.0, 420.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao abrir o Stivo");
}
