const MAX_STATEMENT_LINES = 5000;
const MAX_AMOUNT = 1_000_000_000_000;
const MATCH_DATE_TOLERANCE_DAYS = 3;

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export function isValidIsoDate(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

export function normalizeStatementLines(lines, { dateDebut, dateFin } = {}) {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_STATEMENT_LINES) {
    throw Object.assign(new Error(`Le relevé doit contenir entre 1 et ${MAX_STATEMENT_LINES} lignes.`), { status: 400 });
  }
  if (!isValidIsoDate(dateDebut) || !isValidIsoDate(dateFin) || dateDebut > dateFin) {
    throw Object.assign(new Error('La période du relevé est invalide.'), { status: 400 });
  }

  const seenLineNumbers = new Set();
  return lines.map((line, index) => {
    const lineNumber = Number(line?.lineNumber ?? index + 1);
    const date = String(line?.date || '');
    const description = String(line?.description || '').trim();
    const reference = line?.reference == null ? null : String(line.reference).trim().slice(0, 255) || null;
    const amount = Number(line?.amount);
    const transactionId = line?.transactionId == null || line.transactionId === ''
      ? null
      : Number(line.transactionId);

    if (!Number.isInteger(lineNumber) || lineNumber < 1 || seenLineNumbers.has(lineNumber)) {
      throw Object.assign(new Error(`Numéro de ligne invalide ou répété (${index + 1}).`), { status: 400 });
    }
    seenLineNumbers.add(lineNumber);
    if (!isValidIsoDate(date) || date < dateDebut || date > dateFin) {
      throw Object.assign(new Error(`La date de la ligne ${lineNumber} doit être comprise dans la période.`), { status: 400 });
    }
    if (!Number.isFinite(amount) || Math.abs(amount) > MAX_AMOUNT || amount === 0) {
      throw Object.assign(new Error(`Le montant de la ligne ${lineNumber} est invalide.`), { status: 400 });
    }
    if (description.length > 500) {
      throw Object.assign(new Error(`La description de la ligne ${lineNumber} est trop longue.`), { status: 400 });
    }
    if (transactionId !== null && (!Number.isInteger(transactionId) || transactionId < 1)) {
      throw Object.assign(new Error(`La transaction choisie pour la ligne ${lineNumber} est invalide.`), { status: 400 });
    }

    return {
      lineNumber,
      date,
      description,
      reference,
      amount: round2(amount),
      transactionId,
    };
  });
}

export function signedLedgerAmount(transaction) {
  const amount = Number(transaction?.montant || 0);
  if (!Number.isFinite(amount)) return 0;
  return transaction.type === 'encaissement' ? round2(amount) : -round2(amount);
}

function dateDistanceInDays(left, right) {
  const leftTime = Date.parse(`${left}T00:00:00.000Z`);
  const rightTime = Date.parse(`${right}T00:00:00.000Z`);
  return Math.abs(Math.round((leftTime - rightTime) / 86_400_000));
}

function normalizeReference(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function suggestStatementMatches(statementLines, transactions) {
  const usedTransactionIds = new Set();
  return statementLines.map((line) => {
    const lineReference = normalizeReference(line.reference || line.description);
    const candidates = transactions
      .filter((transaction) => !transaction.rapproche && !transaction.rapprochementId)
      .map((transaction) => {
        const transactionDate = typeof transaction.dateTransaction === 'string'
          ? transaction.dateTransaction.slice(0, 10)
          : transaction.dateTransaction?.toISOString?.().slice(0, 10);
        if (!transactionDate) return null;
        const dayDistance = dateDistanceInDays(line.date, transactionDate);
        if (dayDistance > MATCH_DATE_TOLERANCE_DAYS) return null;
        const signedAmount = signedLedgerAmount(transaction);
        if (Math.abs(signedAmount - line.amount) > 0.01) return null;

        const transactionReference = normalizeReference(
          `${transaction.numeroPiece || ''} ${transaction.description || ''} ${transaction.tiersNom || ''}`,
        );
        const referenceMatch = lineReference.length >= 3
          && transactionReference.length >= 3
          && (transactionReference.includes(lineReference) || lineReference.includes(transactionReference));
        const score = (referenceMatch ? 100 : 0) + 30 - dayDistance * 5;
        return { transaction, score, dayDistance, referenceMatch };
      })
      .filter(Boolean)
      .filter(({ transaction }) => !usedTransactionIds.has(transaction.id))
      .sort((left, right) => right.score - left.score);

    if (!candidates.length || (candidates.length > 1 && candidates[0].score === candidates[1].score)) {
      return { ...line, suggestedTransactionId: null, suggestionReason: null };
    }

    const [best] = candidates;
    usedTransactionIds.add(best.transaction.id);
    return {
      ...line,
      suggestedTransactionId: best.transaction.id,
      suggestionReason: best.referenceMatch
        ? 'Montant, date et référence proches'
        : `Montant identique, date à ${best.dayDistance} jour(s)`,
    };
  });
}

export function calculateReconciliationBalances({
  openingBalance = 0,
  statementBalance = 0,
  transactions = [],
  selectedTransactionIds = [],
}) {
  const selected = new Set(selectedTransactionIds.map(Number));
  const bookBalance = round2(Number(openingBalance) + transactions.reduce(
    (sum, transaction) => sum + signedLedgerAmount(transaction),
    0,
  ));
  const outstanding = transactions.filter((transaction) => (
    !transaction.rapproche
    && !transaction.rapprochementId
    && !selected.has(Number(transaction.id))
  ));
  const outstandingNet = round2(outstanding.reduce((sum, transaction) => (
    sum + signedLedgerAmount(transaction)
  ), 0));
  const adjustedStatementBalance = round2(Number(statementBalance) + outstandingNet);
  return {
    bookBalance,
    adjustedStatementBalance,
    outstandingNet,
    difference: round2(adjustedStatementBalance - bookBalance),
    outstandingCount: outstanding.length,
  };
}

export const bankReconciliationLimits = Object.freeze({
  maxStatementLines: MAX_STATEMENT_LINES,
  matchDateToleranceDays: MATCH_DATE_TOLERANCE_DAYS,
});
