import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { alice, arrival } from "./corpus";
import { accounts, defaults, launch, park, type Desktop, type Setup } from "./environment";

type Step = Desktop & { shot: (name: string, quiet?: number) => Promise<void>; right: (left: number, top: number) => Promise<unknown> };
type Scenario = { name: string; setup: Partial<Setup>; run: (ui: Step) => Promise<void> };

const title = "Brevlada Email Client";
const account = { alice: [250, 124], bob: [250, 158] } as const;
const folder = { archive: 159, drafts: 193, junk: 227, projects: 261, brevlada: 295, sent: 363, trash: 397 } as const;
const sender = (row: number) => [650, 140 + 63 * row] as const;
const listed = (row: number) => [300, 140 + 63 * row] as const;
const thread = (row: number) => [700, 140 + 65 * row] as const;
const button = {
  sync: [127, 77],
  collapse: [431, 77],
  search: [518, 77],
  sort: [831, 77],
  compose: [878, 77],
  menu: [1431, 77],
  settings: [1417, 130],
} as const;
const narrow = { expand: [127, 77], threadSort: [882, 77] } as const;
const draftSaved = 3000;

async function conversation(ui: Step, row: number, threadRow: number) {
  await ui.click(...account.alice);
  await ui.settle();
  await ui.click(...sender(row));
  await ui.settle();
  await ui.click(...thread(threadRow));
  await ui.settle();
}

async function scroll(ui: Step, left: number, top: number, clicks: number) {
  await ui.x("mousemove", left, top, "click", "--repeat", clicks, 5, "mousemove", ...park);
  await ui.settle();
}

async function bottom(ui: Step, left: number, top: number) {
  await scroll(ui, left, top, 60);
  await scroll(ui, left, top, 60);
}

