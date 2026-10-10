import type { Message } from ".";
import { asciiLower } from "./text";

export interface Details {
  mime: string;
  size: number;
  calendarRendered: boolean | null;
}

export function safeName(name: string) {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1).replace(/\p{Cc}/gu, "");
  return !base.trim() || base === "." || base === ".." ? "attachment" : base;
}

export function renderedCalendar({ attachmentDetails, attachments, calendarEvents }: Message, index: number) {
  const details = attachmentDetails[index];
  if (details && details.calendarRendered !== null) return details.calendarRendered;
  const name = attachments[index];
  const calendar = details !== undefined && (details.mime === "text/calendar" || details.mime === "application/ics");
  return calendarEvents.length > 0 && ((name !== undefined && asciiLower(name).endsWith(".ics")) || calendar);
}
