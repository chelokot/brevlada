import { expect, test } from "bun:test";
import { message } from "../models";
import { descendants, html as serialize, parse, text } from "../models/dom";
import css from "./html_viewer/body.css" with { type: "text" };
import { document, hasRemoteMedia, plainText } from "./html";

test("full documents and unbalanced markup stay inside the measured root", () => {
  const html = document(
    message({
      bodyHtml:
        "<!doctype html><html><head><style>body{padding:0}</style></head><body class='newsletter' style='background:blue'><table><tr><td>Top</td></tr></table></div></div><p>Bottom</p></body></html>",
    }),
    false,
    false,
  );
  const tree = parse(html);
  const root = descendants(tree).find((element) => element.attributes.some(([name, value]) => name === "id" && value === "brevlada-content"));
  if (!root) throw new Error("root expected");
  expect(text(root)).toContain("Bottom");
  const inner = serialize(root.children);
  expect(inner).toContain("newsletter");
  expect(inner).toContain("background:blue");
  expect(descendants(tree).filter((element) => element.name === "html").length).toBe(1);
  expect(html.indexOf("body{padding:0}")).toBeLessThan(html.indexOf(css));
  expect(html.match(/<div/g)?.length).toBe(html.match(/<\/div>/g)?.length);
});

test("collapses only trailing plain text quotes", () => {
  const html = plainText("Intro\n> inline quote\nMy reply\n> older reply\n> another line\n\n", false);
  expect(html.match(/<details>/g)?.length).toBe(1);
  expect(html.startsWith("<pre>Intro\n&gt; inline quote\nMy reply</pre><details>")).toBe(true);
  expect(plainText("> quotation\nMy reply", false)).not.toContain("<details>");
  expect(plainText("Only my reply\n\n", false)).not.toContain("<details>");
  const withoutQuote = plainText("My reply\nOn Tuesday, Alice wrote:\n\n> older message\n", true);
  expect(withoutQuote).toBe("<pre>My reply</pre>");
});

test("escapes plain text and collapses quoted replies without scripts", () => {
  const html = document(message({ bodyText: "<script>alert(1)</script>\n> old reply\nnew reply" }), false, false);
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<details>");
  expect(html).toContain("default-src 'none'");
});

test("remote images are permitted by policy for webkit to load on request", () => {
  expect(document(message({ bodyHtml: "<img src='https://example.com/image.png'>" }), false, false)).toContain("img-src data: https: http:;");
});

test("short plain text does not keep trailing blank lines", () => {
  expect(plainText("Hello\n\n \n", false)).toBe("<pre>Hello</pre>");
  expect(plainText("Hello", false)).toBe("<pre>Hello</pre>");
  expect(plainText("it's <b>\x01", false)).toBe("<pre>it&#39;s &lt;b&gt;&#x1;</pre>");
});

test("remote media requires a loaded html image", () => {
  const item = message({ bodyHtml: "<img src='https://example.com/image.png'>" });
  expect(hasRemoteMedia(item)).toBe(false);
  expect(hasRemoteMedia({ ...item, bodyLoaded: true })).toBe(true);
  expect(hasRemoteMedia({ ...item, bodyLoaded: true, bodyHtml: "<p>Just text</p><img src='cid:logo'>" })).toBe(true);
  expect(hasRemoteMedia({ ...item, bodyLoaded: true, bodyHtml: "<img srcset='local.png 1x, //cdn/x.png 2x'><video src='https://x'></video>" })).toBe(true);
  expect(hasRemoteMedia({ ...item, bodyLoaded: true, bodyHtml: "<video src='https://x'></video><img src='data:image/png;base64,AA'>" })).toBe(false);
});

test("replaces cid image only when media is enabled", () => {
  const item = message({ bodyHtml: "<img src='cid:LOGO@example.com'>", inlineMedia: [{ contentId: "logo@example.com", mime: "image/png", data: "aGVsbG8=" }] });
  expect(document(item, false, false)).toContain("cid:LOGO@example.com");
  expect(document(item, false, true)).toContain("data:image/png;base64,aGVsbG8=");
});
