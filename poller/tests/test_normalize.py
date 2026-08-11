from __future__ import annotations

from poller.normalize import (
    PLAINTEXT_CAP,
    clean_title,
    html_to_plaintext,
    normalize_location,
    normalize_locations,
    safe_list,
    safe_string,
    split_locations,
    strip_tags,
    unescape_html,
)


class TestCleanTitle:
    def test_collapse_whitespace(self) -> None:
        assert clean_title("  foo   bar  ") == "foo bar"

    def test_em_dash_to_hyphen(self) -> None:
        assert clean_title("Software Engineer — Summer 2027") == "Software Engineer - Summer 2027"

    def test_en_dash_to_hyphen(self) -> None:
        assert clean_title("Backend – Frontend") == "Backend - Frontend"

    def test_multiple_dash_types(self) -> None:
        result = clean_title("A‐B‒C–D—E")
        assert result == "A-B-C-D-E"

    def test_strip_leading_trailing(self) -> None:
        assert clean_title("  hello world  ") == "hello world"

    def test_none_returns_empty(self) -> None:
        assert clean_title(None) == ""

    def test_empty_returns_empty(self) -> None:
        assert clean_title("") == ""

    def test_unicode_preserved(self) -> None:
        assert clean_title("软件工程师 — 实习") == "软件工程师 - 实习"

    def test_accented_characters_preserved(self) -> None:
        assert clean_title("Développeur Logiciel") == "Développeur Logiciel"

    def test_tabs_and_newlines_collapsed(self) -> None:
        assert clean_title("Software\t\tEngineer\nIntern") == "Software Engineer Intern"

    def test_standard_hyphen_unchanged(self) -> None:
        assert clean_title("Full-Stack Developer") == "Full-Stack Developer"


class TestNormalizeLocation:
    def test_none_returns_empty(self) -> None:
        assert normalize_location(None) == ""

    def test_empty_returns_empty(self) -> None:
        assert normalize_location("") == ""

    def test_whitespace_only_returns_empty(self) -> None:
        assert normalize_location("   ") == ""

    def test_remote(self) -> None:
        assert normalize_location("Remote") == "Remote"

    def test_remote_case_insensitive(self) -> None:
        assert normalize_location("REMOTE") == "Remote"
        assert normalize_location("remote") == "Remote"

    def test_anywhere_becomes_remote(self) -> None:
        assert normalize_location("Anywhere") == "Remote"

    def test_worldwide_becomes_remote(self) -> None:
        assert normalize_location("Worldwide") == "Remote"

    def test_work_from_anywhere_becomes_remote(self) -> None:
        assert normalize_location("Work from anywhere") == "Remote"

    def test_nyc_alias(self) -> None:
        assert normalize_location("NYC") == "New York, NY"

    def test_new_york_city_alias(self) -> None:
        assert normalize_location("New York City") == "New York, NY"

    def test_sf_alias(self) -> None:
        assert normalize_location("SF") == "San Francisco, CA"

    def test_la_alias(self) -> None:
        assert normalize_location("LA") == "Los Angeles, CA"

    def test_dc_alias(self) -> None:
        assert normalize_location("DC") == "Washington, DC"

    def test_washington_dc_alias(self) -> None:
        assert normalize_location("Washington D.C.") == "Washington, DC"

    def test_unrecognized_passthrough(self) -> None:
        assert normalize_location("Austin, TX") == "Austin, TX"

    def test_strips_whitespace(self) -> None:
        assert normalize_location("  NYC  ") == "New York, NY"


class TestSplitLocations:
    def test_none_returns_empty(self) -> None:
        assert split_locations(None) == []

    def test_empty_returns_empty(self) -> None:
        assert split_locations("") == []

    def test_single_location(self) -> None:
        assert split_locations("Austin, TX") == ["Austin, TX"]

    def test_split_on_or(self) -> None:
        assert split_locations("NYC or SF") == ["New York, NY", "San Francisco, CA"]

    def test_split_on_slash(self) -> None:
        assert split_locations("NYC / SF") == ["New York, NY", "San Francisco, CA"]

    def test_split_on_semicolon(self) -> None:
        assert split_locations("NYC; SF") == ["New York, NY", "San Francisco, CA"]

    def test_split_mixed(self) -> None:
        result = split_locations("NYC or Austin, TX")
        assert result == ["New York, NY", "Austin, TX"]

    def test_remote_in_multi(self) -> None:
        result = split_locations("Remote or NYC")
        assert result == ["Remote", "New York, NY"]

    def test_empty_parts_filtered(self) -> None:
        result = split_locations("NYC or  or SF")
        assert result == ["New York, NY", "San Francisco, CA"]


