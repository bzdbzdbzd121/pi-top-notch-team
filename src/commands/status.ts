/** Callback to provide real-time member process statuses for /team status display. */
export type StatusProvider = () => Array<{ name: string; status: string; pid: number | null }>;
