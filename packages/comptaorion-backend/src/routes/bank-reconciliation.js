import { Router } from 'express';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import { db } from '../db.js';
import {
  comptesBancaires,
  lignesRapprochementBancaire,
  rapprochementsBancaires,
  transactionsTresorerie,
} from '../schema.js';
import {
  calculateReconciliationBalances,
  normalizeStatementLines,
  signedLedgerAmount,
  suggestStatementMatches,
} from '../services/bankReconciliation.js';

const router = Router();
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const amountTolerance = 0.01;
const dateToleranceDays = 3;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function parsePositiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw fail(`${label} invalide.`);
  return parsed;
}

function validAmount(value) {
  if (typeof value === 'string' && !value.trim()) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || Math.abs(amount) > 1_000_000_000_000) return null;
  return round2(amount);
}

function shiftDate(date, days) {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function isoDate(value) {
  if (typeof value === 'string') return value.slice(0, 10);
  return value instanceof Date ? value.toISOString().slice(0, 10) : '';
}

function safeFailure(res, error, fallback) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return res.status(status).json({
    success: false,
    message: status < 500 ? error.message : fallback,
  });
}

async function getAccount(executor, entrepriseId, accountId) {
  const [account] = await executor.select().from(comptesBancaires).where(and(
    eq(comptesBancaires.id, accountId),
    eq(comptesBancaires.entrepriseId, entrepriseId),
    eq(comptesBancaires.actif, true),
  )).limit(1);
  if (!account) throw fail('Compte bancaire introuvable ou inactif.', 404);
  return account;
}

async function getLedgerThrough(executor, entrepriseId, accountId, dateFin) {
  return executor.select().from(transactionsTresorerie).where(and(
    eq(transactionsTresorerie.entrepriseId, entrepriseId),
    eq(transactionsTresorerie.compteBancaireId, accountId),
    lte(transactionsTresorerie.dateTransaction, dateFin),
  )).orderBy(asc(transactionsTresorerie.dateTransaction), asc(transactionsTresorerie.id));
}

function calculateBalances(account, transactions, statementBalance, selectedTransactionIds = []) {
  return calculateReconciliationBalances({
    openingBalance: account.soldeInitial,
    statementBalance,
    transactions,
    selectedTransactionIds,
  });
}

function presentTransaction(transaction) {
  return {
    id: transaction.id,
    dateTransaction: transaction.dateTransaction,
    type: transaction.type,
    montant: Number(transaction.montant || 0),
    montantSigne: signedLedgerAmount(transaction),
    description: transaction.description || '',
    numeroPiece: transaction.numeroPiece || '',
    categorie: transaction.categorie || '',
    tiersNom: transaction.tiersNom || '',
    modePaiement: transaction.modePaiement || '',
    rapproche: transaction.rapproche === true,
    rapprochementId: transaction.rapprochementId || null,
  };
}

function validMatch(line, transaction) {
  const transactionDate = isoDate(transaction.dateTransaction);
  if (!transactionDate) return false;
  const dayDifference = Math.abs(
    (Date.parse(`${transactionDate}T00:00:00.000Z`) - Date.parse(`${line.date}T00:00:00.000Z`))
    / 86_400_000,
  );
  return dayDifference <= dateToleranceDays
    && Math.abs(signedLedgerAmount(transaction) - line.amount) <= amountTolerance;
}

async function findReconciliation(executor, entrepriseId, reconciliationId) {
  const [reconciliation] = await executor.select().from(rapprochementsBancaires).where(and(
    eq(rapprochementsBancaires.id, reconciliationId),
    eq(rapprochementsBancaires.entrepriseId, entrepriseId),
  )).limit(1);
  if (!reconciliation) throw fail('Rapprochement introuvable.', 404);
  return reconciliation;
}

async function refreshReconciliationBalances(executor, reconciliation, account, selectedIds) {
  const transactions = await getLedgerThrough(
    executor,
    reconciliation.entrepriseId,
    reconciliation.compteBancaireId,
    reconciliation.dateFin,
  );
  const balances = calculateBalances(account, transactions, reconciliation.soldeReleve, selectedIds);
  const [updated] = await executor.update(rapprochementsBancaires).set({
    soldeComptable: balances.bookBalance.toFixed(2),
    ecart: balances.difference.toFixed(2),
    updatedAt: new Date(),
  }).where(and(
    eq(rapprochementsBancaires.id, reconciliation.id),
    eq(rapprochementsBancaires.entrepriseId, reconciliation.entrepriseId),
  )).returning();
  return { reconciliation: updated, balances };
}

