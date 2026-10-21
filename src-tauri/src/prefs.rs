// Preferências do desktop em <app_config>/prefs.json. None é "o padrão de hoje": DOCKER_GUI_CLI ou docker, o contexto
// que o docker resolve sozinho (DOCKER_CONTEXT, docker context use) e a língua do sistema.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use stivo_core::Lang;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    pub cli: Option<String>,
    pub context: Option<String>,
    pub lang: Option<String>,
    /// notificações do sistema: ligadas por padrão (PRD RF2.4); desligáveis aqui (RF4.4)
    pub notifications: Option<bool>,
    /// o aviso "o Stivo continua na bandeja" sai só na primeira vez que a janela fecha
    pub close_hint_shown: bool,
}

impl Prefs {
    pub fn path(dir: &Path) -> PathBuf {
        dir.join("prefs.json")
    }

    /// arquivo que falta ou que não é JSON: os padrões (nunca impede o app de abrir)
    pub fn load(dir: &Path) -> Prefs {
        std::fs::read_to_string(Prefs::path(dir)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    /// gravação atômica: um arquivo pela metade (queda de energia) não apaga as preferências
    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join("prefs.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?)?;
        std::fs::rename(tmp, Prefs::path(dir))
    }

    pub fn notifications(&self) -> bool {
        self.notifications.unwrap_or(true)
    }

    /// o binário e as flags globais, como o CLI do Python depois do --cli e do --context
    pub fn cli(&self, env: impl Fn(&str) -> Option<String>) -> Vec<String> {
        let bin = self
            .cli
            .clone()
            .or_else(|| env("DOCKER_GUI_CLI"))
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| "docker".into());
        let mut cli = vec![bin];
        if let Some(c) = &self.context {
            cli.extend(["--context".into(), c.clone()]);
        }
        cli
    }

    pub fn lang(&self, env: impl Fn(&str) -> Option<String>) -> Lang {
        self.lang.as_deref().map_or_else(|| Lang::from_env(env), Lang::parse)
    }
}

/// O que a tela de preferências manda (o close_hint_shown não é dela)
#[derive(Clone, Debug, Deserialize)]
pub struct Choice {
    pub cli: Option<String>,
    pub context: Option<String>,
    pub lang: Option<String>,
    pub notifications: bool,
}

/// Confere o que veio da página antes de virar argv: CLI só docker ou podman, contexto só um que o `docker context ls`
/// listou (e só com o docker), idioma pt ou en. Erro: a mensagem para a tela
pub fn validate(c: &Choice, contexts: &[String], en: bool) -> Result<(), String> {
    let msg = |pt: &str, e: &str| Err(if en { e } else { pt }.to_string());
    if let Some(cli) = &c.cli
        && cli != "docker"
        && cli != "podman"
    {
        return msg("CLI inválida: use docker ou podman", "invalid CLI: use docker or podman");
    }
    if let Some(ctx) = &c.context {
        if c.cli.as_deref() == Some("podman") {
            return msg(
                "o contexto é do docker: com o podman, deixe no padrão",
                "contexts are a docker thing: leave it on default with podman",
            );
        }
        if !contexts.contains(ctx) {
            return msg("contexto que o docker context ls não lista", "context not listed by docker context ls");
        }
    }
    if let Some(l) = &c.lang
        && l != "pt"
        && l != "en"
    {
        return msg("idioma inválido: use pt ou en", "invalid language: use pt or en");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn defaults_follow_today() {
        let p = Prefs::default();
        assert_eq!(p.cli(none), vec!["docker"]);
        assert_eq!(p.cli(|k| (k == "DOCKER_GUI_CLI").then(|| "podman".into())), vec!["podman"]);
        assert!(p.notifications());
        let p = Prefs { cli: Some("podman".into()), context: Some("prod".into()), ..Default::default() };
        assert_eq!(p.cli(none), vec!["podman", "--context", "prod"]);
    }

    #[test]
    fn validate_only_what_the_screen_offers() {
        let ok = |cli: Option<&str>, ctx: Option<&str>, lang: Option<&str>| {
            let c = Choice {
                cli: cli.map(Into::into),
                context: ctx.map(Into::into),
                lang: lang.map(Into::into),
                notifications: true,
            };
            validate(&c, &["default".into(), "prod".into()], false)
        };
        assert!(ok(None, None, None).is_ok());
        assert!(ok(Some("podman"), None, Some("en")).is_ok());
        assert!(ok(Some("docker"), Some("prod"), Some("pt")).is_ok());
        assert!(ok(Some("/bin/sh"), None, None).is_err());
        assert!(ok(Some("docker --host=tcp://x"), None, None).is_err());
        assert!(ok(None, Some("--host=tcp://x"), None).is_err());
        assert!(ok(Some("podman"), Some("prod"), None).is_err());
        assert!(ok(None, None, Some("fr")).is_err());
    }

    #[test]
    fn missing_or_broken_file_is_default_and_save_roundtrips() {
        let dir = std::env::temp_dir().join(format!("stivo-prefs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(Prefs::load(&dir), Prefs::default());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(Prefs::path(&dir), "{não é json").unwrap();
        assert_eq!(Prefs::load(&dir), Prefs::default());
        let p = Prefs { lang: Some("en".into()), close_hint_shown: true, ..Default::default() };
        p.save(&dir).unwrap();
        assert_eq!(Prefs::load(&dir), p);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
