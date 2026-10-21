//! Stivo desktop: a janela com a página da versão web, falando com o núcleo (stivo-core) pela IPC, sem porta aberta.
//! Fechar a janela deixa o app na bandeja, vigiando os containers.
mod background;
mod ipc;
mod page;
mod prefs;

use std::collections::HashMap;
use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex, RwLock};

use prefs::Prefs;
use stivo_core::Ctx;
use stivo_core::terminal::Terminal;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub struct AppState {
    ctx: RwLock<Ctx>,
    prefs: Mutex<Prefs>,
    streams: Mutex<HashMap<u32, tauri::async_runtime::JoinHandle<()>>>,
    terms: Mutex<HashMap<u32, Arc<Terminal>>>,
    next: AtomicU32,
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok()
}

impl AppState {
    fn new(prefs: Prefs) -> AppState {
        AppState {
            ctx: RwLock::new(Ctx::new(prefs.cli(env), prefs.lang(env))),
            prefs: Mutex::new(prefs),
            streams: Mutex::default(),
            terms: Mutex::default(),
            next: AtomicU32::new(1),
        }
    }

    pub fn ctx(&self) -> Ctx {
        self.ctx.read().unwrap().clone()
    }
}

/// O Stivo passa o dia na bandeja com a página viva (ela decide quando notificar): o WebKitGTK no modo de cache de
/// visualizador de documentos (uma página só, sem histórico) e sem aceleração por GPU gasta menos memória parado.
/// Meta do PRD: até 150 MB com a janela fechada (scripts/memory.sh --idle)
fn lean_webview(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "linux")]
    let _ = window.with_webview(|wv| {
        use webkit2gtk::{CacheModel, HardwareAccelerationPolicy, SettingsExt, WebContextExt, WebViewExt};
        let view = wv.inner();
        if let Some(ctx) = view.context() {
            ctx.set_cache_model(CacheModel::DocumentViewer);
        }
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Never);
        }
    });
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}

pub fn run() {
    tauri::Builder::default()
        // abrir o Stivo de novo traz a janela que já existe (e o clique no toast do Windows também passa por aqui)
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| background::show_main(app)))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Warn)
                .level_for("stivo_lib", log::LevelFilter::Info)
                .level_for("stivo_core", log::LevelFilter::Info)
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("dg", page::protocol)
        .invoke_handler(tauri::generate_handler![
            ipc::api,
            ipc::stream_open,
            ipc::stream_close,
            ipc::term_open,
            ipc::term_input,
            ipc::term_resize,
            ipc::term_close,
            background::attention,
            background::notify,
            ipc::prefs_get,
            ipc::prefs_set,
        ])
        .setup(|app| {
            let prefs = app.path().app_config_dir().map(|d| Prefs::load(&d)).unwrap_or_default();
            app.manage(AppState::new(prefs));
            background::tray(app.handle())?;
            log::info!("Stivo aberto");
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(page::url()))
                .title("Stivo")
                .inner_size(1280.0, 820.0)
                .min_inner_size(480.0, 420.0)
                // o título da página (contexto e contagens, como a aba da versão web) vira o da janela (PRD RF3.3)
                .on_document_title_changed(|w, title| {
                    let _ = w.set_title(&title);
                })
                .build()?;
            lean_webview(&window);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                background::on_close(window, api);
            }
        })
        .run(tauri::generate_context!())
        .expect("erro ao abrir o Stivo");
}
