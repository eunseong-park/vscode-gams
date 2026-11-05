// SPDX-License-Identifier: GPL-3.0-or-later
//! Read throughput of gdx-rs vs. the GDX C library (open + raw read of every record of every
//! symbol): `cargo run -p gdx-rs --release --features capi-oracle --example bench_read -- <sysdir> <file.gdx>...`
use gdx_rs::oracle::CGdx;
use gdx_rs::GdxReader;
use std::path::Path;
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let sd = Path::new(&a[1]);
    for f in &a[2..] {
        let p = Path::new(f);
        let size = std::fs::metadata(p).unwrap().len() as f64 / 1e6;
        let mut best = (f64::MAX, f64::MAX);
        let mut n = (0u64, 0u64);
        for _ in 0..5 {
            let t = Instant::now();
            let mut r = GdxReader::open(p).unwrap();
            let mut cnt = 0u64;
            let mut sum = 0f64;
            for nr in 1..=r.system_info().0 {
                r.read_raw_with(nr, |k, v, _| {
                    cnt += 1;
                    sum += v[0] + k.first().copied().unwrap_or(0) as f64;
                    true
                })
                .unwrap();
            }
            best.0 = best.0.min(t.elapsed().as_secs_f64());
            n.0 = cnt;
            std::hint::black_box(sum);
            let t = Instant::now();
            let c = CGdx::open_read(sd, p).unwrap();
            let mut cnt = 0u64;
            let mut sum = 0f64;
            for nr in 1..=c.system_info().0 {
                c.read_raw(nr, |k, v, _| {
                    cnt += 1;
                    sum += v[0] + k.first().copied().unwrap_or(0) as f64;
                });
            }
            best.1 = best.1.min(t.elapsed().as_secs_f64());
            n.1 = cnt;
            std::hint::black_box(sum);
        }
        assert_eq!(n.0, n.1);
        println!(
            "{f}: {size:.1} MB, {} records: gdx-rs {:.3}s ({:.1} M rec/s), C {:.3}s ({:.1} M rec/s), ratio C/Rust {:.2}",
            n.0,
            best.0,
            n.0 as f64 / best.0 / 1e6,
            best.1,
            n.1 as f64 / best.1 / 1e6,
            best.1 / best.0
        );
    }
}