router.get('/', async (req, res) => {
  try {
    const results = await db.select({
      id: rapprochementsBancaires.id,
      compteBancaireId: rapprochementsBancaires.compteBancaireId,
      nomCompte: comptesBancaires.nomCompte,
      banque: comptesBancaires.banque,
      dateDebut: rapprochementsBancaires.dateDebut,
      dateFin: rapprochementsBancaires.dateFin,
      soldeReleve: rapprochementsBancaires.soldeReleve,
      soldeComptable: rapprochementsBancaires.soldeComptable,
      ecart: rapprochementsBancaires.ecart,
      statut: rapprochementsBancaires.statut,
      notes: rapprochementsBancaires.notes,
      createdAt: rapprochementsBancaires.createdAt,
    }).from(rapprochementsBancaires)
      .leftJoin(comptesBancaires, and(
        eq(rapprochementsBancaires.compteBancaireId, comptesBancaires.id),
        eq(rapprochementsBancaires.entrepriseId, comptesBancaires.entrepriseId),
      ))
      .where(eq(rapprochementsBancaires.entrepriseId, req.entrepriseId))
      .orderBy(desc(rapprochementsBancaires.dateFin), desc(rapprochementsBancaires.id))
      .limit(200);
    return res.json({ success: true, data: results });
  } catch (error) {
    return safeFailure(res, error, 'Impossible de charger les rapprochements bancaires.');
  }
});

router.post('/accounts', async (req, res) => {
  try {
    const nomCompte = String(req.body?.nomCompte || '').trim();
    const banque = req.body?.banque == null ? null : String(req.body.banque).trim().slice(0, 255) || null;
    const numeroCompte = req.body?.numeroCompte == null
      ? null
      : String(req.body.numeroCompte).trim().slice(0, 100) || null;
    if (!nomCompte || nomCompte.length > 255) throw fail('Le nom du compte est obligatoire.');

    const [account] = await db.insert(comptesBancaires).values({
      entrepriseId: req.entrepriseId,
      nomCompte,
      banque,
      numeroCompte,
      soldeInitial: '0.00',
      soldeActuel: '0.00',
      type: 'banque',
      actif: true,
    }).returning({
      id: comptesBancaires.id,
      nomCompte: comptesBancaires.nomCompte,
      banque: comptesBancaires.banque,
      numeroCompte: comptesBancaires.numeroCompte,
      soldeActuel: comptesBancaires.soldeActuel,
      actif: comptesBancaires.actif,
    });
    return res.status(201).json({ success: true, data: { account } });
  } catch (error) {
    return safeFailure(res, error, 'Impossible de créer le compte bancaire.');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const reconciliationId = parsePositiveId(req.params.id, 'Rapprochement');
    const reconciliation = await findReconciliation(db, req.entrepriseId, reconciliationId);
    const account = await getAccount(db, req.entrepriseId, reconciliation.compteBancaireId);
    const [lines, transactions] = await Promise.all([
      db.select().from(lignesRapprochementBancaire).where(and(
        eq(lignesRapprochementBancaire.entrepriseId, req.entrepriseId),
        eq(lignesRapprochementBancaire.rapprochementId, reconciliationId),
      )).orderBy(asc(lignesRapprochementBancaire.numeroLigne)),
      db.select().from(transactionsTresorerie).where(and(
        eq(transactionsTresorerie.entrepriseId, req.entrepriseId),
        eq(transactionsTresorerie.compteBancaireId, reconciliation.compteBancaireId),
        gte(transactionsTresorerie.dateTransaction, shiftDate(reconciliation.dateDebut, -dateToleranceDays)),
        lte(transactionsTresorerie.dateTransaction, reconciliation.dateFin),
        or(
          isNull(transactionsTresorerie.rapprochementId),
          eq(transactionsTresorerie.rapprochementId, reconciliationId),
        ),
      )).orderBy(asc(transactionsTresorerie.dateTransaction), asc(transactionsTresorerie.id)),
    ]);
    const matchedIds = lines.map((line) => line.transactionId).filter(Boolean);
    const mappedLines = lines.map((line) => ({
      ...line,
      lineNumber: line.numeroLigne,
      date: isoDate(line.dateOperation),
      amount: Number(line.montant),
      transactionId: line.transactionId || null,
    }));
    const mappedTransactions = transactions.map(presentTransaction);
    const suggestionMap = new Map(suggestStatementMatches(
      mappedLines.filter((line) => !line.transactionId),
      mappedTransactions,
    ).map((line) => [line.lineNumber, line]));

    return res.json({
      success: true,
      data: {
        reconciliation: {
          ...reconciliation,
          nomCompte: account.nomCompte,
          soldeReleve: Number(reconciliation.soldeReleve),
          soldeComptable: Number(reconciliation.soldeComptable),
          ecart: Number(reconciliation.ecart),
        },
        lines: mappedLines.map((line) => ({
          ...line,
          suggestedTransactionId: suggestionMap.get(line.numeroLigne)?.suggestedTransactionId || null,
          suggestionReason: suggestionMap.get(line.numeroLigne)?.suggestionReason || null,
        })),
        transactions: mappedTransactions,
        matchedTransactionIds: matchedIds,
      },
    });
  } catch (error) {
    return safeFailure(res, error, 'Impossible de charger le rapprochement bancaire.');
  }
});

