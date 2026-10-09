export interface Rsvp {
  label: string;
  url: string;
}

export interface Attendee {
  email: string;
  name: string | null;
  status: string;
}

export interface Event {
  uid: string | null;
  recurrenceId: string | null;
  sequence: number;
  stamp: number;
  method: string | null;
  organizerEmail: string | null;
  attendees: Attendee[];
  name: string;
  start: string;
  end: string | null;
  timezone: string | null;
  location: string | null;
  organizer: string | null;
  description: string | null;
  url: string | null;
  status: string | null;
  rsvp: Rsvp[];
  invitation: boolean;
  calendar: string | null;
}

export type Response = "Accepted" | "Tentative" | "Declined";
