//! Núcleo do Stivo desktop: o equivalente ao backend do docker_gui.py (as rotas /api/*, os streams e o terminal), sem
//! Tauri e sem HTTP. O app desktop o chama pela IPC; o harness (feature "harness") o serve por HTTP para os testes.
//! O contrato com o Python está em tests/contract/ (raiz do repositório), lido pelo tests/contract.rs.

pub mod cli;
pub mod compose;
pub mod i18n;
mod i18n_en;
pub mod normalize;
pub mod page;
pub mod pyfmt;
pub mod router;
pub mod streams;
pub mod terminal;
pub mod validate;

pub use cli::{Ctx, Output, RunError, Runner};
pub use i18n::Lang;
pub use router::{Method, Reply, Request, Response, handle};
