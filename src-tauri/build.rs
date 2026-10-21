/// Comandos do app: só a janela main pode chamá-los (capabilities/main.json)
const COMMANDS: &[&str] = &[
    "api",
    "stream_open",
    "stream_close",
    "term_open",
    "term_input",
    "term_resize",
    "term_close",
    "attention",
    "notify",
    "prefs_get",
    "prefs_set",
    "open_dir",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri build");
}
