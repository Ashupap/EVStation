import { z } from 'zod';

export const roleSchema = z.enum(['tenant_admin', 'site_manager', 'viewer']);
export type Role = z.infer<typeof roleSchema>;

export const membershipSchema = z.object({
  tenant_id: z.string().uuid(),
  tenant_name: z.string(),
  tenant_slug: z.string(),
  role: roleSchema,
  site_ids: z.array(z.string().uuid()),
});
export type Membership = z.infer<typeof membershipSchema>;

export const principalSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  display_name: z.string().nullable(),
  email_verified: z.boolean(),
  is_platform_admin: z.boolean(),
  memberships: z.array(membershipSchema),
});
export type Principal = z.infer<typeof principalSchema>;

export const siteSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  name: z.string(),
  address: z.string().nullable(),
  status: z.string(),
});
export type Site = z.infer<typeof siteSchema>;

export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  display_name: z.string().nullable(),
  membership_id: z.string().uuid(),
  role: roleSchema,
  site_ids: z.array(z.string().uuid()),
});
export type User = z.infer<typeof userSchema>;

export const invitationSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: roleSchema,
  expires_at: z.string(),
  accepted_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});
export type Invitation = z.infer<typeof invitationSchema>;

export const tenantSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
});
export type Tenant = z.infer<typeof tenantSchema>;