class TestNormalizeLocations:
    def test_none_returns_empty(self) -> None:
        assert normalize_locations(None) == []

    def test_empty_list_returns_empty(self) -> None:
        assert normalize_locations([]) == []

    def test_normalizes_each(self) -> None:
        result = normalize_locations(["NYC", "SF", "Remote"])
        assert result == ["New York, NY", "San Francisco, CA", "Remote"]

    def test_filters_empty(self) -> None:
        result = normalize_locations(["NYC", "", None])  # type: ignore[list-item]
        assert result == ["New York, NY"]

    def test_preserves_unknown(self) -> None:
        result = normalize_locations(["Austin, TX", "Boston, MA"])
        assert result == ["Austin, TX", "Boston, MA"]


class TestUnescapeHtml:
    def test_single_escape(self) -> None:
        assert unescape_html("&amp;") == "&"

    def test_double_escape(self) -> None:
        assert unescape_html("&amp;amp;") == "&"

    def test_triple_escape(self) -> None:
        assert unescape_html("&amp;amp;amp;") == "&"

    def test_lt_gt(self) -> None:
        assert unescape_html("&lt;b&gt;") == "<b>"

    def test_mixed_entities(self) -> None:
        assert unescape_html("&amp;lt;b&amp;gt;") == "<b>"

    def test_no_entities_passthrough(self) -> None:
        assert unescape_html("hello world") == "hello world"

    def test_numeric_entities(self) -> None:
        assert unescape_html("&#38;") == "&"

    def test_unicode_entities(self) -> None:
        assert unescape_html("&#x2019;") == "’"


class TestStripTags:
    def test_simple_tags(self) -> None:
        assert strip_tags("<p>Hello <b>world</b></p>") == "Hello world"

    def test_nested_tags(self) -> None:
        assert strip_tags("<div><p><span>text</span></p></div>") == "text"

    def test_self_closing(self) -> None:
        assert strip_tags("Hello<br/>world") == "Hello world"

    def test_collapse_whitespace(self) -> None:
        assert strip_tags("<p>A</p>   <p>B</p>") == "A B"

    def test_no_tags_passthrough(self) -> None:
        assert strip_tags("plain text") == "plain text"

    def test_tag_with_attributes(self) -> None:
        assert strip_tags('<a href="url">link</a>') == "link"


class TestHtmlToPlaintext:
    def test_full_pipeline(self) -> None:
        result = html_to_plaintext("<p>Hello &amp; world</p>")
        assert result == "Hello & world"

    def test_double_encoded_entities(self) -> None:
        result = html_to_plaintext("&amp;amp;")
        assert result == "&"

    def test_complex_html(self) -> None:
        raw = "<div><h1>Title</h1><p>Some &amp;amp; text</p><ul><li>Item</li></ul></div>"
        result = html_to_plaintext(raw)
        assert result == "Title Some & text Item"

    def test_cap_at_5000(self) -> None:
        long_input = "<p>" + "x" * 6000 + "</p>"
        result = html_to_plaintext(long_input)
        assert len(result) == PLAINTEXT_CAP

    def test_none_returns_empty(self) -> None:
        assert html_to_plaintext(None) == ""

    def test_empty_returns_empty(self) -> None:
        assert html_to_plaintext("") == ""

    def test_unicode_preserved(self) -> None:
        result = html_to_plaintext("<p>日本語テスト</p>")
        assert result == "日本語テスト"

    def test_accented_characters(self) -> None:
        result = html_to_plaintext("<p>café résumé naïve</p>")
        assert result == "café résumé naïve"

    def test_whitespace_collapse(self) -> None:
        result = html_to_plaintext("<p>  foo   bar  </p>")
        assert result == "foo bar"

    def test_greenhouse_style_double_encode(self) -> None:
        raw = "We&amp;amp;#39;re looking for &amp;amp;quot;great&amp;amp;quot; engineers"
        result = html_to_plaintext(raw)
        assert "&amp;" not in result
        assert "&quot;" not in result
        assert "&#39;" not in result


class TestSafeString:
    def test_none_returns_default(self) -> None:
        assert safe_string(None) == ""

    def test_none_returns_custom_default(self) -> None:
        assert safe_string(None, "N/A") == "N/A"

    def test_string_passthrough(self) -> None:
        assert safe_string("hello") == "hello"

    def test_int_converted(self) -> None:
        assert safe_string(42) == "42"

    def test_empty_string_passthrough(self) -> None:
        assert safe_string("") == ""


class TestSafeList:
    def test_none_returns_empty(self) -> None:
        assert safe_list(None) == []

    def test_list_copied(self) -> None:
        original = ["a", "b"]
        result = safe_list(original)
        assert result == ["a", "b"]
        assert result is not original

    def test_empty_list(self) -> None:
        assert safe_list([]) == []
