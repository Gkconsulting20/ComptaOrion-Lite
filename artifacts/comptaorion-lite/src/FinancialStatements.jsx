import { useEffect, useState } from 'react';
import api from './api.js';

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const startOfYear = () => `${new Date().getFullYear()}-01-01`;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function formatAmount(value, currency) {
  return `${Number(value || 0).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${currency}`;
}

export default function FinancialStatements({ settings, t }) {
  const [dateDebut, setDateDebut] = useState(startOfYear);
  const [dateFin, setDateFin] = useState(today);
  const [report, setReport] = useState(null);
  const [tab, setTab] = useState('resultat');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api.get('/financial-reports', { dateDebut, dateFin })
      .then((result) => {
        if (active) setReport(result);
      })
      .catch((reason) => {
        if (active) setError(reason?.message || t('Impossible de charger les états financiers.', 'Could not load financial statements.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [dateDebut, dateFin, requestVersion, t]);

  const statement = tab === 'resultat' ? report?.etatResultat : report?.bilan;
  const rows = tab === 'resultat'
    ? [...(statement?.produits || []), ...(statement?.charges || [])]
    : [...(statement?.actif || []), ...(statement?.capitauxEtDettes || [])];
  const printStatement = () => {
    if (!report || !statement) return;
    const title = tab === 'resultat' ? 'État de résultat' : 'Bilan';
    const lines = tab === 'resultat'
      ? [
          ...statement.produits.map((row) => ({ ...row, section: 'Produits' })),
          ...statement.charges.map((row) => ({ ...row, section: 'Charges' })),
        ]
      : [
          ...statement.actif.map((row) => ({ ...row, section: 'Actif' })),
          ...statement.capitauxEtDettes.map((row) => ({ ...row, section: 'Capitaux et dettes' })),
        ];
    const totalRows = tab === 'resultat'
      ? `<tr class="total"><th colspan="3">Total produits</th><td>${escapeHtml(formatAmount(statement.totalProduits, settings.currency))}</td></tr><tr class="total"><th colspan="3">Total charges</th><td>${escapeHtml(formatAmount(statement.totalCharges, settings.currency))}</td></tr><tr class="result"><th colspan="3">Résultat net</th><td>${escapeHtml(formatAmount(statement.resultatNet, settings.currency))}</td></tr>`
      : `<tr class="total"><th>Total actif</th><td>${escapeHtml(formatAmount(statement.totalActif, settings.currency))}</td></tr><tr class="total"><th>Total capitaux et dettes</th><td>${escapeHtml(formatAmount(statement.totalPassif, settings.currency))}</td></tr><tr class="result"><th>Écart</th><td>${escapeHtml(formatAmount(statement.ecart, settings.currency))}</td></tr>`;
    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title><style>body{font:14px Arial,sans-serif;color:#172326;margin:32px}h1{margin-bottom:4px}p{color:#56615f}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{text-align:left;padding:10px;border-bottom:1px solid #ddd}td:last-child{text-align:right}.total{font-weight:bold;background:#f3f5f3}.result{font-size:16px;font-weight:bold;background:#e5f3ef}.notice{padding:12px;background:#fff3dd}</style></head><body><h1>ComptaOrion Lite · ${title}</h1><p>Période : ${escapeHtml(report.dateDebut)} au ${escapeHtml(report.dateFin)}</p>${report.qualite.ecrituresNonValidees ? `<p class="notice">${report.qualite.ecrituresNonValidees} écriture(s) ne sont pas encore validées. État provisoire.</p>` : ''}<table><thead><tr><th>Section</th><th>Compte</th><th>Libellé</th><th>Montant (${escapeHtml(settings.currency)})</th></tr></thead><tbody>${lines.map((row) => `<tr><td>${escapeHtml(row.section)}</td><td>${escapeHtml(row.numero)}</td><td>${escapeHtml(row.nom)}</td><td>${escapeHtml(formatAmount(row.montant, settings.currency))}</td></tr>`).join('')}${totalRows}</tbody></table><script>window.onload=()=>window.print()</script></body></html>`;
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setError(t('Autorisez les fenêtres contextuelles pour imprimer ou enregistrer en PDF.', 'Allow pop-ups to print or save as PDF.'));
      return;
    }
    printWindow.opener = null;
    printWindow.document.write(html);
    printWindow.document.close();
  };

  const income = report?.etatResultat;
  const balance = report?.bilan;
  return <section className="financial-statements" aria-labelledby="financial-statements-title">
    <div className="financial-heading">
      <div>
        <span className="eyebrow">{t('Comptabilité', 'Accounting')}</span>
        <h2 id="financial-statements-title">{t('États financiers', 'Financial statements')}</h2>
        <p className="muted">{t('Consultez votre état de résultat et votre bilan à partir des écritures comptables.', 'View your profit and loss statement and balance sheet from accounting entries.')}</p>
      </div>
      <button className="outline" type="button" onClick={printStatement} disabled={!report || loading} data-testid="button-print-financial-statement">
        {t('Imprimer / PDF', 'Print / PDF')}
      </button>
    </div>

    <div className="financial-filters">
      <label>{t('Du', 'From')}<input type="date" value={dateDebut} max={dateFin} onChange={(event) => setDateDebut(event.target.value)} data-testid="input-financial-start-date" /></label>
      <label>{t('Au', 'To')}<input type="date" value={dateFin} min={dateDebut} onChange={(event) => setDateFin(event.target.value)} data-testid="input-financial-end-date" /></label>
      <button className="primary" type="button" onClick={() => setRequestVersion((value) => value + 1)} disabled={loading} data-testid="button-refresh-financial-statements">
        {loading ? t('Chargement…', 'Loading…') : t('Actualiser', 'Refresh')}
      </button>
    </div>

    <div className="financial-tabs" role="tablist" aria-label={t('Rapports financiers', 'Financial reports')}>
      <button type="button" role="tab" aria-selected={tab === 'resultat'} className={tab === 'resultat' ? 'active' : ''} onClick={() => setTab('resultat')} data-testid="tab-income-statement">
        {t('État de résultat', 'Profit & loss')}
      </button>
      <button type="button" role="tab" aria-selected={tab === 'bilan'} className={tab === 'bilan' ? 'active' : ''} onClick={() => setTab('bilan')} data-testid="tab-balance-sheet">
        {t('Bilan', 'Balance sheet')}
      </button>
    </div>

    {error && <div className="financial-alert is-error" role="alert" data-testid="financial-report-error">{error}</div>}
    {loading && <p className="financial-empty" role="status">{t('Chargement des données comptables…', 'Loading accounting data…')}</p>}
    {!loading && report && <>
      {(report.qualite.ecrituresNonValidees > 0 || report.qualite.ecrituresNonEquilibrees > 0) &&
        <div className="financial-alert" role="status" data-testid="financial-report-warning">
          {report.qualite.ecrituresNonValidees > 0 && <span>{t(`${report.qualite.ecrituresNonValidees} écriture(s) sont en brouillon et non validées. Ces états sont provisoires.`, `${report.qualite.ecrituresNonValidees} journal entry/entries are drafts and not validated. These statements are provisional.`)}</span>}
          {report.qualite.ecrituresNonEquilibrees > 0 && <span>{t(`${report.qualite.ecrituresNonEquilibrees} écriture(s) ne sont pas équilibrées. Vérifiez les journaux.`, `${report.qualite.ecrituresNonEquilibrees} journal entry/entries are unbalanced. Review the ledgers.`)}</span>}
        </div>}
      {tab === 'resultat' && income && <div className="financial-summary-grid">
        <article><span>{t('Produits', 'Revenue')}</span><strong>{formatAmount(income.totalProduits, settings.currency)}</strong><small>{income.produits.length} {t('compte(s)', 'account(s)')}</small></article>
        <article><span>{t('Charges', 'Expenses')}</span><strong>{formatAmount(income.totalCharges, settings.currency)}</strong><small>{income.charges.length} {t('compte(s)', 'account(s)')}</small></article>
        <article className={income.resultatNet < 0 ? 'negative' : 'positive'}><span>{t('Résultat net', 'Net result')}</span><strong>{formatAmount(income.resultatNet, settings.currency)}</strong><small>{income.resultatNet < 0 ? t('Perte', 'Loss') : t('Bénéfice', 'Profit')}</small></article>
      </div>}
      {tab === 'bilan' && balance && <div className="financial-summary-grid">
        <article><span>{t('Total de l’actif', 'Total assets')}</span><strong>{formatAmount(balance.totalActif, settings.currency)}</strong><small>{balance.actif.length} {t('compte(s)', 'account(s)')}</small></article>
        <article><span>{t('Capitaux et dettes', 'Equity and liabilities')}</span><strong>{formatAmount(balance.totalPassif, settings.currency)}</strong><small>{balance.capitauxEtDettes.length} {t('ligne(s)', 'line(s)')}</small></article>
        <article className={balance.equilibre ? 'positive' : 'negative'}><span>{t('Écart du bilan', 'Balance difference')}</span><strong>{formatAmount(balance.ecart, settings.currency)}</strong><small>{balance.equilibre ? t('Bilan équilibré', 'Balanced') : t('Écart à vérifier', 'Difference to review')}</small></article>
      </div>}
      <div className="financial-table-wrap">
        <table className="financial-table">
          <thead><tr>
            {tab === 'resultat'
              ? <><th>{t('Compte', 'Account')}</th><th>{t('Libellé', 'Name')}</th><th>{t('Produits', 'Revenue')}</th><th>{t('Charges', 'Expenses')}</th></>
              : <><th>{t('Compte', 'Account')}</th><th>{t('Libellé', 'Name')}</th><th>{t('Classe', 'Section')}</th><th>{t('Montant', 'Amount')}</th></>}
          </tr></thead>
          <tbody>
            {tab === 'resultat' && <>
              {income?.produits.map((row) => <tr key={`product-${row.numero}`}><td>{row.numero}</td><td>{row.nom}</td><td>{formatAmount(row.montant, settings.currency)}</td><td>—</td></tr>)}
              {income?.charges.map((row) => <tr key={`expense-${row.numero}`}><td>{row.numero}</td><td>{row.nom}</td><td>—</td><td>{formatAmount(row.montant, settings.currency)}</td></tr>)}
              <tr className="financial-total"><th colSpan="3">{t('Résultat net', 'Net result')}</th><td>{formatAmount(income?.resultatNet, settings.currency)}</td></tr>
            </>}
            {tab === 'bilan' && <>
              {balance?.actif.map((row) => <tr key={`asset-${row.numero}`}><td>{row.numero}</td><td>{row.nom}</td><td>{t('Actif', 'Assets')}</td><td>{formatAmount(row.montant, settings.currency)}</td></tr>)}
              {balance?.capitauxEtDettes.map((row) => <tr key={`liability-${row.numero}`}><td>{row.numero}</td><td>{row.nom}</td><td>{row.numero === 'RESULTAT' ? t('Résultat', 'Result') : t('Capitaux et dettes', 'Equity and liabilities')}</td><td>{formatAmount(row.montant, settings.currency)}</td></tr>)}
              {!balance?.actif.length && !balance?.capitauxEtDettes.length && <tr><td colSpan="4">{t('Aucun mouvement de bilan sur cette période.', 'No balance sheet activity in this period.')}</td></tr>}
            </>}
            {rows.length === 0 && tab === 'resultat' && <tr><td colSpan="4">{t('Aucune écriture de charge ou de produit sur cette période.', 'No expense or revenue entries in this period.')}</td></tr>}
          </tbody>
          <tfoot>{tab === 'resultat'
            ? <tr><th colSpan="2">{t('Totaux', 'Totals')}</th><th>{formatAmount(income?.totalProduits, settings.currency)}</th><th>{formatAmount(income?.totalCharges, settings.currency)}</th></tr>
            : <><tr><th colSpan="3">{t('Total de l’actif', 'Total assets')}</th><th>{formatAmount(balance?.totalActif, settings.currency)}</th></tr><tr><th colSpan="3">{t('Total capitaux et dettes', 'Total equity and liabilities')}</th><th>{formatAmount(balance?.totalPassif, settings.currency)}</th></tr></>}
          </tfoot>
        </table>
      </div>
      {tab === 'bilan' && !balance?.equilibre && <p className="financial-alert" data-testid="balance-sheet-difference">{t('Le bilan ne s’équilibre pas encore. Il peut manquer des soldes d’ouverture ou des écritures; l’écart reste affiché pour ne pas masquer le problème.', 'The balance sheet does not balance yet. Opening balances or entries may be missing; the difference is shown rather than hidden.')}</p>}
      {report.qualite.nombreEcritures === 0 && <p className="financial-empty">{t('Aucune écriture n’a encore été enregistrée pour cette période.', 'No journal entries have been recorded for this period yet.')}</p>}
    </>}
  </section>;
}
