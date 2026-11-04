const amount = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

export function buildThirdPartyLedger({ partyType, invoices = [], payments = [], returns = [] }) {
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
    ...returns.map((row) => ({
      date: row.dateRetour,
      reference: row.numero || `RET-${row.id}`,
      type: 'retour',
      libelle: partyType === 'client'
        ? 'Avoir client — retour de marchandise'
        : 'Retour de marchandise au fournisseur',
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

  return {
    mouvements: movements,
    totaux: {
      factures: facturesTotal,
      paiements: paiementsTotal,
      retours: retoursTotal,
      solde: amount(facturesTotal - paiementsTotal - retoursTotal),
    },
  };
}
