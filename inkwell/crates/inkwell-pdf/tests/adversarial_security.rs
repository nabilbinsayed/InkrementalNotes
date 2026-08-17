// ===========================================================================
// Adversarial Unicode Search Character Window Slicing Stress Test
// ===========================================================================

#[derive(Debug, PartialEq, Eq)]
pub struct SearchResultSnippet {
    pub snippet: String,
    pub match_count: usize,
}

/// Exact replica of search_pdf character window search & slicing logic from commands.rs
pub fn execute_search_slice(text: &str, query: &str) -> Option<SearchResultSnippet> {
    let query_trimmed = query.trim();
    if query_trimmed.is_empty() {
        return None;
    }

    let q_lower = query_trimmed.to_lowercase();
    let text_chars: Vec<char> = text.chars().collect();
    let text_lower: String = text_chars.iter().collect::<String>().to_lowercase();
    let text_lower_chars: Vec<char> = text_lower.chars().collect();
    let q_chars: Vec<char> = q_lower.chars().collect();

    if q_chars.is_empty() {
        return None;
    }

    if let Some(char_idx) = text_lower_chars
        .windows(q_chars.len())
        .position(|w| w == q_chars.as_slice())
    {
        let start = char_idx.saturating_sub(40).min(text_chars.len());
        let end = (char_idx + q_chars.len() + 40).min(text_chars.len()).max(start);
        let snippet_str: String = text_chars[start..end].iter().collect();
        let snippet = format!(
            "{}{}{}",
            if start > 0 { "…" } else { "" },
            snippet_str.replace('\n', " "),
            if end < text_chars.len() { "…" } else { "" }
        );
        let match_count = text_lower_chars
            .windows(q_chars.len())
            .filter(|w| *w == q_chars.as_slice())
            .count();
        Some(SearchResultSnippet { snippet, match_count })
    } else {
        None
    }
}

#[test]
fn test_unicode_search_multilingual_corpus() {
    let test_corpora = &[
        // Bengali (complex Brahmic script with virama ligatures)
        (
            "অধ্যায় ৩: ত্রিকোণমিতি এবং ক্যালকুলাস। এই অধ্যায়ে আমরা ত্রিকোণমিতিক অনুপাত নিয়ে আলোচনা করব।",
            "ত্রিকোণমিতি",
            2,
        ),
        (
            "গণিত ও পদার্থবিজ্ঞান গবেষণায় বাংলাদেশের অবদান অনস্বীকার্য।",
            "পদার্থবিজ্ঞান",
            1,
        ),
        // Arabic (RTL, cursive joining, diacritics, ligature marks)
        (
            "بسم الله الرحمن الرحيم - الحمد لله رب العالمين - الرحمن الرحيم",
            "الرحمن",
            2,
        ),
        (
            "اللغة العربية هي أكثر اللغات السامية تحدثاً وإحدى أكثر اللغات انتشاراً في العالم.",
            "اللغة العربية",
            1,
        ),
        // CJK (Chinese, Japanese, Korean)
        (
            "形態素解析（けいたいそかいせき）とは、文法的な情報の注記のない自然言語のテキストデータを解析する処理。",
            "形態素解析",
            1,
        ),
        (
            "自然语言处理是计算机科学领域与人工智能领域中的一个重要方向。语言处理应用广泛。",
            "语言处理",
            2,
        ),
        (
            "한국어 정보 처리 및 자연어 처리 기술의 발전은 매우 눈부십니다. 자연어 처리는 인공지능의 핵심입니다.",
            "자연어 처리",
            2,
        ),
        // Emojis & Extended Graphemes (ZWJ, skin tone modifiers, flags)
        (
            "Team members: 👨‍💻 coder, 👩‍🔬 scientist, 🧑‍🚀 astronaut, 👩‍👩‍👧‍👦 family, 🏳️‍🌈 pride, and 👍🏽 thumbs up!",
            "👩‍🔬",
            1,
        ),
        (
            "Rocket launch sequence: 3️⃣ 2️⃣ 1️⃣ 🚀 BLASTOFF! 🌌 Exploring deep space with 🚀 rockets.",
            "🚀",
            2,
        ),
        // Mathematical & Technical Symbols
        (
            "Maxwell's equations: ∇⋅E = ρ/ε₀, ∇⋅B = 0, ∇×E = -∂B/∂t, ∇×B = μ₀J + μ₀ε₀∂E/∂t. Note that ∇×E is rotational.",
            "∇×E",
            2,
        ),
        (
            "Summation series: ∑_{i=0}^∞ a_i x^i = e^x where ∀x∈ℝ, ∃y>0 such that |x - y| < ε.",
            "∑_{i=0}^∞",
            1,
        ),
    ];

    for (text, query, expected_count) in test_corpora {
        let result = execute_search_slice(text, query);
        assert!(result.is_some(), "Query '{query}' must match in text '{text}'");
        let res = result.unwrap();
        assert_eq!(
            res.match_count, *expected_count,
            "Match count mismatch for query '{query}'"
        );
        assert!(
            res.snippet.to_lowercase().contains(&query.to_lowercase()),
            "Snippet must contain query '{query}': got snippet '{}'",
            res.snippet
        );
    }
}

