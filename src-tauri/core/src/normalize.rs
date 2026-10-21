// A saída do CLI no formato que a página lê: o do docker. O podman manda outros nomes e tipos (Id, Names em lista,
// portas como objetos, Labels dict, tamanho em bytes, data em epoch...). Cada função é a do docker_gui.py com o
// mesmo nome, linha por linha: o contrato (tests/contract/) compara o JSON que sai. JSON solto do CLI entra e sai como
// Value: tipar seria inventar um schema que o docker não garante. None = formato inesperado (o KeyError/TypeError
// que o Python transforma em 500).
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::pyfmt::fmt_g;

/// a verdade do Python: None, False, 0, "", [] e {} são falsos
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// `a or b` do Python
fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if truthy(a) { a } else { b }
}

/// str() do Python para o que entra numa f-string
pub fn py_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True" } else { "False" }.into(),
        Value::Number(n) if n.is_f64() => {
            let f = n.as_f64().unwrap();
            if f.fract() == 0.0 && f.abs() < 1e16 { format!("{f:.1}") } else { f.to_string() }
        }
        other => other.to_string(),
    }
}

fn s(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or("")
}

/// `d.get(k, default)`: a chave existe (mesmo null) ou o padrão
fn get_or<'a>(d: &'a Value, k: &str, default: &'a Value) -> &'a Value {
    d.get(k).unwrap_or(default)
}

/// O docker manda um JSON por linha; o podman (--format json), um array
pub fn rows(out: &str) -> Option<Vec<Value>> {
    if out.trim_start().starts_with('[') {
        serde_json::from_str::<Vec<Value>>(out).ok()
    } else {
        out.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).ok()).collect()
    }
}

/// estados do podman que o docker não tem -> o equivalente que a página entende
fn podman_state(st: &str) -> &str {
    match st {
        "configured" | "initialized" => "created",
        "stopping" => "running",
        "stopped" => "exited",
        other => other,
    }
}

/// Uma linha do `podman ps --format json` no formato do `docker ps --format '{{json .}}'`
pub fn from_podman(c: &Value) -> Option<Value> {
    let mut ports = Vec::new();
    let null = Value::Null;
    for p in c.get("Ports").filter(|v| truthy(Some(v))).and_then(Value::as_array).into_iter().flatten() {
        // podman 4+ usa snake_case e junta portas seguidas em "range"; o 3 usava camelCase, uma por entrada
        let h = p.get("host_port").or(p.get("hostPort")).unwrap_or(&null);
        let ctr = p.get("container_port").or(p.get("containerPort")).unwrap_or(&null);
        let n = or(p.get("range"), None).and_then(Value::as_i64).unwrap_or(1) - 1;
        let (hs, cs) = if n != 0 {
            (format!("{}-{}", h.as_i64()?, h.as_i64()? + n), format!("{}-{}", ctr.as_i64()?, ctr.as_i64()? + n))
        } else {
            (py_str(h), py_str(ctr))
        };
        let protos = or(p.get("protocol"), None).map_or("tcp".to_string(), py_str);
        for proto in protos.split(',') {
            ports.push(if truthy(Some(h)) {
                let ip = or(or(p.get("host_ip"), p.get("hostIP")), None).map_or("0.0.0.0".into(), py_str);
                format!("{ip}:{hs}->{cs}/{proto}")
            } else {
                format!("{cs}/{proto}")
            });
        }
    }
    let names: Vec<String> =
        or(c.get("Names"), None).and_then(Value::as_array).map_or(vec![], |a| a.iter().map(py_str).collect());
    let labels: Vec<String> = or(c.get("Labels"), None)
        .and_then(Value::as_object)
        .map_or(vec![], |o| o.iter().map(|(k, v)| format!("{k}={}", py_str(v))).collect());
    let state = c.get("State").map(|v| podman_state(s(Some(v))).to_string());
    Some(json!({
        "ID": c.get("Id")?,
        "Names": names.join(","),
        "Image": get_or(c, "Image", &json!("")),
        "State": state.map_or(json!(""), Value::from),
        "Status": s(or(c.get("Status"), None)).replace("(starting)", "(health: starting)"),
        "Ports": ports.join(", "),
        "Labels": labels.join(","),
    }))
}