const scenarios: Scenario[] = [
  { name: "no-accounts", setup: { accounts: [] }, run: (ui) => ui.shot("no-accounts") },
  {
    name: "first-sync",
    setup: { imap: "frozen" },
    async run(ui) {
      await ui.shot("sync-in-progress");
      await ui.thaw();
      await ui.shot("sync-complete");
    },
  },
  {
    name: "server-down",
    setup: { imap: "down" },
    async run(ui) {
      await ui.click(...account.alice);
      await ui.shot("error-server-down");
    },
  },
  {
    name: "wrong-password",
    setup: { accounts: [{ ...accounts.alice, password: "wrong" }, accounts.bob] },
    async run(ui) {
      await ui.click(...account.alice);
      await ui.shot("error-wrong-password");
    },
  },
  {
    name: "sidebar",
    setup: {},
    async run(ui) {
      await ui.click(127, account.alice[1]);
      await ui.shot("sidebar-folders");
      await ui.click(210, folder.projects);
      await ui.click(127, 431);
      await ui.shot("sidebar-nested");
      await ui.click(...button.collapse);
      await ui.shot("sidebar-collapsed");
      await ui.click(...narrow.expand);
      await ui.shot("sidebar-restored");
    },
  },
  {
    name: "folders",
    setup: {},
    async run(ui) {
      await ui.click(127, account.alice[1]);
      await ui.settle();
      await ui.click(210, folder.projects);
      for (const name of ["sent", "drafts", "archive", "junk", "trash", "brevlada"] as const) {
        await ui.click(210, folder[name]);
        await ui.shot(`folder-${name}`);
      }
    },
  },
  {
    name: "inbox",
    setup: {},
    async run(ui) {
      await ui.click(...account.alice);
      await ui.shot("inbox-alice");
      await ui.click(...account.bob);
      await ui.shot("inbox-bob");
      await ui.click(...sender(0));
      await ui.click(...thread(0));
      await ui.shot("bob-plain-message");
    },
  },
  {
    name: "conversation",
    setup: {},
    async run(ui) {
      await ui.click(...account.alice);
      await ui.settle();
      await ui.click(...sender(0));
      await ui.shot("thread-list");
      await ui.click(...thread(0));
      await ui.shot("conversation-long");
      await ui.click(943, 268);
      await ui.shot("conversation-card-expanded");
      await ui.click(...thread(1));
      await ui.shot("quote-collapsed");
      await ui.click(960, 330);
      await ui.shot("quote-expanded");
    },
  },
  {
    name: "load-older",
    setup: {},
    async run(ui) {
      await conversation(ui, 6, 0);
      await ui.shot("conversation-standup");
      await bottom(ui, 1200, 600);
      await ui.shot("conversation-load-older");
      await ui.click(1200, 900);
      await ui.shot("conversation-older-loaded");
    },
  },
  {
    name: "newsletter",
    setup: {},
    async run(ui) {
      await conversation(ui, 3, 0);
      await ui.shot("newsletter-blocked");
      await ui.click(1233, 149);
      await ui.shot("newsletter-media");
      await ui.click(1412, 149);
      await ui.shot("newsletter-unsubscribed");
      await ui.click(960, 650);
    },
  },
  {
    name: "trusted-sender",
    setup: {},
    async run(ui) {
      await ui.click(...account.alice);
      await ui.settle();
      await ui.right(...sender(3));
      await ui.shot("sender-menu");
      await ui.click(650, 620);
      await ui.click(...sender(3));
      await ui.click(...thread(1));
      await ui.shot("newsletter-trusted");
      await ui.click(1412, 149);
      await ui.shot("newsletter-mailto-unsubscribe");
    },
  },
  {
    name: "attachments",
    setup: {},
    async run(ui) {
      await conversation(ui, 1, 0);
      await ui.shot("draft-and-calendar-event", draftSaved);
      await bottom(ui, 1200, 600);
      await ui.shot("attachments-collapsed");
      await ui.click(1350, 543);
      await ui.settle();
      await bottom(ui, 1200, 600);
      await ui.click(1020, 910);
      await bottom(ui, 1200, 600);
      await ui.shot("attachments-expanded");
      await ui.click(1000, 790);
      await ui.shot("attachment-opened");
      await ui.click(1168, 790);
      await ui.window("Save attachment");
      await ui.shot("attachment-save-dialog");
    },
  },
  {
    name: "draft-delete",
    setup: {},
    async run(ui) {
      await conversation(ui, 1, 0);
      await ui.settle();
      await ui.click(1458, 137);
      await ui.shot("draft-delete-dialog");
    },
  },
  {
    name: "calendar-invitation",
    setup: {},
    async run(ui) {
      await conversation(ui, 5, 0);
      await ui.shot("calendar-invitation");
      await ui.click(1018, 344);
      await ui.click(1010, 293);
      await ui.shot("calendar-rsvp-sent");
    },
  },
  {
    name: "calendar-variants",
    setup: {},
    async run(ui) {
      await conversation(ui, 5, 2);
      await ui.shot("calendar-cancelled");
      await ui.click(...listed(12));
      await ui.click(...thread(0));
      await ui.shot("calendar-web-rsvp");
      await ui.click(980, 288);
    },
  },
  {
    name: "calendar-replies",
    setup: {},
    async run(ui) {
      await conversation(ui, 0, 2);
      await ui.shot("calendar-reply");
      await ui.click(944, 421);
      await ui.shot("calendar-participants");
    },
  },
  {
    name: "parcel",
    setup: {},
    async run(ui) {
      await conversation(ui, 2, 0);
      await ui.shot("parcel-card");
      await ui.click(975, 240);
      await ui.shot("parcel-step-popover");
      await ui.key("Escape");
      await ui.click(1022, 301);
      await ui.click(1215, 301);
      await ui.window("Order Details");
      await ui.shot("parcel-order-details");
    },
  },
  {
    name: "tickets",
    setup: {},
    async run(ui) {
      await conversation(ui, 7, 0);
      await ui.shot("ticket-train");
      await ui.click(1018, 508);
      await ui.click(1018, 278);
      await ui.shot("ticket-stop-popover");
      await ui.key("Escape");
      await ui.click(1328, 400);
      await ui.shot("ticket-passenger");
      await ui.key("Escape");
      for (const [row, name] of [
        [9, "flight"],
        [10, "event"],
        [11, "bus"],
      ] as const) {
        await ui.click(...listed(row));
        await ui.click(...thread(0));
        await ui.shot(`ticket-${name}`);
      }
    },
  },
  {
    name: "charsets",
    setup: {},
    async run(ui) {
      await conversation(ui, 4, 0);
      await ui.shot("charset-windows-1251");
      await ui.click(982, 312);
      await ui.shot("quote-html-expanded");
      await ui.click(...thread(1));
      await ui.shot("charset-koi8-r");
      await ui.click(...listed(8));
      await ui.click(...thread(0));
      await ui.shot("charset-iso-2022-jp");
    },
  },
  {
    name: "sorting",
    setup: {},
    async run(ui) {
      await ui.click(...account.alice);
      await ui.settle();
      await ui.click(...button.sort);
      await ui.shot("sort-menu");
      await ui.click(840, 130);
      await ui.key("Escape");
      await ui.shot("sort-newest-first");
      await ui.click(...sender(0));
      await ui.click(...narrow.threadSort);
      await ui.shot("thread-sort-menu");
    },
  },
  {
    name: "search",
    setup: {},
    async run(ui) {
      await ui.click(...account.alice);
      await ui.settle();
      await ui.click(...button.search);
      await ui.shot("search-empty");
      await ui.type("northwind");
      await ui.shot("search-results");
      await ui.click(542, 118);
      await ui.shot("search-accounts-popover");
      await ui.click(542, 298);
      await ui.key("Escape");
      await ui.shot("search-all-accounts");
      await ui.click(738, 118);
      await ui.shot("search-folders-popover");
      await ui.key("Escape");
      await ui.click(542, 150);
      await ui.shot("search-sources-popover");
      await ui.key("Escape");
      await ui.click(738, 150);
      await ui.shot("search-dates-popover");
      await ui.click(910, 222);
      await ui.shot("search-dates-calendar");
      await ui.key("Escape");
      await ui.click(650, 260);
      await ui.shot("search-result-opened");
    },
  },
  ...(
    [
      ["mark-read", 2, 25],
      ["mark-unread", 7, 61],
      ["star", 7, 97],
      ["move", 7, 133],
      ["spam", 4, 169],
      ["archive", 3, 205],
      ["delete", 2, 241],
    ] as const
  ).map(
    ([name, row, offset]): Scenario => ({
      name: `sender-${name}`,
      setup: {},
      async run(ui) {
        await ui.click(127, account.alice[1]);
        await ui.settle();
        await ui.click(...account.alice);
        await ui.settle();
        await ui.right(...sender(row));
        await ui.click(650, sender(row)[1] + offset);
        await ui.shot(`sender-${name}`);
        if (name === "spam") {
          await ui.right(...sender(row));
          await ui.shot("sender-spam-menu");
        }
      },
    }),
  ),
  {
    name: "thread-actions",
    setup: {},
    async run(ui) {
      await ui.click(...account.alice);
      await ui.settle();
      await ui.click(...sender(0));
      await ui.right(...thread(1));
      await ui.shot("thread-menu");
      await ui.key("Escape");
      await ui.click(...thread(1));
      await ui.settle();
      await ui.click(1150, 190);
      await ui.key("Delete");
      await ui.shot("thread-deleted-by-shortcut");
      await ui.click(1150, 160);
      await ui.key("BackSpace");
      await ui.shot("thread-archived-by-shortcut");
    },
  },
  {
    name: "compose",
    setup: {},
    async run(ui) {
      await ui.click(...account.alice);
      await ui.settle();
      await ui.click(...button.compose);
      await ui.shot("compose-new", draftSaved);
      await ui.type("carol@brevlada.test");
      await ui.click(1050, 178);
      await ui.type("Weekend plans");
      await ui.click(1050, 300);
      await ui.type("Hiking on Saturday? The forecast looks great.");
      await ui.shot("compose-filled", draftSaved);
      await ui.click(936, 492);
      await ui.window("Attach files");
      await ui.shot("compose-attach-dialog");
      await ui.click(440, 476);
      await ui.settle();
      await ui.x("mousemove", 586, 494, "click", "--repeat", 2, 1, "mousemove", ...park);
      await ui.shot("compose-attachment", draftSaved);
      await ui.click(976, 216);
      await ui.shot("compose-html", draftSaved);
      await ui.click(1172, 262);
      await ui.key("ctrl+a", "ctrl+b");
      await ui.shot("compose-bold", draftSaved);
      await ui.x("mousemove", 1172, 456, "mousedown", 1);
      for (const top of [476, 496, 516]) {
        await ui.x("mousemove", 1172, top);
        await ui.settle(300);
      }
      await ui.x("mouseup", 1, "mousemove", ...park);
      await ui.shot("compose-resized", draftSaved);
      await ui.click(1398, 136);
      await ui.shot("compose-sent");
    },
  },
  ...(
    [
      ["reply", 1288],
      ["reply-all", 1328],
      ["forward", 1368],
    ] as const
  ).map(
    ([name, left]): Scenario => ({
      name: `compose-${name}`,
      setup: {},
      async run(ui) {
        await conversation(ui, 0, 0);
        await ui.click(left, 135);
        await ui.shot(`compose-${name}`, draftSaved);
      },
    }),
  ),
  {
    name: "send-failure",
    setup: { accounts: [{ ...accounts.alice, mail: { ...accounts.alice.mail, SmtpHost: "smtp.brevlada.test:2525" } }, accounts.bob] },
    async run(ui) {
      await conversation(ui, 0, 1);
      await ui.click(1288, 135);
      await ui.settle();
      await ui.type("See you there!");
      await ui.click(1396, 137);
      await ui.shot("compose-send-failed", draftSaved);
    },
  },
  {
    name: "settings",
    setup: {},
    async run(ui) {
      await ui.click(...button.menu);
      await ui.shot("main-menu");
      await ui.click(...button.settings);
      await ui.window("Settings");
      await ui.shot("settings");
      await ui.click(798, 422);
      await ui.shot("settings-privacy");
      await ui.click(1008, 414);
      await ui.shot("settings-trust-all");
      await ui.click(548, 345);
      await ui.click(798, 476);
      await ui.shot("settings-general");
      await ui.click(1008, 414);
      await ui.shot("settings-background-on");
    },
  },
  {
    name: "notifications",
    setup: { config: { "settings.json": { trust_all_senders: false, background_service: true } } },
    async run(ui) {
      await ui.deliver(alice.email, "1791640800.M1P1.brevlada", arrival.raw);
      await ui.click(...button.sync);
      await ui.click(...account.alice);
      await ui.shot("new-mail-arrived");
    },
  },
  {
    name: "large-inbox",
    setup: { large: 2000 },
    async run(ui) {
      await ui.click(...account.alice);
      await ui.shot("large-inbox");
      await scroll(ui, 650, 500, 10);
      await ui.shot("large-inbox-scrolled");
    },
  },
];

