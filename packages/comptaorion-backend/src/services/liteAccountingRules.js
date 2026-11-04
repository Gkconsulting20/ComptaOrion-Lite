const amount = (value, label) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} invalide`);
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
};

const accountLine = (accountId, debit, credit, libelle) => {
  if (!Number.isInteger(Number(accountId)) || Number(accountId) < 1) {
    throw new Error('Compte comptable requis');
  }
  return {
    compteComptableId: Number(accountId),
    debit: amount(debit, 'Débit'),
    credit: amount(credit, 'Crédit'),
    libelle,
  };
};

export function assertBalancedJournalLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error('Une écriture comptable doit contenir au moins deux lignes');
  }
  const debit = lines.reduce((sum, line) => sum + amount(line.debit || 0, 'Débit'), 0);
  const credit = lines.reduce((sum, line) => sum + amount(line.credit || 0, 'Crédit'), 0);
  if (Math.abs(debit - credit) > 0.01) {
    throw new Error(`Écriture non équilibrée: Débit=${debit}, Crédit=${credit}`);
  }
  return { debit: Math.round(debit * 100) / 100, credit: Math.round(credit * 100) / 100 };
}

export function getCustomerReceiptAccountNumber(modePaiement) {
  if (modePaiement === 'especes') return '57';
  if (modePaiement === 'cheque') return '513';
  return '52';
}

export function buildCustomerReceiptLines({ settlementAccountId, customerAccountId, amount: value, modePaiement, reference }) {
  const amountValue = amount(value, 'Montant reçu');
  const lines = [
    accountLine(settlementAccountId, amountValue, 0, `Encaissement ${modePaiement} - ${reference}`),
    accountLine(customerAccountId, 0, amountValue, `Règlement client ${reference}`),
  ];
  assertBalancedJournalLines(lines);
  return lines;
}

export function buildSupplierPaymentLines({ supplierAccountId, settlementAccountId, amount: value, modePaiement, reference }) {
  const amountValue = amount(value, 'Montant payé');
  const lines = [
    accountLine(supplierAccountId, amountValue, 0, `Règlement fournisseur ${reference}`),
    accountLine(settlementAccountId, 0, amountValue, `Décaissement ${modePaiement} - ${reference}`),
  ];
  assertBalancedJournalLines(lines);
  return lines;
}

export function buildCustomerPaymentLines({
  settlementAccountId,
  customerAccountId,
  discountAccountId,
  amount: cashValue,
  discountAmount = 0,
  modePaiement,
  reference,
}) {
  const cash = amount(cashValue, 'Montant reçu');
  const discount = amount(discountAmount, 'Escompte accordé');
  const lines = [
    accountLine(settlementAccountId, cash, 0, `Encaissement ${modePaiement} - ${reference}`),
  ];
  if (discount > 0) {
    lines.push(accountLine(discountAccountId, discount, 0, `Escompte accordé ${reference}`));
  }
  lines.push(accountLine(customerAccountId, 0, cash + discount, `Règlement client ${reference}`));
  assertBalancedJournalLines(lines);
  return lines;
}

export function buildSupplierPaymentDiscountLines({
  supplierAccountId,
  settlementAccountId,
  discountAccountId,
  amount: cashValue,
  discountAmount = 0,
  modePaiement,
  reference,
}) {
  const cash = amount(cashValue, 'Montant payé');
  const discount = amount(discountAmount, 'Escompte obtenu');
  const lines = [
    accountLine(supplierAccountId, cash + discount, 0, `Règlement fournisseur ${reference}`),
    accountLine(settlementAccountId, 0, cash, `Décaissement ${modePaiement} - ${reference}`),
  ];
  if (discount > 0) {
    lines.push(accountLine(discountAccountId, 0, discount, `Escompte obtenu ${reference}`));
  }
  assertBalancedJournalLines(lines);
  return lines;
}

export function buildCustomerDebitNoteLines({
  customerAccountId,
  adjustmentAccountId,
  vatAccountId,
  totalHT,
  totalTVA,
  totalTTC,
  reference,
}) {
  const ht = amount(totalHT, 'Montant HT');
  const vat = amount(totalTVA, 'TVA');
  const ttc = amount(totalTTC, 'Montant TTC');
  const lines = [
    accountLine(customerAccountId, ttc, 0, `Note de débit client ${reference}`),
    accountLine(adjustmentAccountId, 0, ht, `Ajustement client ${reference}`),
  ];
  if (vat > 0) lines.push(accountLine(vatAccountId, 0, vat, `TVA note de débit client ${reference}`));
  assertBalancedJournalLines(lines);
  return lines;
}

export function buildSupplierCreditNoteLines({
  supplierAccountId,
  adjustmentAccountId,
  vatAccountId,
  totalHT,
  totalTVA,
  totalTTC,
  reference,
}) {
  const ht = amount(totalHT, 'Montant HT');
  const vat = amount(totalTVA, 'TVA');
  const ttc = amount(totalTTC, 'Montant TTC');
  const lines = [
    accountLine(supplierAccountId, ttc, 0, `Note de crédit fournisseur ${reference}`),
    accountLine(adjustmentAccountId, 0, ht, `Ajustement qualité fournisseur ${reference}`),
  ];
  if (vat > 0) lines.push(accountLine(vatAccountId, 0, vat, `TVA note de crédit fournisseur ${reference}`));
  assertBalancedJournalLines(lines);
  return lines;
}

export function calculateEarlyPaymentDiscount({
  balance,
  paymentAmount,
  invoiceDate,
  paymentDate,
  percentage,
  discountDays,
}) {
  const due = amount(balance, 'Solde facture');
  const cash = amount(paymentAmount, 'Montant payé');
  const rate = Number(percentage || 0);
  const days = Number(discountDays || 0);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100
    || !Number.isInteger(days) || days < 0) {
    throw new Error('Conditions d’escompte ou dates invalides');
  }
  if (rate === 0 || days === 0 || due <= 0 || cash >= due) {
    return { discountAmount: 0, settledAmount: cash, discountApplied: false };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(invoiceDate || ''))
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(paymentDate || ''))) {
    throw new Error('Dates d’escompte invalides');
  }
  const start = new Date(`${invoiceDate}T00:00:00.000Z`);
  const payment = new Date(`${paymentDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(payment.getTime()) || payment < start) {
    return { discountAmount: 0, settledAmount: cash, discountApplied: false };
  }
  const cutoff = new Date(start.getTime() + days * 86400000);
  const expectedDiscount = amount(due * rate / 100, 'Escompte calculé');
  const expectedCash = amount(due - expectedDiscount, 'Paiement net');
  if (payment <= cutoff && expectedDiscount > 0 && Math.abs(cash - expectedCash) <= 0.01) {
    return { discountAmount: expectedDiscount, settledAmount: due, discountApplied: true };
  }
  return { discountAmount: 0, settledAmount: cash, discountApplied: false };
}