/// Saída do ps -> lista no formato do docker. Pela forma da linha, não pelo binário: o podman-docker também cai aqui
pub fn containers(out: &str) -> Option<Value> {
    rows(out)?
        .iter()
        .map(|c| if c.get("Id").is_some() { from_podman(c) } else { Some(c.clone()) })
        .collect::<Option<Vec<_>>>()
        .map(Value::Array)
}

/// Quem usa cada imagem, volume e rede (o `usage()` do Python, menos as chamadas ao docker, que ficam no router)
#[derive(Default)]
pub struct Use {
    pub image: Map<String, Value>,
    pub volume: Map<String, Value>,
    pub network: Map<String, Value>,
    pub size: Map<String, Value>,
}

pub fn usage_from_inspect(items: &[Value]) -> Use {
    let mut use_ = Use::default();
    for c in items {
        let name = s(or(c.get("Name"), None)).trim_start_matches('/').to_string();
        let image = s(or(c.get("Image"), None)).rsplit(':').next().unwrap_or("").to_string();
        let volumes: Vec<String> = or(c.get("Mounts"), None)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|m| m.get("Type") == Some(&json!("volume")))
            .filter_map(|m| m.get("Name").and_then(Value::as_str).map(String::from))
            .collect();
        let networks: Vec<String> = or(or(c.get("NetworkSettings"), None).and_then(|n| n.get("Networks")), None)
            .and_then(Value::as_object)
            .map_or(vec![], |o| o.keys().cloned().collect());
        for (map, keys) in [(&mut use_.image, vec![image]), (&mut use_.volume, volumes), (&mut use_.network, networks)]
        {
            for k in keys.into_iter().filter(|k| !k.is_empty()) {
                map.entry(k).or_insert_with(|| json!([])).as_array_mut().unwrap().push(json!(name));
            }
        }
    }
    use_
}

/// CreatedAt do docker ("2026-09-18 00:00:00 +0000 UTC") -> segundos desde 1970; None se não reconhecer
pub fn epoch(v: Option<&Value>) -> Option<i64> {
    let s = v?.as_str()?;
    let parts: Vec<&str> = s.split_whitespace().take(3).collect();
    let [date, time, tz] = parts[..] else { return None };
    let d: Vec<i64> = date.split('-').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    let t: Vec<i64> = time.split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    if d.len() != 3 || t.len() != 3 || date.len() != 10 || time.len() != 8 {
        return None;
    }
    let off = utc_offset(tz)?;
    Some(days_from_civil(d[0], d[1], d[2])? * 86400 + t[0] * 3600 + t[1] * 60 + t[2] - off)
}

/// %z do strptime: Z, ±HHMM ou ±HH:MM -> segundos
fn utc_offset(tz: &str) -> Option<i64> {
    if tz == "Z" {
        return Some(0);
    }
    let sign = match tz.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits = tz[1..].replace(':', "");
    if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(sign * (digits[..2].parse::<i64>().ok()? * 3600 + digits[2..].parse::<i64>().ok()? * 60))
}

