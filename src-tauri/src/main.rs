// sem a janela de console no Windows, no build de release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // cada thread (tokio, GTK, WebKit) ganharia uma arena própria do malloc da glibc, e a memória parada infla: com
    // o Stivo o dia inteiro na bandeja, duas arenas bastam (meta do PRD: até 150 MB com a janela fechada)
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: primeira coisa do main, antes de qualquer thread existir
    unsafe {
        libc::mallopt(libc::M_ARENA_MAX, 2);
    }
    stivo_lib::run()
}