router.post('/preview', async (req, res) => {
  try {
    const accountId = parsePositiveId(req.body?.compteBancaireId, 'Compte bancaire');
    const { dateDebut, dateFin } = req.body || {};
    const lines = normalizeStatementLines(req.body?.statementLines, { dateDebut, dateFin });
    const statementBalance = validAmount(req.body?.soldeReleve);
    if (req.body?.soldeReleve !== undefined && statementBalance === null) {
      throw fail('Le solde de clôture du relevé est invalide.');
    }
    const account = await getAccount(db, req.entrepriseId, accountId);
    const [transactions, ledgerThroughEnd] = await Promise.all([
      db.select().from(transactionsTresorerie).where(and(
        eq(transactionsTresorerie.entrepriseId, req.entrepriseId),
        eq(transactionsTresorerie.compteBancaireId, accountId),
        gte(transactionsTresorerie.dateTransaction, shiftDate(dateDebut, -dateToleranceDays)),
        lte(transactionsTresorerie.dateTransaction, dateFin),
        isNull(transactionsTresorerie.rapprochementId),
      )).orderBy(asc(transactionsTresorerie.dateTransaction), asc(transactionsTresorerie.id)),
      getLedgerThrough(db, req.entrepriseId, accountId, dateFin),
    ]);
    const candidateTransactions = transactions.filter((transaction) => transaction.rapproche !== true);
    const suggestions = suggestStatementMatches(lines, candidateTransactions);
    const balances = calculateBalances(account, ledgerThroughEnd, statementBalance ?? 0);
    return res.json({
      success: true,
      data: {
        lines: suggestions,
        transactions: candidateTransactions.map(presentTransaction),
        soldeComptable: balances.bookBalance,
        soldeReleveAjuste: statementBalance === null ? null : balances.adjustedStatementBalance,
        outstandingNet: balances.outstandingNet,
        ecart: statementBalance === null ? null : balances.difference,
        operationsEnAttente: balances.outstandingCount,
      },
    });
  } catch (error) {
    return safeFailure(res, error, 'Impossible de préparer le relevé bancaire.');
  }
});

