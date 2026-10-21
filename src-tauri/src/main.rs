// sem a janela de console no Windows, no build de release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    stivo_lib::run()
}
