import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { message } from "../models";
import { BODY_HEIGHT } from "../theme";
import { view } from "./body";
import { column, scroll } from "./index";
import { settle, useDisplay } from "./testing";

useDisplay();

test("short message keeps its content height", async () => {
  for (const shown of [
    message({ bodyText: "Hello", bodyLoaded: true }),
    message({ bodyText: "A short message should wrap to the actual card width. ".repeat(4), bodyLoaded: true }),
    message({ bodyHtml: `<p>Hello</p><blockquote>${"<p>Older reply</p>".repeat(100)}</blockquote>`, bodyLoaded: true }),
  ]) {
    const [body, webview] = view(shown, false, false);
    let peakRequest = BODY_HEIGHT;
    webview.connect("notify::height-request", (webview) => (peakRequest = Math.max(peakRequest, webview.heightRequest)));
    let peakAllocation = 0;
    body.add_tick_callback((body) => {
      peakAllocation = Math.max(peakAllocation, body.get_height());
      return true;
    });
    const viewer = column("message-container");
    viewer.append(body);
    const content = column("message-viewer-content");
    content.append(viewer);
    const window = new Gtk.Window({ defaultWidth: 700, defaultHeight: 600, child: scroll(new Gtk.Viewport({ child: content })) });
    window.present();
    await settle(3000);
    expect(webview.get_mapped() && !webview.isLoading).toBe(true);
    expect(webview.get_parent()?.get_opacity()).toBe(1);
    expect(webview.get_height()).toBe(webview.heightRequest);
    expect(peakRequest).toBe(webview.heightRequest);
    expect(peakAllocation).toBe(body.get_height());
    expect(body.get_height()).toBeLessThan(160);
    window.close();
    await settle(250);
  }
}, 20_000);

test("full message is measured after mapping and width changes", async () => {
  const fixture = process.env["BREVLADA_HTML_FIXTURE"];
  const html = fixture
    ? await Bun.file(fixture).text()
    : `<!doctype html><html><head><style>body{padding:0} .line{margin:0;padding:8px}</style></head><body style='background:lightblue'><div>Header</div></div>${"<p class='line'>A complete line of newsletter content</p>".repeat(80)}<p>Bottom</p></body></html>`;
  const [body, webview] = view(message({ bodyHtml: html, bodyLoaded: true }), false, false);
  const scrolled = new Gtk.ScrolledWindow({ child: body });
  const window = new Gtk.Window({ defaultWidth: 700, defaultHeight: 400, child: scrolled });
  window.present();
  for (const width of [700, 450]) {
    window.set_default_size(width, 400);
    await settle(3000);
    expect(webview.heightRequest).toBeGreaterThan(1000);
    expect(webview.get_height()).toBeGreaterThanOrEqual(webview.heightRequest);
    expect(scrolled.get_vadjustment().get_upper()).toBeGreaterThan(1000);
  }
  window.close();
  await settle(250);
}, 20_000);
