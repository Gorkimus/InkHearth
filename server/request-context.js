// Per-request user context. The auth middleware runs each request as its
// session user; currentUserId() reads it here. Jobs and CLI scripts run
// outside any request and pass user ids explicitly instead.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

export function runAsUser(uid, fn) {
  return als.run(uid, fn);
}

export function getRequestUserId() {
  return als.getStore() ?? null;
}
