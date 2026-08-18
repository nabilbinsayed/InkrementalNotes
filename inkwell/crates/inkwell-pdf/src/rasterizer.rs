use inkwell_core::tiles::{PageRasterizer, Tile};
use pdfium_render::prelude::*;

pub struct PdfiumRasterizer<'a> {
    document: PdfDocument<'a>,
}

impl<'a> PdfiumRasterizer<'a> {
    pub fn new(document: PdfDocument<'a>) -> Self {
        Self { document }
    }
}

impl<'a> PageRasterizer for PdfiumRasterizer<'a> {
    fn page_size_pt(&self, page: u32) -> Option<(f64, f64)> {
        let p = self.document.pages().get(page as i32).map_err(|e| {
            eprintln!("PDFium could not get page {page}: {e:?}");
            e
        }).ok()?;
        Some((p.width().value as f64, p.height().value as f64))
    }

    fn rasterize(&self, page: u32, rect: [f64; 4], px: u32) -> Option<Tile> {
        let p = self.document.pages().get(page as i32).ok()?;
        
        let rw = (rect[2] - rect[0]).max(1.0);
        let rh = (rect[3] - rect[1]).max(1.0);
        
        let page_w = p.width().value as f64;
        let page_h = p.height().value as f64;
        
        let scale = (px as f64) / rw.max(rh);
        let out_w = (rw * scale).round().max(1.0) as u32;
        let out_h = (rh * scale).round().max(1.0) as u32;
        
        let target_w = (page_w * scale).round().max(1.0) as i32;
        let target_h = (page_h * scale).round().max(1.0) as i32;
        
        let config = PdfRenderConfig::new()
            .set_target_width(target_w)
            .set_maximum_height(target_h)
            .set_clear_color(PdfColor::WHITE)
            .render_annotations(false);
            
        let bitmap = p.render_with_config(&config).map_err(|e| {
            eprintln!("PDFium failed to render page {page}: {e:?}");
            e
        }).ok()?;
        let bgra_bytes = bitmap.as_raw_bytes();
        let bitmap_w = bitmap.width() as u32;
        let bitmap_h = bitmap.height() as u32;
        
        let x0 = (rect[0] * scale).round().max(0.0) as u32;
        let y0 = (rect[1] * scale).round().max(0.0) as u32;
        
        let mut rgb_data = vec![255; (out_w * out_h * 3) as usize];
        
        if x0 >= bitmap_w || y0 >= bitmap_h {
            return Some(Tile {
                w: out_w,
                h: out_h,
                data: rgb_data,
            });
        }
        
        let crop_w = out_w.min(bitmap_w.saturating_sub(x0));
        let crop_h = out_h.min(bitmap_h.saturating_sub(y0));
        
        for y in 0..crop_h {
            for x in 0..crop_w {
                let src_idx = ((y0 + y) * bitmap_w + (x0 + x)) as usize * 4;
                let dst_idx = (y * out_w + x) as usize * 3;
                
                if src_idx + 3 < bgra_bytes.len() {
                    let (r, g, b, a) = (
                        bgra_bytes[src_idx],
                        bgra_bytes[src_idx + 1],
                        bgra_bytes[src_idx + 2],
                        bgra_bytes[src_idx + 3] as u32,
                    );
                    
                    // Alpha-blend over white background
                    let blended_r = ((r as u32 * a + 255 * (255 - a)) / 255) as u8;
                    let blended_g = ((g as u32 * a + 255 * (255 - a)) / 255) as u8;
                    let blended_b = ((b as u32 * a + 255 * (255 - a)) / 255) as u8;
                    
                    rgb_data[dst_idx] = blended_r;
                    rgb_data[dst_idx + 1] = blended_g;
                    rgb_data[dst_idx + 2] = blended_b;
                }
            }
        }
        
        Some(Tile {
            w: out_w,
            h: out_h,
            data: rgb_data,
        })
    }
}
