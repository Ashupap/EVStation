export interface InvitationMail {
  invitationId: string;
  tenantId: string;
  to: string;
  acceptUrl: string;
  expiresAt: Date;
}

export interface Mailer {
  sendInvitation(message: InvitationMail): Promise<void>;
}

export class MemoryMailer implements Mailer {
  readonly outbox: InvitationMail[] = [];

  async sendInvitation(message: InvitationMail): Promise<void> {
    this.outbox.push(message);
  }
}
