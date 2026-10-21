// O que o Python imprime e o Rust não tem pronto: repr() de string, %g e o parse_qs. O contrato compara texto, então
// a resposta tem que sair igual, vírgula por vírgula.

/// repr() de uma str do Python: aspas simples (duplas se houver ' e não houver "), com \\, \n, \r, \t e controles
/// escapados
pub fn repr(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::from(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c if (0x80..0xa0).contains(&(c as u32)) => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

/// Os primeiros n caracteres (s[:n] do Python conta caracteres, não bytes)
pub fn head(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// f"{x:.{prec}g}": prec algarismos significativos, sem zeros no fim, notação científica fora de 1e-4..10^prec
pub fn fmt_g(x: f64, prec: usize) -> String {
    if x == 0.0 {
        return "0".into();
    }
    let sci = format!("{:.*e}", prec - 1, x); // "1.88e2": já arredondado para prec algarismos
    let (mant, exp) = sci.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    if exp < -4 || exp >= prec as i32 {
        let mant = strip_zeros(mant);
        format!("{mant}e{}{:02}", if exp < 0 { '-' } else { '+' }, exp.abs())
    } else {
        strip_zeros(&format!("{:.*}", (prec as i32 - 1 - exp).max(0) as usize, x))
    }
}

fn strip_zeros(s: &str) -> String {
    if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s.to_string() }
}

/// parse_qs do Python: pares separados por &, + vira espaço, %XX decodificado (inválido vira U+FFFD). Sem "=", ou com o
/// valor vazio, o par só entra com keep_blank. Devolve as chaves na ordem em que apareceram, cada uma com seus valores.
pub fn parse_qs(query: &str, keep_blank: bool) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.split_once('=') {
            Some(kv) => kv,
            None if keep_blank => (pair, ""),
            None => continue,
        };
        if v.is_empty() && !keep_blank {
            continue;
        }
        let (k, v) = (unquote(k), unquote(v));
        match out.iter_mut().find(|(n, _)| *n == k) {
            Some((_, vs)) => vs.push(v),
            None => out.push((k, vec![v])),
        }
    }
    out
}

fn unquote(s: &str) -> String {
    let s = s.replace('+', " ");
    String::from_utf8_lossy(&percent_encoding::percent_decode_str(&s).collect::<Vec<u8>>()).into_owned()
}

pub fn qs_get<'a>(qs: &'a [(String, Vec<String>)], key: &str) -> Option<&'a Vec<String>> {
    qs.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repr_like_python() {
        assert_eq!(repr("HOME"), "'HOME'");
        assert_eq!(repr("it's"), "\"it's\"");
        assert_eq!(repr("a'b\"c"), "'a\\'b\"c'");
        assert_eq!(repr("x\ny\\z\0"), "'x\\ny\\\\z\\x00'");
        assert_eq!(repr("ação"), "'ação'");
    }

    #[test]
    fn g_like_python() {
        for (x, p, want) in [
            (187.654321, 3, "188"),
            (999.0, 3, "999"),
            (12.345, 3, "12.3"),
            (1.0, 3, "1"),
            (0.5, 3, "0.5"),
            (1500.0, 3, "1.5e+03"),
            (0.00001234, 3, "1.23e-05"),
            (10.48576, 4, "10.49"),
            (8.0, 4, "8"),
            (999.95, 4, "1000"),
            (1.0, 4, "1"),
        ] {
            assert_eq!(fmt_g(x, p), want, "{x} .{p}g");
        }
    }

    #[test]
    fn parse_qs_like_python() {
        let q = parse_qs("tail=500&since=&x&project=lo+ja&dir=%2Fsrv%2Floja&tail=all", true);
        assert_eq!(qs_get(&q, "tail").unwrap(), &vec!["500".to_string(), "all".to_string()]);
        assert_eq!(qs_get(&q, "since").unwrap(), &vec![String::new()]);
        assert_eq!(qs_get(&q, "x").unwrap(), &vec![String::new()]);
        assert_eq!(qs_get(&q, "project").unwrap(), &vec!["lo ja".to_string()]);
        assert_eq!(qs_get(&q, "dir").unwrap(), &vec!["/srv/loja".to_string()]);
        let q = parse_qs("since=&x&dir=%2Fx", false);
        assert!(qs_get(&q, "since").is_none() && qs_get(&q, "x").is_none());
    }
}
