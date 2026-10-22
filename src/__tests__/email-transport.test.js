'use strict';

// System e-mails go out through ZeptoMail over SMTP (utils/email.js). These
// tests stub nodemailer, so nothing leaves the machine and no database is needed.

const mockSendMail = jest.fn();
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSendMail }));
jest.mock('nodemailer', () => ({ createTransport: mockCreateTransport }));

const SMTP = { host: 'smtp.zeptomail.test', port: 587, user: 'emailapikey', password: 'token' };

function loadEmailWith({ isDev = false, sendInDev = false, smtp = SMTP } = {}) {
  jest.resetModules();
  jest.doMock('../config', () => {
    const actual = jest.requireActual('../config');
    return {
      ...actual,
      isDev,
      email: { from: 'noreply@crmtree.pl', fromName: 'CRMtree', smtp, sendInDev },
    };
  });
  return require('../utils/email');
}

beforeEach(() => {
  mockSendMail.mockReset().mockResolvedValue({});
  mockCreateTransport.mockClear();
});

test('sends through SMTP with STARTTLS on 587 and the CRMtree sender', async () => {
  const email = loadEmailWith();
  await email.sendMail({ to: 'a@example.com', subject: 'Hi', html: '<p>Hello <b>there</b></p>' });

  expect(mockCreateTransport).toHaveBeenCalledWith({
    host: 'smtp.zeptomail.test',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: 'emailapikey', pass: 'token' },
  });
  expect(mockSendMail).toHaveBeenCalledWith({
    from: { name: 'CRMtree', address: 'noreply@crmtree.pl' },
    to: 'a@example.com',
    subject: 'Hi',
    html: '<p>Hello <b>there</b></p>',
    text: 'Hello there',
  });
});

test('port 465 uses implicit TLS', async () => {
  const email = loadEmailWith({ smtp: { ...SMTP, port: 465 } });
  await email.sendMail({ to: 'a@example.com', subject: 'Hi', html: '<p>x</p>' });

  expect(mockCreateTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true, requireTLS: false }));
});

test('development environments only log unless sending is switched on', async () => {
  await loadEmailWith({ isDev: true }).sendMail({ to: 'a@example.com', subject: 'Hi', html: '<p>x</p>' });
  expect(mockSendMail).not.toHaveBeenCalled();

  await loadEmailWith({ isDev: true, sendInDev: true }).sendMail({ to: 'a@example.com', subject: 'Hi', html: '<p>x</p>' });
  expect(mockSendMail).toHaveBeenCalledTimes(1);
});

test('a missing SMTP setting or a failed send never throws', async () => {
  const unconfigured = loadEmailWith({ smtp: { ...SMTP, host: '', password: '' } });
  await expect(unconfigured.sendMail({ to: 'a@example.com', subject: 'Hi', html: '<p>x</p>' })).resolves.toBeUndefined();
  expect(mockSendMail).not.toHaveBeenCalled();

  mockSendMail.mockRejectedValueOnce(new Error('550 rejected'));
  const configured = loadEmailWith();
  await expect(configured.sendMail({ to: 'a@example.com', subject: 'Hi', html: '<p>x</p>' })).resolves.toBeUndefined();
});
