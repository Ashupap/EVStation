/**
 * Fastify API service — HTTP surface of the EVStation CMS.
 *
 * Phase 1: Keycloak JWT verification, one transaction per request, RLS tenant
 * context, centralized authorization and auditing. See docs/ARCHITECTURE.md.
 */
export { SERVICE_NAME, buildApp } from './app.js';
export { createJwtVerifier } from './auth.js';
export type { TokenClaims, TokenVerifier } from './auth.js';
export { loadConfig } from './config.js';
export type { ApiConfig } from './config.js';
export { assertRuntimeRole, createDb, inspectRuntimeRole } from './db.js';
export type { ApiDb } from './db.js';
export { authorize, roleFor } from './authorize.js';
export type { Capability } from './authorize.js';
export { ROUTES } from './routes.js';
export type { RouteDefinition } from './routes.js';
