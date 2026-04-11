import nodemailer from 'nodemailer';

export class MailService {
  constructor({ host, port, secure, user, pass, from, transportFactory = nodemailer.createTransport }) {
    this.from = from || user || '';
    this.transport = host && port && user && pass && this.from
      ? transportFactory({
        host,
        port,
        secure,
        auth: {
          user,
          pass
        }
      })
      : null;
  }

  async send({ to, subject, text }) {
    if (!this.transport) {
      throw new Error('Mail transport is not configured');
    }

    return this.transport.sendMail({
      from: this.from,
      to,
      subject,
      text
    });
  }
}
