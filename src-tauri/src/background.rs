// O Stivo em segundo plano: fechar a janela só a esconde, a bandeja mostra a contagem da faixa de atenção (o ícone vem
// desenhado pela página, o mesmo do favicon) e a notificação do sistema avisa quando algo entra na faixa. Quando
// notificar é decisão da página (as mesmas regras da versão web); aqui só se exibe.
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::AppState;

/// os textos do desktop que o docker_gui.py não tem (a tabela do core é a do Python, conferida por teste)
fn t(app: &AppHandle<impl Runtime>, pt: &'static str, en: &'static str) -> &'static str {
    if app.state::<AppState>().ctx().lang == stivo_core::Lang::En { en } else { pt }
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", t(app, "Abrir o Stivo", "Open Stivo"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", t(app, "Sair", "Quit"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("ícone do app"))
        .tooltip("Stivo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            // no Windows o clique abre a janela; no Linux (AppIndicator) só existe o menu
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Fechar esconde: o Stivo continua vigiando. Na primeira vez, um aviso de como voltar e de como sair
pub fn on_close<R: Runtime>(window: &tauri::Window<R>, api: &tauri::CloseRequestApi) {
    api.prevent_close();
    let _ = window.hide();
    let app = window.app_handle();
    let state = app.state::<AppState>();
    let mut prefs = state.prefs.lock().unwrap();
    if !prefs.close_hint_shown {
        prefs.close_hint_shown = true;
        if let Ok(dir) = app.path().app_config_dir() {
            let _ = prefs.save(&dir);
        }
        show_notification(
            app,
            t(app, "O Stivo continua na bandeja", "Stivo is still in the tray"),
            t(
                app,
                "Ele segue vigiando os containers e avisa quando algo quebrar. Para sair, use Sair no menu da bandeja; abrir o Stivo de novo traz a janela de volta.",
                "It keeps watching your containers and lets you know when something breaks. To quit, use Quit in the tray menu; opening Stivo again brings the window back.",
            ),
        );
    }
}

/// a contagem da faixa de atenção: o ícone que a página desenhou e o texto para quem passa o mouse (Windows)
#[tauri::command]
pub fn attention(app: AppHandle, badge: String, tooltip: String, icon: Vec<u8>) {
    log::info!("bandeja: {}", if badge.is_empty() { "-" } else { &badge });
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(img) = Image::from_bytes(&icon) {
            let _ = tray.set_icon(Some(img));
        }
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) {
    if app.state::<AppState>().prefs.lock().unwrap().notifications() {
        show_notification(&app, &title, &body);
    }
}

/// Notificação do sistema. No Linux, o clique (ação default) traz a janela e avisa a página; no Windows o toast
/// traz o app à frente pela instância única
pub fn show_notification<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) {
    log::info!("notificação: {title}");
    let mut n = notify_rust::Notification::new();
    n.summary(title).body(body).appname("Stivo");
    #[cfg(target_os = "linux")]
    n.action("default", "Abrir").icon(&app.config().identifier);
    #[cfg(windows)]
    n.app_id(&app.config().identifier);
    let app = app.clone();
    std::thread::spawn(move || match n.show() {
        #[cfg(target_os = "linux")]
        Ok(handle) => handle.wait_for_action(|action| {
            if action == "default" {
                show_main(&app);
                let _ = app.emit("notification-click", ());
            }
        }),
        #[cfg(not(target_os = "linux"))]
        Ok(_) => drop(app),
        Err(e) => log::warn!("notificação não saiu: {e}"),
    });
}
