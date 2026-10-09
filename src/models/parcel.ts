export interface Step {
  name: string | null;
  date: string | null;
  location: string | null;
}

export interface Parcel {
  item: string | null;
  arrivalFrom: string | null;
  arrivalUntil: string | null;
  carrier: string | null;
  trackingUrl: string | null;
  orderUrl: string | null;
  orderNumber: string | null;
  steps: Step[];
  details: unknown;
}
