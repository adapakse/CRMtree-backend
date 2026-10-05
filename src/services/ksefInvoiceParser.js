'use strict';
// services/ksefInvoiceParser.js
//
// Reads the fields CRMtree uses from a FA(3) invoice XML (KSeF structured
// invoice). Every field is optional: whatever the document lacks or carries in
// an unexpected shape comes back as null (or an empty list), never as an error.
// No network, no database.

const { XMLParser } = require('fast-xml-parser');

const REPEATABLE_ELEMENTS = new Set([
  'FaWiersz', 'TerminPlatnosci', 'RachunekBankowy', 'RachunekBankowyFaktora', 'ZaplataCzesciowa',
]);
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;
const NET_FIELD_RE = /^P_13_\d+(_\d+)?$/;
// P_14_xW are the PLN equivalents on foreign-currency invoices — not part of the total.
const VAT_FIELD_RE = /^P_14_\d+$/;
const PAID_FLAG = '1';
const PARTIALLY_PAID = '1';
const PAID_IN_PARTS = '2';

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  // Elements may carry a namespace prefix.
  removeNSPrefix: true,
  // Values stay strings: a NIP or a bank account must keep its leading zeros.
  parseTagValue: false,
  trimValues: true,
  isArray: (tagName) => REPEATABLE_ELEMENTS.has(tagName),
});

function toText(value) {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

function toNumber(value) {
  const text = toText(value);
  if (text === null) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function toDate(value) {
  const text = toText(value);
  const match = text && DATE_PREFIX_RE.exec(text);
  if (!match || Number.isNaN(Date.parse(match[0]))) return null;
  return match[0];
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function sumFields(section, fieldPattern) {
  const values = Object.entries(section)
    .filter(([field]) => fieldPattern.test(field))
    .map(([, value]) => toNumber(value))
    .filter((value) => value !== null);
  if (!values.length) return null;
  return roundMoney(values.reduce((total, value) => total + value, 0));
}

function parseParty(party) {
  const address = [toText(party?.Adres?.AdresL1), toText(party?.Adres?.AdresL2)].filter(Boolean).join(', ');
  return {
    nip: toText(party?.DaneIdentyfikacyjne?.NIP),
    name: toText(party?.DaneIdentyfikacyjne?.Nazwa),
    address: address || null,
    country_code: toText(party?.Adres?.KodKraju),
  };
}

function parseLine(line) {
  return {
    number: toNumber(line?.NrWierszaFa),
    name: toText(line?.P_7),
    unit: toText(line?.P_8A),
    quantity: toNumber(line?.P_8B),
    unit_net_price: toNumber(line?.P_9A),
    net_amount: toNumber(line?.P_11),
    vat_rate: toText(line?.P_12),
    exchange_rate: toNumber(line?.KursWaluty),
  };
}

function parseBankAccounts(accounts, isFactor) {
  return (accounts || [])
    .map((account) => ({
      number: toText(account?.NrRB),
      bank_name: toText(account?.NazwaBanku),
      swift: toText(account?.SWIFT),
      is_factor: isFactor,
    }))
    .filter((account) => account.number);
}

function parsePayment(payment) {
  const dueDates = (payment?.TerminPlatnosci || [])
    .map((term) => toDate(term?.Termin))
    .filter(Boolean)
    .sort();
  const partialPaymentDates = (payment?.ZaplataCzesciowa || [])
    .map((partial) => toDate(partial?.DataZaplatyCzesciowej))
    .filter(Boolean)
    .sort();
  const paidFlag = toText(payment?.Zaplacono);
  const partialFlag = toText(payment?.ZnacznikZaplatyCzesciowej);

  let isPaid = null;
  if (paidFlag === PAID_FLAG || partialFlag === PAID_IN_PARTS) isPaid = true;
  else if (partialFlag === PARTIALLY_PAID) isPaid = false;

  return {
    due_dates: dueDates,
    form: toText(payment?.FormaPlatnosci),
    // When a factor's account is given the payment is owed to the factor, so
    // both kinds are kept and told apart by is_factor.
    bank_accounts: [
      ...parseBankAccounts(payment?.RachunekBankowy, false),
      ...parseBankAccounts(payment?.RachunekBankowyFaktora, true),
    ],
    is_paid: isPaid,
    is_partially_paid: partialFlag === PARTIALLY_PAID,
    payment_date: toDate(payment?.DataZaplaty) || (isPaid ? partialPaymentDates.at(-1) || null : null),
  };
}

// Returns null when `xml` is not a FA invoice at all.
function parseInvoiceXml(xml) {
  let document;
  try {
    document = xmlParser.parse(xml);
  } catch {
    return null;
  }
  const invoice = document?.Faktura;
  if (!invoice || typeof invoice !== 'object') return null;
  const body = invoice.Fa && typeof invoice.Fa === 'object' ? invoice.Fa : {};

  return {
    invoice_number: toText(body.P_2),
    invoice_type: toText(body.RodzajFaktury),
    issue_date: toDate(body.P_1),
    sale_date: toDate(body.P_6),
    currency: toText(body.KodWaluty),
    seller: parseParty(invoice.Podmiot1),
    buyer: parseParty(invoice.Podmiot2),
    net_amount: sumFields(body, NET_FIELD_RE),
    vat_amount: sumFields(body, VAT_FIELD_RE),
    gross_amount: toNumber(body.P_15),
    amount_due: toNumber(body.Rozliczenie?.DoZaplaty),
    payment: parsePayment(body.Platnosc),
    lines: (body.FaWiersz || []).map(parseLine),
  };
}

module.exports = { parseInvoiceXml };