/// dias desde 1970-01-01 (algoritmo de Howard Hinnant), conferindo a data
fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let dim = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&m) || d < 1 || d > dim[(m - 1) as usize] {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

/// Bytes -> "187MB", como o docker escreve (base 1000, 3 algarismos)
pub fn human(mut n: f64) -> String {
    for unit in ["B", "kB", "MB", "GB", "TB"] {
        if n < 999.5 || unit == "TB" {
            return format!("{}{unit}", fmt_g(n, 3));
        }
        n /= 1000.0;
    }
    unreachable!()
}

/// image ls -> uma entrada por imagem (o docker repete a imagem em cada tag), com ID inteiro e criação em epoch
pub fn images(items: &[Value], use_: &Use) -> Option<Value> {
    let mut out: Map<String, Value> = Map::new();
    for i in items {
        let (iid, size, created, tags): (String, Value, Value, Vec<Value>) = if i.get("Repository").is_some() {
            let tag = get_or(i, "Tag", &json!("<none>")).clone();
            (
                i.get("ID")?.as_str()?.rsplit(':').next()?.to_string(),
                get_or(i, "Size", &json!("")).clone(),
                epoch(i.get("CreatedAt")).map_or(Value::Null, Value::from),
                vec![json!(format!("{}:{}", py_str(i.get("Repository")?), py_str(&tag)))],
            )
        } else {
            // podman: as tags vêm em Names (RepoTags às vezes vem null), Size em bytes, Created em epoch
            let size = or(i.get("Size"), None).map_or(Some(0.0), Value::as_f64)?;
            (
                i.get("Id")?.as_str()?.rsplit(':').next()?.to_string(),
                json!(human(size)),
                i.get("Created").cloned().unwrap_or(Value::Null),
                or(or(i.get("Names"), i.get("RepoTags")), None).and_then(Value::as_array).cloned().unwrap_or_default(),
            )
        };
        let img = out.entry(iid.clone()).or_insert_with(|| {
            json!({"ID": iid, "Tags": [], "Size": size, "Created": created,
                   "Containers": use_.image.get(&iid).cloned().unwrap_or(json!([]))})
        });
        let have = img["Tags"].as_array().unwrap().clone();
        let new: Vec<Value> = tags.into_iter().filter(|t| !have.contains(t) && t != "<none>:<none>").collect();
        img["Tags"].as_array_mut().unwrap().extend(new);
    }
    Some(Value::Array(out.into_values().collect()))
}

pub fn volumes(items: &[Value], use_: &Use) -> Option<Value> {
    items
        .iter()
        .map(|v| {
            let name = v.get("Name")?;
            let key = py_str(name);
            Some(json!({
                "Name": name,
                "Driver": get_or(v, "Driver", &json!("")),
                "Size": use_.size.get(&key).cloned().unwrap_or(json!("")),
                "Containers": use_.volume.get(&key).cloned().unwrap_or(json!([])),
            }))
        })
        .collect::<Option<Vec<_>>>()
        .map(Value::Array)
}

/// network ls -> nome, driver, escopo. O podman 4+ manda as chaves em minúsculas e sem escopo
pub fn networks(items: &[Value], use_: &Use) -> Option<Value> {
    let empty = json!("");
    Some(Value::Array(
        items
            .iter()
            .map(|n| {
                let name = n.get("Name").or(n.get("name")).unwrap_or(&empty);
                let key = name.as_str().unwrap_or("");
                json!({
                    "ID": n.get("ID").or(n.get("id")).unwrap_or(&empty),
                    "Name": name,
                    "Driver": n.get("Driver").or(n.get("driver")).unwrap_or(&empty),
                    "Scope": get_or(n, "Scope", &json!("local")),
                    "Builtin": crate::validate::BUILTIN_NETWORKS.contains(&key),
                    "Containers": use_.network.get(key).cloned().unwrap_or(json!([])),
                })
            })
            .collect(),
    ))
}

/// Saída do `compose logs` em ordem cronológica: sem -f, ele despeja um container de cada vez. A fração vem sem os
/// zeros do fim (RFC3339Nano) e é completada antes de comparar; sem timestamp, vai para o topo
pub fn by_time(text: &str) -> String {
    static LOG_TIME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\|\s(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?").unwrap());
    let key = |line: &str| match LOG_TIME.captures(line) {
        Some(m) => (m[1].to_string(), format!("{:0<9}", m.get(2).map_or("", |x| x.as_str()))),
        None => (String::new(), String::new()),
    };
    // split e não lines: um \r no meio do log é parte da linha, não uma linha nova
    let mut lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
    lines.sort_by_cached_key(|l| key(l));
    lines.iter().map(|l| format!("{l}\n")).collect()
}

/// Bytes no formato do HumanSize do go-units (decimal, 4 dígitos), o mesmo que o podman imprime: 10.5MB
pub fn podman_size(mut n: f64) -> String {
    let units = ["B", "kB", "MB", "GB", "TB", "PB"];
    let mut i = 0;
    while n >= 1000.0 && i < units.len() - 1 {
        n /= 1000.0;
        i += 1;
    }
    format!("{}{}", fmt_g(n, 4), units[i])
}

fn num(v: Option<&Value>) -> f64 {
    or(v, None).and_then(Value::as_f64).unwrap_or(0.0)
}

/// Uma linha do `podman stats` no formato do `docker stats --format '{{json .}}'`
pub fn from_podman_stats(st: &Value) -> Option<Value> {
    if st.get("cpu_percent").is_some() {
        let g = |k| get_or(st, k, &json!("")).clone();
        return Some(json!({"ID": g("id"), "Name": g("name"), "CPUPerc": g("cpu_percent"), "MemUsage": g("mem_usage"),
                           "MemPerc": g("mem_percent"), "NetIO": g("net_io"), "BlockIO": g("block_io")}));
    }
    let nets: Vec<&Value> =
        or(st.get("Network"), None).and_then(Value::as_object).map_or(vec![], |o| o.values().collect());
    let sum = |k: &str| nets.iter().map(|n| n.get(k).and_then(Value::as_f64).unwrap_or(0.0)).sum::<f64>();
    Some(json!({
        "ID": st.get("ContainerID")?.as_str()?.chars().take(12).collect::<String>(),
        "Name": get_or(st, "Name", &json!("")),
        "CPUPerc": format!("{:.2}%", num(st.get("CPU"))),
        "MemUsage": format!("{} / {}", podman_size(num(st.get("MemUsage"))), podman_size(num(st.get("MemLimit")))),
        "MemPerc": format!("{:.2}%", num(st.get("MemPerc"))),
        "NetIO": format!("{} / {}", podman_size(sum("RxBytes")), podman_size(sum("TxBytes"))),
        "BlockIO": format!("{} / {}", podman_size(num(st.get("BlockInput"))), podman_size(num(st.get("BlockOutput")))),
    }))
}

/// Saída do stats -> lista no formato do docker. Como no ps, a forma da linha decide
/// RAM total do daemon, do `info --format {{json .}}` (o mem_total do Python)
pub fn mem_total(out: &str) -> Option<u64> {
    let v: Value = serde_json::from_str(out).ok()?;
    v.get("MemTotal").or_else(|| v.get("host")?.get("memTotal"))?.as_u64().filter(|&t| t > 0)
}

pub fn stats(out: &str) -> Option<Value> {
    let rows: Vec<Value> = if out.trim_start().starts_with('[') {
        serde_json::from_str(out).ok()?
    } else {
        out.lines().map(|l| serde_json::from_str(l).ok()).collect::<Option<_>>()?
    };
    rows.iter()
        .map(|st| {
            if st.get("cpu_percent").is_some() || st.get("ContainerID").is_some() {
                from_podman_stats(st)
            } else {
                Some(st.clone())
            }
        })
        .collect::<Option<Vec<_>>>()
        .map(Value::Array)
}

/// Uma linha do `docker events` muda a lista? Na dúvida, sim: o custo é uma consulta a mais
pub fn relevant(line: &str) -> bool {
    const IGNORE: [&str; 10] =
        ["attach", "resize", "top", "archive-path", "extract-to-dir", "export", "commit", "copy", "mount", "unmount"];
    if line.trim().is_empty() {
        return false;
    }
    let Ok(ev) = serde_json::from_str::<Value>(line) else { return true };
    let Some(obj) = ev.as_object() else { return true };
    let v = or(or(obj.get("Action"), obj.get("status")), obj.get("Status"));
    let Some(text) = (if truthy(v) { v.and_then(Value::as_str) } else { Some("") }) else { return true };
    let name = text.split(':').next().unwrap_or("").trim().to_lowercase();
    !(name.starts_with("exec") || IGNORE.contains(&name.as_str()))
}

/// Hora do evento em epoch: o docker (e o podman 4+) manda número; o podman antigo, texto RFC 3339 (a fração cai)
fn event_time(v: Option<&Value>) -> Option<Value> {
    static EVENT_TIME: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)?$").unwrap()
    });
    match v? {
        Value::Number(n) => Some(Value::Number(n.clone())),
        Value::String(s) => {
            let m = EVENT_TIME.captures(s)?;
            let n = |i: usize| m[i].parse::<i64>().unwrap();
            let off = m.get(7).map_or(Some(0), |z| utc_offset(z.as_str()))?;
            let t = days_from_civil(n(1), n(2), n(3))? * 86400 + n(4) * 3600 + n(5) * 60 + n(6) - off;
            Some(json!(t as f64))
        }
        _ => None,
    }
}

