use inkwell_core::tiles::*;

/// Stand-in for PDFium. Records what it was asked to draw so we can assert on
/// the access pattern rather than on pixels.
struct Stub {
    calls: std::cell::RefCell<Vec<(u32, [f64; 4], u32)>>,
    page: (f64, f64),
}

impl Stub {
    fn new() -> Self {
        Self { calls: std::cell::RefCell::new(Vec::new()), page: (595.0, 842.0) }
    }
    fn count(&self) -> usize {
        self.calls.borrow().len()
    }
}

impl PageRasterizer for Stub {
    fn page_size_pt(&self, _page: u32) -> Option<(f64, f64)> {
        Some(self.page)
    }
    fn rasterize(&self, page: u32, rect: [f64; 4], px: u32) -> Option<Tile> {
        self.calls.borrow_mut().push((page, rect, px));
        Some(Tile { w: px, h: px, data: vec![255u8; (px * px * 3) as usize] })
    }
}

fn view(zoom: f64) -> View {
    View { page: 0, origin: (0.0, 0.0), size: (595.0, 842.0), zoom, dpr: 1.0 }
}

#[test]
fn lod_rises_with_zoom_and_never_upscales() {
    let mut last = LOD_MIN;
    for z in [0.1, 0.25, 0.5, 1.0, 1.5, 2.0, 4.0, 8.0, 100.0] {
        let v = view(z);
        let l = v.lod();
        assert!(l >= last, "lod must be monotonic in zoom");
        last = l;
        // the chosen bucket must be at or ABOVE the required scale, so tiles get
        // downscaled (sharp) rather than upscaled (soft)
        assert!(
            lod_scale(l) >= v.device_scale() - 1e-9 || l == LOD_MAX,
            "lod {l} (scale {}) is below required {} at zoom {z}",
            lod_scale(l),
            v.device_scale()
        );
    }
}

#[test]
fn lod_accounts_for_device_pixel_ratio() {
    let a = View { dpr: 1.0, ..view(1.0) };
    let b = View { dpr: 2.0, ..view(1.0) };
    assert!(b.lod() > a.lod(), "a 2x display needs a finer lod at the same zoom");
}

#[test]
fn lod_is_clamped_at_both_ends() {
    assert_eq!(view(1e9).lod(), LOD_MAX);
    assert_eq!(view(1e-9).lod(), LOD_MIN);
}

#[test]
fn visible_tiles_cover_the_viewport_and_stay_bounded() {
    for z in [0.5, 1.0, 2.0, 4.0, 8.0] {
        let v = view(z);
        let ts = visible_tiles(&v);
        assert!(!ts.is_empty());
        // union of tile rects must cover the viewport
        let (mut mx, mut my) = (f64::MIN, f64::MIN);
        for k in &ts {
            let r = tile_rect(*k);
            mx = mx.max(r[2]);
            my = my.max(r[3]);
        }
        assert!(mx >= v.size.0 - 1e-6, "horizontal gap at zoom {z}");
        assert!(my >= v.size.1 - 1e-6, "vertical gap at zoom {z}");
        // a full A4 page must never explode into an unbounded tile set
        assert!(ts.len() < 400, "{} tiles at zoom {z} is too many", ts.len());
    }
}

#[test]
fn centre_tiles_are_requested_first() {
    let v = View { origin: (0.0, 0.0), size: (595.0, 842.0), ..view(4.0) };
    let ts = visible_tiles(&v);
    assert!(ts.len() > 4, "need a multi-tile view for this to mean anything");
    let t = TILE as f64 / lod_scale(v.lod());
    let cx = (v.size.0 / 2.0) / t;
    let cy = (v.size.1 / 2.0) / t;
    let d = |k: &TileKey| (k.tx as f64 + 0.5 - cx).hypot(k.ty as f64 + 0.5 - cy);
    assert!(d(&ts[0]) <= d(ts.last().unwrap()), "first tile should be nearer the centre");
}

#[test]
fn exact_hit_after_insert() {
    let mut c = TileCache::new(64 * 1024 * 1024);
    let stub = Stub::new();
    let v = view(1.0);
    c.request_for_view(&v);
    c.pump(&stub, 999);
    for k in visible_tiles(&v) {
        assert_eq!(c.lookup(k), Lookup::Exact, "tile {k:?} should be resident");
    }
}

#[test]
fn zooming_in_falls_back_to_a_coarser_tile_instead_of_blank() {
    let mut c = TileCache::new(64 * 1024 * 1024);
    let stub = Stub::new();
    // render at 1x
    let v1 = view(1.0);
    c.request_for_view(&v1);
    c.pump(&stub, 999);

    // now the user zooms to 4x: nothing sharp is resident yet
    let v4 = view(4.0);
    let target = visible_tiles(&v4)[0];
    match c.lookup(target) {
        Lookup::Coarser(l) => assert!(l < v4.lod(), "must fall back to a lower lod"),
        other => panic!("expected coarser fallback, got {other:?}"),
    }
}

