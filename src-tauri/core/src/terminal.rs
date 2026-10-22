// Terminal no container: `docker exec -it` num PTY (portable-pty: PTY de verdade no Linux, ConPTY no Windows). O
// docker_gui.py, sem PTY no Windows, abre o TTY dentro do container com o `script`; aqui não precisa, então o modo
// pipe (TTY_INIT, TTY_MARK, PIPE_SHELL) não existe.
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

/// bash se a imagem tiver, senão sh (o SHELL do Python)
pub const SHELL: [&str; 3] = ["sh", "-c", "exec $(command -v bash || echo sh)"];

pub struct Terminal {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

fn err(e: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

/// Abre o exec já no tamanho da tela (um SIGWINCH antes de o shell subir se perderia). on_data recebe a saída;
/// on_close, quando o exec termina (o shell saiu, o container parou)
pub fn open(
    cli: &[String],
    id: &str,
    cols: u16,
    rows: u16,
    mut on_data: impl FnMut(Vec<u8>) + Send + 'static,
    on_close: impl FnOnce() + Send + 'static,
) -> std::io::Result<Arc<Terminal>> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(err)?;
    let mut cmd = CommandBuilder::new(&cli[0]);
    cmd.args(&cli[1..]);
    cmd.args(["exec", "-it", id]);
    cmd.args(SHELL);
    let child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave); // sem nenhum lado escravo aberto aqui, o read dá EOF quando o exec termina
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 65536];
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            on_data(buf[..n].to_vec());
        }
        on_close();
    });
    Ok(Arc::new(Terminal { master: Mutex::new(pair.master), writer: Mutex::new(writer), child: Mutex::new(child) }))
}

impl Terminal {
    pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()
    }

    pub fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        // o kernel avisa o programa em primeiro plano (vim...) com SIGWINCH
        self.master.lock().unwrap().resize(size(cols, rows)).map_err(err)
    }

    /// Mata o docker exec. O shell dentro do container pode sobreviver (moby#9098), como no Python
    pub fn close(&self) {
        let mut c = self.child.lock().unwrap();
        let _ = c.kill();
        let _ = c.wait();
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.close();
    }
}

/// {"cols": .., "rows": ..} da página -> (cols, rows); só inteiros de 16 bits, como o term_size do Python
pub fn parse_size(text: &str) -> Option<(u16, u16)> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let n = |k: &str| v.get(k)?.as_u64().filter(|n| *n < 1 << 16).map(|n| n as u16);
    Some((n("cols")?, n("rows")?))
}

#[cfg(all(test, unix))]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    #[test]
    fn opens_at_size_echoes_input_and_closes() {
        // o "docker" é um sh que mostra o tamanho do TTY, lê uma linha e sai (o resto do argv vira $1...)
        let cli: Vec<String> =
            ["sh", "-c", "stty size; read l; echo \"got:$l\"", "docker"].iter().map(|s| s.to_string()).collect();
        let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
        let tx2 = tx.clone();
        let term =
            open(&cli, "0123456789ab", 100, 30, move |b| tx.send(Some(b)).unwrap(), move || tx2.send(None).unwrap())
                .unwrap();
        let mut out = String::new();
        let wait_for = |want: &str, out: &mut String| {
            while !out.contains(want) {
                match rx.recv_timeout(Duration::from_secs(5)).expect(want) {
                    Some(b) => out.push_str(&String::from_utf8_lossy(&b)),
                    None => panic!("fechou antes de {want}: {out}"),
                }
            }
        };
        wait_for("30 100", &mut out);
        term.write(b"oi\n").unwrap();
        wait_for("got:oi", &mut out);
        while let Ok(Some(_)) = rx.recv_timeout(Duration::from_secs(5)) {}
    }

    #[test]
    fn size_only_16_bit_ints() {
        assert_eq!(parse_size(r#"{"cols": 80, "rows": 24}"#), Some((80, 24)));
        assert_eq!(parse_size(r#"{"cols": 80.5, "rows": 24}"#), None);
        assert_eq!(parse_size(r#"{"cols": 65536, "rows": 24}"#), None);
        assert_eq!(parse_size(r#"{"cols": -1, "rows": 24}"#), None);
        assert_eq!(parse_size(r#"{"cols": true, "rows": 24}"#), None);
        assert_eq!(parse_size("lixo"), None);
    }
}