const HISTORY_EVENTS: [&str; 6] = ["start", "die", "oom", "pause", "unpause", "health_status"];

/// `docker events` de um container -> [{t, a, code, health}], só as de HISTORY_EVENTS, no máximo as 100 últimas
pub fn history(out: &str) -> Value {
    let mut events = Vec::new();
    for line in out.lines() {
        let Ok(ev) = serde_json::from_str::<Value>(line) else { continue };
        if !ev.is_object() {
            continue;
        }
        let raw = or(or(ev.get("Action"), ev.get("status")), ev.get("Status")).map_or(String::new(), py_str);
        let (kind, detail) = raw.split_once(':').unwrap_or((&raw, ""));
        let kind = kind.trim().to_lowercase();
        let kind = if kind == "died" { "die".to_string() } else { kind };
        let t = event_time(ev.get("time").or(ev.get("Time")));
        let Some(t) = t.filter(|_| HISTORY_EVENTS.contains(&kind.as_str())) else { continue };
        let empty = json!({});
        let attrs = or(or(or(ev.get("Actor"), None).and_then(|a| a.get("Attributes")), ev.get("Attributes")), None)
            .unwrap_or(&empty);
        let code = attrs.get("exitCode").or(ev.get("ContainerExitCode")).map_or("None".into(), py_str);
        let digits = code.trim_start_matches('-');
        let code = if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
            code.parse::<i64>().map_or(Value::Null, Value::from)
        } else {
            Value::Null
        };
        let detail = detail.trim();
        let health = if !detail.is_empty() {
            json!(detail)
        } else {
            or(ev.get("HealthStatus"), None).cloned().unwrap_or(json!(""))
        };
        events.push(json!({"t": t, "a": kind, "code": code, "health": health}));
    }
    let skip = events.len().saturating_sub(100);
    Value::Array(events.split_off(skip))
}