#[test]
fn cold_cache_reports_miss_not_a_lie() {
    let mut c = TileCache::new(1024);
    assert_eq!(c.lookup(TileKey { page: 0, lod: 0, tx: 0, ty: 0 }), Lookup::Miss);
}

#[test]
fn eviction_respects_the_memory_budget() {
    let tile_bytes = (TILE * TILE * 3) as usize;
    let budget = tile_bytes * 4;
    let mut c = TileCache::new(budget);
    let stub = Stub::new();

    for page in 0..12u32 {
        let v = View { page, ..view(1.0) };
        c.request_for_view(&v);
        c.pump(&stub, 999);
        assert!(
            c.bytes_used() <= budget || c.len() <= 1,
            "budget blown: {} > {budget}",
            c.bytes_used()
        );
    }
    assert!(c.evictions > 0, "nothing was ever evicted; the budget is not being enforced");
    assert!(c.len() <= 4 + 1);
}

#[test]
fn eviction_is_least_recently_used() {
    let tile_bytes = (TILE * TILE * 3) as usize;
    let mut c = TileCache::new(tile_bytes * 3);
    let mk = |i: i32| TileKey { page: 0, lod: 0, tx: i, ty: 0 };
    let tile = || Tile { w: TILE, h: TILE, data: vec![0u8; tile_bytes] };

    c.insert(mk(0), tile());
    c.insert(mk(1), tile());
    c.insert(mk(2), tile());
    // touch tile 0 so tile 1 becomes the oldest
    assert_eq!(c.lookup(mk(0)), Lookup::Exact);
    c.insert(mk(3), tile());

    assert!(c.contains(&mk(0)), "recently used tile must survive");
    assert!(!c.contains(&mk(1)), "least recently used tile should have been evicted");
    assert!(c.contains(&mk(3)));
}

#[test]
fn panning_cancels_requests_that_scrolled_off_screen() {
    let mut c = TileCache::new(64 * 1024 * 1024);
    let v1 = View { origin: (0.0, 0.0), size: (300.0, 300.0), ..view(4.0) };
    let queued = c.request_for_view(&v1);
    assert!(!queued.is_empty());
    let n1 = c.pending().len();

    // user pans a long way before anything finished rendering
    let v2 = View { origin: (4000.0, 4000.0), size: (300.0, 300.0), ..view(4.0) };
    c.request_for_view(&v2);
    let still = c.pending().iter().filter(|k| visible_tiles(&v1).contains(k)).count();
    assert_eq!(still, 0, "{still} stale tiles still queued out of {n1}");
    assert!(!c.pending().is_empty(), "the new viewport's tiles must be queued");
}

#[test]
fn repeated_views_do_not_re_rasterise() {
    let mut c = TileCache::new(64 * 1024 * 1024);
    let stub = Stub::new();
    let v = view(2.0);
    c.request_for_view(&v);
    c.pump(&stub, 999);
    let after_first = stub.count();
    assert!(after_first > 0);

    for _ in 0..5 {
        let queued = c.request_for_view(&v);
        assert!(queued.is_empty(), "already-resident tiles must not be re-requested");
        c.pump(&stub, 999);
    }
    assert_eq!(stub.count(), after_first, "re-rasterised tiles that were already cached");
}

#[test]
fn rasterizer_is_asked_for_the_correct_page_region() {
    let stub = Stub::new();
    let mut c = TileCache::new(64 * 1024 * 1024);
    let v = view(1.0);
    c.request_for_view(&v);
    c.pump(&stub, 1);
    let calls = stub.calls.borrow();
    let (page, rect, px) = calls[0];
    assert_eq!(page, 0);
    assert_eq!(px, TILE, "tiles must be rendered at the tile resolution");
    let expect = TILE as f64 / lod_scale(v.lod());
    assert!((rect[2] - rect[0] - expect).abs() < 1e-6, "tile covers the wrong point span");
}

#[test]
fn rasterizer_failure_does_not_wedge_the_queue() {
    struct Failing;
    impl PageRasterizer for Failing {
        fn page_size_pt(&self, _: u32) -> Option<(f64, f64)> {
            Some((595.0, 842.0))
        }
        fn rasterize(&self, _: u32, _: [f64; 4], _: u32) -> Option<Tile> {
            None
        }
    }
    let mut c = TileCache::new(1024 * 1024);
    let v = view(1.0);
    c.request_for_view(&v);
    let n = c.pending().len();
    assert!(n > 0);
    c.pump(&Failing, 999);
    assert!(c.pending().is_empty(), "failed renders must be dequeued, not retried forever");
    assert_eq!(c.len(), 0);
}
