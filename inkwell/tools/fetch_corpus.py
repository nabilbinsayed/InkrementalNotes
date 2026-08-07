import os
import sys
import ssl
import urllib.request

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
INKWELL_DIR = os.path.dirname(TOOLS_DIR)
CORPUS_DIR = os.path.join(INKWELL_DIR, "fixtures", "corpus")

os.makedirs(CORPUS_DIR, exist_ok=True)

# List of test PDFs with reliable URLs
PDF_SOURCES = [
    {
        "filename": "arxiv_attention.pdf",
        "url": "https://arxiv.org/pdf/1706.03762.pdf",
        "description": "arXiv paper (Attention Is All You Need) - LaTeX output with object streams / xref streams",
        "property": "xref_stream_latex"
    },
    {
        "filename": "arxiv_adam.pdf",
        "url": "https://arxiv.org/pdf/1412.6980.pdf",
        "description": "arXiv paper (Adam optimizer) - LaTeX output with object streams / xref streams",
        "property": "xref_stream_latex_2"
    },
    {
        "filename": "irs_w9.pdf",
        "url": "https://www.irs.gov/pub/irs-pdf/fw9.pdf",
        "description": "US IRS Form W-9 - Official PDF form with interactive form fields",
        "property": "form_fields_gov"
    },
    {
        "filename": "sample_simple.pdf",
        "url": "https://www.learningcontainer.com/wp-content/uploads/2019/09/sample-pdf-file.pdf",
        "description": "Sample simple text & vector document",
        "property": "simple_vector"
    },
    {
        "filename": "sample_multi_page.pdf",
        "url": "https://www.pdf995.com/samples/pdf.pdf",
        "description": "Multi-page sample document",
        "property": "multi_page"
    }
]

def download_corpus():
    print(f"Target corpus directory: {CORPUS_DIR}")
    downloaded = 0
    skipped = 0
    failed = 0

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }

    for item in PDF_SOURCES:
        filepath = os.path.join(CORPUS_DIR, item["filename"])
        if os.path.exists(filepath) and os.path.getsize(filepath) > 0:
            print(f"[SKIP] {item['filename']} already exists ({os.path.getsize(filepath)} bytes)")
            skipped += 1
            continue

        print(f"[DOWNLOADING] {item['filename']} from {item['url']}...")
        try:
            req = urllib.request.Request(item["url"], headers=headers)
            with urllib.request.urlopen(req, context=ctx, timeout=30) as response, open(filepath, "wb") as out_file:
                data = response.read()
                out_file.write(data)
                print(f"[SUCCESS] Saved {item['filename']} ({len(data)} bytes)")
                downloaded += 1
        except Exception as e:
            print(f"[ERROR] Failed to download {item['filename']}: {e}")
            failed += 1

    manifest_path = os.path.join(CORPUS_DIR, "MANIFEST.md")
    with open(manifest_path, "w", encoding="utf-8") as f:
        f.write("# InkWell Test PDF Corpus\n\n")
        f.write("| Filename | Test Property | Source URL | Description |\n")
        f.write("|---|---|---|---|\n")
        for item in PDF_SOURCES:
            f.write(f"| `{item['filename']}` | `{item['property']}` | [{item['url']}]({item['url']}) | {item['description']} |\n")
    print(f"\nUpdated corpus manifest at: {manifest_path}")
    print(f"Summary: {downloaded} downloaded, {skipped} skipped, {failed} failed.")

if __name__ == "__main__":
    download_corpus()
