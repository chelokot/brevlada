import { expect, test } from "bun:test";
import { append, savedLocation } from "./draft-save";
import { scripted } from "./testing";

test("appends with draft flags and reports rejection without retrying", async () => {
  for (const [response, success] of [
    ["a2 OK saved\r\n", true],
    ["a2 NO quota exceeded\r\n", false],
  ] as const) {
    const { session, sent } = await scripted(`+ ready\r\n${response}`);
    const appended = append(session, 'Work/"Drafts"', new TextEncoder().encode("Subject: Unfinished\r\n\r\nHello"));
    if (success) await appended;
    else await expect(appended).rejects.toThrow("No Response: quota exceeded");
    const written = await sent();
    expect(written.split("APPEND")).toHaveLength(2);
    expect(written).toContain('APPEND "Work/\\"Drafts\\"" (\\Draft \\Seen)');
    expect(written.endsWith("Subject: Unfinished\r\n\r\nHello\r\n")).toBe(true);
  }
});

test("locates only the saved draft instead of fetching the mailbox", async () => {
  const header = "Message-ID: <new-draft@example.com>\r\n\r\n";
  const { session, sent } = await scripted(
    `* OK [UIDVALIDITY 7] valid\r\na2 OK select\r\n* SEARCH 42\r\na3 OK search\r\n* 1 FETCH (UID 42 BODY[HEADER] {${header.length}}\r\n${header})\r\na4 OK fetch\r\n`,
  );
  expect(await savedLocation(session, "Drafts", "new-draft@example.com")).toEqual([7, 42]);
  const written = await sent();
  expect(written).toContain('UID SEARCH HEADER Message-ID "new-draft@example.com"');
  expect(written).toContain("UID FETCH 42 (UID BODY.PEEK[HEADER])");
  expect(written).not.toContain("1:*");
});
