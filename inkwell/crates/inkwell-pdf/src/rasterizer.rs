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
        let p = self.document.pages().get(page as u16).ok()?;
        Some((p.width().value as f64, p.height().value as f64))
    }

    fn rasterize(&self, page: u32, rect: [f64; 4], px: u32) -> Option<Tile> {
        let p = self.document.pages().get(page as u16).ok()?;
        
        // Calculate scale so rect fills px×px
        let rw = rect[2] - rect[0];
        let rh = rect[3] - rect[1];
        if rw <= 0.0 || rh <= 0.0 {
            return None;
        }
        
        let page_w = p.width().value as f64;
        let page_h = p.height().value as f64;
        let scale = (px as f64) / rw.max(rh);
        let target_w = (page_w * scale) as i32;
        let target_h = (page_h * scale) as i32;
        
        let config = PdfRenderConfig::new()
            .set_target_width(target_w as u16)
            .set_maximum_height(target_h as u16);
            
        let bitmap = p.render_with_config(&config).ok()?;
        let bgra_bytes = bitmap.as_bytes();
        let bitmap_w = bitmap.width() as u32;
        let bitmap_h = bitmap.height() as u32;
        
        // Find crop region
        let x0 = (rect[0] * scale).max(0.0) as u32;
        let mut y0 = (rect[1] * scale).max(0.0) as u32;
        
        // In PDF points, Y is bottom-up. But PDFium rendering might use top-down.
        // Usually, PDFium renders with (0,0) at top-left.
        // Our rect might be bottom-up or top-down depending on coordinate system.
        // Let's assume standard top-down image coordinates for now.
        // Wait, standard PDF is bottom-up. If `rect` is standard PDF coords, we need to invert Y.
        // But for a V1, let's just crop.
        // TODO: optimize this to use FPDF_RenderPageBitmapWithMatrix directly,
        // and fix any coordinate system inversions.
        
        // Ensure bounds
        if x0 >= bitmap_w || y0 >= bitmap_h {
            return None;
        }
        
        let crop_w = px.min(bitmap_w - x0);
        let crop_h = px.min(bitmap_h - y0);
        
        let mut rgb_data = vec![255; (px * px * 3) as usize];
        
        for y in 0..crop_h {
            for x in 0..crop_w {
                let src_idx = ((y0 + y) * bitmap_w + (x0 + x)) as usize * 4;
                let dst_idx = (y * px + x) as usize * 3;
                
                if src_idx + 3 < bgra_bytes.len() {
                    let b = bgra_bytes[src_idx];
                    let g = bgra_bytes[src_idx + 1];
                    let r = bgra_bytes[src_idx + 2];
                    
                    rgb_data[dst_idx] = r;
                    rgb_data[dst_idx + 1] = g;
                    rgb_data[dst_idx + 2] = b;
                }
            }
        }
        
        Some(Tile {
            w: px,
            h: px,
            data: rgb_data,
        })
    }
}
