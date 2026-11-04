const amount = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

export function buildThirdPartyLedger({
  partyType,
  invoices = [],
  payments = [],
  returns = [],
  adjustments = [],
}) {
  if (!['client', 'fournisseur'].includes(partyType)) {
    throw new Error('Type de compte tiers invalide');
  }

  const movements = [
    ...invoices.map((row) => ({
      date: row.dateFacture,
      reference: row.numeroFacture || `FAC-${row.id}`,
      type: 'facture',
      libelle: partyType === 'client' ? 'Facture client' : 'Facture fournisseur',
      montant: amount(row.totalTTC),
    })),
    ...payments.map((row) => ({
      date: row.datePaiement,
      reference: row.reference || `${partyType === 'client' ? 'PAI' : 'REG'}-${row.id}`,
      type: 'paiement',
      libelle: partyType === 'client'
        ? (row.modePaiement === 'cheque' ? `Paiement reçu par chèque ${row.numeroCheque || ''}`.trim() : 'Paiement client reçu')
        : 'Paiement fournisseur effectué',
      montant: amount(row.montant),
    })),
    ...payments.filter((row) => amount(row.escompteMontant) > 0).map((row) => ({
      date: row.datePaiement,
      reference: row.reference || `${partyType === 'client' ? 'PAI' : 'REG'}-${row.id}`,
      type: 'escompte',
      libelle: partyType === 'client' ? 'Escompte accordé au client' : 'Escompte obtenu du fournisseur',
      montant: amount(row.escompteMontant),
    })),
    ...returns.map((row) => ({
      date: row.dateRetour,
      reference: row.numero || `RET-${row.id}`,
      type: 'retour',
      libelle: partyType === 'client'
        ? 'Avoir client — retour de marchandise'
        : 'Retour de marchandise au fournisseur',
      montant: amount(row.totalTTC),
    })),
    ...adjustments.map((row) => ({
      date: row.dateNote,
      reference: row.numero || `AJU-${row.id}`,
      type: partyType === 'client' ? 'note_debit' : 'note_credit',
      libelle: partyType === 'client' ? 'Note de débit client — ajustement' : 'Note de crédit fournisseur — ajustement qualité',
      montant: amount(row.totalTTC),
    })),
  ].sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))
    || String(a.reference).localeCompare(String(b.reference)));

  const facturesTotal = amount(movements
    .filter((row) => row.type === 'facture')
    .reduce((sum, row) => sum + row.montant, 0));
  const paiementsTotal = amount(movements
    .filter((row) => row.type === 'paiement')
    .reduce((sum, row) => sum + row.montant, 0));
  const retoursTotal = amount(movements
    .filter((row) => row.type === 'retour')
    .reduce((sum, row) => sum + row.montant, 0));
  const notesDebitTotal = amount(movements
    .filter((row) => row.type === 'note_debit')
    .reduce((sum, row) => sum + row.montant, 0));
  const notesCreditTotal = amount(movements
    .filter((row) => row.type === 'note_credit')
    .reduce((sum, row) => sum + row.montant, 0));
  const escomptesTotal = amount(movements
    .filter((row) => row.type === 'escompte')
    .reduce((sum, row) => sum + row.montant, 0));

  return {
    mouvements: movements,
    totaux: {
      factures: facturesTotal,
      paiements: paiementsTotal,
      retours: retoursTotal,
      notesDebit: notesDebitTotal,
      notesCredit: notesCreditTotal,
      escomptes: escomptesTotal,
      solde: amount(facturesTotal + notesDebitTotal - paiementsTotal - retoursTotal - notesCreditTotal - escomptesTotal),
    },
  };
}
