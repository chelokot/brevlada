import { expect, test } from "bun:test";
import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import { Editor, toolbar, WORLD } from "./html-editor";
import { settle, useDisplay } from "./testing";

useDisplay();

const evaluate = async (editor: Editor, script: string) => (await editor.view.evaluate_javascript(script, -1, WORLD, null, null)).to_string();
const json = async (editor: Editor, script: string) => JSON.parse(await evaluate(editor, script));

async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 50 && !check(); attempt++) await settle(20);
  return check();
}

async function ready(editor: Editor) {
  for (let attempt = 0; attempt < 250 && !editor.ready; attempt++) await settle(20);
  expect(editor.ready).toBe(true);
  await settle(300);
}

function htmlMode() {
  const buffer = new Gtk.TextBuffer();
  const mode = new Gtk.ToggleButton();
  mode.set_active(true);
  return { buffer, mode };
}

test("forwards html with literal headers and original formatting", async () => {
  const { buffer, mode } = htmlMode();
  const editor = new Editor(buffer, mode, () => {});
  const header = "From: Sender <sender@example.com>\nSubject: <b>Literal</b>\n";
  editor.forward(
    header,
    "<!doctype html><html><head><style>b { color: rgb(255, 0, 0); }</style></head><body bgcolor='#f6f6f6'><b>Original</b><img src='cid:logo'><script>document.body.textContent='bad'</script></body></html>",
  );
  const window = new Gtk.Window({ child: editor.view });
  window.present();
  await ready(editor);
  expect(
    await json(
      editor,
      "(() => { const doc = document.querySelector('iframe').contentDocument; return JSON.stringify({header: doc.querySelector('pre').textContent, bold: doc.querySelectorAll('b').length, color: getComputedStyle(doc.querySelector('b')).color, background: getComputedStyle(doc.body).backgroundColor, scripts: doc.querySelectorAll('script').length}); })()",
    ),
  ).toEqual({ header, bold: 1, color: "rgb(255, 0, 0)", background: "rgb(246, 246, 246)", scripts: 0 });
  const [html, text] = await editor.message();
  expect(html).toContain("&lt;sender@example.com&gt;");
  expect(html).toContain("<b>Original</b>");
  expect(html).toContain("cid:logo");
  expect(text).toContain("Subject: <b>Literal</b>");
  expect(text).toContain("Original");
  editor.view.stop_loading();
  window.destroy();
}, 20_000);

test("renders and edits html quotes", async () => {
  const { buffer, mode } = htmlMode();
  let measured = 0;
  let grew = false;
  const editor = new Editor(buffer, mode, (height, edited) => {
    if (edited && height > measured) grew = true;
    measured = height;
  });
  editor.reply(
    "<!doctype html><html><head><style>.heading { background: rgb(0, 120, 180); color: white; } td { height: 800px; }</style></head><body bgcolor='#f6f6f6'><p class='heading'><b>Original</b></p><table><tr><td style='color: rgb(255, 0, 0)'>Cell</td></tr></table><script>document.body.textContent='bad'</script></body></html>",
  );
  const strip = toolbar(editor, mode);
  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  content.append(mode);
  content.append(strip);
  content.append(editor.view);
  const window = new Gtk.Window({ child: content });
  window.present();
  await ready(editor);
  Bun.gc(true);
  const result = await json(
    editor,
    "const quoteDoc = document.querySelector('iframe').contentDocument; JSON.stringify({background: getComputedStyle(quoteDoc.querySelector('.heading')).backgroundColor, bodyBackground: getComputedStyle(quoteDoc.body).backgroundColor, scroll: window.scrollY, frameHeight: document.querySelector('iframe').height, quote: quoteDoc.querySelector('b').textContent, table: quoteDoc.querySelectorAll('td').length, color: getComputedStyle(quoteDoc.querySelector('td')).color, scripts: quoteDoc.querySelectorAll('script').length, top: document.body.firstChild.contains(getSelection().anchorNode) || (getSelection().anchorNode === document.body && getSelection().anchorOffset === 0), offset: getSelection().anchorOffset})",
  );
  expect(result).toMatchObject({ background: "rgb(0, 120, 180)", bodyBackground: "rgb(246, 246, 246)", scroll: 0, quote: "Original", table: 1, color: "rgb(255, 0, 0)", scripts: 0, top: true, offset: 0 });
  expect(Number.parseInt(result.frameHeight)).toBeGreaterThanOrEqual(800);
  await evaluate(editor, "document.execCommand('insertText', false, 'My reply'); report()");
  const text = () => buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), true);
  expect(await eventually(() => text().startsWith("My reply\n\n"))).toBe(true);
  expect(text()).toContain("Original");
  await evaluate(editor, "document.execCommand('insertParagraph'); document.execCommand('insertText', false, 'Another line')");
  expect(await eventually(() => grew)).toBe(true);
  const controllers = editor.view.observe_controllers();
  const keys = Array.from({ length: controllers.get_n_items() }, (_, index) => controllers.get_item(index)).find(
    (controller): controller is Gtk.EventControllerKey => controller instanceof Gtk.EventControllerKey && controller.get_name() === "compose-html-shortcuts",
  );
  expect(keys?.emit("key-pressed", Gdk.KEY_a, 0, Gdk.ModifierType.CONTROL_MASK) as unknown).toBe(true);
  const selection = await json(editor, "JSON.stringify({collapsed: getSelection().isCollapsed, text: getSelection().toString()})");
  expect(selection.collapsed).toBe(false);
  expect(selection.text).toContain("My reply");
  const [bold, italic] = [strip.get_first_child(), strip.get_first_child()?.get_next_sibling()];
  const clear = strip.get_last_child();
  if (!(bold instanceof Gtk.ToggleButton) || !(italic instanceof Gtk.ToggleButton) || !(clear instanceof Gtk.Button)) throw new Error("The toolbar has format toggles");
  for (const newline of [false, true]) {
    await evaluate(
      editor,
      "setContent({html: '<div><b><i>Styled</i></b></div>'}); { const range = document.createRange(); range.selectNodeContents(document.querySelector('i')); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); } reportFormats()",
    );
    if (newline) await evaluate(editor, "document.execCommand('insertParagraph'); reportFormats()");
    expect(await eventually(() => bold.get_active() && italic.get_active())).toBe(true);
    clear.emit("clicked");
    await evaluate(editor, "document.execCommand('insertText', false, 'Plain'); reportFormats()");
    expect(await eventually(() => !bold.get_active() && !italic.get_active())).toBe(true);
    expect(
      await json(
        editor,
        "(() => { const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let styled; while (walker.nextNode()) if (walker.currentNode.data === 'Styled') styled = walker.currentNode; const typed = getComputedStyle(getSelection().anchorNode.parentElement); const original = getComputedStyle(styled.parentElement); return JSON.stringify({weight: typed.fontWeight, style: typed.fontStyle, originalWeight: original.fontWeight, originalStyle: original.fontStyle}); })()",
      ),
    ).toEqual({ weight: "400", style: "normal", originalWeight: "700", originalStyle: "italic" });
    bold.emit("clicked");
    await evaluate(editor, "reportFormats()");
    expect(await eventually(() => bold.get_active())).toBe(true);
  }
  editor.view.stop_loading();
  window.destroy();
}, 30_000);