export function buildCustomerReturnLines({
  salesAccountId,
  vatAccountId,
  customerAccountId,
  stockAccountId,
  costAccountId,
  totalHT,
  totalTVA,
  totalTTC,
  restockedCost = 0,
  reference,
}) {
  const ht = amount(totalHT, 'Montant HT');
  const vat = amount(totalTVA, 'TVA');
  const ttc = amount(totalTTC, 'Montant TTC');
  const cost = amount(restockedCost, 'Coût repris');
  const lines = [
    accountLine(salesAccountId, ht, 0, `Retour client ${reference}`),
    accountLine(customerAccountId, 0, ttc, `Avoir client ${reference}`),
  ];
  if (vat > 0) lines.push(accountLine(vatAccountId, vat, 0, `Annulation TVA vente ${reference}`));
  if (cost > 0) {
    lines.push(
      accountLine(stockAccountId, cost, 0, `Stock repris ${reference}`),
      accountLine(costAccountId, 0, cost, `Annulation du coût vendu ${reference}`),
    );
  }
  assertBalancedJournalLines(lines);
  return lines;
}

export function buildSupplierReturnLines({
  supplierAccountId,
  stockAccountId,
  vatAccountId,
  totalHT,
  totalTVA,
  totalTTC,
  reference,
}) {
  const ht = amount(totalHT, 'Montant HT');
  const vat = amount(totalTVA, 'TVA');
  const ttc = amount(totalTTC, 'Montant TTC');
  const lines = [
    accountLine(supplierAccountId, ttc, 0, `Retour fournisseur ${reference}`),
    accountLine(stockAccountId, 0, ht, `Sortie de stock ${reference}`),
  ];
  if (vat > 0) lines.push(accountLine(vatAccountId, 0, vat, `Annulation TVA déductible ${reference}`));
  assertBalancedJournalLines(lines);
  return lines;
}

export function buildChequeDepositLines({ bankAccountId, chequeAccountId, amount: value, reference }) {
  const amountValue = amount(value, 'Montant du chèque');
  const lines = [
    accountLine(bankAccountId, amountValue, 0, `Dépôt du chèque ${reference}`),
    accountLine(chequeAccountId, 0, amountValue, `Transfert des chèques à encaisser ${reference}`),
  ];
  assertBalancedJournalLines(lines);
  return lines;
}
