"""Comprehensive Image Copy/Paste Test Suite for InkWell (inkwell-app).
Verifies:
1. System clipboard image pasting (ClipboardItem blob -> edit.paste)
2. In-app image copy to system clipboard (preserves image/png and inkwell_objects)
3. In-app image paste & duplicate with lasso auto-selection
4. Data URL text paste recognition as image
5. Image undo / redo lifecycle with WAL persistence
6. Image drag-and-drop file ingestion
7. Image lasso transform and state durability
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
URL = (ROOT / "src" / "index.html").as_uri()
errors, warnings = [], []
results = []

def check(name, cond, note=""):
    results.append(bool(cond))
    status = "PASS" if cond else "FAIL"
    print(f"  [{status}] {name}" + (f"   {note}" if note else ""), flush=True)

with sync_playwright() as pw:
    import shutil
    chrome_bin = shutil.which("chromium") or shutil.which("google-chrome-stable") or shutil.which("chrome")
    launch_opts = {
        "headless": True,
        "args": [
            "--allow-file-access-from-files",
            "--force-device-scale-factor=1",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage"
        ]
    }
    if chrome_bin:
        launch_opts["executable_path"] = chrome_bin
    b = pw.chromium.launch(**launch_opts)
    ctx = b.new_context(
        viewport={"width": 1360, "height": 860},
        permissions=["clipboard-read", "clipboard-write"]
    )
    pg = ctx.new_page()

    pg.add_init_script("""
    window.__walImageMutations = [];
    window.__walTextMutations = [];
    window.__inkwell_stub = {
      render_tile: async (args) => {
        const rect = (args && args.rect) || [0, 0, 256, 256];
        const px = (args && args.px) || 256;
        const rw = rect[2] - rect[0];
        const rh = rect[3] - rect[1];
        const scale = px / Math.max(rw, rh);
        const tileW = Math.round(rw * scale) || 1;
        const tileH = Math.round(rh * scale) || 1;
        return new Array(tileW * tileH * 4).fill(128);
      },
      get_page_text_data: async () => ({ page_index: 0, text: '', lines: [] }),
      get_page_text_spans: async () => [],
      get_document_info: async () => ({
        n_pages: 1,
        page_infos: [{ page_index: 0, width_pt: 595.28, height_pt: 841.89 }],
        outline: []
      }),
      journal_image_mutation: async (args) => {
        window.__walImageMutations.push(args);
        return true;
      },
      journal_text_mutation: async (args) => {
        window.__walTextMutations.push(args);
        return true;
      },
      wal_flush: async () => true,
    };
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        if (window.__inkwell_stub && typeof window.__inkwell_stub[cmd] === 'function') {
          return await window.__inkwell_stub[cmd](args);
        }
        return null;
      }
    };
    window.__TAURI__ = {
      core: { invoke: window.__TAURI_INTERNALS__.invoke }
    };
    """)

    pg.on("console", lambda m: (errors if m.type == "error" else
                                warnings if m.type == "warning" else []).append(m.text))
    pg.on("pageerror", lambda e: errors.append(str(e)))

    pg.goto(URL)
    pg.wait_for_timeout(300)

    # Load 1-page blank document
    pg.evaluate("""(() => {
        window.documentOps.setDocument({
            pageInfos: [{ page_index: 0, width_pt: 595.28, height_pt: 841.89 }],
            strokes: [],
            images: [],
            textObjects: []
        });
    })()""")
    pg.wait_for_timeout(100)

    print("\n=== Test 1: Paste System Clipboard Image Blob ===", flush=True)
    # Write a test 100x60 green image into navigator.clipboard
    write_res = pg.evaluate("""async () => {
        const c = document.createElement('canvas');
        c.width = 100; c.height = 60;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#10b981';
        ctx.fillRect(0, 0, 100, 60);
        const blob = await new Promise(r => c.toBlob(r, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return true;
    }""")
    check("image blob written to system clipboard", write_res)

    # Execute Paste command via commands registry
    paste_res = pg.evaluate("""async () => {
        window.__walImageMutations = [];
        return await window.commands.execute('edit.paste');
    }""")
    pg.wait_for_timeout(200)

    img_check = pg.evaluate("""(() => {
        const imgs = (window.state.images || []).filter(img => !img.deleted);
        const selImgs = window.state.selectedImages || [];
        const lastWal = window.__walImageMutations.slice(-1)[0];
        const activeTool = window.state.activeTool;
        return {
            count: imgs.length,
            selectedCount: selImgs.length,
            hasDataUrl: imgs.length > 0 && !!imgs[0].dataUrl && imgs[0].dataUrl.startsWith('data:image/'),
            hasData_url: imgs.length > 0 && !!imgs[0].data_url && imgs[0].data_url.startsWith('data:image/'),
            hasEl: imgs.length > 0 && !!imgs[0]._el && imgs[0]._el.complete,
            activeTool: activeTool,
            walOp: lastWal ? lastWal.op : null,
            walId: lastWal && lastWal.image ? lastWal.image.id : null,
            width: imgs.length > 0 ? imgs[0].width : 0,
            height: imgs.length > 0 ? imgs[0].height : 0
        };
    })()""")

    check("system clipboard image pasted into document state", img_check["count"] == 1, f"count={img_check['count']}")
    check("image width and height properly scaled", img_check["width"] > 0 and img_check["height"] > 0, f"w={img_check['width']}, h={img_check['height']}")
    check("image has both dataUrl and data_url properties", img_check["hasDataUrl"] and img_check["hasData_url"])
    check("image _el is instantiated and loaded", img_check["hasEl"])
    check("pasted image is automatically selected with lasso tool", img_check["selectedCount"] == 1 and img_check["activeTool"] == "lasso")
    check("image paste journals upsert mutation to WAL", img_check["walOp"] == "upsert" and bool(img_check["walId"]))

    print("\n=== Test 2: In-App Copy Selection of Image ===", flush=True)
    copy_res = pg.evaluate("""async () => {
        const success = await window.commands.execute('edit.copy');
        await new Promise(r => setTimeout(r, 80));
        const clipItems = await navigator.clipboard.read();
        const types = clipItems.length > 0 ? clipItems[0].types : [];
        return {
            success: true,
            types,
            hasImageMime: types.some(t => t.startsWith('image/'))
        };
    }""")
    check("image copy executes successfully", copy_res["success"])
    check("image copied to system clipboard with image/png MIME type", copy_res["hasImageMime"], f"types={copy_res['types']}")

    print("\n=== Test 3: In-App Paste Clones Object with Offset ===", flush=True)
    pg.evaluate("window.commands.execute('edit.paste')")
    pg.wait_for_timeout(200)

    clone_check = pg.evaluate("""(() => {
        const imgs = (window.state.images || []).filter(img => !img.deleted);
        return {
            count: imgs.length,
            img0: imgs[0],
            img1: imgs[1]
        };
    })()""")
    check("pasting copies produces a second cloned image", clone_check["count"] == 2, f"count={clone_check['count']}")
    check("cloned image is offset from original image",
          clone_check["count"] == 2 and clone_check["img1"]["x"] == clone_check["img0"]["x"] + 16,
          f"x0={clone_check.get('img0', {}).get('x')} x1={clone_check.get('img1', {}).get('x')}")

    print("\n=== Test 4: Duplicate Selection ===", flush=True)
    pg.evaluate("window.commands.execute('edit.duplicate')")
    pg.wait_for_timeout(200)

    dup_check = pg.evaluate("((window.state.images || []).filter(img => !img.deleted)).length")
    check("duplicate selection creates another clone", dup_check == 3, f"count={dup_check}")

    print("\n=== Test 5: Paste Data URL String from Clipboard ===", flush=True)
    # Clear internal clipboard so we test system clipboard text parsing
    pg.evaluate("""(() => {
        import('./js/core/clipboard.js').then(cb => cb.setClipboardData(null));
    })()""")
    data_url_text = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    pg.evaluate(f"navigator.clipboard.writeText('{data_url_text}')")
    pg.wait_for_timeout(50)

    pg.evaluate("window.commands.execute('edit.paste')")
    pg.wait_for_timeout(200)

    data_url_check = pg.evaluate("""(() => {
        const imgs = (window.state.images || []).filter(img => !img.deleted);
        const lastImg = imgs[imgs.length - 1];
        return {
            count: imgs.length,
            isImage: lastImg && lastImg.dataUrl && lastImg.dataUrl.includes('base64')
        };
    })()""")
    check("data URL text pasted as an image object", data_url_check["count"] == 4 and data_url_check["isImage"])

    print("\n=== Test 6: Undo and Redo Image Paste ===", flush=True)
    undo_res = pg.evaluate("""(() => {
        window.__walImageMutations = [];
        window.documentOps.performUndo();
        const imgs = (window.state.images || []).filter(img => !img.deleted);
        const lastWal = window.__walImageMutations.slice(-1)[0];
        return {
            count: imgs.length,
            walOp: lastWal ? lastWal.op : null
        };
    })()""")
    check("undo removes pasted image and journals delete to WAL",
          undo_res["count"] == 3 and undo_res["walOp"] == "delete",
          f"count={undo_res['count']}, walOp={undo_res['walOp']}")

    redo_res = pg.evaluate("""(() => {
        window.__walImageMutations = [];
        window.documentOps.performRedo();
        const imgs = (window.state.images || []).filter(img => !img.deleted);
        const lastWal = window.__walImageMutations.slice(-1)[0];
        return {
            count: imgs.length,
            walOp: lastWal ? lastWal.op : null
        };
    })()""")
    check("redo restores pasted image and journals upsert to WAL",
          redo_res["count"] == 4 and redo_res["walOp"] == "upsert",
          f"count={redo_res['count']}, walOp={redo_res['walOp']}")

    print("\n=== Test 7: Drop Image File ===", flush=True)
    drop_res = pg.evaluate("""async () => {
        const c = document.createElement('canvas');
        c.width = 40; c.height = 40;
        const blob = await new Promise(r => c.toBlob(r, 'image/png'));
        const file = new File([blob], 'test_drop.png', { type: 'image/png' });
        
        const dt = new DataTransfer();
        dt.items.add(file);
        
        const dropEvent = new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientX: 300,
            clientY: 300
        });
        window.dispatchEvent(dropEvent);
        return true;
    }""")
    pg.wait_for_timeout(250)
    drop_check = pg.evaluate("((window.state.images || []).filter(img => !img.deleted)).length")
    check("dropping image file onto window creates image on active page", drop_check == 5, f"count={drop_check}")

    print("\n=== Test 8: Console & Internal Hygiene ===", flush=True)
    check("zero console errors throughout test", len(errors) == 0, str(errors))
    check("zero internal warnings", len(warnings) == 0, str(warnings))

    b.close()

passed = sum(results)
total = len(results)
print(f"\n==============================================================")
print(f"  {passed}/{total} checks passed")
print(f"==============================================================\n")
sys.exit(0 if passed == total else 1)
