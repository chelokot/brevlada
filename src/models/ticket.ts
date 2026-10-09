export type Kind = "Event" | "Bus" | "Train" | "Flight" | "Ticket";

export interface Ticket {
  number: string | null;
  holder: string | null;
  seat: string | null;
  token: string | null;
}

export interface Reservation {
  kind: Kind;
  number: string | null;
  status: string | null;
  name: string;
  start: string | null;
  end: string | null;
  departure: string | null;
  arrival: string | null;
  location: string | null;
  provider: string | null;
  service: string | null;
  url: string | null;
  holder: string | null;
  tickets: Ticket[];
}
