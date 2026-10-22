// A página com os data-* do <html> preenchidos, como o main() do docker_gui.py faz: o binário e o --context (para o
// "Copiar docker exec"), onde a página age (o rótulo e o endereço do daemon), se é remoto e a língua
use crate::cli::Ctx;

/// where() do Python: (rótulo, endereço do daemon, remoto?). Quem resolve --context, DOCKER_CONTEXT e DOCKER_HOST é o
/// próprio docker; podman e docker antigo ficam só com o nome
pub async fn where_(ctx: &Ctx) -> (String, String, bool) {
    let bin = &ctx.cli[0];
    let name = bin.rsplit(['/', '\\']).next().unwrap_or(bin).to_string();
    if name != "docker" && name != "docker.exe" {
        let mut parts = vec![name];
        parts.extend(ctx.cli.get(2).cloned());
        return (parts.join(" · "), String::new(), false);
    }
    let r = ctx
        .docker(
            &["context", "inspect", "--format", "{{.Name}}\t{{.Endpoints.docker.Host}}"],
            std::time::Duration::from_secs(5),
        )
        .await;
    let (c, host) = if r.code == 0 {
        let s = r.stdout.trim();
        s.split_once('\t').map_or((s.to_string(), String::new()), |(a, b)| (a.to_string(), b.to_string()))
    } else {
        (String::new(), String::new())
    };
    let remote = !host.is_empty() && !host.starts_with("unix://") && !host.starts_with("npipe://");
    (if c.is_empty() { "docker".into() } else { format!("docker · {c}") }, host, remote)
}

/// html.escape do Python (quote=True)
pub fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#x27;")
}

/// shlex.quote do Python
pub fn shquote(s: &str) -> String {
    if s.is_empty() {
        return "''".into();
    }
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// Troca o data-cli="docker" do page.html pelos atributos de verdade
pub async fn render(template: &str, ctx: &Ctx) -> String {
    let (label, host, remote) = where_(ctx).await;
    let cli = ctx.cli.iter().map(|s| shquote(s)).collect::<Vec<_>>().join(" ");
    template.replacen(
        "data-cli=\"docker\"",
        &format!(
            "data-cli=\"{}\" data-where=\"{}\" data-host=\"{}\"{} data-lang=\"{}\"",
            escape(&cli),
            escape(&label),
            escape(&host),
            if remote { " data-remote" } else { "" },
            ctx.lang.code()
        ),
        1,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shquote_like_python() {
        assert_eq!(shquote("docker"), "docker");
        assert_eq!(shquote("--context"), "--context");
        assert_eq!(shquote("meu ctx"), "'meu ctx'");
        assert_eq!(shquote("it's"), "'it'\"'\"'s'");
    }
}
