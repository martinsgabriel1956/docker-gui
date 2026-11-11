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
    // aberto pelo Finder, o app herda só /usr/bin:/bin:/usr/sbin:/sbin, sem o docker de nenhuma instalação comum
    // ponytail: lista fixa; ler o PATH do shell de login se aparecer uma instalação fora dela
    #[cfg(target_os = "macos")]
    // SAFETY: primeira coisa do main, antes de qualquer thread existir
    unsafe {
        let home = std::env::var("HOME").unwrap_or_default();
        let path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var(
            "PATH",
            format!(
                "{path}:/opt/homebrew/bin:/usr/local/bin:/opt/podman/bin:{home}/.docker/bin:{home}/.orbstack/bin:{home}/.rd/bin"
            ),
        );
    }
    stivo_lib::run()
}
