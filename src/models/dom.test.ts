import { expect, test } from "bun:test";
import { attribute, decode, descendants, html, parse, text } from "./dom";

test("decodes character references like html5ever", () => {
  expect(decode("&amp; &AMP &notin; &notit; &ampx; &#x1F600; &#128512 &#0; &#x80; &#xD800; &zwnj;&nbsp;&bogus; a\r\nb\rc")).toBe(
    "& & ∉ ¬it; &x; 😀 😀 � € � ‌ &bogus; a\nb\nc",
  );
  expect(decode("?a=1&copy=2&amp;b&copyx", true)).toBe("?a=1&copy=2&b&copyx");
  expect(decode("&constructor;")).toBe("&constructor;");
});

test("builds a balanced tree from tag soup", () => {
  const root = parse("<div title='a &amp; b'><p>one<b>two</div>three</p><img src=x><br>four");
  expect(html(root.children, "body")).toBe('<div title="a &amp; b"><p>one<b>two</b></p></div>three<img src="x"><br>four');
  const [div] = descendants(root);
  expect(div && attribute(div, "title")).toBe("a & b");
  expect(text(root)).toBe("onetwothreefour");
  expect(html(parse("<style>a > b { }</style><p>1 < 2 &nbsp;</p><svg><circle/></svg>").children, "head")).toBe(
    "<head><style>a > b { }</style></head><p>1 &lt; 2 &nbsp;</p><svg><circle></circle></svg>",
  );
});
