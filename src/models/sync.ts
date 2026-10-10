export interface Count {
  cached: number;
  total: number;
}

export interface Progress {
  accounts: Count | null;
  folders: Count | null;
  messages: Count | null;
}

export interface Activity {
  description: string;
  folder: string;
  progress: Progress;
}

export interface Status {
  activity: Activity | null;
  active: number;
  queued: number;
  failed: number;
  lastStarted: number | null;
}
