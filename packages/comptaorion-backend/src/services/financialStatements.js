const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function movement(row) {
  return {
    debit: Number(row.debit) || 0,
    credit: Number(row.credit) || 0,
  };
}

function toAccountLines(rows, selector) {
  return rows
    .map((row) => {
      const amount = roundMoney(selector(row, movement(row)));
      return {
        numero: row.numero,
        nom: row.nom,
        montant: amount,
      };
    })
    .filter((row) => Math.abs(row.montant) >= 0.01)
    .sort((a, b) => a.numero.localeCompare(b.numero, 'fr', { numeric: true }));
}

export function buildFinancialStatements({ balanceRows, incomeRows, dateDebut, dateFin, quality }) {
  const charges = toAccountLines(
    incomeRows.filter((row) => row.numero.startsWith('6')),
    (_row, values) => values.debit - values.credit,
  );
  const produits = toAccountLines(
    incomeRows.filter((row) => row.numero.startsWith('7')),
    (_row, values) => values.credit - values.debit,
  );

  const totalCharges = roundMoney(charges.reduce((total, row) => total + row.montant, 0));
  const totalProduits = roundMoney(produits.reduce((total, row) => total + row.montant, 0));
  const resultatNet = roundMoney(totalProduits - totalCharges);

  const actif = [];
  const capitauxEtDettes = [];
  for (const row of balanceRows) {
    const values = movement(row);
    const netDebit = roundMoney(values.debit - values.credit);
    if (Math.abs(netDebit) < 0.01) continue;

    const classe = row.numero.charAt(0);
    if (classe === '1') {
      capitauxEtDettes.push({ numero: row.numero, nom: row.nom, montant: roundMoney(-netDebit) });
    } else if (['2', '3'].includes(classe)) {
      actif.push({ numero: row.numero, nom: row.nom, montant: netDebit });
    } else if (['4', '5'].includes(classe)) {
      if (netDebit > 0) actif.push({ numero: row.numero, nom: row.nom, montant: netDebit });
      else capitauxEtDettes.push({ numero: row.numero, nom: row.nom, montant: roundMoney(-netDebit) });
    }
  }

  capitauxEtDettes.push({
    numero: 'RESULTAT',
    nom: 'Résultat de la période',
    montant: resultatNet,
  });
  actif.sort((a, b) => a.numero.localeCompare(b.numero, 'fr', { numeric: true }));
  capitauxEtDettes.sort((a, b) => a.numero.localeCompare(b.numero, 'fr', { numeric: true }));

  const totalActif = roundMoney(actif.reduce((total, row) => total + row.montant, 0));
  const totalPassif = roundMoney(capitauxEtDettes.reduce((total, row) => total + row.montant, 0));
  const qualitySummary = {
    nombreEcritures: Number(quality.nombreEcritures) || 0,
    ecrituresNonValidees: Number(quality.ecrituresNonValidees) || 0,
    ecrituresNonEquilibrees: Number(quality.ecrituresNonEquilibrees) || 0,
  };

  return {
    dateDebut,
    dateFin,
    etatResultat: {
      charges,
      produits,
      totalCharges,
      totalProduits,
      resultatNet,
      typeResultat: resultatNet >= 0 ? 'benefice' : 'perte',
    },
    bilan: {
      actif,
      capitauxEtDettes,
      totalActif,
      totalPassif,
      ecart: roundMoney(totalActif - totalPassif),
      equilibre: Math.abs(totalActif - totalPassif) < 0.01,
    },
    qualite: qualitySummary,
  };
}
