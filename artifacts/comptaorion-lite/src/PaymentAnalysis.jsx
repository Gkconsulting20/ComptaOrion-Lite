import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from './api.js';

const fmt = (v, c) => `${Math.round(Number(v) || 0).toLocaleString('fr-FR')} ${c}`;

export default function PaymentAnalysis({ client, t, settings, onClose }) {
  const [res, setRes] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [explaining, setExplaining] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = useCallback(async (explain) => {
    if (!navigator.onLine) { setError(t('Cette opération nécessite une connexion.', 'This operation requires a connection.')); setLoading(false); return; }
    explain ? setExplaining(true) : setLoading(true); setError('');
    try { const r = await api.post(`/ai/payment-analysis/${client.id}`, { explain }); if (alive.current) setRes(r?.data || null); }
    catch (e) { if (alive.current) setError(e?.message || t('Analyse impossible.', 'Analysis failed.')); }
    finally { if (alive.current) { setLoading(false); setExplaining(false); } }
  }, [client.id, settings.language]);
  useEffect(() => { run(false); }, [client.id]);
  const c = settings.currency;
  const cover = { 'insuffisante': t('insuffisante', 'insufficient'), 'limitée': t('limitée', 'limited'), 'établie': t('établie', 'established') };
  return <div className="lite-modal-backdrop" role="presentation"><section className="lite-modal pa-modal" role="dialog" aria-modal="true">
    <header><h2>{t('Analyse des paiements', 'Payment analysis')} · {client.nom}</h2><button className="icon-button" onClick={onClose} aria-label={t('Fermer', 'Close')}>×</button></header>
    {loading && <div className="pa-skeleton"><span /><span /><span /></div>}
    {error && <div className="auth-message auth-error" role="alert">{error} <button className="text-button" onClick={() => run(false)}>{t('Réessayer', 'Retry')}</button></div>}
    {res && !loading && <div className="pa-body">
      <div className="pa-score"><span>{t('Score indicatif', 'Indicative score')}</span><strong>{res.score == null ? '—' : `${res.score}/100`}</strong>
        <small>{res.score == null ? t('Historique insuffisant pour calculer un score.', 'Not enough history to compute a score.') : t('Indication seulement, ce n’est pas une décision de crédit.', 'Indication only, not a credit decision.')}</small></div>
      <dl className="pa-grid">
        <div><dt>{t('Couverture', 'Coverage')}</dt><dd>{cover[res.coverage] || res.coverage}</dd></div>
        <div><dt>{t('Au', 'As of')}</dt><dd>{res.asOf}</dd></div>
        <div><dt>{t('Factures', 'Invoices')}</dt><dd>{res.eligibleCount}/{res.invoiceCount} {res.excludedCount > 0 && `(${res.excludedCount} ${t('exclues', 'excluded')})`}</dd></div>
        <div><dt>{t('Facturé', 'Invoiced')}</dt><dd>{fmt(res.totalInvoiced, c)}</dd></div>
        <div><dt>{t('Payé', 'Paid')}</dt><dd>{fmt(res.totalPaid, c)}</dd></div>
        <div><dt>{t('Reste dû', 'Outstanding')}</dt><dd>{fmt(res.outstanding, c)}</dd></div>
        <div><dt>{t('En retard', 'Overdue')}</dt><dd>{fmt(res.overdueAmount, c)}</dd></div>
        <div><dt>{t('Factures en retard', 'Late invoices')}</dt><dd>{res.lateInvoiceCount}</dd></div>
        <div><dt>{t('Retard moyen', 'Average delay')}</dt><dd>{Number(res.averageDelayDays).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} {t('j', 'd')}</dd></div>
      </dl>
      <h3 className="subheading">{t('Contributions au score', 'Score contributions')}</h3>
      {[['repayment', t('Remboursement', 'Repayment')], ['punctuality', t('Ponctualité', 'Punctuality')], ['delay', t('Délai', 'Delay')]].map(([k, label]) => <div className="pa-bar" key={k}><span>{label}</span><i><u style={{ transform: `scaleX(${Math.max(0, Math.min(1, Number(res.components?.[k]) / 100 || 0))})` }} /></i><b>{res.components?.[k]}</b></div>)}
      <p className="install-help"><b>{t('Formule', 'Formula')} :</b> {res.formula}</p>
      {res.warnings?.length > 0 && <div className="auth-message ai-warning"><b>{t('Limites des données', 'Data limitations')}</b><ul>{res.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
      {res.explanation && <div className="pa-explain"><b>{t('Explication', 'Explanation')}</b><p>{res.explanation}</p></div>}
      {res.explanationError && <div className="auth-message auth-error">{res.explanationError}</div>}
      {!res.explanation && <><p className="install-help">{t('Expliquer envoie uniquement des agrégats anonymes à Groq, sans nom ni coordonnées.', 'Explain sends only anonymous aggregates to Groq, with no name or contact details.')}</p>
        <button className="outline" disabled={explaining || res.score == null} onClick={() => run(true)}>{explaining ? t('Explication en cours…', 'Explaining…') : t('Expliquer avec Groq', 'Explain with Groq')}</button></>}
    </div>}
  </section></div>;
}
