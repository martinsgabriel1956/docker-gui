// Mensagens do backend: o texto fica em pt-BR no código, e em inglês sai da mesma tabela do docker_gui.py (EN)
use crate::i18n_en::EN;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Pt,
    En,
}

impl Lang {
    pub fn parse(s: &str) -> Lang {
        if s == "en" { Lang::En } else { Lang::Pt }
    }
    pub fn code(self) -> &'static str {
        match self {
            Lang::Pt => "pt",
            Lang::En => "en",
        }
    }
    /// O system_lang() do Python: DOCKER_GUI_LANG ou o locale (LC_ALL, LC_MESSAGES, LANG); começa com "pt": português
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Lang {
        let v = ["DOCKER_GUI_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]
            .iter()
            .find_map(|k| get(k).filter(|v| !v.is_empty()))
            .unwrap_or_default()
            .to_lowercase();
        if v.starts_with("pt") || v.starts_with("portuguese") { Lang::Pt } else { Lang::En }
    }
}

pub fn tr(lang: Lang, s: &str) -> String {
    match lang {
        Lang::En => EN.iter().find(|(k, _)| *k == s).map_or(s, |(_, v)| v).to_string(),
        Lang::Pt => s.to_string(),
    }
}

/// tr() com os {nome} trocados, como o .format(nome=...) do Python
pub fn trf(lang: Lang, s: &str, args: &[(&str, &str)]) -> String {
    let mut out = tr(lang, s);
    for (k, v) in args {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn i18n_matches_python() {
        // a tabela do Python é a fonte: cada par (pt, en) dela precisa estar aqui, e nada além disso
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docker_gui.py")).unwrap();
        let block = &src[src.find("\nEN = {").unwrap()..];
        let block = &block[..block.find("\n}\n").unwrap()];
        let pairs = regex::Regex::new(r#"(?s)"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)""#).unwrap();
        let python: Vec<(String, String)> =
            pairs.captures_iter(block).map(|c| (c[1].replace("\\\\", "\\"), c[2].replace("\\\\", "\\"))).collect();
        let rust: Vec<(String, String)> = EN.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        assert_eq!(python, rust);
    }

    #[test]
    fn from_env_follows_python() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
        };
        assert_eq!(Lang::from_env(env(&[("LANG", "pt_BR.UTF-8")])), Lang::Pt);
        assert_eq!(Lang::from_env(env(&[("LANG", "en_US.UTF-8")])), Lang::En);
        assert_eq!(Lang::from_env(env(&[("DOCKER_GUI_LANG", "en"), ("LANG", "pt_BR")])), Lang::En);
        assert_eq!(Lang::from_env(env(&[])), Lang::En);
    }

    #[test]
    fn trf_fills_placeholders() {
        assert_eq!(trf(Lang::En, "variável repetida: {key}", &[("key", "A")]), "variable repeated: A");
        assert_eq!(trf(Lang::Pt, "variável repetida: {key}", &[("key", "A")]), "variável repetida: A");
    }
}
