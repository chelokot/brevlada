import { expect, test } from "bun:test";
import { message as create } from "../models";
import { event } from "../models/calendar";
import { message, thread } from "./preview";

test("skips rsvp bodies before the invitation or body loads", () => {
  const reply = create({ bodyText: "Accepted: Lunch", bodyHtml: "<p>Accepted: Lunch</p>", calendarEvents: [event({ method: "REPLY" })] });
  for (const bodyLoaded of [false, true]) {
    const loaded = { ...reply, bodyLoaded };
    expect(message(loaded)).toBe("");
    expect(thread([loaded])).toBe("");
    expect(thread([loaded, create({ bodyText: "Join us for lunch" })])).toBe("Join us for lunch");
  }
  expect(message({ ...reply, isDraft: true })).toBe("Accepted: Lunch");
  expect(message({ ...reply, calendarEvents: [...reply.calendarEvents, event({ method: "REQUEST", name: "Another event" })] })).toBe("Accepted: Lunch");
});

test("prefers plain text and collapses whitespace", () => {
  expect(message(create({ bodyText: "  Hello\n\tworld <3  ", bodyHtml: "<p>Different text</p>" }))).toBe("Hello world <3");
});

test("extracts html text without metadata or tags", () => {
  const bodyHtml =
    "<head><title>Title</title><style>p { color: red }</style></head><body><!-- comment --><script>ignored()</script><template>hidden</template><p data-value='>'>Hello <b>world</b>! &amp; &#x1F600;</p><div>Next<br>line&nbsp;here</div></body>";
  expect(message(create({ bodyText: " \n ", bodyHtml }))).toBe("Hello world! & 😀 Next line here");
});

test("handles empty and truncates unicode", () => {
  expect(message(create())).toBe("");
  expect(message(create({ bodyText: "é".repeat(161) }))).toBe(`${"é".repeat(160)}…`);
  expect(message(create({ bodyText: `${"a".repeat(159)} ${"😀".repeat(5)}` }))).toBe(`${"a".repeat(159)}…`);
});

test("stops reading long html once the preview is full", () => {
  const bodyHtml = Array.from({ length: 400 }, (_, index) => `<p>Paragraph ${index} &amp;\n\t words</p>`).join("");
  const full = Array.from({ length: 400 }, (_, index) => `Paragraph ${index} & words`).join(" ");
  expect(message(create({ bodyHtml }))).toBe(`${full.slice(0, 160).trimEnd()}…`);
});

test("follows html5ever head handling", () => {
  for (const bodyHtml of ["<html><head><title>Title</title><body><p>Body</p>", "<title>Title</title><p>Body</p>", "<p>Body</p></body></html><html><head></head>"])
    expect(message(create({ bodyHtml }))).toBe("Body");
  expect(message(create({ bodyHtml: "<p>Body</p><head><title>Late</title></head>" }))).toBe("Body Late");
});
