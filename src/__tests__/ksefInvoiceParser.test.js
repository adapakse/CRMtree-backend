'use strict';

// FA(3) invoice parsing — no database, no network. The full document is the
// Ministry of Finance sample `tpl-fa3-s3.xml`, unchanged (its #nip# placeholders included).

const fs = require('fs');
const path = require('path');
const { parseInvoiceXml } = require('../services/ksefInvoiceParser');

const NAMESPACE = 'http://crd.gov.pl/wzor/2025/06/25/13775/';
const mfSample = fs.readFileSync(path.join(__dirname, 'fixtures', 'ksef-fa3-mf-sample.xml'), 'utf8');

const invoiceXml = (body, { extra = '' } = {}) => `<?xml version="1.0" encoding="utf-8"?>
<Faktura xmlns="${NAMESPACE}">
  <Podmiot1><DaneIdentyfikacyjne><NIP>0123456789</NIP><Nazwa>Seller</Nazwa></DaneIdentyfikacyjne></Podmiot1>
  ${extra}
  <Fa>${body}</Fa>
</Faktura>`;

describe('parseInvoiceXml', () => {
  test('reads the header, parties, totals, lines and payment data of the MF sample', () => {
    const invoice = parseInvoiceXml(mfSample);

    expect(invoice).toMatchObject({
      invoice_number: 'FV2026/02/150',
      invoice_type: 'VAT',
      issue_date: '2025-10-10',
      sale_date: null,
      currency: 'PLN',
      net_amount: 52260.1,
      vat_amount: 12019.82,
      gross_amount: 64279.92,
      amount_due: 63279.92,
    });
    expect(invoice.seller).toEqual({
      nip: '#nip#', name: 'Elektrownia S.A.', address: 'ul. Kwiatowa 1 m. 2, 00-001 Warszawa', country_code: 'PL',
    });
    expect(invoice.buyer).toMatchObject({ nip: '9795075130', name: 'Szkoła Testowa', address: 'ul. Polna 1, 00-001 Warszawa' });
    expect(invoice.lines).toHaveLength(3);
    expect(invoice.lines[1]).toEqual({
      number: 2, name: 'zamrażarka Zimnotech mk2', unit: 'szt.', quantity: 20, unit_net_price: 1000,
      net_amount: 18000, vat_rate: '23', exchange_rate: null,
    });
    expect(invoice.payment).toEqual({
      due_dates: ['2026-03-15'],
      form: '6',
      bank_accounts: [{
        number: '73111111111111111111111111', bank_name: 'Bank Bankowości Bankowej S. A.', swift: null, is_factor: true,
      }],
      is_paid: null,
      is_partially_paid: false,
      payment_date: null,
    });
  });

  test('every optional element may be missing', () => {
    const invoice = parseInvoiceXml(invoiceXml('<P_1>2026-09-01</P_1><P_2>FV/1</P_2>'));

    expect(invoice).toMatchObject({
      invoice_number: 'FV/1', issue_date: '2026-09-01', sale_date: null, currency: null, invoice_type: null,
      net_amount: null, vat_amount: null, gross_amount: null, amount_due: null, lines: [],
    });
    expect(invoice.seller).toEqual({ nip: '0123456789', name: 'Seller', address: null, country_code: null });
    expect(invoice.buyer).toEqual({ nip: null, name: null, address: null, country_code: null });
    expect(invoice.payment).toEqual({
      due_dates: [], form: null, bank_accounts: [], is_paid: null, is_partially_paid: false, payment_date: null,
    });
  });

  test('a document without the Fa section still parses', () => {
    const invoice = parseInvoiceXml(`<Faktura xmlns="${NAMESPACE}"><Naglowek/></Faktura>`);
    expect(invoice).toMatchObject({ invoice_number: null, issue_date: null, lines: [] });
  });

  test('sale date, several net rates, several due dates, own bank account, paid flag', () => {
    const invoice = parseInvoiceXml(invoiceXml(`
      <KodWaluty>EUR</KodWaluty><P_1>2026-09-14</P_1><P_2>FV/2</P_2><P_6>2026-09-10</P_6>
      <P_13_1>100.10</P_13_1><P_14_1>23.02</P_14_1><P_14_1W>97.84</P_14_1W>
      <P_13_2>50.00</P_13_2><P_14_2>4.00</P_14_2><P_13_6_1>10</P_13_6_1><P_15>187.12</P_15>
      <RodzajFaktury>VAT</RodzajFaktury>
      <FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Nocleg</P_7><P_11>100.10</P_11><KursWaluty>4.2500</KursWaluty></FaWiersz>
      <Platnosc>
        <Zaplacono>1</Zaplacono><DataZaplaty>2026-09-15</DataZaplaty>
        <TerminPlatnosci><Termin>2026-10-30</Termin></TerminPlatnosci>
        <TerminPlatnosci><Termin>2026-10-14</Termin></TerminPlatnosci>
        <FormaPlatnosci>6</FormaPlatnosci>
        <RachunekBankowy><NrRB>00123456789012345678901234</NrRB><SWIFT>BANKPLPW</SWIFT><NazwaBanku>Bank</NazwaBanku></RachunekBankowy>
        <RachunekBankowy><NrRB>PL99123456789012345678901234</NrRB></RachunekBankowy>
      </Platnosc>`));

    expect(invoice).toMatchObject({
      currency: 'EUR', sale_date: '2026-09-10', net_amount: 160.1, vat_amount: 27.02, gross_amount: 187.12,
    });
    expect(invoice.lines).toEqual([expect.objectContaining({ name: 'Nocleg', net_amount: 100.1, exchange_rate: 4.25 })]);
    expect(invoice.payment).toMatchObject({
      due_dates: ['2026-10-14', '2026-10-30'], form: '6', is_paid: true, payment_date: '2026-09-15',
    });
    // Leading zeros of an account number survive.
    expect(invoice.payment.bank_accounts).toEqual([
      { number: '00123456789012345678901234', bank_name: 'Bank', swift: 'BANKPLPW', is_factor: false },
      { number: 'PL99123456789012345678901234', bank_name: null, swift: null, is_factor: false },
    ]);
  });

  test('partial payments: paid in part is not paid, paid in full in parts is', () => {
    const partial = parseInvoiceXml(invoiceXml(`<Platnosc>
      <ZnacznikZaplatyCzesciowej>1</ZnacznikZaplatyCzesciowej>
      <ZaplataCzesciowa><KwotaZaplatyCzesciowej>10</KwotaZaplatyCzesciowej><DataZaplatyCzesciowej>2026-09-01</DataZaplatyCzesciowej></ZaplataCzesciowa>
    </Platnosc>`));
    expect(partial.payment).toMatchObject({ is_paid: false, is_partially_paid: true, payment_date: null });

    const settled = parseInvoiceXml(invoiceXml(`<Platnosc>
      <ZnacznikZaplatyCzesciowej>2</ZnacznikZaplatyCzesciowej>
      <ZaplataCzesciowa><KwotaZaplatyCzesciowej>10</KwotaZaplatyCzesciowej><DataZaplatyCzesciowej>2026-09-01</DataZaplatyCzesciowej></ZaplataCzesciowa>
      <ZaplataCzesciowa><KwotaZaplatyCzesciowej>20</KwotaZaplatyCzesciowej><DataZaplatyCzesciowej>2026-09-20</DataZaplatyCzesciowej></ZaplataCzesciowa>
    </Platnosc>`));
    expect(settled.payment).toMatchObject({ is_paid: true, is_partially_paid: false, payment_date: '2026-09-20' });
  });

  test('elements with a namespace prefix are read the same way', () => {
    const invoice = parseInvoiceXml(`<fa:Faktura xmlns:fa="${NAMESPACE}">
      <fa:Podmiot2><fa:DaneIdentyfikacyjne><fa:NIP>3430714583</fa:NIP></fa:DaneIdentyfikacyjne></fa:Podmiot2>
      <fa:Fa><fa:P_1>2026-09-02</fa:P_1><fa:P_2>FV/3</fa:P_2><fa:P_13_1>10.00</fa:P_13_1></fa:Fa>
    </fa:Faktura>`);
    expect(invoice).toMatchObject({ invoice_number: 'FV/3', issue_date: '2026-09-02', net_amount: 10 });
    expect(invoice.buyer.nip).toBe('3430714583');
  });

  test('malformed values come back as null instead of failing', () => {
    const invoice = parseInvoiceXml(invoiceXml(`
      <P_1>not-a-date</P_1><P_15>abc</P_15><P_13_1>x</P_13_1>
      <Platnosc><TerminPlatnosci><Termin>31.12.2026</Termin></TerminPlatnosci><TerminPlatnosci/></Platnosc>`));
    expect(invoice).toMatchObject({ issue_date: null, gross_amount: null, net_amount: null });
    expect(invoice.payment.due_dates).toEqual([]);
  });

  test('something that is not an invoice gives null', () => {
    expect(parseInvoiceXml('<Other><Fa/></Other>')).toBeNull();
    expect(parseInvoiceXml('')).toBeNull();
    expect(parseInvoiceXml('plain text, no XML at all')).toBeNull();
  });
});
