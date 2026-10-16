import React, { useEffect, useRef, useState } from 'react';
import api from './api.js';

const MAX_BYTES = 4 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const readAsDataUrl = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('read')); r.readAsDataURL(file); });

export default function AiAssistant({ t, settings, notify, reload, setPage }) {
  const [status, setStatus] = useState(null), [statusError, setStatusError] = useState(false);
  const [file, setFile] = useState(null), [preview, setPreview] = useState(''), [fileError, setFileError] = useState('');
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [result, setResult] = useState(null), [draft, setDraft] = useState(null), [confirmed, setConfirmed] = useState(false), [saving, setSaving] = useState(false), [done, setDone] = useState(false);
  const previewRef = useRef('');

  const loadStatus = () => { setStatusError(false); api.get('/ai/status').then(r => setStatus(r?.data || null)).catch(() => setStatusError(true)); };
  useEffect(() => { loadStatus(); return () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); }; }, []);

  const pick = (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setFileError(''); setError(''); setResult(null); setDraft(null); setConfirmed(false); setDone(false); setConsent(false);
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    if (!TYPES.includes(f.type)) { setFile(null); setPreview(''); setFileError(t('Format accepté : JPEG, PNG ou WebP.', 'Accepted formats: JPEG, PNG or WebP.')); return; }
    if (f.size > MAX_BYTES) { setFile(null); setPreview(''); setFileError(t('Image trop lourde (4 Mo maximum).', 'Image too large (4 MiB maximum).')); return; }
    const url = URL.createObjectURL(f); previewRef.current = url; setFile(f); setPreview(url);
  };
  const clearPhoto = () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); previewRef.current = ''; setFile(null); setPreview(''); setConsent(false); };

  const analyze = async () => {
    if (!file || !consent) return;
    if (!navigator.onLine) { setError(t('Cette opération nécessite une connexion.', 'This operation requires a connection.')); return; }
    setBusy(true); setError(''); setDone(false);
    try {
      const image = await readAsDataUrl(file);
      const r = await api.post('/ai/prepare-photo', { image, consent: true });
      const d = r?.data; if (!d?.draft) throw new Error(t('Réponse inattendue du serveur.', 'Unexpected server response.'));
      setResult(d); setDraft({ description: d.draft.description || '', montant: d.draft.montant ?? '', dateDepense: d.draft.dateDepense || '', reference: d.draft.reference || '', devise: d.draft.devise || '' }); setConfirmed(false);
    } catch (e) { setError(e?.message || t('Analyse impossible.', 'Analysis failed.')); }
    finally { setBusy(false); }
  };
  const edit = (changes) => { setDraft(d => ({ ...d, ...changes })); setConfirmed(false); };
  const valid = draft && draft.description.trim() && Number.isFinite(Number(draft.montant)) && Number(draft.montant) > 0 && draft.devise.trim() && /^\d{4}-\d{2}-\d{2}$/.test(draft.dateDepense);
  const confirm = async () => {
    if (!valid || !confirmed || result?.duplicate) return;
    if (!navigator.onLine) { setError(t('Cette opération nécessite une connexion.', 'This operation requires a connection.')); return; }
    setSaving(true); setError('');
    try {
      await api.post('/ai/confirm', { draftToken: result.draftToken, confirmed: true, draft: { description: draft.description.trim(), montant: Number(draft.montant), dateDepense: draft.dateDepense, reference: draft.reference.trim(), devise: draft.devise } });
      setDone(true); setResult(null); setDraft(null); setConfirmed(false); clearPhoto(); notify(t('Dépense enregistrée', 'Expense saved')); reload();
    } catch (e) { setError(e?.message || t('Enregistrement impossible. Le brouillon est conservé.', 'Could not save. Your draft is kept.')); }
    finally { setSaving(false); }
  };

  return <>
    <div className="lite-page-head"><div><span className="eyebrow">{t('Assistant', 'Assistant')}</span><h1>{t('Saisie par photo', 'Photo entry')}</h1><p className="muted">{t('Photographiez une facture ou un reçu d’achat pour préparer une dépense.', 'Photograph a purchase invoice or receipt to prepare an expense.')}</p></div></div>
    <section className="ai-card">
      <div className="ai-status">
        {statusError ? <>{t('État de l’assistant indisponible.', 'Assistant status unavailable.')} <button className="text-button" onClick={loadStatus}>{t('Réessayer', 'Retry')}</button></>
          : !status ? <span className="ai-skeleton" />
          : status.configured ? <span>{t('Groq configuré (clé présente, disponibilité non vérifiée)', 'Groq configured (key present, readiness not verified)')} · {status.model} · {status.license}</span>
          : <span>{t('Assistant non configuré sur le serveur.', 'Assistant not configured on the server.')}</span>}
      </div>
      <p className="ai-note">{t('Seules les factures et reçus d’achat sont pris en charge, pas les ventes ni les encaissements. Masquez les données personnelles inutiles avant l’envoi. Lite ne conserve pas l’image; Groq applique sa propre politique de traitement des données.', 'Only purchase invoices and receipts are supported, not sales or payments. Mask unneeded personal data before sending. Lite does not store the image; Groq applies its own data handling policy.')}</p>
      <div className="ai-pick">
        <label className="outline ai-file">{t('Prendre une photo', 'Take a photo')}<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={pick} disabled={busy || saving} hidden /></label>
        <label className="outline ai-file">{t('Choisir un fichier', 'Choose a file')}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={pick} disabled={busy || saving} hidden /></label>
      </div>
      {fileError && <div className="auth-message auth-error" role="alert">{fileError}</div>}
      {preview && <div className="ai-preview"><img src={preview} alt={t('Aperçu local de la photo', 'Local photo preview')} /><button className="text-button" disabled={busy || saving} onClick={clearPhoto}>{t('Retirer la photo', 'Remove photo')}</button></div>}
      {file && !draft && <>
        <label className="ai-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>{t('J’accepte l’envoi de cette image pour analyse. J’ai masqué les données personnelles inutiles.', 'I agree to send this image for analysis. I have masked unneeded personal data.')}</span></label>
        <button className="primary" disabled={!consent || busy || status?.configured === false} onClick={analyze}>{busy ? t('Analyse en cours…', 'Analyzing…') : t('Analyser la photo', 'Analyze photo')}</button>
      </>}
    </section>
    {error && <div className="auth-message auth-error" role="alert">{error}</div>}
    {done && <div className="auth-message auth-success" role="status">{t('La dépense a été enregistrée et vos données sont à jour.', 'The expense was saved and your data is up to date.')} <button className="text-button" onClick={() => setPage('expenses')}>{t('Voir les dépenses', 'View expenses')}</button></div>}
    {draft && <section className="ai-card">
      <h2 className="subheading">{t('Brouillon de dépense', 'Expense draft')}</h2>
      {result.duplicate && <div className="auth-message auth-error" role="alert">{t('Cette dépense semble déjà enregistrée. La confirmation est bloquée pour éviter un doublon.', 'This expense seems already saved. Confirmation is blocked to avoid a duplicate.')}</div>}
      {result.warnings?.map((w, i) => <div className="auth-message ai-warning" key={i}>{w}</div>)}
      <form className="lite-form" onSubmit={e => { e.preventDefault(); confirm(); }}><fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 16, minWidth: 0 }}>
        <label>{t('Description', 'Description')}<input required value={draft.description} onChange={e => edit({ description: e.target.value })} /></label>
        <div className="form-split">
          <label>{t('Montant', 'Amount')}<input type="number" min="0.01" step="0.01" required value={draft.montant} onChange={e => edit({ montant: e.target.value })} /></label>
          <label>{t('Date', 'Date')}<input type="date" required value={draft.dateDepense} onChange={e => edit({ dateDepense: e.target.value })} /></label>
        </div>
        <div className="form-split">
          <label>{t('Référence', 'Reference')}<input value={draft.reference} onChange={e => edit({ reference: e.target.value })} /></label>
          <label>{t('Devise', 'Currency')}<input required placeholder={t('Ex. FCFA, EUR', 'E.g. XOF, EUR')} value={draft.devise} onChange={e => edit({ devise: e.target.value })} /></label>
        </div>
        <label className="ai-check"><input type="checkbox" checked={confirmed} disabled={result.duplicate} onChange={e => setConfirmed(e.target.checked)} /><span>{t('Je confirme avoir relu ces informations et je souhaite créer cette dépense.', 'I confirm I reviewed this information and want to create this expense.')}</span></label>
        <button className="primary wide" disabled={!valid || !confirmed || saving || result.duplicate}>{saving ? t('Enregistrement…', 'Saving…') : t('Enregistrer la dépense', 'Save expense')}</button>
      </fieldset></form>
    </section>}
  </>;
}