const repo = `${import.meta.dir}/../..`;
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    only: { type: "string" },
    app: { type: "string", default: `bun --preload ${repo}/src/gi/plugin.ts ${repo}/src/main.ts` },
  },
});
if (!values.out) throw new Error('Usage: bun tests/e2e/scenarios.ts --out <dir> [--only a,b] [--app "<command>"]');
const out = values.out;
const only = values.only;
const selected = scenarios.filter(({ name }) => !only || only.split(",").includes(name));
await mkdir(`${out}/failures`, { recursive: true });
const timing: Record<string, { ready: number; total: number; shots: Record<string, number> }> = {};
const effects: Record<string, unknown> = {};
const failures: string[] = [];
let active: Desktop | null = null;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    console.log(`Received ${signal}, stopping`);
    if (active) await active.stop();
    process.exit(130);
  });
for (const { name, setup, run } of selected) {
  try {
    const desktop = (active = await launch(name, values.app.split(" "), { ...defaults, ...setup }));
    const shots: Record<string, number> = {};
    const elapsed = () => Math.round(performance.now() - desktop.started);
    const step: Step = {
      ...desktop,
      right: (left, top) => desktop.click(left, top, 3),
      async shot(shot, quiet = 1000) {
        await Bun.write(`${out}/${shot}.png`, await desktop.settle(quiet));
        shots[shot] = elapsed();
      },
    };
    try {
      await desktop.window(title);
      await desktop.settle();
      const ready = elapsed();
      await run(step);
      timing[name] = { ready, total: elapsed(), shots };
      const observed = Object.entries({
        smtp: (await desktop.smtp()).map((raw) =>
          [...raw.replace(/\r\n[ \t]+/g, " ").matchAll(/^(?:X-Envelope|Subject|To|Cc|In-Reply-To|Content-Type|Content-Disposition):.*$/gim)].map(([line]) =>
            line.replace(/boundary="[^"]*"/, "boundary"),
          ),
        ),
        notifications: (await desktop.lines("notifications.jsonl")).map((line) => JSON.parse(line)),
        opened: await desktop.lines("opened.log"),
        posted: (await desktop.lines("web.log")).filter((line) => line.startsWith("POST")),
      }).filter(([, list]) => list.length);
      if (observed.length) effects[name] = Object.fromEntries(observed);
      console.log(`ok   ${name} (${elapsed()} ms)`);
    } catch (error) {
      await Bun.write(`${out}/failures/${name}.png`, await desktop.capture());
      throw error;
    } finally {
      await desktop.stop();
      active = null;
    }
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}
await Bun.write(`${out}/timing.json`, JSON.stringify(timing, null, 2));
await Bun.write(`${out}/effects.json`, JSON.stringify(effects, null, 2));
console.log(`${selected.length - failures.length}/${selected.length} scenarios passed; screenshots in ${out}`);
process.exit(failures.length ? 1 : 0);
