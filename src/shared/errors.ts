export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = 'AppError';
  }
}
