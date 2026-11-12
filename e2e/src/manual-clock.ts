export class ManualClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  set(iso: string): void {
    this.current = new Date(iso);
  }
}