/// Resumo do `docker inspect`. O env costuma ter senha e token: sem reveal, os valores nem saem (vão como null)
pub fn summary(info: &Value, reveal: bool) -> Value {
    let empty = json!({});
    let obj = |v: Option<&Value>| or(v, None).unwrap_or(&empty).clone();
    let rp = obj(obj(info.get("HostConfig")).get("RestartPolicy"));
    let nets = obj(obj(info.get("NetworkSettings")).get("Networks"));
    let state = obj(info.get("State"));
    let retries = rp.get("MaximumRetryCount");
    let restart = format!(
        "{}{}",
        or(rp.get("Name"), None).map_or("no".into(), py_str),
        if truthy(retries) { format!(":{}", py_str(retries.unwrap())) } else { String::new() }
    );
    let networks: Map<String, Value> = nets.as_object().map_or(Map::new(), |o| {
        o.iter().map(|(k, n)| (k.clone(), get_or(&obj(Some(n)), "IPAddress", &json!("")).clone())).collect()
    });
    let mounts: Vec<Value> = or(info.get("Mounts"), None)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|m| {
            let mut o = Map::new();
            for k in ["Type", "Name", "Source", "Destination", "RW"] {
                o.insert(k.into(), get_or(m, k, &json!("")).clone());
            }
            Value::Object(o)
        })
        .collect();
    let env: Vec<Value> = or(obj(info.get("Config")).get("Env"), None)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|e| {
            let e = py_str(e);
            let (k, v) = e.split_once('=').unwrap_or((&e, ""));
            json!([k, if reveal { json!(v) } else { Value::Null }])
        })
        .collect();
    json!({
        "Restart": restart,
        "Networks": networks,
        "Mounts": mounts,
        "Env": env,
        "OOMKilled": truthy(state.get("OOMKilled")),
        "RestartCount": or(info.get("RestartCount"), None).cloned().unwrap_or(json!(0)),
        "FinishedAt": or(state.get("FinishedAt"), None).cloned().unwrap_or(json!("")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_like_strptime() {
        assert_eq!(epoch(Some(&json!("2026-09-18 00:00:00 +0000 UTC"))), Some(1789689600));
        assert_eq!(epoch(Some(&json!("2026-09-18 03:00:00 +03:00"))), Some(1789689600));
        assert_eq!(epoch(Some(&json!("data estranha"))), None);
        assert_eq!(epoch(Some(&json!("2026-02-30 00:00:00 +0000"))), None);
        assert_eq!(epoch(None), None);
    }

    #[test]
    fn human_like_docker() {
        assert_eq!(human(187654321.0), "188MB");
        assert_eq!(human(999.0), "999B");
        assert_eq!(human(0.0), "0B");
        assert_eq!(human(1000.0), "1kB");
    }

    #[test]
    fn relevant_events() {
        assert!(relevant(r#"{"Action":"start"}"#));
        assert!(!relevant(r#"{"Action":"exec_start: sh -c x"}"#));
        assert!(!relevant(r#"{"status":"resize"}"#));
        assert!(relevant("não é json"));
        assert!(!relevant("  "));
        assert!(relevant(r#"{"Status":"died"}"#));
    }
}