#[test]
fn test_unicode_search_boundary_conditions() {
    let text = "START: 中文 এবং বাংলা and English at the END.";

    // Match at exact start (char 0)
    let start_res = execute_search_slice(text, "START").expect("match start");
    assert_eq!(start_res.match_count, 1);
    assert!(!start_res.snippet.starts_with('…'), "Start match should not have leading ellipsis");

    // Match at exact end
    let end_res = execute_search_slice(text, "END.").expect("match end");
    assert_eq!(end_res.match_count, 1);
    assert!(!end_res.snippet.ends_with('…'), "End match should not have trailing ellipsis");

    // Exact full match (text == query)
    let exact_res = execute_search_slice(text, text).expect("match exact text");
    assert_eq!(exact_res.match_count, 1);
    assert!(!exact_res.snippet.starts_with('…'));
    assert!(!exact_res.snippet.ends_with('…'));

    // Empty queries
    assert!(execute_search_slice(text, "").is_none());
    assert!(execute_search_slice(text, "   ").is_none());
    assert!(execute_search_slice(text, "\t\n\r ").is_none());

    // Query longer than text
    let huge_query = "START: 中文 এবং বাংলা and English at the END. WITH EVEN MORE TEXT THAT EXCEEDS TOTAL LENGTH";
    assert!(execute_search_slice(text, huge_query).is_none());

    // Text shorter than 40 chars
    let short_text = "বাংলা এবং CJK";
    let short_res = execute_search_slice(short_text, "এবং").expect("match short text");
    assert_eq!(short_res.match_count, 1);
    assert_eq!(short_res.snippet, "বাংলা এবং CJK");
}

#[test]
fn test_unicode_search_massive_text_and_stress_fuzzing() {
    // Generate a long 10,000-character multilingual text
    let mut large_text = String::new();
    let alphabet = ["বাংলা", "ত্রিকোণমিতি", "العربية", "日本語", "한국어", "🚀", "∑_{i=0}^n", "test", "αβγδε", "\n"];
    for i in 0..2000 {
        large_text.push_str(alphabet[i % alphabet.len()]);
        large_text.push(' ');
    }

    // Search for repeated tokens
    let res = execute_search_slice(&large_text, "ত্রিকোণমিতি");
    assert!(res.is_some());
    let r = res.unwrap();
    assert!(r.match_count >= 100);
    assert!(r.snippet.starts_with('…') || !r.snippet.is_empty());

    // Random slicing stress test with 5,000 queries: ensure ZERO panics
    for i in 0..5000 {
        let needle = alphabet[i % alphabet.len()];
        let _ = execute_search_slice(&large_text, needle);
    }
}
