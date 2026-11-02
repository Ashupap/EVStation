/**
 * Single module allowed to talk to CitrineOS (PRD contract rule 2).
 *
 * In Phase 0 this package is empty by design: the CitrineOS OpenAPI surface
 * is validated first via docs, smoke tests, and the health-check script. The
 * adapter implementation and its typed client come in Phase 2.
 */
export const ADAPTER_NAME = 'evstation-csms-adapter';
