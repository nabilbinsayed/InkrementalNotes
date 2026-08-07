//! Full pipeline in one command, for cross-language validation.
//!
//!   cargo run --example annotate -- <in.pdf> <out.pdf> [generations]
//!
//! Writes N incremental generations, exactly as autosave would, then reads the
//! sidecar back and prints a machine-readable summary for `tools/validate.py`.

use inkwell_core::doc::{DeviceInfo, Document};
use inkwell_core::ink::*;
use inkwell_core::pdf::{self, PdfFile, SidecarStatus};

fn stroke(id: u128, y0: f64, n: usize, kind: ToolKind, seed: u32, rgb: [f64; 3]) -> Stroke {
    let brush = Brush {
        base_width: if kind == ToolKind::Highlighter { 15.0 } else { 2.4 },
        gamma: 0.85 + (seed % 5) as f64 * 0.09,
        ..Default::default()
    };
    let s = seed as f64;
    let mut b = StrokeBuilder::new(id, kind, rgb, brush, true);
    for i in 0..n {
        let t = i as f64 / (n - 1) as f64;
        let x = 70.0 + t * (360.0 + s * 9.0);
        let y = y0 + 5.5 * (t * (24.0 + s)).sin() + 2.2 * (t * (55.0 + s * 3.0)).sin();
        let env = (std::f64::consts::PI * t.powf(0.8 + s * 0.03)).sin().powf(0.55);
        let ripple = 0.88 + 0.12 * (t * (9.0 + s * 1.7) + s).sin();
        b.push(x, y, (env * ripple * 0.95 + 0.04).clamp(0.02, 1.0), i as f64 * 4.3);
    }
    b.finish(0.12)
}

fn build(n_strokes: usize, generation: u64) -> Document {
    let mut d = Document::for_pdf(1);
    d.device = DeviceInfo { model: "Huion H640P".into(), report_hz: 233.0, tilt: false };
    d.generation = generation;
    let mut ids = IdGen::seeded(0xC0FFEE);
    // one highlighter over the formula, then handwritten note lines
    d.push_stroke(0, stroke(ids.next_id(), 458.0, 200, ToolKind::Highlighter, 1, [1.0, 0.86, 0.2]));
    for i in 1..n_strokes {
        d.push_stroke(
            0,
            stroke(ids.next_id(), 250.0 - (i as f64 - 1.0) * 26.0, 280, ToolKind::Pen, i as u32 + 1,
                   [0.06, 0.06, 0.30]),
        );
    }
    d
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 3 {
        eprintln!("usage: annotate <in.pdf> <out.pdf> [generations]");
        std::process::exit(2);
    }
    let (src, dst) = (&a[1], &a[2]);
    let gens: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(2);

    let original = std::fs::read(src)?;
    let mut current = original.clone();
    let mut sizes = Vec::new();

    for g in 1..=gens {
        let n = 4 + (g as usize) * 3; // user keeps adding strokes
        let doc = build(n, g);
        let mut f = PdfFile::open(current.clone())?;
        f.write_document(&doc, pdf::DEFAULT_GROUP)?;
        current = f.finish();
        sizes.push((g, n, current.len()));
        // keep generation 1 around so the validator can test crash recovery
        if g == 1 {
            std::fs::write(format!("{dst}.gen1"), &current)?;
        }
    }
    std::fs::write(dst, &current)?;

    let prefix_ok = current[..original.len()] == original[..];
    let (strokes, samples, gen, model, tilt) = match pdf::read_sidecar(&current)? {
        SidecarStatus::Ok(d) => (
            d.stroke_count(),
            d.sample_count(),
            d.generation,
            d.device.model.clone(),
            d.device.tilt,
        ),
        other => {
            eprintln!("sidecar not Ok after write");
            let _ = other;
            std::process::exit(1);
        }
    };

    println!("{{");
    println!("  \"original_bytes\": {},", original.len());
    println!("  \"final_bytes\": {},", current.len());
    println!("  \"generations\": {gens},");
    println!("  \"prefix_preserved\": {prefix_ok},");
    println!("  \"sidecar_strokes\": {strokes},");
    println!("  \"sidecar_samples\": {samples},");
    println!("  \"sidecar_generation\": {gen},");
    println!("  \"device_model\": \"{model}\",");
    println!("  \"device_tilt\": {tilt},");
    print!("  \"sizes\": [");
    for (i, (g, n, s)) in sizes.iter().enumerate() {
        print!("{}{{\"gen\":{g},\"strokes\":{n},\"bytes\":{s}}}", if i > 0 { "," } else { "" });
    }
    println!("]");
    println!("}}");
    Ok(())
}
