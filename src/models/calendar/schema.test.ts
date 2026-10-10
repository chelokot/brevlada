import { expect, test } from "bun:test";
import { parse } from "./schema";

test("reservation with rsvp and event subtype", () => {
  const events = parse(
    `<script type="application/ld+json">{"@graph":[{"@type":"EventReservation","reservationFor":{"@type":"MusicEvent","name":"Concert","startDate":"2026-10-02T19:00:00+02:00","location":{"name":"Hall","address":{"streetAddress":"Main Street","addressLocality":"Berlin"}},"potentialAction":[{"@type":"RsvpAction","rsvpResponse":"https://schema.org/RsvpResponseYes","target":{"urlTemplate":"https://example.com/yes"}},{"@type":"RsvpAction","name":"No","target":{"urlTemplate":"https://example.com/no","httpMethod":"POST"}}]}}]}</script>`,
  );
  expect(events.length).toBe(1);
  expect(events[0]?.location).toBe("Hall, Main Street, Berlin");
  expect(events[0]?.rsvp).toEqual([{ label: "Yes", url: "https://example.com/yes" }]);
});

test("microdata keeps nested scopes and deduplicates", () => {
  const events = parse(
    `<div itemscope itemtype="https://schema.org/EventReservation"><div itemprop="reservationFor" itemscope itemtype="https://schema.org/Event"><meta itemprop="name" content="Lunch"><meta itemprop="startDate" content="2026-10-02"><div itemprop="potentialAction" itemscope itemtype="https://schema.org/RsvpAction"><link itemprop="target" href="https://example.com/rsvp"></div></div></div>`,
  );
  expect(events.length).toBe(1);
  expect(events[0]?.rsvp[0]?.url).toBe("https://example.com/rsvp");
  expect(parse("<script type='application/ld+json'>{broken}</script>")).toEqual([]);
});
