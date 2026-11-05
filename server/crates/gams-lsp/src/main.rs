// SPDX-License-Identifier: GPL-3.0-or-later
use lsp_server::Connection;

fn main() {
    let (conn, io) = Connection::stdio();
    let r = gams_lsp::run(conn);
    if let Err(e) = io.join() {
        eprintln!("[gams-lsp] io error: {e}");
    }
    if let Err(e) = r {
        eprintln!("[gams-lsp] fatal: {e}");
        std::process::exit(1);
    }
}
