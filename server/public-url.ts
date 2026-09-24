import type { FastifyRequest } from 'fastify';

export function publicOrigin(request?: FastifyRequest): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Configuration validation reports invalid APP_URL in production.
    }
  }
  if (request) {
    const forwardedProto = request.headers['x-forwarded-proto'];
    const forwardedHost = request.headers['x-forwarded-host'];
    const proto =
      typeof forwardedProto === 'string' && forwardedProto
        ? forwardedProto.split(',')[0].trim()
        : request.protocol;
    const host =
      typeof forwardedHost === 'string' && forwardedHost
        ? forwardedHost.split(',')[0].trim()
        : request.headers.host;
    if (host) {
      try {
        return new URL(`${proto}://${host}`).origin;
      } catch {
        // Fall through to the local development origin.
      }
    }
  }
  return 'http://localhost:33442';
}
