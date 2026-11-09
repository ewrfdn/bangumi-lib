/** Application errors cross layer boundaries; controllers decide the HTTP response. */
export class HttpError extends Error {
  readonly status: number
  readonly statusCode: number
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.statusCode = status
    if (code) this.code = code
  }
}
