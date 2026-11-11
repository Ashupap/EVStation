import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

const PG_MESSAGES: Record<string, { status: number; code: string }> = {
  tenant_mismatch: { status: 403, code: 'TENANT_MISMATCH' },
  membership_change_forbidden: { status: 403, code: 'FORBIDDEN' },
  invitation_forbidden: { status: 403, code: 'FORBIDDEN' },
  role_above_actor: { status: 403, code: 'ROLE_ABOVE_ACTOR' },
  last_tenant_admin: { status: 409, code: 'LAST_TENANT_ADMIN' },
  tenant_status_forbidden: { status: 403, code: 'FORBIDDEN' },
  membership_keys_immutable: { status: 409, code: 'MEMBERSHIP_KEYS_IMMUTABLE' },
  email_change_forbidden: { status: 403, code: 'EMAIL_CHANGE_FORBIDDEN' },
  email_not_verified: { status: 403, code: 'EMAIL_UNVERIFIED' },
  email_in_use: { status: 409, code: 'EMAIL_IN_USE' },
  email_invalid: { status: 400, code: 'EMAIL_INVALID' },
  actor_mismatch: { status: 401, code: 'UNAUTHORIZED' },
  invitation_invalid: { status: 400, code: 'INVITATION_INVALID' },
  inviter_not_authorized: { status: 409, code: 'INVITER_NOT_AUTHORIZED' },
  invitation_expiry_invalid: { status: 400, code: 'INVITATION_EXPIRY_INVALID' },
  site_required: { status: 400, code: 'SITE_REQUIRED' },
  site_manager_requires_site: { status: 400, code: 'SITE_REQUIRED' },
  invalid_site_scope: { status: 400, code: 'INVALID_SITE_SCOPE' },
  site_scope_not_allowed: { status: 400, code: 'SITE_SCOPE_NOT_ALLOWED' },
  already_member: { status: 409, code: 'ALREADY_MEMBER' },
  tenant_suspended: { status: 403, code: 'TENANT_SUSPENDED' },
};

function pgMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

function pgCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof AppError) {
    return {
      status: error.statusCode,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }

  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'request validation failed',
          details: error.issues,
        },
      },
    };
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { validation?: unknown }).validation !== undefined
  ) {
    return {
      status: 400,
      body: { error: { code: 'VALIDATION_ERROR', message: 'request validation failed' } },
    };
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return {
      status: statusCode,
      body: {
        error: {
          code: (error as { code?: string }).code ?? 'BAD_REQUEST',
          message: 'invalid request',
        },
      },
    };
  }

  const message = pgMessage(error);
  if (message && PG_MESSAGES[message]) {
    const mapped = PG_MESSAGES[message];
    return {
      status: mapped.status,
      body: { error: { code: mapped.code, message } },
    };
  }

  switch (pgCode(error)) {
    case '23505':
      return { status: 409, body: { error: { code: 'CONFLICT', message: 'already exists' } } };
    case '23503':
      return {
        status: 400,
        body: { error: { code: 'INVALID_REFERENCE', message: 'invalid reference' } },
      };
    case '22P02':
      return { status: 400, body: { error: { code: 'INVALID_ID', message: 'invalid id' } } };
    case '42501':
      return {
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'not permitted' } },
      };
    default:
      break;
  }

  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: 'internal server error' } },
  };
}

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const { status, body } = toErrorBody(error);
  if (status >= 500) request.log.error({ err: error }, 'request failed');
  void reply.code(status).send(body);
}
