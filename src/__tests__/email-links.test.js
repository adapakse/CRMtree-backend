'use strict';

// Links in e-mails point at the recipient's company address ({slug}.crmtree.pl),
// because one e-mail can have accounts in several companies and signing in on
// the shared app host picks one of them. No database: the tenant lookup is stubbed.

const mockQuery = jest.fn();
jest.mock('../config/database', () => ({ query: (...args) => mockQuery(...args) }));
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  frontendUrl: 'https://app.crmtree.pl',
}));

const emailUtil = require('../utils/email');

let sendMailSpy;
beforeEach(() => {
  mockQuery.mockReset();
  sendMailSpy = jest.spyOn(emailUtil, 'sendMail').mockResolvedValue();
});
afterEach(() => sendMailSpy.mockRestore());

const sentHtml = () => sendMailSpy.mock.calls[0][0].html;

function sendLeadActivityMail(tenantId) {
  return emailUtil.sendCrmActivityAssigned({
    tenantId,
    to: 'rep@example.com',
    locale: 'en',
    assigneeName: 'Rep',
    assignerName: 'Boss',
    activityType: 'task',
    activityTitle: 'Call back',
    activityAt: '2026-10-23T09:00:00Z',
    sourceName: 'Acme',
    sourceType: 'lead',
    sourceId: 187,
  });
}

test('a lead link opens on the company address', async () => {
  mockQuery.mockResolvedValue({ rows: [{ slug: 'acme' }] });
  await sendLeadActivityMail('tenant-1');

  expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM tenants'), ['tenant-1']);
  expect(sentHtml()).toContain('https://acme.crmtree.pl/crm/leads/187');
  expect(sentHtml()).not.toContain('https://app.crmtree.pl/crm/leads/187');
});

test('a company without its own host keeps the shared address', async () => {
  mockQuery.mockResolvedValue({ rows: [{ slug: 'crmtree-gold' }] });
  await sendLeadActivityMail('tenant-2');

  expect(sentHtml()).toContain('https://app.crmtree.pl/crm/leads/187');
});

test('a failed lookup still sends the mail with the shared address', async () => {
  mockQuery.mockRejectedValue(new Error('db down'));
  await sendLeadActivityMail('tenant-3');

  expect(sentHtml()).toContain('https://app.crmtree.pl/crm/leads/187');
});

test('project links in the daily digest use the company address', async () => {
  mockQuery.mockResolvedValue({ rows: [{ slug: 'acme' }] });
  await emailUtil.sendDailyDigest({
    tenantId: 'tenant-1',
    to: 'rep@example.com',
    locale: 'en',
    recipientName: 'Rep',
    date: '2026-10-23',
    digest: {
      overdue: [{
        source: 'project', task_id: 't-1', source_id: 'p-1', type: 'task',
        title: 'Import', source_name: 'ONB-4', due_date: '2026-10-20',
      }],
      today: [], noDate: [], unread: [],
    },
  });

  expect(sentHtml()).toContain('https://acme.crmtree.pl/projects/p-1?task=t-1');
  expect(sentHtml()).toContain('https://acme.crmtree.pl/crm/dashboard');
});
