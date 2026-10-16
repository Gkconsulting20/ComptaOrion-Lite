// The model never calculates or changes this score. All dates use calendar UTC.
const day = value => {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text ? time : null;
};
const round = n => Math.round(n * 100) / 100;
const amount = n => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n)) && Number(n) >= 0;
export const SCORE_FORMULA = '50 × taux de règlement + 30 × part des factures réglées à échéance + 20 × (1 − min(retard moyen, 60) / 60). Seules les factures échues non annulées/non brouillon avec échéance et historique de paiement cohérent sont évaluées. Une facture encore impayée n’est pas ponctuelle; son retard court jusqu’à la date du calcul.';

export function computePaymentScore(invoices, payments, now = new Date()) {
  const asOf = now.toISOString().slice(0, 10);
  const at = day(asOf);
  const issued = invoices.filter(f => !['brouillon', 'annulee'].includes(f.statut) && day(f.dateFacture) !== null && day(f.dateFacture) <= at);
  const warnings = [];
  const eligible = [];
  let outstanding = 0, overdueAmount = 0, totalInvoiced = 0, totalPaid = 0, inconsistent = 0;
  for (const f of issued) {
    if (!amount(f.totalTTC) || Number(f.totalTTC) <= 0 || !amount(f.montantPaye) || !amount(f.soldeRestant)) { inconsistent++; continue; }
    const total = Number(f.totalTTC), paidField = Number(f.montantPaye), balance = Number(f.soldeRestant);
    const due = day(f.dateEcheance);
    const history = payments.filter(p => p.factureId === f.id);
    let coherent = true;
    const valid = history.filter(p => {
      if (!amount(p.montant) || Number(p.montant) <= 0 || day(p.datePaiement) === null || day(p.datePaiement) < day(f.dateFacture)) { coherent = false; return false; }
      return day(p.datePaiement) <= at;
    }).sort((a, b) => day(a.datePaiement) - day(b.datePaiement));
    const sum = valid.reduce((s, p) => s + Number(p.montant), 0);
    if (Math.abs(sum - paidField) > 0.02 || Math.abs(total - paidField - balance) > 0.02 || paidField > total + 0.02) coherent = false;
    totalInvoiced += total;
    totalPaid += Math.min(paidField, total);
    outstanding += balance;
    if (due !== null && due < at) overdueAmount += balance;
    if (!coherent) { inconsistent++; continue; }
    // Missing dates and not-yet-due invoices must not earn a perfect score.
    if (due === null || due > at || due < day(f.dateFacture)) continue;
    let cumulative = 0, settled = null;
    for (const p of valid) {
      cumulative += Number(p.montant);
      if (cumulative >= total - 0.005) { settled = day(p.datePaiement); break; }
    }
    const delay = Math.max(0, ((settled ?? at) - due) / 86400000);
    eligible.push({ total, paid: Math.min(sum, total), delay, punctual: settled !== null && settled <= due });
  }
  const count = eligible.length;
  const evaluatedTotal = eligible.reduce((s, f) => s + f.total, 0);
  const repayment = evaluatedTotal ? eligible.reduce((s, f) => s + f.paid, 0) / evaluatedTotal : 0;
  const punctuality = count ? eligible.filter(f => f.punctual).length / count : 0;
  const averageDelayDays = count ? eligible.reduce((s, f) => s + f.delay, 0) / count : 0;
  const components = {
    repayment: round(50 * repayment),
    punctuality: round(30 * punctuality),
    delay: round(20 * (1 - Math.min(averageDelayDays, 60) / 60)),
  };
  if (!count) warnings.push('Historique insuffisant : aucune facture échue avec échéance et paiements vérifiables.');
  else if (count < 5) warnings.push('Moins de cinq factures évaluables : indicateur peu représentatif.');
  if (issued.length > count) warnings.push('Des factures non échues, sans échéance ou incohérentes sont exclues du score.');
  if (inconsistent) warnings.push('Des totaux ou historiques sont incohérents : rapprocher les paiements avant toute interprétation.');
  warnings.push('Indicateur descriptif uniquement; aucune décision automatique d’octroi de crédit. Les paiements non affectés à une facture ne sont pas évalués.');
  return {
    score: count ? Math.max(0, Math.min(100, Math.round(Object.values(components).reduce((s, n) => s + n, 0)))) : null,
    asOf, invoiceCount: issued.length, eligibleCount: count, excludedCount: issued.length - count,
    totalInvoiced: round(totalInvoiced), totalPaid: round(totalPaid), outstanding: round(outstanding), overdueAmount: round(overdueAmount),
    lateInvoiceCount: eligible.filter(f => f.delay > 0).length, averageDelayDays: round(averageDelayDays),
    coverage: !count ? 'insuffisante' : count < 5 ? 'limitée' : 'établie',
    components: count ? components : { repayment: 0, punctuality: 0, delay: 0 },
    formula: SCORE_FORMULA, warnings,
  };
}

export function anonymousScoreSummary(score) {
  // Explicit allow-list: no identity, invoice number, amount, contact or dates.
  return {
    score: score.score, eligibleCount: score.eligibleCount, excludedCount: score.excludedCount,
    lateInvoiceCount: score.lateInvoiceCount, averageDelayDays: score.averageDelayDays,
    coverage: score.coverage, components: score.components, formula: score.formula,
  };
}
