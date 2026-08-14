use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TocItem {
    pub title: String,
    pub page_index: Option<usize>,
    pub children: Vec<TocItem>,
}

fn extract_from_bookmark<'a>(bookmark: &PdfBookmark<'a>) -> TocItem {
    let title = bookmark.title().unwrap_or_else(|| "Untitled".to_string());
    let page_index = bookmark.destination()
        .and_then(|d| d.page_index().ok())
        .map(|p| p as usize)
        .or_else(|| match bookmark.action() {
            Some(PdfAction::LocalDestination(local)) => {
                local.destination().ok().and_then(|d| d.page_index().ok()).map(|p| p as usize)
            }
            _ => None,
        });

    let mut children = Vec::new();
    let mut child = bookmark.first_child();
    while let Some(c) = child {
        children.push(extract_from_bookmark(&c));
        child = c.next_sibling();
    }

    TocItem {
        title,
        page_index,
        children,
    }
}

pub fn extract_outline(document: &PdfDocument<'_>) -> Vec<TocItem> {
    let mut items = Vec::new();
    for bookmark in document.bookmarks().iter() {
        items.push(extract_from_bookmark(&bookmark));
    }
    items
}
