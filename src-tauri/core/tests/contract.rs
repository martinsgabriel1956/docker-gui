// Contrato com o docker_gui.py: os mesmos casos de tests/contract/ (raiz do repositório) que o tests/test_contract.py
// roda contra o Python. O Runner falso confere as chamadas ao docker em ordem, como o docker() falso de lá.
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use stivo_core::{Ctx, Lang, Method, Output, Reply, Request, RunError, Runner, handle};

struct Fake {
    calls: Mutex<VecDeque<Value>>,
    errors: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl Runner for Fake {
    async fn run(&self, _cli: &[String], args: &[String], _timeout: Duration) -> Result<Output, RunError> {
        let Some(exp) = self.calls.lock().unwrap().pop_front() else {
            self.errors.lock().unwrap().push(format!("chamada a mais: {args:?}"));
            return Ok(Output { code: 99, stdout: String::new(), stderr: "mismatch".into() });
        };
        let want: Vec<String> = serde_json::from_value(exp["args"].clone()).unwrap();
        if want != args {
            self.errors.lock().unwrap().push(format!("esperava {want:?}, veio {args:?}"));
            return Ok(Output { code: 99, stdout: String::new(), stderr: "mismatch".into() });
        }
        Ok(Output {
            code: exp["code"].as_i64().unwrap() as i32,
            stdout: exp["stdout"].as_str().unwrap().into(),
            stderr: exp["stderr"].as_str().unwrap().into(),
        })
    }
}

fn cases(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            cases(&p, out);
        } else if p.extension().is_some_and(|x| x == "json") {
            out.push(p);
        }
    }
}

#[tokio::test]
async fn contract() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/contract");
    let mut paths = Vec::new();
    cases(&root, &mut paths);
    paths.sort();
    let mut failures = Vec::new();
    let mut ran = 0;
    for path in &paths {
        let name = path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        ran += 1;
        let case: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let fake = Arc::new(Fake {
            calls: Mutex::new(case["calls"].as_array().unwrap().iter().cloned().collect()),
            errors: Mutex::new(Vec::new()),
        });
        let now = case.get("now").and_then(Value::as_f64).unwrap_or(1700000000.5);
        let ctx = Ctx {
            cli: serde_json::from_value(case["cli"].clone()).unwrap(),
            lang: Lang::parse(case["lang"].as_str().unwrap()),
            runner: fake.clone(),
            now: Arc::new(move || now),
        };
        let req = &case["request"];
        let method = if req["method"] == "POST" { Method::Post } else { Method::Get };
        let body = if req["body"].is_null() { None } else { Some(req["body"].clone()) };
        let got = match handle(&ctx, Request::new(method, req["path"].as_str().unwrap(), body)).await {
            Reply::Json(r) => (r.status, r.body),
            Reply::Ndjson(_) => (0, Value::String("NDJSON fora do escopo do contrato".into())),
        };
        let want = (case["response"]["status"].as_u64().unwrap() as u16, case["response"]["body"].clone());
        let mut errs = fake.errors.lock().unwrap().clone();
        if let Some(left) = fake.calls.lock().unwrap().front() {
            errs.push(format!("chamada esperada não aconteceu: {}", left["args"]));
        }
        if got != want {
            errs.push(format!("resposta: esperava {} {}, veio {} {}", want.0, want.1, got.0, got.1));
        }
        if !errs.is_empty() {
            failures.push(format!("{name}: {}", errs.join("; ")));
        }
    }
    assert!(ran > 100, "só {ran} casos de contrato: a pasta tests/contract/ mudou de lugar?");
    assert!(failures.is_empty(), "{} de {ran} casos falharam:\n{}", failures.len(), failures.join("\n"));
}
