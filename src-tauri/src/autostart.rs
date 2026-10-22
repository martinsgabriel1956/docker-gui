// Iniciar com o sistema: o mecanismo de login de cada sistema, na sessão do usuário e sem administrador. O estado é o
// do sistema, lido a cada vez (a pessoa pode apagar a entrada por fora); nada vai para o prefs.json
use std::io;

/// o login abre o app com este argumento: a janela nasce escondida, direto na bandeja
pub const ARG: &str = "--autostart";

/// desligar o que não existe não é erro
fn absent_ok(r: io::Result<()>) -> io::Result<()> {
    match r {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

// Linux: XDG Autostart. O TryExec faz a sessão ignorar a entrada quando o pacote é removido (RF3.1)
#[cfg(target_os = "linux")]
fn file() -> Option<std::path::PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|d| !d.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".config")))?;
    Some(config.join("autostart/io.github.martinsgabriel1956.Stivo.desktop"))
}

// ponytail: o caminho vai sem o escape do Exec (aspas, $, crase); o current_exe é /usr/bin/stivo nos pacotes
#[cfg(target_os = "linux")]
fn entry() -> io::Result<String> {
    let exe = std::env::current_exe()?;
    let exe = exe.display();
    Ok(format!(
        "[Desktop Entry]\nType=Application\nName=Stivo\nExec=\"{exe}\" {ARG}\nTryExec={exe}\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n"
    ))
}

/// só a entrada que o app grava conta: desligada pelo GNOME ou apontando para outro executável é desligada (RF1.3)
#[cfg(target_os = "linux")]
pub fn enabled() -> bool {
    let (Some(f), Ok(want)) = (file(), entry()) else { return false };
    std::fs::read_to_string(f).is_ok_and(|have| have == want)
}

#[cfg(target_os = "linux")]
pub fn set(on: bool) -> io::Result<()> {
    let f = file().ok_or_else(|| io::Error::other("sem HOME"))?;
    if !on {
        return absent_ok(std::fs::remove_file(f));
    }
    std::fs::create_dir_all(f.parent().expect("autostart/"))?;
    std::fs::write(f, entry()?)
}

// Windows: o valor Stivo em HKCU\...\Run, apagado na desinstalação pelos instaladores (windows/hooks.nsh e
// windows/autostart.wxs)
#[cfg(windows)]
const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
fn line() -> io::Result<String> {
    Ok(format!("\"{}\" {ARG}", std::env::current_exe()?.display()))
}

#[cfg(windows)]
pub fn enabled() -> bool {
    let have = winreg::HKCU.open_subkey(RUN).and_then(|k| k.get_value::<String, _>("Stivo"));
    matches!((have, line()), (Ok(have), Ok(want)) if have == want)
}

#[cfg(windows)]
pub fn set(on: bool) -> io::Result<()> {
    let (run, _) = winreg::HKCU.create_subkey(RUN)?;
    if on { run.set_value("Stivo", &line()?) } else { absent_ok(run.delete_value("Stivo")) }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn linux_entry_follows_the_file() {
        let dir = std::env::temp_dir().join(format!("stivo-autostart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // SAFETY: o único teste do crate que lê ou escreve esta variável
        unsafe { std::env::set_var("XDG_CONFIG_HOME", &dir) };
        let file = dir.join("autostart/io.github.martinsgabriel1956.Stivo.desktop");
        assert!(!enabled());
        set(false).unwrap(); // desligar o que não existe é Ok
        set(true).unwrap();
        let exe = std::env::current_exe().unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains(&format!("Exec=\"{}\" {ARG}\n", exe.display())));
        assert!(text.contains(&format!("TryExec={}\n", exe.display())));
        assert!(enabled());
        std::fs::remove_file(&file).unwrap(); // apagado por fora (painel do GNOME): a tela mostra desligado
        assert!(!enabled());
        set(true).unwrap();
        set(false).unwrap();
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