router.post('/', async (req, res) => {
  try {
    const accountId = parsePositiveId(req.body?.compteBancaireId, 'Compte bancaire');
    const { dateDebut, dateFin } = req.body || {};
    const statementBalance = validAmount(req.body?.soldeReleve);
    if (statementBalance === null) throw fail('Le solde de clôture du relevé est invalide.');
    const lines = normalizeStatementLines(req.body?.statementLines, { dateDebut, dateFin });
    const notes = req.body?.notes == null ? null : String(req.body.notes).trim().slice(0, 2000) || null;
    const selectedIds = lines.map((line) => line.transactionId).filter((id) => id !== null);
    if (new Set(selectedIds).size !== selectedIds.length) {
      throw fail('Une transaction ne peut être associée qu’à une seule ligne du relevé.');
    }

    const data = await db.transaction(async (tx) => {
      const account = await getAccount(tx, req.entrepriseId, accountId);
      const [overlap] = await tx.select({ id: rapprochementsBancaires.id })
        .from(rapprochementsBancaires)
        .where(and(
          eq(rapprochementsBancaires.entrepriseId, req.entrepriseId),
          eq(rapprochementsBancaires.compteBancaireId, accountId),
          lte(rapprochementsBancaires.dateDebut, dateFin),
          gte(rapprochementsBancaires.dateFin, dateDebut),
        )).limit(1);
      if (overlap) throw fail('Un rapprochement existe déjà pour une partie de cette période. Ouvrez-le pour continuer.', 409);

      const selectedTransactions = selectedIds.length ? await tx.select().from(transactionsTresorerie).where(and(
        eq(transactionsTresorerie.entrepriseId, req.entrepriseId),
        eq(transactionsTresorerie.compteBancaireId, accountId),
        inArray(transactionsTresorerie.id, selectedIds),
        isNull(transactionsTresorerie.rapprochementId),
      )) : [];
      if (selectedTransactions.length !== selectedIds.length) {
        throw fail('Une transaction sélectionnée est déjà rapprochée ou n’appartient pas à ce compte.', 409);
      }
      const selectedById = new Map(selectedTransactions.map((transaction) => [transaction.id, transaction]));
      for (const line of lines) {
        if (line.transactionId === null) continue;
        const transaction = selectedById.get(line.transactionId);
        if (!transaction || transaction.rapproche || !validMatch(line, transaction)) {
          throw fail(`La transaction choisie pour la ligne ${line.lineNumber} ne correspond plus. Rechargez les suggestions.`, 409);
        }
      }

      const [created] = await tx.insert(rapprochementsBancaires).values({
        entrepriseId: req.entrepriseId,
        compteBancaireId: accountId,
        dateDebut,
        dateFin,
        soldeReleve: statementBalance.toFixed(2),
        soldeComptable: '0.00',
        ecart: '0.00',
        statut: 'en_cours',
        notes,
        userId: req.user?.id || req.userId,
      }).returning();

      const createdLines = await tx.insert(lignesRapprochementBancaire).values(lines.map((line) => ({
        entrepriseId: req.entrepriseId,
        rapprochementId: created.id,
        transactionId: line.transactionId,
        numeroLigne: line.lineNumber,
        dateOperation: line.date,
        description: line.description,
        reference: line.reference,
        montant: line.amount.toFixed(2),
      }))).returning();

      if (selectedIds.length) {
        await tx.update(transactionsTresorerie).set({
          rapproche: true,
          rapprochementId: created.id,
        }).where(and(
          eq(transactionsTresorerie.entrepriseId, req.entrepriseId),
          eq(transactionsTresorerie.compteBancaireId, accountId),
          inArray(transactionsTresorerie.id, selectedIds),
          isNull(transactionsTresorerie.rapprochementId),
        ));
      }
      const ledger = await getLedgerThrough(tx, req.entrepriseId, accountId, dateFin);
      const balances = calculateBalances(account, ledger, statementBalance, selectedIds);
      const [updated] = await tx.update(rapprochementsBancaires).set({
        soldeComptable: balances.bookBalance.toFixed(2),
        ecart: balances.difference.toFixed(2),
        updatedAt: new Date(),
      }).where(and(
        eq(rapprochementsBancaires.id, created.id),
        eq(rapprochementsBancaires.entrepriseId, req.entrepriseId),
      )).returning();
      return {
        reconciliation: {
          ...updated,
          nomCompte: account.nomCompte,
          soldeReleve: Number(updated.soldeReleve),
          soldeComptable: Number(updated.soldeComptable),
          ecart: Number(updated.ecart),
        },
        lines: createdLines.map((line) => ({
          ...line,
          amount: Number(line.montant),
          transactionId: line.transactionId || null,
        })),
      };
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return safeFailure(res, error, 'Impossible d’enregistrer le rapprochement bancaire.');
  }
});

router.put('/:id/lines/:lineId', async (req, res) => {
  try {
    const reconciliationId = parsePositiveId(req.params.id, 'Rapprochement');
    const lineId = parsePositiveId(req.params.lineId, 'Ligne');
    const rawTransactionId = req.body?.transactionId;
    const transactionId = rawTransactionId == null || rawTransactionId === ''
      ? null
      : parsePositiveId(rawTransactionId, 'Transaction');

    const data = await db.transaction(async (tx) => {
      const reconciliation = await findReconciliation(tx, req.entrepriseId, reconciliationId);
      if (reconciliation.statut === 'valide') throw fail('Ce rapprochement est déjà validé.', 409);
      const [account] = await tx.select().from(comptesBancaires).where(and(
        eq(comptesBancaires.id, reconciliation.compteBancaireId),
        eq(comptesBancaires.entrepriseId, req.entrepriseId),
      )).limit(1);
      if (!account) throw fail('Compte bancaire introuvable.', 404);
      const [line] = await tx.select().from(lignesRapprochementBancaire).where(and(
        eq(lignesRapprochementBancaire.id, lineId),
        eq(lignesRapprochementBancaire.rapprochementId, reconciliationId),
        eq(lignesRapprochementBancaire.entrepriseId, req.entrepriseId),
      )).limit(1);
      if (!line) throw fail('Ligne de relevé introuvable.', 404);

      let nextTransaction = null;
      if (transactionId !== null) {
        const [candidate] = await tx.select().from(transactionsTresorerie).where(and(
          eq(transactionsTresorerie.id, transactionId),
          eq(transactionsTresorerie.entrepriseId, req.entrepriseId),
          eq(transactionsTresorerie.compteBancaireId, reconciliation.compteBancaireId),
          or(
            isNull(transactionsTresorerie.rapprochementId),
            eq(transactionsTresorerie.rapprochementId, reconciliationId),
          ),
        )).limit(1);
        if (!candidate) throw fail('Transaction introuvable ou déjà utilisée dans un autre rapprochement.', 409);
      if (candidate.rapproche && candidate.rapprochementId !== reconciliationId) {
        throw fail('Cette transaction a déjà été rapprochée.', 409);
      }
        const lineAsCandidate = {
          date: String(line.dateOperation).slice(0, 10),
          amount: Number(line.montant),
        };
        if (!validMatch(lineAsCandidate, candidate)) {
          throw fail('La date ou le montant de la transaction ne correspond pas à cette ligne.', 400);
        }
        const [alreadyUsed] = await tx.select({ id: lignesRapprochementBancaire.id })
          .from(lignesRapprochementBancaire)
          .where(and(
            eq(lignesRapprochementBancaire.entrepriseId, req.entrepriseId),
            eq(lignesRapprochementBancaire.rapprochementId, reconciliationId),
            eq(lignesRapprochementBancaire.transactionId, transactionId),
            ne(lignesRapprochementBancaire.id, lineId),
          )).limit(1);
        if (alreadyUsed && alreadyUsed.id !== line.id) {
          throw fail('Cette transaction est déjà associée à une autre ligne.', 409);
        }
        nextTransaction = candidate;
      }

      if (line.transactionId && line.transactionId !== transactionId) {
        await tx.update(transactionsTresorerie).set({
          rapproche: false,
          rapprochementId: null,
        }).where(and(
          eq(transactionsTresorerie.id, line.transactionId),
          eq(transactionsTresorerie.entrepriseId, req.entrepriseId),
          eq(transactionsTresorerie.rapprochementId, reconciliationId),
        ));
      }
      if (nextTransaction) {
        await tx.update(transactionsTresorerie).set({
          rapproche: true,
          rapprochementId: reconciliationId,
        }).where(and(
          eq(transactionsTresorerie.id, nextTransaction.id),
          eq(transactionsTresorerie.entrepriseId, req.entrepriseId),
          or(
            isNull(transactionsTresorerie.rapprochementId),
            eq(transactionsTresorerie.rapprochementId, reconciliationId),
          ),
        ));
      }
      const [updatedLine] = await tx.update(lignesRapprochementBancaire).set({
        transactionId,
      }).where(and(
        eq(lignesRapprochementBancaire.id, lineId),
        eq(lignesRapprochementBancaire.entrepriseId, req.entrepriseId),
        eq(lignesRapprochementBancaire.rapprochementId, reconciliationId),
      )).returning();
      const lines = await tx.select().from(lignesRapprochementBancaire).where(and(
        eq(lignesRapprochementBancaire.entrepriseId, req.entrepriseId),
        eq(lignesRapprochementBancaire.rapprochementId, reconciliationId),
      ));
      const balances = await refreshReconciliationBalances(
        tx,
        reconciliation,
        account,
        lines.map((entry) => entry.transactionId).filter(Boolean),
      );
      return {
        line: { ...updatedLine, amount: Number(updatedLine.montant), transactionId: updatedLine.transactionId || null },
        reconciliation: balances.reconciliation,
        balances: balances.balances,
      };
    });
    return res.json({ success: true, data });
  } catch (error) {
    return safeFailure(res, error, 'Impossible de modifier cette correspondance.');
  }
});

router.post('/:id/validate', async (req, res) => {
  try {
    const reconciliationId = parsePositiveId(req.params.id, 'Rapprochement');
    const result = await db.transaction(async (tx) => {
      const reconciliation = await findReconciliation(tx, req.entrepriseId, reconciliationId);
      if (reconciliation.statut === 'valide') return { reconciliation, alreadyValidated: true };
      const account = await getAccount(tx, req.entrepriseId, reconciliation.compteBancaireId);
      const lines = await tx.select().from(lignesRapprochementBancaire).where(and(
        eq(lignesRapprochementBancaire.entrepriseId, req.entrepriseId),
        eq(lignesRapprochementBancaire.rapprochementId, reconciliationId),
      ));
      const unmatchedLines = lines.filter((line) => !line.transactionId).length;
      if (unmatchedLines > 0) {
        throw fail(`Associez les ${unmatchedLines} ligne(s) du relevé restantes avant de valider.`, 409);
      }
      const ledger = await getLedgerThrough(
        tx,
        req.entrepriseId,
        reconciliation.compteBancaireId,
        reconciliation.dateFin,
      );
      const balances = calculateBalances(
        account,
        ledger,
        reconciliation.soldeReleve,
        lines.map((line) => line.transactionId),
      );
      if (Math.abs(balances.difference) > amountTolerance) {
        throw fail(`Le rapprochement présente encore un écart de ${balances.difference.toFixed(2)}. Vérifiez les lignes non enregistrées ou le solde saisi.`, 409);
      }
      const [updated] = await tx.update(rapprochementsBancaires).set({
        statut: 'valide',
        soldeComptable: balances.bookBalance.toFixed(2),
        ecart: balances.difference.toFixed(2),
        dateRapprochement: new Date().toISOString().slice(0, 10),
        updatedAt: new Date(),
      }).where(and(
        eq(rapprochementsBancaires.id, reconciliationId),
        eq(rapprochementsBancaires.entrepriseId, req.entrepriseId),
        eq(rapprochementsBancaires.statut, 'en_cours'),
      )).returning();
      if (!updated) throw fail('Le rapprochement a changé pendant la validation. Rechargez la page.', 409);
      return {
        reconciliation: {
          ...updated,
          soldeReleve: Number(updated.soldeReleve),
          soldeComptable: Number(updated.soldeComptable),
          ecart: Number(updated.ecart),
          nomCompte: account.nomCompte,
        },
        alreadyValidated: false,
      };
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    return safeFailure(res, error, 'Impossible de valider le rapprochement bancaire.');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const reconciliationId = parsePositiveId(req.params.id, 'Rapprochement');
    await db.transaction(async (tx) => {
      const reconciliation = await findReconciliation(tx, req.entrepriseId, reconciliationId);
      if (reconciliation.statut === 'valide') throw fail('Un rapprochement validé ne peut pas être supprimé.', 409);
      await tx.update(transactionsTresorerie).set({
        rapproche: false,
        rapprochementId: null,
      }).where(and(
        eq(transactionsTresorerie.entrepriseId, req.entrepriseId),
        eq(transactionsTresorerie.rapprochementId, reconciliationId),
      ));
      const [deleted] = await tx.delete(rapprochementsBancaires).where(and(
        eq(rapprochementsBancaires.id, reconciliationId),
        eq(rapprochementsBancaires.entrepriseId, req.entrepriseId),
        eq(rapprochementsBancaires.statut, 'en_cours'),
      )).returning({ id: rapprochementsBancaires.id });
      if (!deleted) throw fail('Le rapprochement a changé pendant la suppression. Rechargez la page.', 409);
    });
    return res.json({ success: true });
  } catch (error) {
    return safeFailure(res, error, 'Impossible de supprimer ce rapprochement.');
  }
});

export default router;
