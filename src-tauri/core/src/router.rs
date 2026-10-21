// As rotas /api/* do Handler do docker_gui.py, sem HTTP: o mesmo roteador atende a IPC do app desktop e o harness dos
// testes. A autenticação (token, Host, Origin) fica de fora: na IPC, quem chama é a própria janela; no harness, o
// servidor confere antes de chegar aqui.
use futures_util::stream::BoxStream;
use serde_json::{Value, json};

use crate::cli::Ctx;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Clone, Debug)]
pub struct Request {
    pub method: Method,
    /// sem a query
    pub path: String,
    /// sem o "?"
    pub query: String,
    /// None: sem corpo ou corpo que não é JSON (o Python responde igual aos dois)
    pub body: Option<Value>,
}

impl Request {
    /// "/api/logs/<id>?tail=500" -> path e query
    pub fn new(method: Method, target: &str, body: Option<Value>) -> Request {
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        Request { method, path: path.to_string(), query: query.to_string(), body }
    }

    /// o self.path do Python: algumas rotas casam com o caminho inteiro, com a query
    pub fn full(&self) -> String {
        if self.query.is_empty() { self.path.clone() } else { format!("{}?{}", self.path, self.query) }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: Value,
}

pub fn reply(status: u16, body: impl Into<Value>) -> Response {
    Response { status, body: body.into() }
}

pub enum Reply {
    Json(Response),
    /// o compose: uma linha de saída por item (string) e, no fim, {"code": n}
    Ndjson(BoxStream<'static, Value>),
}

pub async fn handle(_ctx: &Ctx, _req: Request) -> Reply {
    Reply::Json(reply(404, json!("not found")))
}
