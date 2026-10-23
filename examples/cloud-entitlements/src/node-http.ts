import type { IncomingMessage, ServerResponse } from 'node:http';
import { unavailable, type Handler } from './config';
/** Adapt Node HTTP without trusting Host, request JSON, or client plan fields. */
export function nodeHttpHandler(handle: Handler) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // The example accepts no body. Drain it without buffering arbitrary input.
    request.resume();
    let result: Response;
    try {
      const headers = new Headers();
      const authorization = request.headers.authorization;
      if (authorization) headers.set('authorization', authorization);
      result = await handle(new Request('https://application.invalid/check-export', {
        method: request.method ?? 'GET', headers,
      }));
    } catch { result = unavailable(); }
    response.statusCode = result.status;
    result.headers.forEach((value, key) => response.setHeader(key, value));
    response.end(await result.text());
  };
}
