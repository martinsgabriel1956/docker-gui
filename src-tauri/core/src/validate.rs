// As listas fixas e as regex do docker_gui.py, copiadas literalmente: nada que vem da página chega ao CLI sem passar
// por uma delas. Classes explícitas ([0-9], [a-zA-Z]) como lá: o \d e o \w aceitariam Unicode.
use std::sync::LazyLock;

use regex::Regex;

fn full(re: &str) -> Regex {
    Regex::new(&format!("^(?:{re})$")).unwrap()
}

pub static ID_RE: LazyLock<Regex> = LazyLock::new(|| full("[0-9a-f]{12,64}"));
pub static STARTED_RE: LazyLock<Regex> =
    LazyLock::new(|| full("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9]{2}:[0-9]{2})"));

const HOST: &str = "[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?";
const PATH: &str = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
/// referência de imagem: [registry[:porta]/]caminho/em/minúsculas[:tag][@sha256:...]; nunca começa com "-"
pub static IMAGE_RE: LazyLock<Regex> = LazyLock::new(|| {
    full(&format!(
        "(?:{HOST}(?:\\.{HOST})*(?::[0-9]+)?/)?{PATH}(?:/{PATH})*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{{0,127}})?(?:@sha256:[0-9a-f]{{64}})?"
    ))
});
/// regra do docker para nome de container e de volume
pub static NAME_RE: LazyLock<Regex> = LazyLock::new(|| full("[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}"));
pub static PORT_RE: LazyLock<Regex> = LazyLock::new(|| full("([0-9]{1,5}):([0-9]{1,5})(?:/(tcp|udp))?"));
pub static ENV_RE: LazyLock<Regex> = LazyLock::new(|| full("[A-Za-z_][A-Za-z0-9_]{0,255}"));
/// nome:/caminho. O nome não tem barra nem começa com ponto: não há como virar caminho do host (bind mount)
pub static VOLUME_RE: LazyLock<Regex> =
    LazyLock::new(|| full("([a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}):((?:/[A-Za-z0-9._@+-]+)+)"));

/// quanto histórico dos logs a página pode pedir (?tail=): o argv sai daqui, nunca da query. "all" é sem --tail
pub fn log_tail(v: &str) -> Option<&'static [&'static str]> {
    Some(match v {
        "500" => &["--tail", "500"],
        "2000" => &["--tail", "2000"],
        "10000" => &["--tail", "10000"],
        "all" => &[],
        "5" => &["--tail", "5"], // a última linha de quem caiu, que a lista mostra na faixa de atenção
        _ => return None,
    })
}

/// janela dos logs (?since=), também de lista fixa ("start" é tratado à parte: o início atual do container)
pub fn log_since(v: &str) -> Option<&'static [&'static str]> {
    Some(match v {
        "5m" => &["--since", "5m"],
        "15m" => &["--since", "15m"],
        "1h" => &["--since", "1h"],
        "24h" => &["--since", "24h"],
        _ => return None,
    })
}

pub fn action(a: &str) -> Option<&'static [&'static str]> {
    Some(match a {
        "start" => &["start"],
        "stop" => &["stop"],
        "restart" => &["restart"],
        "pause" => &["pause"],
        "unpause" => &["unpause"],
        "remove" => &["rm", "-f"],
        _ => return None,
    })
}

/// limpeza por categoria do docker system df
pub fn prune(k: &str) -> Option<&'static [&'static str]> {
    Some(match k {
        "containers" => &["container", "prune", "-f"],
        "images" => &["image", "prune", "-a", "-f"],
        "volumes" => &["volume", "prune", "-f"],
        "buildcache" => &["builder", "prune", "-a", "-f"],
        _ => return None,
    })
}

/// remoção um a um: cada tipo tem a sua regex (imagem e rede por ID; volume pelo nome, nunca começando por "-")
pub fn remove(kind: &str, r: &str) -> Option<&'static [&'static str]> {
    static VOLUME: LazyLock<Regex> = LazyLock::new(|| full("[a-zA-Z0-9][a-zA-Z0-9_.-]*"));
    let (ok, argv): (bool, &'static [&'static str]) = match kind {
        "image" => (ID_RE.is_match(r), &["image", "rm"]),
        "volume" => (VOLUME.is_match(r), &["volume", "rm"]),
        "network" => (ID_RE.is_match(r), &["network", "rm"]),
        _ => return None,
    };
    ok.then_some(argv)
}

/// redes que vêm com o daemon ("podman" é a padrão do podman)
pub const BUILTIN_NETWORKS: [&str; 4] = ["bridge", "host", "none", "podman"];

/// por projeto compose
pub fn compose_project(a: &str) -> Option<&'static [&'static str]> {
    Some(match a {
        "up" => &["up", "-d"],
        "rebuild" => &["up", "-d", "--build"],
        "down" => &["down"],
        "pull" => &["pull"],
        _ => return None,
    })
}

/// por serviço: o nome vai no fim do argv, depois de um "--"
pub fn compose_service(a: &str) -> Option<&'static [&'static str]> {
    Some(match a {
        "restart" => &["restart"],
        "build" => &["up", "-d", "--build", "--no-deps"],
        "svcup" => &["up", "-d"],
        _ => return None,
    })
}

pub const COMPOSE_LOGS: [&str; 3] = ["logs", "--no-color", "--timestamps"];
/// .Label (um por vez) e não .Labels: este junta tudo com vírgula, e config_files já tem vírgula
pub const COMPOSE_FORMAT: &str = "[{{json (.Label \"com.docker.compose.project\")}},{{json (.Label \"com.docker.compose.project.working_dir\")}},{{json (.Label \"com.docker.compose.project.config_files\")}},{{json (.Label \"com.docker.compose.service\")}}]";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_re() {
        for ok in [
            "nginx",
            "nginx:1.27",
            "registry.local:5000/time/app",
            "a/b_c__d-e",
            &format!("x@sha256:{}", "a".repeat(64)),
        ] {
            assert!(IMAGE_RE.is_match(ok), "{ok}");
        }
        for bad in ["-v", "Nginx", "nginx:", "a//b", "ação", "nginx:-x", "x@sha256:abc", ""] {
            assert!(!IMAGE_RE.is_match(bad), "{bad}");
        }
    }

    #[test]
    fn names_ports_env_volumes() {
        assert!(NAME_RE.is_match("web-1.a_b") && !NAME_RE.is_match("-x") && !NAME_RE.is_match("a"));
        assert!(PORT_RE.is_match("8080:80/udp") && !PORT_RE.is_match("80") && !PORT_RE.is_match("1:2/sctp"));
        assert!(ENV_RE.is_match("_A1") && !ENV_RE.is_match("1A") && !ENV_RE.is_match("A-B"));
        assert!(
            VOLUME_RE.is_match("dados:/var/lib/x") && !VOLUME_RE.is_match("/etc:/host") && !VOLUME_RE.is_match(".x:/a")
        );
        assert!(ID_RE.is_match("0123456789ab") && !ID_RE.is_match("0123456789AB") && !ID_RE.is_match("0123"));
        assert!(
            remove("volume", "dados").is_some() && remove("volume", "-rf").is_none() && remove("image", "x").is_none()
        );
    }
}
